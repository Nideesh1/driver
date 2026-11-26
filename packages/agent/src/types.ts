/**
 * driverkit/agent — the contract with the model, and nothing else.
 *
 * This package contains **no model client and no API key handling**, and that
 * is the load-bearing decision rather than a scoping convenience. Three
 * reasons, in order of how much they cost to get wrong:
 *
 * 1. **A browser cannot hold an API key.** Anything shipped to a page is
 *    readable by whoever has the page, so a widget that takes an `apiKey`
 *    option is a widget that leaks one. The realistic deployment is that
 *    `think` does `fetch("/api/chat")` against the app's own backend, which
 *    already authenticates the person and already holds the key. That is the
 *    documented default story — see `backendThink` — and nothing in these
 *    types assumes a model is reachable from the page at all.
 *
 * 2. **Vendor neutrality has to be structural.** A `provider: "anthropic" |
 *    "openai"` option means this package grows a translation layer per vendor
 *    and a release per API change. A function pointer means it grows neither,
 *    and a local model, a proxy, a queue or a scripted fake all satisfy it.
 *
 * 3. **It is how the loop gets tested.** Every test in this package drives a
 *    real `mount()`ed driver with a scripted `think`. If the model were inside,
 *    the loop's hard parts — the refusal path, the commit gate, the bounds —
 *    would be verified by paying a vendor and hoping.
 *
 * The shapes below are deliberately the *intersection* of the tool-use APIs,
 * not the union: a system string, a flat message list, a tool list, and either
 * prose or calls coming back. Mapping that onto a vendor's wire format is
 * twenty lines in the caller and does not belong here.
 */

import type { Manifest, Result, Scalar, Snapshot, VerbKind } from "driverkit";

/**
 * One tool, as the model sees it.
 *
 * This is the MCP `tools/list` shape, down to the field names, because the
 * Python MCP server in this same repository emits exactly that and the two
 * halves of one library must not describe the same verbs differently. A model
 * driving an app from outside through MCP and a model driving it from inside
 * through this loop read the same sentences about the same verbs. See
 * `tools.ts`, and `python/src/driverkit/mcp_server.py` for the other end.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchema>;
    required: string[];
    additionalProperties: false;
  };
}

/** The sliver of JSON Schema a driverkit `ArgSpec` can produce. Hand-rolled to
 *  keep the zero-dependency promise the core makes. */
export interface JsonSchema {
  type: "string" | "number" | "boolean" | "integer";
  description: string;
  /** From `ArgSpec.oneOf`, which is JSON Schema's `enum` and emphatically not
   *  JSON Schema's `oneOf`: the names look alike and the meanings diverge, and
   *  emitting the latter produces a schema that validates anything. */
  enum?: Scalar[];
}

/** A verb the model wants run. `id` is the vendor's correlation id, passed
 *  straight back on the tool turn; this package never interprets it. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, Scalar>;
}

/**
 * One message. A flat list of these, in order, is the uncached half.
 *
 * Three roles rather than a vendor's content-block union: it is the least that
 * can express a tool-use loop, and widening it would mean this package taking
 * a position on image blocks, thinking blocks and citations, each of which is
 * spelled differently by every vendor and needed by none of this.
 */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; calls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; text: string };

/**
 * What `think` is handed.
 *
 * The split in here is the whole cost argument, restated as a function
 * signature: `system` and `tools` are the static half and are **byte-identical
 * on every call within a run**, so a caller can hand them to a provider with
 * caching turned on and pay for them once. `messages` is the growing tail.
 *
 * A caller that folds anything per-turn into `system` — a timestamp, the
 * current screen, a step counter — busts the prefix cache on every turn and
 * the loop stops being cheap. `drive` computes `system` once, before the loop,
 * from the manifest alone, which is the only way to make that structural
 * rather than a rule in a comment. There is a test that asserts it.
 */
