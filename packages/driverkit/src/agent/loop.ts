/**
 * driverkit/agent — the loop.
 *
 * This is the other case the library is for. The relay and the MCP server
 * carry verbs to an agent in another process; this one has no transport at
 * all, because the page already holds the driver. The person types "find the
 * Acme contacts and accept the top thousand" into a panel in the corner, and
 * `drive` turns that into model turns and `driver.call()`s until the model
 * answers in prose.
 *
 * Which makes this a loop and not a protocol. There are no frames, no ids, no
 * deadline and no `WireResult`: every call lands, every call returns a
 * `Result`, and every `Result` carries a snapshot. What is left to get right
 * is the shape of the conversation, and there are four decisions in it that
 * matter more than the code:
 *
 * **1. The static half is computed once, above the loop.** `system` and
 * `tools` are derived from `driver.manifest()` before the first turn and never
 * touched again, so they are byte-identical on every call to `think` and a
 * caller can have their provider cache them. One per-turn string in there — a
 * clock, a step counter, the current screen — re-prices the entire prefix on
 * every turn, and the prefix is the big half. Making them `const`s outside the
 * loop is the only version of this rule that cannot be broken by accident.
 *
 * **2. The screen goes in the newest message, never in the system prompt.** It
 * is the dynamic half by definition. It enters the conversation exactly twice:
 * on the person's own turn, and riding on each tool result. And it LEAVES
 * again: one copy survives, the newest, and every older turn keeps its words
 * or its outcome and gives up its screen. Each copy is small and ten of them
 * are not, and they land in the half nothing caches — see `pruneScreens`,
 * which is where the rest of that argument is.
 *
 * **3. One round trip per step, not two.** `Result` already carries the
 * snapshot after the call, so the tool result the model reads is the outcome
 * *and* the new screen. The loop never follows a verb with a read. With ten
 * steps that is ten saved model turns, each of which would otherwise have
 * re-read the whole prefix — and the round trips, not the manifest, are what
 * actually cost money.
 *
 * **4. A refusal is information, not a failure.** It is fed back and the model
 * is expected to adapt. The one thing that must not happen is adapting
 * forever: the same verb refused the same way three times is a model that has
 * stopped learning, and continuing costs the person money to watch nothing
 * happen.
 *
 * **5. The run is watchable and interruptible, and that is a property of the
 * loop rather than of a UI.** The agent is moving the screen a person is
 * looking at, so going as fast as the model answers is the wrong speed: what
 * the person needs is to see each step coming and have somewhere to put their
 * hand. Pacing (`pace`) puts a cancellable wait before each call, run controls
 * (`controls`) hold the run between calls, and the events are detailed enough
 * that a step list can show a row before the call it describes has happened.
 * None of it reaches the model — it is runtime state, and decision 1 is still
 * the rule: nothing per-turn goes anywhere near `system` or `tools`.
 */

import type { Driver, Manifest, Result, Scalar } from "../core/index.ts";
import { paceWait, realClock } from "./control.ts";
import { SLOW_MS, renderDuration, renderOutcome, renderSnapshot } from "./render.ts";
import { READ_SCREEN, systemPrompt, toolsFor } from "./tools.ts";
import type {
  CallEvent,
  Clock,
  CommitDecision,
  DriveOptions,
  DriveOutcome,
  RunState,
  StopReason,
  ToolCall,
  Turn,
} from "./types.ts";

/**
 * The refusal slug a vetoed commit comes back as.
 *
 * A new name rather than one of the core's. PROTOCOL.md reserves `stale`,
 * `unknown-verb`, `bad-argument`, `unmounted`, `threw`, `no-such-tab`,
 * `tab-went-away` and `timeout`; this is reserved on the same grounds and for
 * the same reason. A model that cannot tell "the person said no" from "your
 * arguments were wrong" will retry with different arguments, which is the one
 * response that is certainly wrong — the arguments were fine and the answer
 * was no.
 *
 * An app must not name one of its own verb refusals this.
 */
export const DECLINED = "declined-by-user";

/**
 * The core's cost-ceiling slug, spelled here because this file has to
 * recognise it. The same arrangement as `DECLINED` above: the string is
 * PROTOCOL.md's rather than either file's, and the core exports the whole
 * reserved list rather than a constant per slug.
 *
 * Recognised and never emitted. The loop cannot run out of somebody else's
 * budget on its own — only `call()` can say this — so a match here is always
 * the driver talking.
 */
const BUDGET_SPENT = "budget-spent";

const DECLINED_HINT =
  "The person was asked to confirm this and declined. Do not retry it, and do not try " +
  "another verb that does the same thing. Tell them what you were about to do and ask " +
  "what they would like instead.";

