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
 * on the person's own turn, and riding on each tool result.
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
 */

import type { Driver, Manifest, Result, Scalar } from "driverkit";
import { renderResult, renderSnapshot } from "./render.ts";
import { READ_SCREEN, systemPrompt, toolsFor } from "./tools.ts";
import type {
  CommitDecision,
  DriveOptions,
  DriveOutcome,
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

const DECLINED_HINT =
  "The person was asked to confirm this and declined. Do not retry it, and do not try " +
  "another verb that does the same thing. Tell them what you were about to do and ask " +
  "what they would like instead.";

/**
 * How the screen is introduced on a user turn, and the seam pruning cuts at.
 *
 * A marker rather than a guess at where the person's prose ends. Pruning has
 * to remove exactly what this file added and nothing anybody typed, and
 * looking for a line this file wrote is the only way to be sure of that.
 */
const SCREEN_MARK = "\n\nOn screen now:\n";

/**
 * What an older user turn's screen is replaced with.
 *
 * Replaced, not deleted. A user turn that simply has no screen reads as a turn
 * where the screen was empty, and "there were no contacts a moment ago" is a
 * worse thing for a model to believe than "there was a screen there and you
 * are not being shown it any more".
 */
const STALE_NOTE =
  "\n\n(the screen as it was at this point is no longer shown; only the newest screen " +
  "in this conversation is current)";

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
 * Keep the screen on the newest user turn only.
 *
 * Every user turn carries the screen as it was when the person spoke, which is
 * right at the time and wrong five turns later. Two costs, and the second is
 * the one that matters: the old blocks are bytes in the uncached half, paid for
 * on every turn forever; and a model that reads a screen from four messages
 * ago as current will act on rows that have moved. The second is a correctness
 * problem wearing a cost problem's clothes.
 *
 * Tool turns are left alone, and that is deliberate rather than an oversight.
 * Each one carries the authoritative post-call screen, which is how the model
 * knows what its own verbs did; pruning those would take away the record of
 * the run. The honest remaining limit, stated rather than quietly handled: in
 * a conversation carried across many runs, the tool turns from EARLIER runs
 * still carry their screens, and deciding how far back those stay useful is a
 * judgement this function is not the right place to make.
 */
export function pruneScreens(messages: Turn[]): Turn[] {
  let newest = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      newest = i;
      break;
    }
  }

  return messages.map((turn, i) => {
    if (turn.role !== "user" || i === newest) return turn;
    const at = turn.text.indexOf(SCREEN_MARK);
    return at === -1 ? turn : { role: "user", text: turn.text.slice(0, at) + STALE_NOTE };
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
 * out.stop; // "answered" | "max-steps" | "aborted" | "stuck" | "silent"
 * ```
 */
export async function drive(driver: Driver, options: DriveOptions): Promise<DriveOutcome> {
  const manifest = driver.manifest();

  // The static half. Computed here, used unchanged on every turn below. See
  // decision 1 in the file comment, and `the system prompt is byte-identical
  // across turns` in the tests, which asserts it rather than trusting it.
  const system = systemPrompt(manifest, options.instructions);
  const tools = toolsFor(manifest);

  const verbs = new Map<string, Manifest["verbs"][number]>(
    manifest.verbs.map((v) => [v.name, v]),
  );

  const maxSteps = options.maxSteps ?? 12;
  const refusalLimit = options.refusalLimit ?? 3;
  const signal = options.signal;

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

  // After the new turn is in, so "newest" means newest including it, and so a
  // run continuing a history that already ends in a user turn keeps that
  // turn's screen. Done once rather than per turn, which also means the
  // `messages` handed back are already pruned and a conversation carried
  // across many runs does not re-accumulate what this just removed.
  //
  // Lossy on purpose, and worth stating: a caller that wanted a verbatim
  // transcript of what the model was shown does not get one from here. The
  // alternative is paying for every screen the conversation ever had, on every
  // turn, so that nothing is lost — and nobody reads those bytes.
  messages = pruneScreens(messages);

  let steps = 0;
  let text: string | undefined;
  let stop: StopReason = "max-steps";

  for (;;) {
    if (signal?.aborted) {
      stop = "aborted";
      break;
    }
    if (steps >= maxSteps) {
      stop = "max-steps";
      break;
    }

    steps++;
    options.onStep?.({ step: steps });

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
      const kindField = kind === undefined ? {} : { kind };
      options.onCall?.({ step: steps, call, ...kindField });

      const outcome = await runOne(driver, call, verb, options);

      options.onResult?.({
        step: steps,
        call,
        ...kindField,
        result: outcome.result,
        text: outcome.text,
      });

      let body = outcome.text;

      if (outcome.result && !outcome.result.ok) {
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

      messages.push({ role: "tool", callId: call.id, name: call.name, text: body });
      if (stuck) {
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
    if (stuck) {
      stop = "stuck";
      break;
    }
  }

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
 * One tool call: resolve it, maybe gate it, run it, render it.
 *
 * `result` is null when nothing was called on the driver — `read_screen`, or a
 * name the manifest does not have. A caller's `onResult` uses that to tell "a
 * verb ran" from "the model looked" when drawing its trace.
 */
async function runOne(
  driver: Driver,
  call: ToolCall,
  verb: Manifest["verbs"][number] | undefined,
  options: DriveOptions,
): Promise<{ result: Result | null; text: string }> {
  if (call.name === READ_SCREEN && verb === undefined) {
    // `verb === undefined` so an app that genuinely declares a verb by this
    // name keeps it. The app's meaning wins over ours, the same way it does
    // for the hoisted `rev`.
    return { result: null, text: renderSnapshot(driver.snapshot()) };
  }

  if (verb === undefined) {
    // Named, not counted. A model asked for a tool that does not exist, and
    // listing the real names is how the fix happens on the next turn rather
    // than after another read — the same reason the core lists them on
    // `unknown-verb`.
    const known = [...driver.manifest().verbs.map((v) => v.name), READ_SCREEN].sort().join(", ");
    return { result: null, text: `no such tool \`${call.name}\`. available: ${known}` };
  }

  // `rev` is ours unless the verb claimed the name, in which case it is an
  // ordinary argument and goes through untouched. Mirrors the MCP server.
  const args: Record<string, Scalar> = { ...call.args };
  let rev: number | undefined;
  if (!(verb.args && "rev" in verb.args)) {
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
      return { result, text: renderResult(result) };
    }
    rev = hoisted;
  }

  if (verb.kind === "commit" && options.onBeforeCommit) {
    const snapshot = driver.snapshot();
    let decision: CommitDecision;
    try {
      decision = await options.onBeforeCommit({ name: verb.name, args, verb, snapshot });
    } catch (err) {
      // A host's confirmation UI throwing must not take the run down, and it
      // must not be read as consent either. A failed ask is a no.
      decision = `the confirmation could not be shown (${
        err instanceof Error ? err.message : String(err)
      })`;
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
      return { result, text: renderResult(result) };
    }
  }

  const result = await driver.call(verb.name, args, rev === undefined ? {} : { rev });
  return { result, text: renderResult(result) };
}