export interface ThinkInput {
  /** Static for the whole run. Cache it. */
  system: string;
  /** Static for the whole run. Cache it. */
  tools: ToolSpec[];
  /** The tail: the person's message, the model's own turns, and one tool turn
   *  per verb that ran, each carrying the screen as it was after it ran. */
  messages: Turn[];
  /** The run's cancellation, forwarded so a `fetch` can be torn down mid
   *  flight. A `think` that ignores it still works; `drive` checks it again on
   *  the way out and will not run a verb for an aborted run. */
  signal?: AbortSignal;
}

/**
 * What `think` returns.
 *
 * No `calls` (or an empty list) means the model answered, and the run ends
 * with `text` as the answer. That is the only stop condition the model
 * controls, and it is the same convention every tool-use API already uses, so
 * an adapter is a field rename rather than a state machine.
 */
export interface ThinkResult {
  text?: string;
  calls?: ToolCall[];
}

export type Think = (input: ThinkInput) => Promise<ThinkResult>;

/** Why the run ended. Returned rather than thrown: `max-steps` and `stuck` are
 *  ordinary outcomes a UI has to render, and an exception would push every
 *  caller into a try/catch that treats a bounded run as a failure. */
export type StopReason =
  /** The model answered in prose. The only ending the model chooses. */
  | "answered"
  /** `maxSteps` was reached with the model still calling verbs. */
  | "max-steps"
  /** The `AbortSignal` fired. */
  | "aborted"
  /** The same verb was refused the same way `refusalLimit` times. */
  | "stuck"
  /** `think` returned neither prose nor calls. A broken adapter, usually. */
  | "silent";

/** Handed to `onBeforeCommit`. Carries the manifest's `kind` and `refuses` so
 *  a host app can word its own confirmation using the app's own vocabulary
 *  rather than re-deriving it from the verb name. */
export interface CommitRequest {
  name: string;
  args: Record<string, Scalar>;
  verb: Manifest["verbs"][number];
  /** The screen as it is right now, so a confirmation can show the selection
   *  the commit is about to act on. */
  snapshot: Snapshot;
}

/**
 * `true` (or nothing) lets the commit run. `false` vetoes it. A string vetoes
 * it and becomes the hint the model is told.
 *
 * The veto reaches the model as an ordinary refusal — the `declined-by-user`
 * slug — and never as an exception. A thrown veto would abort the run and the
 * model would never learn why, so the next thing the person saw would be a
 * dead panel instead of "you declined that; want me to narrow it first?".
 */
export type CommitDecision = boolean | string | void;

/**
 * What the run controls are asking for right now.
 *
 * Two states and not three: there is no "stopped". A stop is the `AbortSignal`,
 * which ends the run rather than changing how it is being driven, and folding
 * the two together would invite a `state === "stopped"` check that a paused run
 * could never recover from.
 */
export type ControlState = "running" | "paused";

/**
 * What a UI should say the run is doing.
 *
 * The control states plus the one wait the controls do not own: a run sitting
 * in front of `onBeforeCommit` is not paused and is not running either, it is
 * waiting for a person to answer, and a panel that showed "running" there would
 * be telling the person to wait for the thing that is waiting for them.
 */
export type RunState = ControlState | "awaiting-approval";

/**
 * Pause, resume and step, as a plain object. Built by `runControls`.
 *
 * Passed into `drive` rather than returned from it, because `drive`'s promise
 * settles when the run is over and a handle you can only hold afterwards is a
 * handle you cannot pause with. See `runControls` for the rest of that
 * argument.
 */