/**
 * How a screen is introduced, and the seam pruning cuts at.
 *
 * A marker rather than a guess at where the rest of the turn ends. Pruning has
 * to remove exactly what this file added and nothing anybody typed, and looking
 * for a line this file wrote is the only way to be sure of that.
 *
 * Written on both kinds of turn that carry a screen — the person's own, and
 * every tool result — so there is one seam and not two. A tool turn whose text
 * were nothing but a screen would have no seam in it at all, which is why even
 * `read_screen`, whose whole answer is the screen, gets an outcome line above
 * this marker. One shape, one cut; see `pruneScreens`.
 */
const SCREEN_MARK = "\n\nOn screen now:\n";

/**
 * What an older turn's screen is replaced with.
 *
 * Replaced, not deleted. A turn that simply has no screen reads as a turn where
 * the screen was empty, and "there were no contacts a moment ago" is a worse
 * thing for a model to believe than "there was a screen there and you are not
 * being shown it any more". On a tool result the empty reading would be worse
 * still: a verb whose result showed no rows looks like a verb that emptied the
 * table.
 *
 * One sentence for both kinds of turn, and it is deliberately short. Unlike the
 * user-turn case, which happens once or twice in a conversation, this is paid
 * once per pruned tool turn — so it is the one piece of boilerplate in here
 * that is itself O(steps), and the only honest answer to that is to keep it to
 * a line. It buys back four fifths of a screen each time it is written.
 */
const STALE_NOTE =
  "\n\n(screen no longer shown; only the newest screen in this conversation is current)";

/**
 * A tool result for a call the loop decided not to run.
 *
 * **Why this is not optional.** `DriveOutcome.messages` is documented as
 * something a caller hands back as the next run's `history`, and every tool-use
 * API — Anthropic's included — rejects a conversation in which a `tool_use`
 * block has no matching result. A 3-call assistant turn that stops after the
 * first call therefore does not merely lose two results: it poisons the
 * widget's own conversation permanently, and the person's next question comes
 * back as a 400 from then on, forever, with nothing on screen to explain it.
 * One missing tool turn is a dead panel.
 *
 * So the answer is written for the model rather than for the protocol. It says
 * plainly that the verb did not run and why, because the honest alternative — a
 * blank or an "ok" — would have the model believe a commit happened and build
 * its next step on it. What it must never say is anything that reads as a
 * failure to retry: `stopped` and `aborted` are decisions, not errors.
 */
function abandoned(call: ToolCall, why: "stopped" | "aborted"): Turn {
  const text =
    why === "aborted"
      ? "not run: the person stopped this run before this call was made. Nothing happened " +
        "here and nothing changed. This is not an error and must not be retried by itself."
      : "not run: the run stopped at an earlier call in this same turn. Nothing happened " +
        "here and nothing changed. This is not an error and must not be retried by itself.";
  return { role: "tool", callId: call.id, name: call.name, text };
}

/**
 * Keep exactly one screen in the conversation: the newest one, wherever it is.
 *
 * The rule the core states on `Snapshot` and this function exists to hold:
 *
 *   "an agent is never shown more than the person at the keyboard. Same
 *    filters, same sort, same page. That is what keeps the cost flat as the
 *    data grows — a hundred rows on screen is a hundred rows in the prompt
 *    whether the table holds a hundred or a million"
 *
 * Flat as the data grows, and the cost of a step is what the person could see
 * when it ran. A conversation holding one copy of the screen per step honours
 * neither: the person at the keyboard is looking at one screen, and the prompt
 * carried ten. Each copy is small, which is exactly why this went unnoticed for
 * as long as it did — the leak is in the COUNT, not in the size, and it lands
 * in the uncached half where every byte is paid for on every remaining turn.
 *
 * Both kinds of turn carry one. A user turn carries the screen as it was when
 * the person spoke; a tool turn carries the screen the call left behind, which
 * is the authoritative one at the moment it arrives. Each is right at the time
 * and wrong a few turns later, for the same two reasons, and the second is the
 * one that matters: old blocks are bytes in the uncached half paid for forever,
 * and a model that reads a screen from four messages ago as current will act on
 * rows that have moved. The second is a correctness problem wearing a cost
 * problem's clothes — and the cure is written into `DriveOutcome.messages`
 * already: a model is never shown two screens and left to work out which one is
 * now true.
 *
 * **What survives on an older tool turn, and what a model loses.** The outcome
 * line stays: `ok`, the count and its warning, `refused: <slug>` and its hint.
 * That is what an old tool turn is actually consulted for — "what did my third
 * call do" — and it is the half that never goes stale. What is gone is the
 * table as it stood between two of the model's own calls. A model that wants it
 * can call `read_screen`, which costs one round trip against ten turns of
 * carrying it, and the newest screen is always in front of it untouched.
 *
 * **Why the newest and not the newest few.** A window of N would still grow
 * with N, would need a number nobody can justify, and would put two or three
 * screens of the same table in the tail with nothing but position to say which
 * is live — reintroducing the misreading above at a constant factor. Keeping
 * the last screen per `Snapshot.screen` id was the other candidate, and it
 * fails on the same count: an app with six screens keeps six, the total grows
 * with navigation rather than with steps, and `screen` is optional — so the
 * bill would depend on whether an app happens to name its screens.
 */
