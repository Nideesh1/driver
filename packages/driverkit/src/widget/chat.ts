/**
 * Surviving a page reload: restore everything, resume nothing.
 *
 * Today a reload destroys the drive loop, the transcript, and everything the
 * agent knows. Settings and the panel's position are remembered — see
 * `settings.ts` and `position.ts` — and the conversation, which is the only
 * thing in the panel anybody would miss, was not.
 *
 * **THE RULE, AND WHY IT IS NOT "RESUME WHERE WE LEFT OFF".** A page can die
 * mid-commit. Five steps in, `accept-selected` in flight on 3,412 rows, the tab
 * reloads. Storage can record that the call was STARTED. It cannot record
 * whether it LANDED — that answer is on the server, and the page that was
 * waiting for it is gone. A run that auto-resumed would either repeat a commit
 * that already happened or skip one that did not, and those two are precisely
 * what the plan token was built to prevent. So on return the transcript is
 * there, and the panel says plainly that a call was in flight and may or may
 * not have landed, naming the verb, before anything else happens.
 *
 * **WHAT IS PERSISTED: THE MODEL TURNS, AND THE RENDERED LINES ARE REBUILT FROM
 * THEM.** Those were the two candidates and only one of them is a conversation.
 * Persisting the rendered lines is cheaper and gives the person their history
 * back — and leaves the model with amnesia, so the panel reads "I accepted
 * 1,000 contacts" above an input box where "undo that" is unanswerable. That is
 * a worse lie than an empty panel, because it looks like it worked. Persisting
 * the turns gives both: the conversation continues coherently AND a readable
 * transcript can be drawn from it, out of one source of truth. Two stored
 * copies of one conversation is two things that come to disagree, which is the
 * same argument the core makes for building an `AuditEvent` off the `Result`
 * rather than from a second look at the app.
 *
 * Note what "resume nothing" does and does not mean. The run does not restart:
 * no step is retried, no verb is called, nothing happens until the person types
 * something. The CONVERSATION is continuous, which is the point of keeping it.
 *
 * **WHERE IT GOES: `sessionStorage`, NOT `localStorage`, AND THE SCOPE IS THE
 * PRIVACY ANSWER AS WELL AS THE CORRECTNESS ONE.** A transcript holds the
 * person's instructions and the model's prose about their records. That is a
 * different privacy class from a remembered pane position, on a machine that
 * may be shared, and `localStorage` would keep it until somebody cleared site
 * data. `sessionStorage` is per TAB, survives a reload, and is discarded when
 * the tab closes — so the conversation lives exactly as long as the sitting it
 * was had in. It also settles scoping for free, which `localStorage` could not:
 * two tabs of one app are two conversations and must not stomp each other, and
 * a per-tab key in `localStorage` would need a tab id and would leave a key
 * behind for every tab ever opened, which nothing can sweep up because
 * `StorageLike` cannot enumerate. Per tab, dying with the tab, no garbage. The
 * budget goes the other way for the opposite reason; see `budget.ts`.
 *
 * **AND IT IS OPT-IN.** `WidgetOptions.rememberChat` defaults off. A library
 * must not start writing its users' business prose to disk because somebody
 * upgraded, and "an app that opts into nothing behaves identically" is a rule
 * this is not worth breaking. Once an app has opted in, the VIEWER's switch —
 * `Settings.rememberChat`, beside the others — defaults on and turning it off
 * forgets what is already stored. The app's `false` wins: an app handling
 * records that must not be written down can say so, and no viewer can undo it.
 */

import type { Manifest, Scalar } from "../core/index.ts";
import { ASK, REDACTED } from "../core/index.ts";
import type { ToolCall, Turn } from "../agent/types.ts";

import type { StorageLike } from "./dom.ts";