export interface RunControls {
  /** `"paused"` means the run will hold before its next call. The call in
   *  flight, if any, still finishes: a pause is a gate between calls and never
   *  an interruption inside one. */
  readonly state: ControlState;
  /** Outstanding `step()` permits. For a UI that wants to show that a step has
   *  been asked for and not yet spent. */
  readonly permits: number;
  /** Hold before the next call. The call in flight finishes first. */
  pause(): void;
  /** Carry on. Drops any unspent `step()` permit, since running is the stronger
   *  statement. */
  resume(): void;
  /** Run exactly one more call, then hold again. Valid from either state. */
  step(): void;
  /**
   * The delay before each call, in milliseconds, right now.
   *
   * Readable so a slider can render the run's real pace rather than its own
   * last write — which are different numbers the moment anything else sets it,
   * and the second one is the one a person would call a bug.
   */
  readonly paceMs: number;
  /**
   * Change the pace of the run **in flight**: from the next wait onwards, and
   * including the wait already running.
   *
   * Live because the moment a person wants the agent slowed down is while it is
   * going. A slider that quietly applied next run would be worse than no
   * slider: they move it, nothing happens, and they conclude it is broken.
   *
   * 0 means the next wait does not happen at all. Values that are not a claim
   * about a speed — `NaN`, `Infinity`, anything non-finite — are **ignored**,
   * and the current pace is kept: reading them as 0 would make the agent faster
   * than the person asked for, and reading `Infinity` as a delay would park the
   * run on a timer nobody meant to set. A negative is clamped to 0, since "less
   * than no wait" has only one sensible meaning.
   */
  pace(ms: number): void;
  /**
   * Be told when any of the above changes, for a UI that has to stay in step
   * with controls it is not the only owner of. Returns an unsubscribe.
   *
   * Fires on a real change to `state`, `permits` or `paceMs`, and on nothing
   * else. The listener is handed no arguments and reads whichever getter it
   * cares about, so this cannot grow a snapshot shape that drifts from the
   * object it describes.
   *
   * `onControl` already reports state during a run; this covers what that
   * cannot, which is a `step()` or a pace change made **between** runs, when
   * there is no loop to report anything. `drive` subscribes as well, which is
   * how a pace change reaches a wait that has already started.
   */
  subscribe(listener: () => void): () => void;
  /**
   * Block until the run may proceed. **`drive` calls this; a caller does not.**
   *
   * On the public interface because the waiting and the state have to live
   * together — a gate that polled a `state` getter would either spin or add a
   * latency of its own — and because a host with an exotic control surface (a
   * queue, a remote operator, a test) can implement this interface itself and
   * `drive` will drive it.
   *
   * `what` distinguishes a model round trip from a verb call: only a call spends
   * a `step()` permit. Resolves immediately, without holding, if `signal` is
   * already aborted or fires while parked — an abort outranks a pause, always.
   */
  gate(what: "think" | "call", signal?: AbortSignal): Promise<void>;
}

/**
 * The timer `pace` uses. Injectable so the suite does not actually sleep.
 *
 * Deliberately smaller than `setTimeout`: no arguments forwarded, no return
 * type promised. `unknown` for the handle because the real one is a `number` in
 * a browser and a `Timeout` object in Node, and a package that named either
 * would stop compiling in the other.
 */
export interface Clock {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  /**
   * Milliseconds since some fixed point. Defaults to `Date.now`.
   *
   * Here because a pace that can change mid-wait has to know how much of the
   * wait has already elapsed, and a suite that could inject the timer but not
   * the clock would have to sleep to test it.
   */
  now?(): number;
}

/** The common shape of the three per-call events. Shared so a widget can write
 *  one function that renders a row and call it from all three. */
export interface CallEvent {
  step: number;
  call: ToolCall;
  /** From the manifest, and undefined when the app declared none — this package
   *  does not manufacture a safety claim the app did not make, in either
   *  direction. */
  kind?: VerbKind;
  /**
   * The verb's `at` selector, if the app declared one: a hint about which
   * element on the page this call is about, so a UI can outline it.
   *
   * Passed straight through from the manifest and used by nothing in here.
   * driverkit does not resolve selectors — see `Verb.at` in the core, which
   * says why that is a promise and not an omission. A UI is free to query it; a
   * UI is the only thing that should.
   */
  at?: string;
  /** Position within this turn's calls, 0-based. A model may ask for several
   *  verbs in one turn, and a step list that showed them without their order
   *  would be hiding the one thing the person needs: what ran before what. */
  index: number;
  /** How many calls this turn asked for. */
  of: number;
}