export function pruneScreens(messages: Turn[]): Turn[] {
  // The newest turn that carries a screen, of either kind. Found by looking for
  // the marker rather than by role: after a call, the newest screen is on a
  // tool turn and the person's own turn is as stale as any other.
  let newest = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const turn = messages[i]!;
    if (turn.role === "assistant") continue;
    if (turn.text.includes(SCREEN_MARK)) {
      newest = i;
      break;
    }
  }

  return messages.map((turn, i) => {
    if (turn.role === "assistant" || i === newest) return turn;
    const at = turn.text.indexOf(SCREEN_MARK);
    if (at === -1) return turn;
    // Everything before the marker is kept verbatim, which on a tool turn is
    // the outcome line and on a user turn is what the person typed. Spread
    // rather than rebuilt, so a tool turn keeps the `callId` its `tool_use`
    // is answering: pruning rewrites text and never removes or re-pairs a
    // turn, which is what makes it safe to do to something a caller will hand
    // back as `history`. See `abandoned`.
    return { ...turn, text: turn.text.slice(0, at) + STALE_NOTE };
  });
}

/**
 * Run the loop until the model answers, or a bound stops it.
 *
 * ```ts
 * const out = await drive(driver, {
 *   // No model client in this package. The browser cannot hold a key, so the
 *   // realistic shape is a call to your own backend, which already knows who
 *   // the person is.
 *   think: backendThink("/api/chat"),
 *   task: "find the Acme contacts and accept the top thousand",
 *   // Opt-in here; mountWidget turns it on by default. See onBeforeCommit.
 *   onBeforeCommit: ({ verb, snapshot }) =>
 *     confirm(`${verb.describe}\n\n${snapshot.selected?.length ?? 0} selected. Go ahead?`),
 * });
 * out.stop; // "answered" | "max-steps" | "aborted" | "stuck" | "over-budget" | "silent"
 * ```
 */
