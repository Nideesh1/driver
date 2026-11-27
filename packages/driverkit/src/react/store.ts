/**
 * The React panel's state, with no React in it.
 *
 * WHY THE STATE IS NOT IN REACT. Everything the panel knows — the transcript,
 * the step list, the run's control state, the approval state machine — lives in
 * a plain object with `subscribe`/`getSnapshot`, and the React layer is a
 * `useSyncExternalStore` call over it. Three reasons, in the order they
 * mattered while writing it:
 *
 *   1. **It is the half that has to be tested, and this repository has no
 *      React.** The published package depends on nothing and there is no
 *      network install here, so a state machine expressed as `useReducer`
 *      plus eight `useEffect`s would be a state machine nothing in the suite
 *      could drive. The approval receipt — the one behaviour this area exists
 *      to get right — is asserted in `test/react.test.ts` against this file,
 *      with no renderer involved.
 *
 *   2. **`drive` is not a React citizen.** It is an async loop that fires
 *      callbacks from inside awaits, and callbacks that land after an unmount
 *      or after a Clear are the normal case rather than the exception. A store
 *      can be written once to be correct about that — see `era` — where a
 *      component tree would have to be correct about it at every subscription
 *      point.
 *
 *   3. **It is what makes the components replaceable.** A host with a design
 *      system wants our behaviour and its own markup. If the behaviour is in
 *      the components, "restyle it" means "fork it". Here a host can take
 *      `useDriver()` and render none of our components at all, and nothing
 *      about the gate, the pacing or the receipt changes.
 *
 * The parts of the vanilla widget's reasoning that still apply are applied
 * here and marked; the ones that do not are listed in `REACT.md` with why.
 */

import { commas, drive, runControls } from "../agent/index.ts";
import type {
  CallEvent,
  Clock,
  CommitDecision,
  CommitRequest,
  DriveOptions,
  RunControls,
  RunControlsOptions,
  RunState,
  StopReason,
  Turn,
} from "../agent/index.ts";
import type {
  Approval,
  ApprovalRequest,
  BudgetState,
  Driver,
  Scalar,
  Snapshot,
  VerbKind,
} from "../core/index.ts";

/**
 * The selection size past which a commit is confirmed even though the app
 * called it reversible.
 *
 * **Deliberately the same number as `COMMIT_ASK_ABOVE` in
 * `src/widget/widget.ts`, and deliberately not imported from it.** Importing it
 * would make this area's module graph include the vanilla widget's, and
 * therefore its hand-written DOM, its stylesheet, its drag positioner and its
 * `localStorage` access — in a React app's bundle, to read one integer. The
 * whole promise of this entry point is that the two panels are independent, and
 * a constant is not worth breaking it for.
 *
 * Two copies of a number drift, so the drift is a test failure rather than a
 * hope: `test/react.test.ts` pins that these two agree. The reasoning behind
 * the value — why a screenful rather than the thousands where an app's undo
 * actually stops being credible — is written once, over there, and is not
 * restated here so that there is still only one place it can be argued with.
 */
export const COMMIT_ASK_ABOVE = 25;

/** How the panel gets a control surface. `runControls` by default; an interface
 *  rather than only a factory, exactly as the agent area says. */
export type RunControlsFactory = (options: RunControlsOptions) => RunControls;

export type StepStatus = "pending" | "running" | "done" | "refused" | "skipped";

/**
 * Where an approval has got to. **One entry moves through these; it is never
 * replaced and never removed.**
 *
 * This is the behaviour the area exists for, so it is worth saying what the
 * states are for rather than only what they are. A gate whose card disappears
 * when you answer it leaves a transcript in which the question and its answer
 * are two unrelated lines, and scrollback is the only place an auditor can
 * stand. So the card becomes its own receipt, in place, and the phases are the
 * phases a reader of that receipt needs distinguished:
 *
 *   `asking`          the buttons are live and nothing has happened.
 *   `allowed`         a person said yes and the verb is now running. Also the
 *                     resting state for a commit that arrived from outside a
 *                     run, where there is no result event to wait for and
 *                     claiming "finished" would be making it up.
 *   `allowed-ok`      the verb ran and the app said ok.
 *   `allowed-refused` the verb ran and **the app refused it anyway**. A
 *                     separate phase because "you approved this" and "this
 *                     happened" are different facts and a receipt that only
 *                     recorded the first would be the more flattering of the
 *                     two. A stale rev, a spent budget and a plan token that
 *                     no longer matches all land here.
 *   `denied`          a person said no.
 *   `stopped`         the run was stopped before the verb ran. Not a denial:
 *                     nobody refused it.
 *   `lapsed`          the panel went away with the question still open, so
 *                     nobody answered. Distinct from `denied` for the same
 *                     reason the core keeps `timed-out` apart from `declined`.
 */