/**
 * The schema version, written into every record and checked on the way back.
 *
 * A stored conversation from an older widget is the normal case and not the
 * exceptional one — somebody has a tab open from before the deploy — and
 * `settings.ts` folds field by field for exactly that reason. A transcript
 * cannot be folded that way: a half-understood `Turn[]` handed to a model is a
 * 400 from the provider, not a default pace. So the version is a gate, and a
 * record that is not this version is dropped whole.
 */
export const CHAT_VERSION = 1;

/**
 * What the panel was doing when the page went away.
 *
 * `asked` and `sent` are the two states the restored panel must never confuse,
 * and they are different KINDS of fact, not degrees of one:
 *
 *   `asked` — a question was on screen and nobody had answered it. The core
 *             asks before it runs, so this one is KNOWABLE: the verb did not
 *             run and nothing moved. The panel can say so flatly.
 *   `sent`  — the call was past every gate and in flight. This one is NOT
 *             knowable from here, ever, and no amount of care in this file
 *             changes that. The answer was on the server.
 *
 * `verb` is the verb's name. Not its arguments: a name is a word out of the
 * app's own manifest and an argument is the person's data, and this record is
 * being written to disk for a sentence in a notice.
 */
export interface ChatInFlight {
  verb: string;
  phase: "asked" | "sent";
}

/** One stored conversation. */
export interface SavedChat {
  v: number;
  /** `MountOptions.app`, so a record found under a key this build no longer
   *  writes cannot be shown in the wrong app's panel. */
  app: string;
  /** `Date.now()` at the write, for the notice and for anybody debugging. */
  at: number;
  /** The conversation, scrubbed and trimmed. See `scrubTurns`. */
  messages: Turn[];
  /** Whether anything had been asked. Drives the launcher's dot, which is a
   *  different question from "is there a transcript". */
  conversed: boolean;
  /** What was in flight, when something was. See `ChatInFlight`. */
  inFlight?: ChatInFlight;
  /** How many leading turns `trimTurns` dropped for size. Present only when it
   *  dropped some, because the notice has to say so: a transcript that is
   *  quietly missing its beginning is one the person will read as complete. */
  trimmed?: number;
}

/**
 * How much stored conversation is enough.
 *
 * `sessionStorage` is about 5MB per origin and `setItem` THROWS on quota — and
 * the quota is shared with the app this panel is embedded in, which is the part
 * that makes a generous limit irresponsible rather than merely wasteful. A long
 * run must not break the app it is a guest in.
 *
 * 128KB is roughly a hundred steps of a pruned conversation, because
 * `pruneScreens` has already removed every screen but the newest: what is left
 * is an outcome line per call and the person's own words. It is a fortieth of
 * the origin's quota, so the panel cannot be the reason an app's own storage
 * write fails.
 */
export const CHAT_LIMIT_CHARS = 128 * 1024;

export function chatKey(app: string): string {
  return `driverkit:widget:chat:${app}`;
}

/** `sessionStorage`, if reaching for it does not throw — which it does when
 *  site data is blocked, before any read has been attempted. The twin of
 *  `defaultStorage()` in `position.ts`, pointing at the per-tab one. */