export async function drive(driver: Driver, options: DriveOptions): Promise<DriveOutcome> {
  const manifest = driver.manifest();

  // The static half. Computed here, used unchanged on every turn below. See
  // decision 1 in the file comment, and `the system prompt is byte-identical
  // across turns` in the tests, which asserts it rather than trusting it.
  const timing = options.timing ?? "off";
  // The note about what a `took:` line means goes in the CACHED half, once,
  // and the per-call line is then four words. The alternative -- a sentence of
  // guidance beside every duration, the way `count` carries `COUNT_NOTE` --
  // would be the one piece of boilerplate in a turn that is O(calls), for a
  // number that needs explaining once. `systemPrompt` stays a pure function of
  // its arguments and therefore still byte-identical across every turn of the
  // run, which is the property the prefix cache is built on.
  const system = systemPrompt(manifest, options.instructions, timing);
  const tools = toolsFor(manifest);

  const verbs = new Map<string, Manifest["verbs"][number]>(
    manifest.verbs.map((v) => [v.name, v]),
  );

  const maxSteps = options.maxSteps ?? 12;
  const refusalLimit = options.refusalLimit ?? 3;
  const signal = options.signal;
  const controls = options.controls;
  const clock = options.clock ?? realClock;

  // The run's `pace` option is the initial value and the controls own it from
  // then on, which is what makes `controls.pace()` live. Seeded only when the
  // option was actually given, so a caller who set the pace on the controls and
  // left the option out keeps theirs instead of being reset to 0.
  if (controls && options.pace !== undefined) controls.pace(options.pace);
  // Read fresh before every wait when there are controls — the whole point —
  // and fixed for the run when there are none. 0 by default, so a headless
  // `drive` is not slowed down by a feature that exists for somebody watching;
  // `mountWidget` passes `WATCHABLE_PACE`. See `pace`.
  const pace: number | (() => number) = controls ? () => controls.paceMs : (options.pace ?? 0);
  // Named once rather than written inline, so the wait and the loop cannot come
  // to disagree about whether a pace change is being listened for.
  const watchPace = controls ? (listener: () => void) => controls.subscribe(listener) : undefined;

  let messages: Turn[] = [...(options.history ?? [])];

  // How many times each (verb, refusal slug) pair has come back. The loop
  // detector; see decision 4.
  const refusals = new Map<string, number>();

  if (options.task !== undefined) {
    // The person's words and the screen they are looking at, in one turn.
    //
    // Together on purpose: this is the newest message at the moment it is
    // sent, which is where the dynamic half belongs, and it saves the model
    // spending its first step on a `read_screen` whose answer we already have
    // in hand. "Accept the top thousand" is also not interpretable without
    // knowing what is on screen — the screen is half of what was said.
    messages.push({
      role: "user",
      text: `${options.task}${SCREEN_MARK}${renderSnapshot(driver.snapshot())}`,
    });
  }

  // Lossy on purpose, and worth stating: a caller that wanted a verbatim
  // transcript of what the model was shown does not get one from here. The
  // alternative is paying for every screen the conversation ever had, on every
  // turn, so that nothing is lost — and nobody reads those bytes.
  //
  // Called below, before every `think` and once on the way out, rather than
  // once here. Once here was enough while only user turns carried screens,
  // because a run adds at most one of those; tool turns are added by the loop
  // itself, one per call, so the newest screen moves on every step and the
  // pruning has to move with it. Running it before each turn also keeps the
  // `messages` handed back already pruned, so a conversation carried across
  // many runs does not re-accumulate what this just removed.

  let steps = 0;
  let text: string | undefined;
  let stop: StopReason = "max-steps";

  // Mirrored here rather than read off `controls` when wanted, because the
  // event is about *transitions* and because `awaiting-approval` is a state
  // only this loop knows it is in. Reported, never consulted: nothing below
  // branches on it, so a bug in here can make a UI say the wrong word and
  // cannot make the run do the wrong thing.
  let state: RunState = controls?.state ?? "running";
  const mark = (next: RunState): void => {
    if (next === state) return;
    state = next;
    options.onControl?.({ step: steps, state: next });
  };
  // Fired unconditionally, including for a run with no controls, so a UI has a
  // defined starting state instead of having to assume one. `step: 0` — no
  // model turn has been spent yet.
  options.onControl?.({ step: 0, state });

  /** Hold if the controls say to, announcing the hold so a UI can show it.
   *
   *  Asking `controls.state` first rather than timing the `gate` call: a UI
   *  that flashed "paused" for every call of an unpaused run would be noise,
   *  and the condition for actually holding is knowable up front. */
  const hold = async (what: "think" | "call"): Promise<void> => {
    if (!controls) return;
    if (controls.state === "paused" && controls.permits === 0) mark("paused");
    await controls.gate(what, signal);
    // Before `mark("running")`, so a run stopped while held is not reported as
    // having resumed on its way out. The caller breaks on the abort next.
    if (signal?.aborted) return;
    mark("running");
  };

  for (;;) {
    if (signal?.aborted) {
      stop = "aborted";
      break;
    }
    if (steps >= maxSteps) {
      stop = "max-steps";
      break;
    }

    // Before `steps++` and before `onStep`, which is the honest order: a held
    // run has not started a step, and a model round trip is the expensive
    // thing a pause is most worth having in front of.
    await hold("think");
    if (signal?.aborted) {
      stop = "aborted";
      break;
    }

    steps++;
    options.onStep?.({ step: steps });

    // Here, not after the pushes below: this is the last moment before the
    // tail is handed to the model, so "the newest screen" means the newest at
    // the instant it is read. Idempotent, so running it on every turn costs a
    // scan of a short array and cannot double-cut anything.
    messages = pruneScreens(messages);

    // `messages.slice()` and not `messages`. A `think` that is a fetch will
    // serialise this and forget it, but one that is a scripted fake, a
    // recorder or a middleware will keep the array, and handing out the live
    // one means a later push mutates something a caller believes it owns.
    const thought = await options.think({
      system,
      tools,
      messages: messages.slice(),
      // Spread rather than passed as `signal: undefined`. `ThinkInput.signal`
      // is optional, and under `exactOptionalPropertyTypes` an explicit
      // `undefined` is a different thing from an absent field — a `think` that
      // checks `"signal" in input` would see one that is not there.
      ...(signal ? { signal } : {}),
    });

    const calls = thought.calls ?? [];
    messages.push({
      role: "assistant",
      ...(thought.text ? { text: thought.text } : {}),
      ...(calls.length ? { calls } : {}),
    });
    if (thought.text) {
      text = thought.text;
      options.onSay?.({ step: steps, text: thought.text });
    }

    if (calls.length === 0) {
      // The only ending the model chooses. Prose with no call is an answer;
      // nothing at all is a broken adapter, and is worth distinguishing so
      // that whoever wrote `think` is told which of the two happened.
      stop = thought.text ? "answered" : "silent";
      break;
    }

    // Checked after `think` as well as before it, because `think` is the slow
    // part of a step and is exactly where a person clicks the stop button. The
    // model's calls are abandoned unrun: an abort that still commits is not an
    // abort.
    if (signal?.aborted) {
      // Every one of the model's calls is abandoned, and every one of them
      // still gets an answer: see `abandoned`. The assistant turn carrying them
      // is already in `messages`, and a `tool_use` with no result makes the
      // whole conversation unusable.
      for (const call of calls) messages.push(abandoned(call, "aborted"));
      stop = "aborted";
      break;
    }

    let stuck = false;
    let aborted = false;
    /** Set by the first `budget-spent`. Separate from `stuck` because the two
     *  say different things to the person watching; see `StopReason`. */
    let spent = false;
    /** Calls the loop decided not to run. Each one still owes the model a
     *  result; see `abandoned`. */
    let unrun: ToolCall[] = [];

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;

      // Re-checked inside the fan-out. A model may emit several calls in one
      // turn, and if the person stops the run halfway through them the rest
      // must not run — the second of three verbs is the worst place to be
      // interrupted and the only way to be sure is to look before each one.
      if (signal?.aborted) {
        aborted = true;
        unrun = calls.slice(i);
        break;
      }

      const verb = verbs.get(call.name);
      const kind = verb?.kind;
      // `at` rides along with `kind`, from the manifest, untouched. Nothing in
      // this loop reads it and nothing ever should: it is a hint for whoever is
      // drawing the run, and driverkit resolving a selector would be the one
      // thing the library promises not to do. See `Verb.at` in the core.
      const event: CallEvent = {
        step: steps,
        call,
        ...(kind === undefined ? {} : { kind }),
        ...(verb?.at === undefined ? {} : { at: verb.at }),
        index: i,
        of: calls.length,
      };

      // Before the pacing and before any hold, so the row for this call can be
      // on screen and glowing while the person still has time to stop it. The
      // ordering is the whole point of the event; see `onBeforeCall`.
      //
      // A copy per listener, like `messages.slice()` above: three events
      // describe one call, and one of them mutating the object would quietly
      // rewrite what the other two were told.
      options.onBeforeCall?.({ ...event });

      // Then the pace, then the gate, in that order. Pacing first so that a
      // person who pauses and then resumes gets the next call immediately
      // instead of sitting through a wait whose job — giving them time to
      // react — they have already done by hand.
      await paceWait({
        ms: pace,
        clock,
        ...(signal ? { signal } : {}),
        ...(watchPace ? { watch: watchPace } : {}),
      });
      if (signal?.aborted) {
        aborted = true;
        unrun = calls.slice(i);
        break;
      }

      await hold("call");
      // The abort wins over the hold. A paused run that could not be stopped
      // would be the worst version of this feature: the person presses stop and
      // the loop is parked on a promise nobody is going to resolve.
      if (signal?.aborted) {
        aborted = true;
        unrun = calls.slice(i);
        break;
      }

      options.onCall?.({ ...event });

      const outcome = await runOne(driver, call, verb, options, mark, timing, clock);

      // The two halves, joined with the pruning seam between them. A call that
      // reached no screen at all — an unknown tool name — gets no marker and
      // no screen, which is the one honest shape for it: a marker followed by
      // nothing would say the screen was empty.
      const screened = (head: string): string =>
        outcome.screen === undefined ? head : head + SCREEN_MARK + outcome.screen;

      options.onResult?.({
        ...event,
        result: outcome.result,
        text: screened(outcome.head),
      });

      // The outcome line only. The screen is appended last, below, so that
      // anything else this loop has to say about the call sits ABOVE the seam
      // and survives pruning — the refusal-limit note in particular, which is
      // written for a caller resuming this conversation later and would be the
      // first thing cut if it were appended after the screen.
      let body = outcome.head;

      if (outcome.result && !outcome.result.ok && outcome.result.refused === BUDGET_SPENT) {
        // Before the refusal counter and not through it. `refusalLimit` exists
        // to notice a model repeating a mistake, and this is not a mistake the
        // model made or can fix — the ceiling was set by whoever mounted the
        // app. Letting it accumulate would spend two more model round trips to
        // reach a conclusion the first refusal already stated, and spend them
        // against the budget that has just run out.
        //
        // The app's own hint is already in the tool turn, which matters for a
        // caller who resumes this conversation later: the transcript says which
        // ceiling and that it does not refill.
        body +=
          `\n\n(stopped: this app's spend ceiling is reached. It does not refill, and no ` +
          `other verb will run either. Say what got through and what is left.)`;
        spent = true;
      } else if (outcome.result && !outcome.result.ok) {
        const key = `${call.name}:${outcome.result.refused}`;
        const seen = (refusals.get(key) ?? 0) + 1;
        refusals.set(key, seen);
        if (seen >= refusalLimit) {
          // The note is appended to the tool result rather than replacing it,
          // so the transcript a caller keeps reads as what actually happened.
          // The model never gets a chance to act on it — that is the point —
          // but a caller resuming this conversation later hands the model a
          // history in which the reason for the gap is written down.
          body +=
            `\n\n(stopped: \`${call.name}\` has now been refused \`${outcome.result.refused}\` ` +
            `${seen} times. Repeating it will not work. Say what is in the way.)`;
          stuck = true;
        }
      }

      messages.push({ role: "tool", callId: call.id, name: call.name, text: screened(body) });
      if (stuck || spent) {
        unrun = calls.slice(i + 1);
        break;
      }
    }

    // The fan-out is never left half-answered. See `abandoned`: this is the
    // difference between a conversation a caller can hand back as `history`
    // and one that makes every later `ask()` fail with a 400.
    for (const call of unrun) messages.push(abandoned(call, aborted ? "aborted" : "stopped"));

    if (aborted) {
      stop = "aborted";
      break;
    }
    // Before `stuck`, which it cannot be at the same time -- the two are set in
    // exclusive branches -- and first anyway, because a budget is the wider
    // fact: `stuck` is about one verb and this is about the whole app.
    if (spent) {
      stop = "over-budget";
      break;
    }
    if (stuck) {
      stop = "stuck";
      break;
    }
  }

  // Again on the way out, because the last thing a run does is often to push
  // tool turns nobody will `think` about — a fan-out's results, or the
  // `abandoned` answers after a stop. Without this the array handed back would
  // carry every screen from that final turn, and a caller passing it as
  // `history` would be billed for them until the next run's first prune.
  messages = pruneScreens(messages);

  options.onStop?.({ stop, steps, ...(text === undefined ? {} : { text }) });
  return { stop, steps, messages, ...(text === undefined ? {} : { text }) };
}