export type ApprovalPhase =
  | "asking"
  | "allowed"
  | "allowed-ok"
  | "allowed-refused"
  | "denied"
  | "stopped"
  | "lapsed";

/** Something said: by the person, by the model, or by the panel about itself. */
export interface SaidEntry {
  kind: "you" | "assistant" | "note";
  id: string;
  text: string;
}

/** One call, as three states of one entry. */
export interface StepEntry {
  kind: "step";
  id: string;
  callId: string;
  verb: string;
  verbKind?: VerbKind;
  args: Record<string, Scalar>;
  /** The verb's `at` selector, straight from the manifest and used by nothing
   *  in here. See `onAim` for the seam a host outlines it through. */
  at?: string;
  commit: boolean;
  status: StepStatus;
  /** What happened, as a phrase appended to the row. Absent while pending. */
  outcome?: string;
  /** From a `describe` verb's `Report.count`, when it reported one. */
  count?: number;
}

/** A standing permission a person installed from a card. See `PanelOptions.grants`. */
export interface Grant {
  verb: string;
  /** The rule, in the words that were shown before the click. */
  rule: string;
  /** Allow, or always refuse. Both are rules worth being able to install, and
   *  a standing refusal is the one a person reaches for when a model keeps
   *  asking about something it is never going to be allowed to do. */
  allow: boolean;
}

/** A question, and then the receipt it becomes. */
export interface ApprovalEntry {
  kind: "approval";
  id: string;
  verb: string;
  /** The verb's own `describe` from the manifest — the app's words, not ours. */
  describe: string;
  args: Record<string, Scalar>;
  count?: number;
  reversible: boolean;
  /** Whether the count alone is why this is being asked about. */
  large: boolean;
  phase: ApprovalPhase;
  /**
   * The rule a person would install by pressing "always", **in the words it is
   * shown in before the click.** The same string is stored on the `Grant`, so
   * what was agreed to and what was installed cannot differ.
   */
  grantOffer?: string;
  /** The rule that answered this without asking, when one did. */
  via?: string;
  /** A free-text note typed beside the decision. See `decide`. */
  note?: string;
  /** The app's refusal slug, when the approved verb was refused anyway. */
  refused?: string;
}

export type Entry = SaidEntry | StepEntry | ApprovalEntry;

export interface PanelSnapshot {
  entries: readonly Entry[];
  /** A run is in flight. */
  busy: boolean;
  runState: RunState;
  paceMs: number;
  /** Unspent `step()` permits, for a button that wants to show one is owed. */
  permits: number;
  stepMode: boolean;
  confirmCommits: boolean;
  /** What this driver has spent, re-read on every change. Absent when the
   *  driver does not account for itself. */
  budget?: BudgetState;
  grants: readonly Grant[];
  /** The open question, if there is one. Also in `entries`, in its place. */
  pending?: ApprovalEntry;
  /** Which conversation this is. Bumped by `clear`. */
  era: number;
}