export interface DriveEvents {
  /** About to spend a model round trip. `step` is 1-based. */
  onStep?: (e: { step: number }) => void;
  /** The model said something in prose, mid-run or as its answer. */
  onSay?: (e: { step: number; text: string }) => void;
  /**
   * A call is going to be attempted — fired **before** the pace wait and before
   * any pause gate, so a row for it can be on screen and glowing while the
   * person still has time to stop it. This is the event a pending step list is
   * built from; `onCall` then means "running" and `onResult` means "done".
   *
   * It is not a promise that the call will run. A stop pressed during the pace
   * wait, or while the run is held, abandons it unrun — `onStop` fires with
   * `aborted` and anything still pending should be settled from there, since no
   * `onResult` is coming for a call that never happened.
   */
  onBeforeCall?: (e: CallEvent) => void;
  /** A verb is about to run, after any pacing and any hold: the last event
   *  before the app is touched. Pre-dates `onBeforeCall` and keeps its exact
   *  meaning and timing — with no pacing and no controls the two fire back to
   *  back, which is what an existing caller already sees. */
  onCall?: (e: CallEvent) => void;
  /** A verb ran. `result` is null for the one tool that is not a verb
   *  (`read_screen`) and for a call to a name the manifest does not have. */
  onResult?: (
    e: CallEvent & {
      result: Result | null;
      /** What the model was told, verbatim. A UI showing this shows exactly
       *  what the model is reasoning from, which is the honest thing to show. */
      text: string;
    },
  ) => void;
  /**
   * The run's control state changed. Fires once at the start of the run with
   * the initial state, then on every transition.
   *
   * There at all because the state has more than one owner. The caller moves it
   * with `pause`/`step`/`resume`, but `drive` moves it too — a step permit
   * spent leaves the run paused again, and the commit gate parks it in
   * `awaiting-approval` — and a UI that tracked it by watching its own buttons
   * would be wrong in exactly the cases that matter. One event, from the thing
   * that knows.
   *
   * `step` is the model turn in flight, and 0 for the opening event, before any
   * turn has been spent.
   */
  onControl?: (e: { step: number; state: RunState }) => void;
  /** The run ended, for any reason including abort. Always fires once. */
  onStop?: (e: { stop: StopReason; steps: number; text?: string }) => void;
}