/** The sentinel `readRev` returns for a `rev` that was sent and cannot be
 *  honoured. A distinct value because `undefined` already means something
 *  load-bearing here — "no rev was sent, so do not check staleness" — and
 *  collapsing the two is exactly the bug. */
const BAD_REV = Symbol("bad-rev");

/**
 * The `rev` a model sent, as a number, or `BAD_REV`.
 *
 * A model answering `{"rev": "9"}` is not a model making a mistake: tool
 * arguments arrive as JSON generated by a language model, and a string where a
 * number was asked for is ordinary behaviour from every vendor. A clean
 * integer-valued string is the same claim as the integer, so it is honoured.
 *
 * Everything else is refused rather than coerced. `"3.7"`, `"abc"`, `""` and
 * `true` are not claims about a rev, they are evidence the model did not read
 * one off the screen — and `Number("")` being `0` and `Number(true)` being `1`
 * is precisely how a permissive coercion turns that into a confident claim
 * about a screen that never existed.
 *
 * `null` is treated as absent, matching `checkArg`: a vendor serialising an
 * omitted optional field as `null` has said nothing, not something wrong.
 */
function readRev(raw: Scalar | undefined): number | undefined | typeof BAD_REV {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : BAD_REV;
  if (typeof raw === "boolean") return BAD_REV;
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) return BAD_REV;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : BAD_REV;
}