export interface PanelOptions
  extends Pick<DriveOptions, "think" | "instructions" | "maxSteps" | "refusalLimit"> {
  /** The first line in the transcript. Omit it for an empty panel. */
  greeting?: string;
  /**
   * Ask before a `commit` the app cannot undo. Default true, as in the vanilla
   * widget and for the same reason: a person watching a panel move their own
   * app should not learn about a thousand accepted rows afterwards.
   */
  confirmCommits?: boolean;
  /** Ask above this selection size even when the commit declared itself
   *  reversible. Default `COMMIT_ASK_ABOVE`. */
  commitAskAbove?: number;
  /** Ask before every commit, reversible or not. Default false. */
  confirmEveryCommit?: boolean;
  /**
   * Your own gate for the in-page run, replacing this one. Overrides rather
   * than stacks — see the vanilla widget's `onBeforeCommit`, which this
   * mirrors exactly.
   */
  onBeforeCommit?: DriveOptions["onBeforeCommit"];
  /**
   * Offer "always allow" / "always refuse" beside the once-only answer.
   * **Default false.**
   *
   * Off by default because a standing permission on a data-changing verb is a
   * larger thing to hand somebody than a button that says yes once, and an
   * app should decide to offer it rather than find that it did. When it is on,
   * two rules hold and both are load-bearing:
   *
   *   The rule is shown in full on the card **before** the click, in the same
   *   string that is then stored, so nobody installs a rule whose text they
   *   have not read.
   *
   *   Grants live for this panel and this page load only. Nothing is written
   *   to storage, deliberately: a standing approval for a commit that came
   *   back after a reload, in a session nobody remembers granting it in, is
   *   worse than asking again. `revoke` takes one away sooner, and
   *   `PanelSnapshot.grants` is there so a host can render the list — a grant
   *   nobody can see is a grant nobody can revoke.
   */
  grants?: boolean;
  /**
   * Offer a free-text note beside the decision. Default false.
   *
   * On a denial the note becomes the hint the model is told, which is a real
   * feature of the gate rather than decoration: `CommitDecision` takes a
   * string, and "not until finance signs off" is something a model can act on
   * where "declined" is not.
   *
   * **Typing in it never approves anything.** The note is read only when a
   * decision button is pressed, Enter in the field does not submit, and a
   * note with no decision leaves the question exactly as open as it was. A
   * gate that inferred consent from a typed explanation would let the
   * explanation authorize the call.
   */
  notes?: boolean;
  /** Starting pace in ms. Default `WATCHABLE_PACE` via `runControls`. A person
   *  can change it live; see `setPace`. */
  pace?: number;
  /** Start every run paused, one `step()` per call. Default false. */
  stepMode?: boolean;
  /** Where Pause, Resume and Step are sent. Default `runControls`, built once
   *  per run because "paused" is a statement about a run. */
  controls?: RunControlsFactory;
  /** The timer the pace waits on. Injectable so a suite need not sleep. */
  clock?: Clock;
  /**
   * Told which element the next call is about, from the verb's `at`.
   *
   * The seam the vanilla widget's spotlight would plug into. It is a callback
   * rather than a built-in outline because the outline is DOM written outside
   * React's tree, into a page whose stacking and transforms belong to the
   * host; a React app that wants it can draw it with the tools it already has.
   * `at` is presentational here as it is everywhere: never resolved, never
   * clicked, never read for a value.
   */
  onAim?: (at: string | undefined) => void;
  /** A failed `think` lands here as well as in the transcript. */
  onError?: (err: unknown) => void;
  AbortController?: { new (): { signal: AbortSignal; abort: () => void } };
}

export interface PanelStore {
  subscribe: (listener: () => void) => () => void;
  /** Referentially stable until something changes, which is what
   *  `useSyncExternalStore` requires of it. */
  getSnapshot: () => PanelSnapshot;
  /** Ask something. Resolves when the run ends. */
  ask: (text: string) => Promise<void>;
  /** Abort the run. Stop is the abort signal and is not on `RunControls`: an
   *  abort outranks a pause, so a held run is still stoppable. */
  stop: () => void;
  /** Throw away the transcript and the history, and stop whatever is running. */
  clear: () => void;
  pause: () => void;
  resume: () => void;
  step: () => void;
  setPace: (ms: number) => void;
  setStepMode: (on: boolean) => void;
  setConfirmCommits: (on: boolean) => void;
  /** Answer an open question. A no-op for an id that is not open, which is what
   *  makes a double click harmless. */
  decide: (id: string, decision: Decision) => void;
  revoke: (verb: string) => void;
  /**
   * This panel's question, in the shape of `MountOptions.approve`.
   *
   * The same function behind the in-page gate and the relay path, exactly as
   * the vanilla widget does it, so a commit arriving over MCP renders the same
   * card under the same rules:
   *
   * ```ts
   * let panel: PanelStore;
   * const driver = mount({ …, approve: (req) => panel.approve(req) });
   * panel = createPanelStore(driver, { think });
   * ```
   */
  approve: (req: ApprovalRequest) => Promise<Approval>;
  /** Stop the run, answer any open question as lapsed, and release the
   *  listeners. Called from the hook's unmount effect. It is FINAL: a
   *  destroyed store answers no further `ask`, which is what `destroyed`
   *  below exists to let a caller find out before it tries. */
  destroy: () => void;
  /**
   * Whether `destroy` has already run.
   *
   * For a caller that did not do the destroying and cannot be sure it did not
   * happen — which is `useDriver` on a remount, because React can run an
   * effect's cleanup and then mount the same effect again. A store that has
   * been closed cannot be reopened, so the hook asks rather than assuming, and
   * builds a new one when the answer is yes.
   */
  destroyed: () => boolean;
}

export interface Decision {
  allow: boolean;
  /** Install the rule that was offered on the card. Ignored when `grants` is
   *  off or the card offered none. */
  always?: boolean;
  /** What was typed beside the decision. On a denial it becomes the model's
   *  hint. It is never what authorized anything. */
  note?: string;
}