export interface DriveOptions extends DriveEvents {
  think: Think;
  /** What the person asked for. Appended as the newest user turn, together
   *  with the current screen. Omit it to continue a `history` that already
   *  ends in a user turn. */
  task?: string;
  /** Earlier turns, as returned by a previous `drive`. The loop keeps no state
   *  between runs: a conversation is the caller's array, which is what lets a
   *  widget hold one and a server hold another without this package owning a
   *  session concept. */
  history?: Turn[];
  /**
   * Extra guidance from THIS HOST, folded into the system prompt after the
   * app's own `Manifest.instructions`.
   *
   * Static, like everything else in there. A per-user or per-screen string
   * here is the one mistake that makes the whole prefix uncacheable **across
   * users**, which is where most of the saving actually lives.
   *
   * What belongs here is what this embedding wants said and the app itself
   * would not say — a house tone, a rule about this deployment. What the APP
   * has to say about itself belongs in `MountOptions.instructions`, which
   * reaches an agent arriving over the relay as well as this one; a briefing
   * put here is visible to one of driverkit's two paths and not the other,
   * which is the gap that field exists to close.
   */
  instructions?: string;
  /**
   * Hard cap on model round trips. Default 12.
   *
   * There is a cap at all because an agent that loops forever inside somebody
   * else's web page is the thing that gets the library uninstalled. 12 is
   * enough for read → describe → check the count → commit → answer with room
   * to recover from two refusals, and small enough that a confused model costs
   * cents rather than a tab that is still spending at lunchtime.
   */
  maxSteps?: number;
  /**
   * Stop after this many identical refusals. Default 3.
   *
   * Identical means the same verb refused with the same slug. Counted across
   * the run and not merely consecutively: a model that alternates a refused
   * commit with a free read has not learned anything, it has just put a cheap
   * call between two expensive mistakes.
   */
  refusalLimit?: number;
  /** Cancel the run. Checked before every model call and before every verb,
   *  and it outranks a pause: a held run is still abortable, never wedged. */
  signal?: AbortSignal;
  /**
   * Milliseconds to wait before each call the model asked for — a verb or a
   * `read_screen` — so a person can follow. **0 by default, which means no
   * waiting at all.**
   *
   * Two defaults, on purpose, and the split is the same one `onBeforeCommit`
   * makes. `drive` is a library primitive: it is driven by backend jobs, tests,
   * CLIs and servers, where nobody is watching and a delay per call is latency
   * charged to work with no eyes on it. So the default here is 0. `mountWidget`
   * defaults it to `WATCHABLE_PACE`, because a panel in a page has a person in
   * front of it by definition, and the whole reason the widget exists is that
   * the person should be able to see what is being done to their screen and
   * stop it. A library that invented 600ms of latency for a cron job to make a
   * UI it cannot see feel better would have the defaults the wrong way round.
   *
   * The wait is before every call including the first, which is the one the
   * person has had least chance to react to. It is cancellable: a stop during a
   * pace wait returns at once rather than after the wait.
   *
   * It is not a wait per model turn. Those are already slow and already
   * visible, and pacing them would double the latency of the part that costs
   * money without making anything more legible.
   */
  pace?: number;
  /**
   * Pause, resume and step. Build one with `runControls()`.
   *
   * Absent means a run that cannot be held, which is the right default for a
   * caller with no UI: an unattended run with nobody to resume it would park
   * forever on the first hold.
   */
  controls?: RunControls;
  /** The timer `pace` uses. Defaults to `setTimeout`. Injectable so a suite can
   *  assert the waits without sleeping through them. */
  clock?: Clock;
  /**
   * Opt-in gate in front of every `commit` verb.
   *
   * Off by default **here, and only here**. `drive` is a library primitive: it
   * is driven by a widget, a backend job, a test, a CLI, and a caller that has
   * its own approval policy should not have to disable one it never asked for.
   *
   * It is a different judgement one level up. `mountWidget` defaults this ON,
   * because a person watching a chatbot move their own screen should not learn
   * about a thousand accepted rows afterwards — and the gate is cheap there
   * for a reason worth stating: a `commit` verb takes no predicate and acts on
   * the whole current selection, so accepting a thousand rows is ONE call and
   * therefore one question, not a thousand. That makes it the cheapest
   * possible place to put a human in front of the expensive failure.
   *
   * A veto reaches the model as a `declined-by-user` refusal — see `DECLINED`
   * and PROTOCOL.md's reserved list — so the model adapts instead of retrying.
   */
  onBeforeCommit?: (req: CommitRequest) => CommitDecision | Promise<CommitDecision>;
}

export interface DriveOutcome {
  stop: StopReason;
  /** The model's last prose. The thing to show the person.
   *
   *  Present for `answered`; also present for the other endings when the model
   *  happened to narrate before it was cut off, because half an explanation is
   *  better than a bare "stopped". */
  text?: string;
  /** Model round trips spent. */
  steps: number;
  /** `history` plus everything this run added. Pass it back as the next run's
   *  `history` to continue the conversation.
   *
   *  Not a verbatim transcript: every turn but the newest one carrying a screen
   *  has had its screen block replaced — the person's turns and the tool turns
   *  alike — so that a model is never shown two screens and left to work out
   *  which one is now true, and so that a ten-step run is not ten screens long.
   *  A tool turn keeps its outcome line either way, and no turn is ever dropped
   *  or re-paired: every `tool_use` in here still has its result. See
   *  `pruneScreens`. */
  messages: Turn[];
}