/**
 * The `screen` a model sent, as a string, or `BAD_REV`.
 *
 * The same shape as `readRev`, and for the same reason: a safety check that
 * silently disables itself when its argument arrives in the wrong type is worse
 * than no check, because the transcript then reads `ok` for a call made against
 * a screen the model never saw. A number or a boolean is not a screen id, it is
 * evidence the model did not read one off a screen, so it is refused rather
 * than dropped. An empty string is refused too: `""` is not the same claim as
 * leaving the field out, which is "I make none".
 *
 * `null` is absent, matching `checkArg` and `readRev`: a vendor serialising an
 * omitted optional field as `null` has said nothing, not something wrong.
 */
function readScreen(raw: Scalar | undefined): string | undefined | typeof BAD_REV {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return BAD_REV;
  const text = raw.trim();
  return text ? text : BAD_REV;
}

/**
 * One tool call: resolve it, maybe gate it, run it, render it.
 *
 * `result` is null when nothing was called on the driver — `read_screen`, or a
 * name the manifest does not have. A caller's `onResult` uses that to tell "a
 * verb ran" from "the model looked" when drawing its trace.
 *
 * The rendering comes back in two pieces rather than one string, and the
 * caller joins them. `head` is the outcome and keeps its meaning forever;
 * `screen` is the block that is current for one turn and is dropped from the
 * turn after. Joining them here would mean the loop had to find the seam again
 * by searching the text it just built. `screen` is absent only for a call that
 * reached no screen at all.
 */