const STOP_NOTE: Record<StopReason, string | null> = {
  // Nothing to add: the model's own prose is already in the transcript.
  answered: null,
  silent: "The model replied with nothing. That is usually a bug in `think`.",
  "max-steps": "Stopped: this took more steps than allowed. Ask again, more specifically.",
  stuck: "Stopped: the same call kept being refused, so going on would not have helped.",
  "over-budget":
    "Stopped: this app's limit on what one session may spend is reached. Asking again will " +
    "not help — the limit is set by the app, not by the panel.",
  aborted: "Stopped.",
};

/**
 * What a receipt says, as one short line of plain text.
 *
 * A pure function and exported, for two reasons. It is what the card renders
 * into its `role="status"`, and a status line is the one piece of this that a
 * screen reader user gets instead of the layout, so it is asserted directly in
 * the suite rather than through a renderer. And a host replacing the card keeps
 * the wording without having to re-derive it from the phase — the phases are a
 * state machine and the sentences are a product decision, and a host should be
 * able to take the second without reimplementing the first.
 */
export function receiptLine(entry: ApprovalEntry): string {
  switch (entry.phase) {
    case "asking":
      return "Waiting for your decision.";
    case "allowed":
      return entry.via ? `Allowed by your rule: ${entry.via}. Running.` : "Approved, running.";
    case "allowed-ok":
      return "Approved. Finished.";
    // Approved and then refused by the app anyway. The receipt says both,
    // because a reader who is told only the first has been told the half that
    // flatters us.
    case "allowed-refused":
      return `Approved, but the app refused it: ${entry.refused ?? "refused"}.`;
    case "denied":
      return entry.via ? `Refused by your rule: ${entry.via}.` : "Denied. Nothing was changed.";
    case "stopped":
      return "The run was stopped before this ran. Nothing was changed.";
    case "lapsed":
      return "The panel closed before anybody answered. Nothing was changed.";
  }
}

/** The step list's outcome phrase, given a result. Pure, so the suite can read
 *  it without a renderer, and so a host's own row renders the same words. */
export function stepOutcome(ok: boolean, refused?: string, count?: number): string {
  if (!ok) return `refused: ${refused ?? "refused"}`;
  return count === undefined ? "ok" : `ok · ${commas(count)} matched`;
}