export function defaultSession(): StorageLike | undefined {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Replace the value of every argument the app declared `sensitive`.
 *
 * **This is the leak `ArgSpec.sensitive` was built to stop, in the one new
 * place it could reappear.** That field exists so a value never crosses the
 * `onAudit` boundary — "the boundary a record is most likely to leave the box
 * across" — and the core replaces it before the hook rather than asking the
 * host to. Persisting the raw model turns would write the same value to disk,
 * where it outlives the call, the run and the page, and it would do it under a
 * feature nobody would think to check. An app that declared an argument too
 * secret for its own logger did not thereby agree to have it in storage.
 *
 * Done HERE, at the one boundary, and not at the call sites that build turns —
 * which is the repo's standing rule about scrubbing and the reason this takes a
 * whole conversation rather than one argument. Every byte that reaches storage
 * goes through this function; there is nowhere else to forget it.
 *
 * `REDACTED` is the core's own marker, reused rather than reinvented, so a
 * restored turn says the same word an audit record says and neither can be
 * mistaken for a string the agent actually sent.
 *
 * **The consequence, stated rather than hidden:** a restored conversation hands
 * the model `[redacted]` where its own earlier argument was. That is correct —
 * the alternative is the leak — and it is honest, because the turn then says
 * out loud that the value is not being shown. A model that needs the value
 * again asks for it again, which is what should happen to a secret after a
 * reload.
 */
export function scrubTurns(turns: Turn[], manifest: Manifest): Turn[] {
  // Built once per save rather than looked up per argument. Empty for the
  // overwhelming majority of apps, in which case the loop below is a shallow
  // copy and the whole function is free.
  const secret = new Map<string, Set<string>>();
  for (const verb of manifest.verbs) {
    for (const [name, spec] of Object.entries(verb.args ?? {})) {
      if (spec.sensitive !== true) continue;
      let fields = secret.get(verb.name);
      if (!fields) secret.set(verb.name, (fields = new Set()));
      fields.add(name);
    }
  }
  if (secret.size === 0) return turns;

  return turns.map((turn) => {
    if (turn.role !== "assistant" || !turn.calls) return turn;
    return {
      ...turn,
      calls: turn.calls.map((call): ToolCall => {
        const fields = secret.get(call.name);
        if (!fields) return call;
        const args: Record<string, Scalar> = {};
        for (const [key, value] of Object.entries(call.args)) {
          args[key] = fields.has(key) ? REDACTED : value;
        }
        return { ...call, args };
      }),
    };
  });
}

/**
 * Drop leading turns until the rest fits, cutting only at a safe seam.
 *
 * **The seam is the whole of this function and the reason it is not a `slice`.**
 * Every tool-use API rejects a conversation in which a `tool_use` block has no
 * matching result — `abandoned` in `loop.ts` exists for that one fact, and says
 * what it costs: "one missing tool turn is a dead panel", forever, with nothing
 * on screen to explain it. So trimming must never leave a tool turn whose
 * assistant turn is gone, nor an assistant turn whose results are gone.
 *
 * A `user` turn is the only index where that is provable without reasoning
 * about pairs: the loop answers every call of an assistant turn before it asks
 * the model again, and a person speaks between runs. So the remainder is cut to
 * begin at a user turn, and if no user boundary is small enough, NOTHING is
 * stored and the caller says so. Storing a conversation that cannot be used is
 * worse than storing none: the first breaks the panel permanently and the
 * second loses a transcript.
 *
 * Returns the number dropped so the notice can admit it. A transcript quietly
 * missing its beginning is one somebody will read as complete.
 */
export function trimTurns(
  turns: Turn[],
  limitChars: number = CHAT_LIMIT_CHARS,
): { messages: Turn[]; trimmed: number } {
  if (JSON.stringify(turns).length <= limitChars) return { messages: turns, trimmed: 0 };

  for (let i = 1; i < turns.length; i++) {
    if (turns[i]!.role !== "user") continue;
    const rest = turns.slice(i);
    if (JSON.stringify(rest).length <= limitChars) return { messages: rest, trimmed: i };
  }
  // No boundary fits: one enormous exchange, or one screen bigger than the
  // whole limit. Nothing is kept, and `trimmed` says how much that was.
  return { messages: [], trimmed: turns.length };
}

/**
 * Answer every tool call left dangling, so the restored history is usable.
 *
 * **This is the correctness bug a reload creates and the single most
 * load-bearing function in the file.** A page that dies mid-call leaves an
 * assistant turn whose `tool_use` has no result. Handed back as `history` that
 * is a 400 from the provider on the person's very next message, and on every
 * message after it, with an apparently fine transcript on screen. The panel
 * would come back looking restored and be permanently broken.
 *
 * So each dangling call gets an answer, and the answer is written for the model
 * rather than for the protocol — the same judgement `abandoned` makes. What it
 * must never say is anything that reads as a step to retry, and what it must
 * never do is guess:
 *
 *   `sent`  — the outcome is UNKNOWN. This is the sentence the whole feature
 *             turns on, and it is deliberately the wording `render.py` uses for
 *             a relay `timeout`, because it is the same fact: the call was
 *             accepted, nobody heard back, and a commit may already have run.
 *             The natural reflex — treat a non-answer as a failure and retry
 *             it — is the one move that turns one bulk accept into two.
 *   `asked` — KNOWN not to have run, because the core asks before it runs.
 *             Said flatly, because an agent told "unknown" about a commit that
 *             provably did not happen will go and check for nothing, and may
 *             decide not to do the thing the person asked for.
 *
 * Only the call the record named gets the `asked` wording. Any other dangling
 * call is unknown, which is the safe direction and also the true one.
 */
export function closeDangling(turns: Turn[], inFlight?: ChatInFlight): Turn[] {
  const answered = new Set<string>();
  for (const turn of turns) {
    if (turn.role === "tool") answered.add(turn.callId);
  }

  const out: Turn[] = [];
  for (const turn of turns) {
    out.push(turn);
    if (turn.role !== "assistant" || !turn.calls) continue;
    for (const call of turn.calls) {
      if (answered.has(call.id)) continue;
      const known = inFlight?.phase === "asked" && inFlight.verb === call.name;
      out.push({
        role: "tool",
        callId: call.id,
        name: call.name,
        text: known
          ? call.name === ASK
            ? // A QUESTION, not a confirmation, and the two must not share a
              // sentence. "The person was being asked to confirm this" is false
              // of a question in a way that matters: a model told its question
              // was a confirmation request may conclude the answer would have
              // been a yes, which is the one inference this channel exists to
              // make impossible. Nothing changed either way -- a question runs
              // no verb at all, which is a stronger claim than the one below.
              "not run: you were being asked this question and the page was reloaded before " +
              "anybody answered. No answer was recorded, nothing in the app changed, and no " +
              "verb ran. This is not an error and it is not a yes. Ask again if you still " +
              "need to know."
            : "not run: the person was being asked to confirm this and the page was reloaded " +
              "before they answered, so the verb did not run and nothing changed. This is not " +
              "an error. Ask them again if it is still what they want."
          : "the page was reloaded while this call was in flight, so no answer ever came back. " +
            "The outcome is UNKNOWN: it may well have run. DO NOT retry it. Read the screen " +
            "first and decide from what you see there, and say plainly that you cannot tell " +
            "whether it took effect.",
      });
    }
  }
  return out;
}

/**
 * What the panel says, in order, when a conversation comes back.
 *
 * Returned as lines rather than printed, so the words are testable without a
 * DOM and so there is one place they are written. The first line is always
 * about what may have happened to the data, because that is the thing a person
 * has to act on and everything else can wait behind it.
 *
 * The verb is NAMED. "A call was in flight" sends somebody to look at the whole
 * app; "`accept-selected` was in flight" sends them to one screen.
 */
export function restoredLines(record: SavedChat): string[] {
  const lines: string[] = [];

  if (record.inFlight?.phase === "sent") {
    lines.push(
      `The page reloaded while \`${record.inFlight.verb}\` was running. This panel cannot ` +
        `tell whether it took effect — that answer was on the server, and the page waiting ` +
        `for it is gone. Check the app before doing anything else.`,
    );
  } else if (record.inFlight?.phase === "asked" && record.inFlight.verb === ASK) {
    // A question, not a confirmation. "You were being asked to approve `ask`"
    // is a sentence about something that did not happen, and the person reading
    // it would go looking for the commit it named.
    lines.push(
      "The page reloaded while the agent was asking you a question. You never answered, so " +
        "it was not told anything and nothing in the app changed.",
    );
  } else if (record.inFlight?.phase === "asked") {
    lines.push(
      `The page reloaded while you were being asked to approve \`${record.inFlight.verb}\`. ` +
        `You never answered, so it did not run and nothing changed.`,
    );
  }

  lines.push(
    "This conversation is from before the reload. Nothing has been resumed: the run stopped " +
      "when the page went away and will not pick itself back up. Ask again to carry on.",
  );

  if (record.trimmed) {
    lines.push(
      `The first ${record.trimmed} message${record.trimmed === 1 ? "" : "s"} of this ` +
        `conversation were too large to keep and are not shown.`,
    );
  }

  return lines;
}

/**
 * One readable line per stored turn, for redrawing the transcript.
 *
 * Deliberately not a reconstruction of what the panel looked like. A tool turn
 * was a row in the step list with a state marker and a `title`; what comes back
 * is a plain line of text, because the step list is a live thing — it glows, it
 * marks a call as pending, it is about a run that is happening — and redrawing
 * it for a run that ended at a reload would be a panel claiming to be mid-step.
 * A restored transcript should read as a record, which is what it is.
 *
 * The screen blocks are dropped from what is DISPLAYED. They are still in the
 * stored turns, where the model needs the newest one; a wall of table on reload
 * is not what the person wants to see first.
 */
export function replayLines(record: SavedChat): Array<{ className: string; text: string }> {
  const out: Array<{ className: string; text: string }> = [];
  for (const turn of record.messages) {
    if (turn.role === "user") {
      out.push({ className: "dk-you", text: firstPart(turn.text) });
    } else if (turn.role === "assistant") {
      if (turn.text) out.push({ className: "dk-said", text: turn.text });
      for (const call of turn.calls ?? []) {
        out.push({ className: "dk-step dk-step-done", text: call.name });
      }
    }
    // Tool turns are not replayed as lines of their own. Their outcome already
    // reads as the step above it in a live run, and a separate line per result
    // would double the length of a restored transcript with text written for a
    // model rather than for a person.
  }
  return out;
}

/** Everything a turn's text says before the screen block `loop.ts` appends.
 *  The marker is that file's `SCREEN_MARK`, matched on its text rather than
 *  imported, because the widget must not start depending on the loop's seam to
 *  render a line. */
function firstPart(text: string): string {
  const at = text.indexOf("\n\nOn screen now:\n");
  return at === -1 ? text : text.slice(0, at);
}

/**
 * Read a stored conversation back, or null for every way that can fail.
 *
 * Validated field by field, and a failure is a `null` rather than a repair.
 * `settings.ts` folds a partial record over the defaults because a missing pace
 * is a readable record with a gap in it; a `Turn[]` with a gap in it is a
 * provider error on the person's next message. The two kinds of persisted state
 * want opposite treatment and this is the strict one.
 *
 * Every read is inside one try, like `loadJson`: a private window and blocked
 * site data throw on the way IN, before any value has been looked at.
 */
export function loadChat(
  session: StorageLike | undefined,
  app: string,
): SavedChat | null {
  try {
    const raw = session?.getItem(chatKey(app));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedChat> | null;
    if (!value || typeof value !== "object") return null;
    if (value.v !== CHAT_VERSION) return null;
    // The app is checked because one origin can serve two driverkit apps, and
    // a conversation about somebody's contacts does not belong in the admin
    // panel's transcript.
    if (value.app !== app) return null;
    if (!Array.isArray(value.messages) || !value.messages.every(isTurn)) return null;
    const inFlight = value.inFlight;
    return {
      v: CHAT_VERSION,
      app,
      at: typeof value.at === "number" ? value.at : 0,
      messages: value.messages,
      conversed: value.conversed === true,
      ...(inFlight &&
      typeof inFlight.verb === "string" &&
      (inFlight.phase === "asked" || inFlight.phase === "sent")
        ? { inFlight: { verb: inFlight.verb, phase: inFlight.phase } }
        : {}),
      ...(typeof value.trimmed === "number" && value.trimmed > 0
        ? { trimmed: value.trimmed }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Whether one stored value is a `Turn`. Shape only: it is about to be handed
 *  to a provider, and a turn with a missing `callId` is a 400 rather than a
 *  cosmetic gap. */
function isTurn(value: unknown): value is Turn {
  const turn = value as Partial<Turn> & { role?: unknown } | null;
  if (!turn || typeof turn !== "object") return false;
  if (turn.role === "user") return typeof (turn as { text?: unknown }).text === "string";
  if (turn.role === "assistant") {
    const t = turn as { text?: unknown; calls?: unknown };
    if (t.text !== undefined && typeof t.text !== "string") return false;
    if (t.calls === undefined) return true;
    return Array.isArray(t.calls) && t.calls.every(isCall);
  }
  if (turn.role === "tool") {
    const t = turn as { callId?: unknown; name?: unknown; text?: unknown };
    return typeof t.callId === "string" && typeof t.name === "string" && typeof t.text === "string";
  }
  return false;
}

function isCall(value: unknown): value is ToolCall {
  const call = value as { id?: unknown; name?: unknown; args?: unknown } | null;
  return (
    !!call &&
    typeof call === "object" &&
    typeof call.id === "string" &&
    typeof call.name === "string" &&
    !!call.args &&
    typeof call.args === "object"
  );
}

/**
 * Write a conversation, and swallow every reason it can fail.
 *
 * Swallowed, unlike `budget.ts`, and the asymmetry is the point. A budget that
 * cannot be written is an uncapped agent, so that one fails closed and stops
 * the agent. A transcript that cannot be written is a conversation somebody
 * will have to retype, which is not worth a thrown error — and a throw here
 * would be thrown INSIDE a drive run, out of an `onResult` handler, where it
 * would take down the run that is moving the person's screen. A storage write
 * must never break a drive run. See `saveJson`, which makes the same promise
 * for the panel's position and for the same reason.
 *
 * `trimmed: 0` is not written, so an ordinary record carries no field for it
 * and `loadChat` reading its absence as "nothing was dropped" is the same
 * sentence either way.
 */
export function saveChat(
  session: StorageLike | undefined,
  app: string,
  record: Omit<SavedChat, "v" | "app">,
): void {
  try {
    session?.setItem(
      chatKey(app),
      JSON.stringify({
        v: CHAT_VERSION,
        app,
        at: record.at,
        messages: record.messages,
        conversed: record.conversed,
        ...(record.inFlight === undefined ? {} : { inFlight: record.inFlight }),
        ...(record.trimmed ? { trimmed: record.trimmed } : {}),
      } satisfies SavedChat),
    );
  } catch {
    // A full quota, a private window, a viewer who blocked site data. The
    // conversation is still correct for this sitting; it just will not come
    // back after a reload, and that is not worth an exception thrown through a
    // run that is driving somebody's screen.
  }
}

/**
 * Forget the stored conversation.
 *
 * Written empty rather than removed, because `StorageLike` is two methods and
 * `removeItem` is not one of them — and `loadChat` reads an empty string as an
 * empty slot, which is what a removal would leave anyway.
 *
 * Called by "Clear conversation", and that call is load-bearing rather than
 * tidy. `era` in `widget.ts` exists so a dying run's writes cannot land in a
 * fresh transcript after a clear; a stored record is the same hazard with a
 * longer fuse — clear the panel, reload, and a cleared conversation comes back
 * from disk. The destructive option has to be destructive all the way down.
 */
export function forgetChat(session: StorageLike | undefined, app: string): void {
  try {
    session?.setItem(chatKey(app), "");
  } catch {
    // Nothing was stored, so nothing needs forgetting.
  }
}