async function runOne(
  driver: Driver,
  call: ToolCall,
  verb: Manifest["verbs"][number] | undefined,
  options: DriveOptions,
  /** Report the run's state. Used for exactly one thing: saying that the run is
   *  parked in front of a person's confirmation, which is a wait the run
   *  controls do not own and a panel showing "running" would misdescribe. */
  mark: (state: RunState) => void,
  /** `DriveOptions.timing`, already defaulted by the caller. */
  timing: "off" | "slow" | "always",
  /** The run's clock, so a suite that pins `now` gets a byte-exact transcript
   *  out of a timed run. See `renderDuration` on why buckets are for
   *  production and an injected clock is for determinism. */
  clock: Clock,
): Promise<{ result: Result | null; head: string; screen?: string }> {
  if (call.name === READ_SCREEN && verb === undefined) {
    // `verb === undefined` so an app that genuinely declares a verb by this
    // name keeps it. The app's meaning wins over ours, the same way it does
    // for the hoisted `rev`.
    // `ok` above the screen, where a verb's outcome goes. The screen is the
    // whole answer here and the line says nothing a model did not know — it is
    // there so that this turn has the same two-part shape as every other turn
    // carrying a screen, and therefore a seam to cut at when it goes stale. A
    // tool turn that was nothing but a screen was the one kind pruning could
    // not touch, and `read_screen` is the call whose turn is pure screen.
    return { result: null, head: "ok", screen: renderSnapshot(driver.snapshot()) };
  }

  if (verb === undefined) {
    // Named, not counted. A model asked for a tool that does not exist, and
    // listing the real names is how the fix happens on the next turn rather
    // than after another read — the same reason the core lists them on
    // `unknown-verb`.
    const known = [...driver.manifest().verbs.map((v) => v.name), READ_SCREEN].sort().join(", ");
    // No screen: nothing was called, so there is no post-call screen to show,
    // and the newest one is already in the conversation a turn above.
    return { result: null, head: `no such tool \`${call.name}\`. available: ${known}` };
  }

  // `rev` is ours unless the verb claimed the name, in which case it is an
  // ordinary argument and goes through untouched. Mirrors the MCP server.
  const args: Record<string, Scalar> = { ...call.args };

  // NEITHER CLAIM IS OFFERED ON AN `ask`, AND NEITHER IS HONOURED HERE.
  //
  // `verbTool` leaves both properties off a question's schema -- a question
  // acts on no screen, so there is nothing for it to be stale about -- and this
  // is the other half of that. A model volunteering a `rev` it was told to
  // quote would otherwise have its question refused `stale` because the person
  // clicked a row while it was being composed, which is the likeliest thing in
  // the world when they are sitting right there, and a question refused for a
  // reason that has nothing to do with the question teaches a model not to ask.
  // So the keys are dropped: not hoisted into a claim, and not left behind to
  // become an argument the core has never heard of. Mirrors the MCP server.
  const asking = verb.kind === "ask";
  if (asking) {
    delete args.rev;
    delete args.screen;
  }

  let rev: number | undefined;
  if (!asking && !(verb.args && "rev" in verb.args)) {
    const raw = args.rev;
    delete args.rev;
    const hoisted = readRev(raw);
    if (hoisted === BAD_REV) {
      // Refused, never dropped. This is the whole bug: `rev` undefined is read
      // by the core as "opt out of the staleness check", so a model answering
      // `{"rev": "9"}` — ordinary behaviour from every vendor — used to turn
      // the check off instead of using it. A safety check that silently
      // disables itself on a type coercion is worse than no check, because the
      // transcript then shows `ok` for a call that acted on a screen the model
      // never saw.
      //
      // `bad-argument` and not `stale`: nothing is known about the screen here,
      // only about the call. It is shaped as a real `Result` so the renderer,
      // `onResult` and the loop detector treat it like any other refusal —
      // a model that keeps sending junk revs hits the refusal limit.
      const snapshot = driver.snapshot();
      const result: Result = {
        ok: false,
        refused: "bad-argument",
        hint:
          `\`rev\` must be the whole number printed on the screen you are acting on, like ` +
          `${snapshot.rev}. Got ${JSON.stringify(raw)}. Read the screen and quote its rev, or ` +
          `leave \`rev\` out entirely.`,
        snapshot,
      };
      return { result, head: renderOutcome(result), screen: renderSnapshot(result.snapshot) };
    }
    rev = hoisted;
  }

  // `screen` is hoisted exactly like `rev`, down to the app keeping the name if
  // it declared one: `go(screen)` is a real verb in a real app, and the app's
  // meaning wins over ours.
  let screen: string | undefined;
  if (!asking && !(verb.args && "screen" in verb.args)) {
    const raw = args.screen;
    delete args.screen;
    const hoisted = readScreen(raw);
    if (hoisted === BAD_REV) {
      const snapshot = driver.snapshot();
      const result: Result = {
        ok: false,
        refused: "bad-argument",
        hint:
          "`screen` must be the id printed on the `screen` line of the screen you are " +
          `acting on${snapshot.screen ? `, like \`${snapshot.screen}\`` : ""}. Got ` +
          `${JSON.stringify(raw)}. Read the screen and quote it, or leave \`screen\` out ` +
          "entirely.",
        snapshot,
      };
      return { result, head: renderOutcome(result), screen: renderSnapshot(result.snapshot) };
    }
    screen = hoisted;
  }

  // `plan` is hoisted on the same terms as `rev` and `screen` — the app keeps
  // the name if it declared an argument by it — with one difference: it is
  // taken off the args only for a verb that declares `consumes`, because that
  // is the only verb the tool schema offered it on, so on any other verb a
  // `plan` key is an argument the app named or a mistake the core should see.
  //
  // Not coerced and not refused on a bad type, which is where this parts
  // company with `readRev` and `readScreen`. Those two refuse a wrong type
  // because `undefined` means "skip the check" and a silent drop would turn a
  // safety claim off. Here the opposite is true: the check is mandatory, so a
  // token that is missing, blank or not a string all arrive at the core and all
  // come back as `stale-plan` — which is the refusal that explains the pairing.
  // Inventing a `bad-argument` here would answer a smaller question with a
  // worse hint.
  let plan: string | undefined;
  if (verb.consumes === "plan" && !(verb.args && "plan" in verb.args)) {
    const raw = args.plan;
    delete args.plan;
    if (typeof raw === "string" && raw.trim()) plan = raw.trim();
  }

  if (verb.kind === "commit" && options.onBeforeCommit) {
    const snapshot = driver.snapshot();
    let decision: CommitDecision;
    mark("awaiting-approval");
    try {
      decision = await options.onBeforeCommit({ name: verb.name, args, verb, snapshot });
    } catch (err) {
      // A host's confirmation UI throwing must not take the run down, and it
      // must not be read as consent either. A failed ask is a no.
      decision = `the confirmation could not be shown (${
        err instanceof Error ? err.message : String(err)
      })`;
    } finally {
      // In a `finally` so a confirmation UI that throws cannot leave a panel
      // claiming forever that it is waiting for an answer nobody is being
      // asked for. The run carries on either way — a failed ask is a no.
      mark("running");
    }

    if (decision === false || typeof decision === "string") {
      // Shaped as a real `Result`, so the renderer, `onResult` and the loop
      // detector all treat it like any other refusal. The veto reaches the
      // model as a refusal rather than a crash, which is the difference
      // between "you declined that, shall I narrow it first?" and a panel
      // that stops responding.
      const result: Result = {
        ok: false,
        refused: DECLINED,
        hint: typeof decision === "string" ? decision : DECLINED_HINT,
        snapshot,
      };
      return { result, head: renderOutcome(result), screen: renderSnapshot(result.snapshot) };
    }
  }

  // The clock brackets `driver.call()` and nothing else. Everything this loop
  // does before this point -- the pace wait, a `controls` hold, the
  // `onBeforeCommit` dialog above -- is already outside it, which is why the
  // honest figure falls out of WHERE the measurement is taken rather than out
  // of arithmetic afterwards. Read only when a duration is going to be
  // rendered: an untimed run reads no clock, exactly as it did before.
  // `clock.now?.()` and never a detached `clock.now ?? Date.now`. A `Clock` is
  // an interface and an implementation is free to be a class -- the test suite's
  // own fake is one, reading a `#private` field -- so a method pulled off the
  // object and called bare loses its receiver and throws. `paceWait` calls it
  // the same way for the same reason.
  const now = (): number => clock.now?.() ?? Date.now();
  const started = timing === "off" ? 0 : now();
  // The person-wait counter before, and again after, so a gate that lives
  // INSIDE `driver.call()` is subtracted. See `DriveOptions.waited`.
  const waitedBefore = timing === "off" ? 0 : (options.waited?.() ?? 0);

  const result = await driver.call(verb.name, args, {
    ...(rev === undefined ? {} : { rev }),
    ...(screen === undefined ? {} : { screen }),
    ...(plan === undefined ? {} : { plan }),
  });

  let head = renderOutcome(result);
  if (timing !== "off") {
    // `Math.max(0, ...)` because `waited` is reported by a host and a host that
    // reports more wait than the call took is a host with a bug -- in which
    // case the floor is zero and the line is simply omitted rather than a
    // negative duration being put in front of a model.
    const waited = Math.max(0, (options.waited?.() ?? 0) - waitedBefore);
    const line = renderDuration(Math.max(0, now() - started - waited), timing === "slow" ? SLOW_MS : 0);
    // Appended to the OUTCOME half, above the screen seam, so it survives
    // `pruneScreens`. That is the right half on its merits and not only for
    // thrift: "how long did my third call take" is a question whose answer
    // stays true forever, like `ok` and like the count, and unlike the table.
    if (line) head += `\n${line}`;
  }

  return { result, head, screen: renderSnapshot(result.snapshot) };
}