export function createPanelStore(driver: Driver, options: PanelOptions): PanelStore {
  const Abort = options.AbortController ?? globalThis.AbortController;
  const askAbove = options.commitAskAbove ?? COMMIT_ASK_ABOVE;

  let entries: Entry[] = [];
  let messages: Turn[] = [];
  let running: { signal: AbortSignal; abort: () => void } | null = null;
  let active: RunControls | null = null;
  let runState: RunState = "running";
  let paceMs = options.pace ?? 600;
  let permits = 0;
  let stepMode = options.stepMode === true;
  let confirmCommits = options.confirmCommits !== false;
  let grants: Grant[] = [];
  let live = true;
  let ids = 0;

  /**
   * Which conversation we are in. Kept for exactly the reason the vanilla
   * widget keeps it, and the reason survives the move to React unchanged: an
   * abort stops `drive` at its next await, so a call it had already announced
   * can still arrive afterwards, and a step row about it would appear in a
   * transcript the person has just emptied. React does not help with this —
   * a `setState` from a stale async callback is exactly as wrong as an
   * `appendChild` from one.
   */
  let era = 0;

  /**
   * The run's last `describe` count, which is the number the model just put on
   * the screen. Cleared when a question is asked, because that is when it has
   * been put in front of somebody and spoken for.
   */
  let lastCount: number | undefined;

  const listeners = new Set<() => void>();
  /** Open questions, by entry id. */
  const open = new Map<string, Open>();
  /** Allowed questions waiting for the app's verdict, oldest first per verb. */
  const awaiting: ApprovalEntry[] = [];

  interface Open {
    entry: ApprovalEntry;
    answer: (approval: Approval, phase: ApprovalPhase, note?: string) => void;
  }

  let snapshot: PanelSnapshot = build();

  function build(): PanelSnapshot {
    const pending = entries.find(
      (e): e is ApprovalEntry => e.kind === "approval" && e.phase === "asking",
    );
    return {
      entries,
      busy: running !== null,
      runState,
      paceMs,
      permits,
      stepMode,
      confirmCommits,
      ...(driver.budget ? { budget: driver.budget() } : {}),
      grants,
      ...(pending ? { pending } : {}),
      era,
    };
  }

  /** One new snapshot per change, and one notification. A fresh `entries`
   *  array every time, because a mutated array is a snapshot React cannot tell
   *  from the last one. */
  function bump(): void {
    entries = entries.slice();
    snapshot = build();
    for (const listener of [...listeners]) listener();
  }

  function id(): string {
    return `dk${++ids}`;
  }

  function say(kind: SaidEntry["kind"], text: string): void {
    entries.push({ kind, id: id(), text });
    bump();
  }

  function patch<E extends Entry>(entry: E, changes: Partial<E>): void {
    const at = entries.indexOf(entry);
    if (at < 0) return;
    entries[at] = { ...entry, ...changes };
    bump();
  }

  // ---- the gate ----------------------------------------------------------
  //
  // The rules below are the vanilla widget's, restated because they have to be
  // the same rules: one of the two panels being laxer about a commit than the
  // other would make "which panel is this app using" a security question.

  /** How many rows the question is about, from the screen alone. */
  function countFor(shot: Snapshot): number | undefined {
    return shot.selectedCount ?? shot.selected?.length;
  }

  /** Whether this commit gets a question. The three options' whole meaning. */
  function shouldAsk(req: ApprovalRequest, count: number | undefined): boolean {
    if (!confirmCommits) return false;
    // Absent means the app made no claim, which is gated: a commit that has not
    // said there is a way back is treated as one that has not got one.
    const reversible = req.verb.reversible === true;
    const large = count !== undefined && count > askAbove;
    return !reversible || options.confirmEveryCommit === true || large;
  }

  /** Whether `driver.call()` already asks, so this panel must not. */
  function coreAsks(): boolean {
    const policy = driver.approval?.policy;
    return policy === "hook" || policy === "adopted";
  }

  /** Hold the core's no-other-calls lock while a question is open, so a second
   *  agent over the relay cannot press an approve button while the card sits
   *  there unanswered. */
  function withLock<T>(verb: string, ask: () => Promise<T>): Promise<T> {
    const hold = driver.approval?.hold;
    return hold ? hold(verb, ask) : ask();
  }

  /** The rule a person would install from this card, in the words they read. */
  function grantRule(verb: string, allow: boolean): string {
    return allow
      ? `Always allow “${verb}” for the rest of this session, without asking`
      : `Always refuse “${verb}” for the rest of this session, without asking`;
  }

  function grantFor(verb: string): Grant | undefined {
    return grants.find((g) => g.verb === verb);
  }

  /**
   * Render the question and wait for an answer.
   *
   * `teardown` is the answer to give if the panel goes away with the question
   * still on screen, and it is a parameter rather than a constant because the
   * two callers are owed different answers — a veto for the in-page run that is
   * being torn down with it, and `{ timedOut: true }` for a call that arrived
   * from outside and has somebody waiting on an approval nobody will now give.
   * Confusing those two is what the core's `timedOut` exists to stop.
   */
  function askPerson(
    req: ApprovalRequest,
    count: number | undefined,
    signal: AbortSignal | undefined,
    teardown: Approval,
  ): Promise<Approval> {
    const entry: ApprovalEntry = {
      kind: "approval",
      id: id(),
      verb: req.name,
      describe: req.verb.describe,
      args: req.args,
      ...(count === undefined ? {} : { count }),
      reversible: req.verb.reversible === true,
      large: count !== undefined && count > askAbove,
      phase: "asking",
      ...(options.grants ? { grantOffer: grantRule(req.name, true) } : {}),
    };
    entries.push(entry);
    bump();

    return new Promise<Approval>((resolve) => {
      let answered = false;
      /**
       * The buttons go and the receipt stays, in the same entry.
       *
       * This is the whole point of the area. The question keeps its id, its
       * place in the transcript and its own words; only `phase` moves. A card
       * that unmounted on decision and left a separate outcome line behind
       * would break the question/answer link in scrollback, which is the one
       * link the only auditable feature in the library depends on.
       */
      const answer = (approval: Approval, phase: ApprovalPhase, note?: string): void => {
        if (answered) return;
        answered = true;
        open.delete(entry.id);
        const found = entries.find((e) => e.id === entry.id) as ApprovalEntry | undefined;
        const row = found ?? entry;
        patch(row, {
          phase,
          ...(note === undefined || note === "" ? {} : { note }),
        } as Partial<ApprovalEntry>);
        // Allowed and inside a run: the app has still to have its say, and the
        // receipt is not finished until it has. Parked by verb name, oldest
        // first, which is how `onResult` finds it again.
        if (phase === "allowed" && running) {
          const settled = entries.find((e) => e.id === entry.id) as ApprovalEntry | undefined;
          if (settled) awaiting.push(settled);
        }
        resolve(approval);
      };

      open.set(entry.id, { entry, answer });

      // An abort answers the question, and the only safe answer is no. Without
      // this a stop would leave the loop waiting on a promise nobody resolves
      // and the panel busy forever.
      signal?.addEventListener("abort", () =>
        answer("the run was stopped before this ran", "stopped"),
      );
      if (signal?.aborted) answer("the run was stopped before this ran", "stopped");
      // Registered after the signal check, so the map only holds genuinely open
      // questions.
      if (answered) return;
      open.set(entry.id, {
        entry,
        answer,
      });
      teardowns.set(entry.id, () => answer(teardown, "lapsed"));
    });
  }

  const teardowns = new Map<string, () => void>();

  function decide(entryId: string, decision: Decision): void {
    const slot = open.get(entryId);
    if (!slot) return;
    teardowns.delete(entryId);
    const note = decision.note?.trim() ?? "";

    // The rule is installed from the text that was on the card, not from a
    // string built again here, so what was agreed to and what was stored
    // cannot differ.
    if (decision.always === true && options.grants) {
      grants = [
        ...grants.filter((g) => g.verb !== slot.entry.verb),
        {
          verb: slot.entry.verb,
          rule: grantRule(slot.entry.verb, decision.allow),
          allow: decision.allow,
        },
      ];
    }

    if (decision.allow) {
      // `true` and never the note. The decision is the authorization; a note
      // beside it is a comment on the record. Reading consent out of typed text
      // would let the text authorize the call.
      slot.answer(true, "allowed", note);
    } else {
      // A denial's note IS load-bearing, in the other direction: the core turns
      // a string into the hint the model is told, so "not until finance signs
      // off" reaches the model where "declined" would not.
      slot.answer(note === "" ? false : note, "denied", note);
    }
  }

  /** This panel's dialog, as a `MountOptions.approve` hook. */
  async function approve(req: ApprovalRequest): Promise<Approval> {
    const standing = options.grants ? grantFor(req.name) : undefined;
    if (standing) return receipt(req, standing);
    // `lastCount` only while a run is in flight, and then first: a commit that
    // arrived between runs has no run to have counted anything.
    const count = (running ? lastCount : undefined) ?? countFor(req.snapshot);
    // Not `true`. A gate that let this through without asking must not be
    // recorded as a person saying yes — `{ asked: false }` is the core's word
    // for this answer.
    if (!shouldAsk(req, count)) return { asked: false };
    lastCount = undefined;
    const was = runState;
    if (active) show("awaiting-approval");
    try {
      // No `withLock`: the core takes its lock before calling an approver, and
      // a second take would assert what is already true.
      return await askPerson(req, count, running?.signal, CLOSED_LAPSE);
    } finally {
      if (active) show(was);
    }
  }

  /**
   * A commit answered by a standing rule. Posted as a receipt all the same.
   *
   * A rule that silenced the question must not also silence the record: the
   * entry says which rule answered, so scrollback shows both that the commit
   * happened and why nobody was asked. The answer handed back is
   * `{ asked: false }` rather than `true`, because nobody WAS asked this time —
   * which is exactly the distinction the core added that answer for. An app
   * that needs every allowed commit to carry a person's yes in the audit record
   * should leave `grants` off.
   */
  function receipt(req: ApprovalRequest, rule: Grant): Approval {
    const count = (running ? lastCount : undefined) ?? countFor(req.snapshot);
    const entry: ApprovalEntry = {
      kind: "approval",
      id: id(),
      verb: req.name,
      describe: req.verb.describe,
      args: req.args,
      ...(count === undefined ? {} : { count }),
      reversible: req.verb.reversible === true,
      large: count !== undefined && count > askAbove,
      phase: rule.allow ? "allowed" : "denied",
      via: rule.rule,
    };
    entries.push(entry);
    bump();
    if (rule.allow) {
      if (running) awaiting.push(entries[entries.length - 1] as ApprovalEntry);
      return { asked: false };
    }
    return rule.rule;
  }

  const CLOSED_VETO = "the panel was closed before this was approved";
  const CLOSED_LAPSE: Approval = {
    timedOut: true,
    hint:
      "the approval panel was closed while this was waiting to be approved, so nobody " +
      "answered. **The verb did not run and nothing changed.** Ask the person to reopen the " +
      "assistant, then call it again.",
  };

  // ---- the run -----------------------------------------------------------

  function show(state: RunState): void {
    runState = state;
    bump();
  }

  async function ask(text: string): Promise<void> {
    if (!live || running) return;
    say("you", text);
    const mine = era;

    const controller = new Abort();
    running = controller;

    const control = (options.controls ?? runControls)({
      pace: paceMs,
      stepMode,
    });
    active = control;
    // The controls have more than one owner — this panel's buttons move them
    // and `drive` moves them too — so the panel reads them rather than
    // remembering what it last asked for.
    const unsubscribe = control.subscribe(() => {
      paceMs = control.paceMs;
      permits = control.permits;
      bump();
    });
    paceMs = control.paceMs;
    permits = control.permits;
    show("running");

    const steps = new Map<string, StepEntry>();
    lastCount = undefined;

    /** The built-in gate, per run. Not installed when the core already asks. */
    function confirmCommit(req: CommitRequest): Promise<CommitDecision> {
      const standing = options.grants ? grantFor(req.name) : undefined;
      if (standing) {
        // `CommitDecision` has no `{ asked: false }`: it is `drive`'s option,
        // not the core's hook, so a grant on this path can only say yes. The
        // entry still records the rule, which is the half the panel owns.
        const answer = receipt(req as ApprovalRequest, standing);
        return Promise.resolve(standing.allow ? true : (answer as CommitDecision));
      }
      const count = lastCount ?? countFor(req.snapshot);
      if (!shouldAsk(req, count)) return Promise.resolve(true);
      lastCount = undefined;
      return withLock(
        req.name,
        async () =>
          (await askPerson(req, count, controller.signal, CLOSED_VETO)) as CommitDecision,
      );
    }

    const gate = options.onBeforeCommit ?? (coreAsks() ? undefined : confirmCommit);

    function row(e: CallEvent): StepEntry {
      const found = steps.get(e.call.id);
      if (found) return found;
      const entry: StepEntry = {
        kind: "step",
        id: id(),
        callId: e.call.id,
        verb: e.call.name,
        ...(e.kind === undefined ? {} : { verbKind: e.kind }),
        args: e.call.args,
        ...(e.at === undefined ? {} : { at: e.at }),
        commit: e.kind === "commit",
        status: "pending",
      };
      entries.push(entry);
      steps.set(e.call.id, entry);
      bump();
      return entry;
    }

    function current(e: StepEntry): StepEntry {
      const found = entries.find((x) => x.id === e.id) as StepEntry | undefined;
      return found ?? e;
    }

    const paced: DriveOptions = {
      think: options.think,
      task: text,
      history: messages,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.refusalLimit === undefined ? {} : { refusalLimit: options.refusalLimit }),
      ...(gate ? { onBeforeCommit: gate } : {}),
      signal: controller.signal,
      controls: control,
      pace: paceMs,
      ...(options.clock === undefined ? {} : { clock: options.clock }),

      // A row appears on `onBeforeCall`, which fires before the pace wait and
      // before any hold — the only way "you can see it coming and stop it" is
      // true rather than aspirational.
      onBeforeCall: (e) => {
        if (era !== mine) return;
        const entry = row(e);
        const now = current(entry);
        steps.set(e.call.id, now);
        patch(now, { status: "pending" });
        options.onAim?.(e.at);
      },
      onCall: (e) => {
        if (era !== mine) return;
        const entry = steps.get(e.call.id) ?? row(e);
        patch(current(entry), { status: "running" });
        options.onAim?.(e.at);
      },
      onControl: ({ state }) => {
        if (era !== mine) return;
        show(state);
      },
      onResult: ({ call, kind, result }) => {
        if (era !== mine) return;
        if (kind === "describe" && result?.ok) lastCount = result.count;
        options.onAim?.(undefined);
        settleReceipt(call.name, result);
        const entry = steps.get(call.id);
        if (!entry) return;
        const now = current(entry);
        if (result === null) {
          patch(now, { status: "done", outcome: "looked" });
          return;
        }
        if (result.ok) {
          // The count is repeated on the row on purpose. It is the number a
          // commit decision turns on, and the person watching should be able to
          // see "1,000 matched" without reading the model's summary of it.
          patch(now, {
            status: "done",
            outcome: stepOutcome(true, undefined, result.count),
            ...(result.count === undefined ? {} : { count: result.count }),
          });
        } else {
          // A refusal is an OUTCOME and not an error. The app said no, on
          // purpose, in its own vocabulary, and the model is about to adapt to
          // it; rendering it as a failure would teach the person to read a
          // working app as a broken one.
          patch(now, { status: "refused", outcome: stepOutcome(false, result.refused) });
        }
      },
      onSay: ({ text: prose }) => {
        if (era !== mine) return;
        say("assistant", prose);
      },
    };

    try {
      const out = await drive(driver, paced);
      if (era !== mine) return;
      messages = out.messages;
      const note = STOP_NOTE[out.stop];
      if (note) say("note", note);
    } catch (err) {
      // Handed to `onError` whichever conversation it belonged to, and said in
      // the transcript only if that transcript is still the one it is about.
      options.onError?.(err);
      if (era === mine) {
        say("note", `Something went wrong talking to the model: ${message(err)}`);
      }
    } finally {
      unsubscribe();
      running = null;
      active = null;
      lastCount = undefined;
      runState = "running";
      options.onAim?.(undefined);
      if (era === mine) {
        // Rows for calls that never ran. A stop during a pace wait or a hold
        // abandons them unrun and no `onResult` is coming, so leaving them
        // pending would be a panel saying something is about to happen when the
        // run is already over.
        for (const entry of steps.values()) {
          const now = current(entry);
          if (now.status === "pending" || now.status === "running") {
            patch(now, { status: "skipped", outcome: "not run" });
          }
        }
        // And receipts for commits that were approved and then abandoned. The
        // card must not be left reading "running" for something that never ran.
        for (const entry of awaiting.slice()) {
          const now = entries.find((x) => x.id === entry.id) as ApprovalEntry | undefined;
          if (now && now.phase === "allowed") patch(now, { phase: "stopped" });
        }
      }
      awaiting.length = 0;
      bump();
    }
  }

  /**
   * Move an approved receipt on to its final phase, from the app's own verdict.
   *
   * Correlated by verb name, oldest first. The gate is handed a
   * `CommitRequest` carrying a name and arguments and no call id — the id
   * exists one layer out, on the `ToolCall` — so a name is what there is to
   * match on. It is sound for the case that exists: the core holds its
   * no-other-calls lock across an approval, so a second commit of the same verb
   * cannot be in flight while the first is still being asked about.
   */
  function settleReceipt(verb: string, result: { ok: boolean; refused?: string } | null): void {
    const at = awaiting.findIndex((e) => e.verb === verb);
    if (at < 0 || result === null) return;
    const [entry] = awaiting.splice(at, 1);
    if (!entry) return;
    const now = entries.find((x) => x.id === entry.id) as ApprovalEntry | undefined;
    if (!now || now.phase !== "allowed") return;
    patch(
      now,
      result.ok
        ? { phase: "allowed-ok" }
        : {
            phase: "allowed-refused",
            ...(result.refused === undefined ? {} : { refused: result.refused }),
          },
    );
  }

  function clear(): void {
    // First, and through the run's own controller: the loop must not be left
    // holding `messages` the panel has just thrown away.
    running?.abort();
    era++;
    entries = [];
    messages = [];
    awaiting.length = 0;
    if (options.greeting !== undefined) {
      entries.push({ kind: "note", id: id(), text: options.greeting });
    }
    bump();
  }

  if (options.greeting !== undefined) {
    entries.push({ kind: "note", id: id(), text: options.greeting });
    snapshot = build();
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    ask,
    stop: () => running?.abort(),
    clear,
    pause: () => active?.pause(),
    resume: () => active?.resume(),
    step: () => active?.step(),
    setPace: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return;
      paceMs = ms;
      // Live, which is the whole reason the controls have a setter: the moment
      // somebody wants the agent slowed down is while it is going.
      active?.pace(ms);
      bump();
    },
    setStepMode: (on) => {
      stepMode = on;
      bump();
    },
    setConfirmCommits: (on) => {
      // Read per commit rather than per run, so turning confirmations off — or
      // back on — in the middle of a run takes effect on the next commit. That
      // is what somebody who has just watched a commit go past expects of the
      // switch they reached for.
      confirmCommits = on;
      bump();
    },
    decide,
    revoke: (verb) => {
      grants = grants.filter((g) => g.verb !== verb);
      bump();
    },
    approve,
    destroyed: () => !live,
    destroy: () => {
      live = false;
      // The open questions are lapsed BEFORE the run is aborted, and the order
      // is the whole difference between two records. An abort answers an open
      // question `stopped` through the signal listener in `ask`, and on an
      // unmount that would be the less true of the two available facts: the
      // run was stopped because the panel went away, and "the panel closed
      // before anybody answered" is what somebody reading the receipt needs.
      // Lapsing first is safe — a lapse answers the core with a refusal
      // string, never an allow — and the abort still lands before the loop
      // resumes, because it runs synchronously here and the loop can only
      // continue on a later microtask.
      for (const lapse of [...teardowns.values()]) lapse();
      teardowns.clear();
      running?.abort();
      listeners.clear();
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
