/**
 * driverkit/react — the same panel, for a team that already has React.
 *
 * WHY THIS EXISTS BESIDE `driverkit/widget` AND NOT INSTEAD OF IT.
 * `mountWidget` is hand-written DOM in a shadow root with zero dependencies,
 * and that is the right shape for a drop-in: it goes into a Thymeleaf
 * template, a Rails view or a static page, and the host owns no version of
 * anything it did not pick. It is the wrong shape for a team that has React, a
 * design system and an opinion about what their product looks like — for them
 * the shadow root is a wall around the panel and the hand-written markup is
 * something to fight. So there are two paths. **The vanilla widget's
 * dependency count stays zero and its behaviour is untouched by anything in
 * here.**
 *
 * WHAT THE PUBLIC SURFACE IS, AND WHY IT IS THIS ONE. Three things, in
 * decreasing order of how much they assume:
 *
 *   `createDriverPanel(React)` returns everything. One call, because React
 *   itself is an argument rather than an import — see `runtime.ts`, which is
 *   the file to read before judging that.
 *
 *   `useDriver(driver, options)` is the primitive, and it is the whole
 *   library: the conversation, the gate, the run controls, the budget and the
 *   receipts, as plain data and plain functions. A host that renders none of
 *   our components still gets all of the behaviour. This is deliberately the
 *   thing the documentation leads with, because a team adopting this has a
 *   design system and headless-with-defaults is the only shape that respects
 *   one.
 *
 *   `<DriverPanel />` is one assembly of the components, for the team that
 *   wants a panel today and will restyle it on Thursday. Every part of it is
 *   replaceable one at a time through `components`, so "restyle it" never has
 *   to become "fork it".
 *
 * Both, rather than one, because the two audiences are real and a single
 * `<DriverPanel />` would make the design-system team reimplement the gate —
 * which is the one thing in here nobody should be reimplementing.
 *
 * WHAT IS DELIBERATELY ABSENT, with the vanilla widget's own reasoning
 * re-examined rather than copied; `REACT.md` has the full list:
 *
 *   **No shadow root.** The vanilla panel needs one because it is rendering
 *   into an app whose CSS it has never seen. A React app has a CSS isolation
 *   story of its own — modules, Tailwind, styled-components, whatever it
 *   picked — and a shadow root would break it: the host's own class names
 *   would not reach inside, which is the opposite of the point.
 *
 *   **No launcher, no drag, no corner.** Those exist because the vanilla
 *   widget has to place itself in a page nobody told it about. Here the host
 *   renders `<DriverPanel />` where it wants it, in its own layout, and a
 *   library that positioned itself `fixed` would be overriding a decision the
 *   host is better placed to make.
 *
 *   **No `aria-live` on the transcript**, which the vanilla panel has and
 *   which is a bug at a 600ms pace: a live region containing the whole
 *   conversation is re-read as each step row lands, so the person hears a
 *   growing transcript from the top instead of what just changed. State is
 *   announced instead, through small `role="status"` regions that say one
 *   thing — see `ReceiptStatus` and `RunAnnouncer`.
 *
 *   **No `textContent` discipline, because React is the discipline.** The
 *   vanilla file keeps `innerHTML` out of its DOM wrapper on purpose; here the
 *   equivalent rule is that nothing in this area calls
 *   `dangerouslySetInnerHTML`, including at the markdown seam, where a host
 *   supplies a COMPONENT and never a string of HTML.
 *
 * The `era` counter is kept, and that one is worth saying out loud: React does
 * not help with it. A `setState` from an async callback that outlived a Clear
 * is exactly as wrong as the `appendChild` it replaced. See `store.ts`.
 */

import { commas } from "../agent/index.ts";
import type { ApprovalRequest, Driver, Scalar } from "../core/index.ts";
import type { Component, ReactRuntime } from "./runtime.ts";
import { createPanelStore, receiptLine } from "./store.ts";
import type {
  ApprovalEntry,
  Decision,
  PanelOptions,
  PanelSnapshot,
  PanelStore,
  SaidEntry,
  StepEntry,
} from "./store.ts";

export { COMMIT_ASK_ABOVE, createPanelStore, receiptLine, stepOutcome } from "./store.ts";
export type {
  ApprovalEntry,
  ApprovalPhase,
  Decision,
  Entry,
  Grant,
  PanelOptions,
  PanelSnapshot,
  PanelStore,
  RunControlsFactory,
  SaidEntry,
  StepEntry,
  StepStatus,
} from "./store.ts";
export type { Component, Node, ReactRuntime } from "./runtime.ts";

/** What `useDriver` hands back: the snapshot, flattened, plus the actions. */
export interface Driving extends PanelSnapshot {
  ask: (text: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
  pause: () => void;
  resume: () => void;
  step: () => void;
  setPace: (ms: number) => void;
  setStepMode: (on: boolean) => void;
  setConfirmCommits: (on: boolean) => void;
  decide: (id: string, decision: Decision) => void;
  revoke: (verb: string) => void;
  /** This panel's gate, as a `MountOptions.approve` hook. Wire it up with a
   *  forward reference so a commit arriving over the relay renders the same
   *  card. See `PanelStore.approve`. */
  approve: (req: ApprovalRequest) => Promise<unknown>;
  /** The store itself, for a host that wants to reach past the hook. */
  store: PanelStore;
}

/**
 * The markdown seam.
 *
 * **Markdown rendering is not built here and must not be.** It is being built
 * for the vanilla widget, and when it lands this is where it plugs in: a
 * component that is handed the model's prose for one turn and returns nodes.
 *
 * What it can rely on: `text` is the model's **complete** text for that turn.
 * `onSay` delivers a whole turn at once — driverkit does not stream tokens —
 * so a renderer here never sees a half-written fence, never has to parse
 * incrementally, and needs none of the streaming-markdown machinery the rest
 * of the world needs. It is called on render, so it must be pure and should be
 * memoized by the host if its parse is expensive.
 *
 * What it must not do: return HTML for React to inject. The prop is a
 * component precisely so that the escape hatch is not a string — a markdown
 * renderer that handed us `dangerouslySetInnerHTML` would make a model's
 * output into a script tag in the host's page, and the model's output is the
 * least trusted thing on this screen.
 */
export type ProseRenderer = Component<{ text: string }>;

export interface PanelComponents {
  Transcript: Component<TranscriptProps>;
  Said: Component<{ entry: SaidEntry; Prose: ProseRenderer }>;
  StepRow: Component<{ entry: StepEntry }>;
  ApprovalCard: Component<ApprovalCardProps>;
  RunControlsBar: Component<RunControlsBarProps>;
  Composer: Component<ComposerProps>;
  BudgetNotice: Component<{ driving: Driving }>;
  GrantList: Component<{ driving: Driving }>;
  Prose: ProseRenderer;
}

export interface TranscriptProps {
  driving: Driving;
  components: PanelComponents;
  /** Whether the approval cards offer the free-text note. From
   *  `PanelOptions.notes`, threaded through here rather than read from the
   *  options by each card, so that a host replacing one component does not
   *  have to re-plumb an option it did not change. */
  notes: boolean;
}

export interface ApprovalCardProps {
  entry: ApprovalEntry;
  decide: (id: string, decision: Decision) => void;
  /** Whether to offer the free-text note. From `PanelOptions.notes`. */
  notes: boolean;
}

export interface RunControlsBarProps {
  driving: Driving;
}

export interface ComposerProps {
  driving: Driving;
  placeholder?: string;
}

export interface DriverPanelProps {
  driver: Driver;
  options: PanelOptions;
  placeholder?: string;
  /** Replace any part of the default assembly, one piece at a time. */
  components?: Partial<PanelComponents>;
  /** Render the model's prose. The markdown seam; see `ProseRenderer`. */
  Prose?: ProseRenderer;
}

/**
 * Visually hidden and still read aloud.
 *
 * Inline rather than a stylesheet because this area ships no CSS at all — a
 * headless library that injected a `<style>` would be making exactly the
 * decision it claims to leave to the host. These five properties are the one
 * exception, and they are not a look: a `role="status"` that is `display:
 * none` is not announced, and one that is merely off-screen with `width: 0`
 * is skipped by some screen readers, so the clip has to be right or the
 * announcement does not happen.
 */
const SR_ONLY: Record<string, string | number> = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

/**
 * Bind this area to the host's React and get the panel.
 *
 * ```tsx
 * // driver-panel.tsx — one file you own
 * import * as React from "react";
 * import { createDriverPanel } from "driverkit/react";
 *
 * export const { DriverPanel, useDriver, components } = createDriverPanel(React);
 * ```
 *
 * Everything after that line is ordinary React. See `runtime.ts` for why the
 * line is there at all.
 */
export function createDriverPanel(react: ReactRuntime): {
  useDriver: (driver: Driver, options: PanelOptions) => Driving;
  DriverPanel: Component<DriverPanelProps>;
  /** The default components, so a host can wrap one instead of writing it. */
  components: PanelComponents;
} {
  const h = react.createElement;

  /**
   * The whole library, as a hook.
   *
   * The store is built once per `driver` and the options are read then — which
   * is a real constraint and so it is said plainly: changing `think` or
   * `maxSteps` on a later render does not change a store that already exists.
   * The things a person changes while watching a run (the pace, step mode,
   * confirmations) are not options but state, with setters, for exactly that
   * reason. A host that genuinely needs new options re-keys the component.
   */
  function useDriver(driver: Driver, options: PanelOptions): Driving {
    const held = react.useRef<{ driver: Driver; store: PanelStore } | null>(null);
    if (held.current === null || held.current.driver !== driver) {
      held.current?.store.destroy();
      held.current = { driver, store: createPanelStore(driver, options) };
    }
    const store = held.current.store;

    // The run is aborted and any open question is answered `lapsed` on
    // unmount. Not `denied`: nobody refused it, and the record must not say
    // somebody did. See `store.ts`.
    react.useEffect(() => () => store.destroy(), [store]);

    const snapshot = react.useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );

    return react.useMemo(
      () => ({
        ...snapshot,
        ask: store.ask,
        stop: store.stop,
        clear: store.clear,
        pause: store.pause,
        resume: store.resume,
        step: store.step,
        setPace: store.setPace,
        setStepMode: store.setStepMode,
        setConfirmCommits: store.setConfirmCommits,
        decide: store.decide,
        revoke: store.revoke,
        approve: store.approve,
        store,
      }),
      [snapshot, store],
    );
  }

  /** The default prose renderer: the model's text, as text. The seam's
   *  identity function, so a host that plugs in markdown is replacing
   *  something rather than filling a hole. */
  const Prose: ProseRenderer = ({ text }) => text;

  const Said: PanelComponents["Said"] = ({ entry, Prose: Render }) =>
    h(
      "div",
      { className: `dk-${entry.kind}`, "data-dk": entry.kind },
      entry.kind === "assistant" ? h(Render, { text: entry.text }) : entry.text,
    );

  const StepRow: PanelComponents["StepRow"] = ({ entry }) =>
    h(
      "div",
      {
        className: `dk-step dk-step-${entry.status}${entry.commit ? " dk-step-commit" : ""}`,
        "data-dk": "step",
        "data-status": entry.status,
        // The marker for a commit is on the row for the person as well as in
        // the prompt for the model. This is the row somebody scrolls back to
        // when they want to know what changed their data.
        ...(entry.commit ? { title: "Changes data, and may be irreversible." } : {}),
      },
      // The row's text reads the same whether somebody looked at it while it
      // was pending or a minute afterwards: the state is an attribute, never
      // part of the sentence.
      `${entry.verb}${entry.verbKind ? ` (${entry.verbKind})` : ""}${argSummary(entry.args)}`,
      entry.outcome === undefined ? null : ` · ${entry.outcome}`,
    );

  /**
   * The receipt's status line, remounted on every phase change.
   *
   * Two things make this work and both are easy to lose in a refactor. The
   * `key` carries the phase, so React unmounts the old node and mounts a new
   * one — a `role="status"` whose text is merely updated is re-announced by
   * some screen readers and silently ignored by others, and a remount is
   * announced by all of them. And focus moves here the first time the phase
   * leaves `asking`, so somebody who pressed a button lands on the answer
   * rather than on whatever followed the buttons that have just gone.
   *
   * Focus is moved only on that transition, never on a later one: a receipt
   * that stole focus again when the app's verdict arrived would yank somebody
   * out of the message they had started typing.
   */
  const ReceiptStatus: Component<{ entry: ApprovalEntry; decided: boolean }> = ({
    entry,
    decided,
  }) => {
    const node = react.useRef<{ focus?: () => void } | null>(null);
    const moved = react.useRef(false);
    react.useEffect(() => {
      if (!decided || moved.current) return;
      moved.current = true;
      node.current?.focus?.();
    }, [decided]);
    return h("div", {
      ref: node,
      // -1 so it can be focused programmatically and is not a tab stop. The
      // receipt is a record, not a control.
      tabIndex: -1,
      role: "status",
      className: "dk-ask-said",
      "data-dk": "receipt",
      "data-phase": entry.phase,
      children: receiptLine(entry),
    });
  };

  /**
   * The question, and then the receipt it becomes. **The same element either
   * way.**
   *
   * The card does not unmount when it is answered: the buttons are replaced by
   * the status line, in place, keeping the question's own words and its
   * position in scrollback. The vanilla panel keeps the row too but tells the
   * person only that they answered; this also says what the APP then did,
   * which is the half that turns a decision into a record of a change.
   */
  const ApprovalCard: PanelComponents["ApprovalCard"] = ({ entry, decide, notes }) => {
    const [note, setNote] = react.useState("");
    const asking = entry.phase === "asking";

    const why =
      (entry.reversible
        ? "This changes data, but the app says this can be undone." +
          (entry.large
            ? " You are being asked because of how many rows it affects: an undo over this" +
              " many is a promise an app may not be able to keep."
            : "")
        : "This changes data and may be irreversible.") +
      (entry.count === undefined
        ? " No count was reported, so nobody can tell you how many rows it affects."
        : "");

    return h(
      "div",
      {
        className: `dk-ask dk-ask-${entry.phase}`,
        "data-dk": "approval",
        "data-phase": entry.phase,
      },
      h(
        "div",
        { className: "dk-ask-q" },
        entry.count === undefined
          ? `${entry.describe}?`
          : `${entry.describe} — ${commas(entry.count)} rows?`,
      ),
      h("div", { className: "dk-ask-why" }, why + argSummary(entry.args)),
      asking
        ? h(
            "div",
            { className: "dk-ask-actions" },
            notes
              ? h("label", { className: "dk-ask-note" }, [
                  h("span", { key: "l" }, "Why? (optional, sent to the model on a refusal)"),
                  h("textarea", {
                    key: "t",
                    value: note,
                    rows: 2,
                    onChange: (e: { target: { value: string } }) => setNote(e.target.value),
                    // Enter does not submit. Typing here is a comment and must
                    // never be the thing that authorizes a call; a field that
                    // answered the question on Enter would make the note the
                    // decision.
                    onKeyDown: (e: { key: string; stopPropagation: () => void }) => {
                      if (e.key === "Enter") e.stopPropagation();
                    },
                  }),
                ])
              : null,
            // "No" first in the DOM, so it is the first of the two a keyboard
            // reaches. Reaching "Yes" takes one more deliberate key, which is
            // the right way round for a button that can accept a thousand rows.
            h(
              "button",
              {
                key: "no",
                type: "button",
                className: "dk-no",
                onClick: () => decide(entry.id, { allow: false, note }),
              },
              "No",
            ),
            h(
              "button",
              {
                key: "yes",
                type: "button",
                className: "dk-yes",
                onClick: () => decide(entry.id, { allow: true, note }),
              },
              "Yes, do it",
            ),
            // The standing rules, each labelled with the rule itself rather
            // than with "always". The exact text that will be installed is on
            // screen before the click, which is the only way somebody can be
            // said to have agreed to it.
            entry.grantOffer === undefined
              ? null
              : h(
                  "div",
                  { key: "grants", className: "dk-ask-grants" },
                  h(
                    "button",
                    {
                      key: "ar",
                      type: "button",
                      className: "dk-no-always",
                      onClick: () => decide(entry.id, { allow: false, always: true, note }),
                    },
                    grantLabel(entry.verb, false),
                  ),
                  h(
                    "button",
                    {
                      key: "aa",
                      type: "button",
                      className: "dk-yes-always",
                      onClick: () => decide(entry.id, { allow: true, always: true, note }),
                    },
                    grantLabel(entry.verb, true),
                  ),
                ),
          )
        : h(ReceiptStatus, { key: entry.phase, entry, decided: true }),
      entry.note === undefined || entry.note === ""
        ? null
        : h("div", { className: "dk-ask-noted" }, `You noted: ${entry.note}`),
    );
  };

  const Transcript: PanelComponents["Transcript"] = ({ driving, components, notes }) =>
    h(
      "div",
      {
        className: "dk-log",
        "data-dk": "transcript",
        // NO `aria-live`. The vanilla panel puts `aria-live="polite"` on this
        // container, and at a 600ms pace that means the whole conversation is
        // re-read as each step row lands — a live region nobody can use. The
        // state is announced instead, in one-sentence `role="status"` regions:
        // `RunAnnouncer` for the run, `ReceiptStatus` for a decision.
      },
      driving.entries.map((entry) =>
        entry.kind === "step"
          ? h(components.StepRow, { key: entry.id, entry })
          : entry.kind === "approval"
            ? h(components.ApprovalCard, {
                key: entry.id,
                entry,
                decide: driving.decide,
                notes,
              })
            : h(components.Said, { key: entry.id, entry, Prose: components.Prose }),
      ),
    );

  /**
   * One short sentence about what the run is doing, for somebody who cannot see
   * the buttons change.
   *
   * Keyed on the state so it remounts and re-announces, and rendered only
   * while a run is in flight: a status region that said "running" to an idle
   * panel would be announcing the absence of news.
   */
  const RunAnnouncer: Component<{ driving: Driving }> = ({ driving }) => {
    const said =
      driving.runState === "paused"
        ? "Run paused"
        : driving.runState === "awaiting-approval"
          ? "Waiting for you"
          : "Run continuing";
    return h("div", {
      key: said,
      role: "status",
      style: SR_ONLY,
      children: driving.busy ? said : "",
    });
  };

  const RunControlsBar: PanelComponents["RunControlsBar"] = ({ driving }) => {
    if (!driving.busy) return null;
    const held = driving.runState === "paused";
    return h(
      "div",
      { className: "dk-run", "data-dk": "controls" },
      h(
        "button",
        {
          key: "pause",
          type: "button",
          className: "dk-pause",
          "aria-label": held ? "Resume the run" : "Pause the run",
          onClick: () => (held ? driving.resume() : driving.pause()),
        },
        held ? "Resume" : "Pause",
      ),
      h(
        "button",
        { key: "step", type: "button", className: "dk-once", onClick: () => driving.step() },
        "Step",
      ),
      // Stop is the abort signal and nothing else, which is also why it is not
      // on `RunControls`: an abort outranks a pause, so a held run is still
      // stoppable and never wedged.
      h(
        "button",
        { key: "stop", type: "button", className: "dk-stop", onClick: () => driving.stop() },
        "Stop",
      ),
      // The pace, visibly and changeably, because the person watching their own
      // screen move is the one who should decide how fast it moves. Named
      // speeds rather than a free slider: a number of milliseconds is not a
      // thing anybody has an opinion about, and a radio group of four labelled
      // buttons is reachable with a keyboard without anybody being careful
      // about it forever.
      h(
        "div",
        { key: "pace", className: "dk-speeds", role: "radiogroup", "aria-label": "Pace" },
        SPEEDS.map((speed) =>
          h(
            "button",
            {
              key: speed.id,
              type: "button",
              role: "radio",
              "aria-checked": nearest(driving.paceMs).id === speed.id,
              className: "dk-speed",
              onClick: () => driving.setPace(speed.ms),
            },
            speed.label,
          ),
        ),
      ),
      h(
        "span",
        { key: "note", className: "dk-run-note" },
        driving.runState === "paused"
          ? "Paused"
          : // Not "running": the run is waiting for the person, and a panel
            // that said "running" there would be telling them to wait for the
            // thing that is waiting for them.
            driving.runState === "awaiting-approval"
            ? "Waiting for you"
            : `${nearest(driving.paceMs).label} · ${driving.paceMs} ms a step`,
      ),
      h(RunAnnouncer, { key: "live", driving }),
    );
  };

  const Composer: PanelComponents["Composer"] = ({ driving, placeholder }) => {
    const [draft, setDraft] = react.useState("");
    return h(
      "form",
      {
        className: "dk-form",
        onSubmit: (e: { preventDefault: () => void }) => {
          e.preventDefault();
          const text = draft.trim();
          if (text === "" || driving.busy) return;
          setDraft("");
          void driving.ask(text);
        },
      },
      h("input", {
        key: "input",
        type: "text",
        className: "dk-input",
        value: draft,
        ...(placeholder === undefined ? {} : { placeholder }),
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      }),
      h(
        "button",
        { key: "send", type: "submit", className: "dk-send", disabled: driving.busy },
        "Send",
      ),
    );
  };

  /**
   * The session's ceiling, where the app declared one.
   *
   * The one thing on the panel with no control beside it, and the reason
   * `Driver.budget` exists at all: `MountOptions.budget` is set by whoever
   * mounted the app, and a viewer must not be able to raise their own ceiling.
   * Shown before the ceiling is reached rather than only after, because a run
   * that stops mid-job and does not say why is read as a broken app.
   *
   * Absent when the app declared no ceiling. A line reading "no limit" would be
   * one more thing to read; the counter is still on `Driver.budget` for anybody
   * debugging.
   */
  const BudgetNotice: PanelComponents["BudgetNotice"] = ({ driving }) => {
    const spend = driving.budget;
    if (!spend) return null;
    const parts: string[] = [];
    if (spend.calls.limit !== undefined) {
      parts.push(`${spend.calls.used} of ${spend.calls.limit} steps used`);
    }
    if (spend.commits.limit !== undefined) {
      parts.push(`${spend.commits.used} of ${spend.commits.limit} changes to data used`);
    }
    if (parts.length === 0) return null;
    return h(
      "div",
      { className: "dk-budget", "data-dk": "budget" },
      h("span", { key: "l", className: "dk-budget-label" }, "This session's limit"),
      h("span", { key: "v", className: "dk-budget-value" }, parts.join(" · ")),
      h(
        "span",
        { key: "w", className: "dk-budget-why" },
        "Set by the app, not by this panel, so it cannot be changed from here.",
      ),
    );
  };

  /** The standing rules, and a way to take one back. A grant nobody can see is
   *  a grant nobody can revoke. */
  const GrantList: PanelComponents["GrantList"] = ({ driving }) => {
    if (driving.grants.length === 0) return null;
    return h(
      "div",
      { className: "dk-grants", "data-dk": "grants" },
      h("span", { key: "l" }, "Standing rules for this session"),
      h(
        "ul",
        { key: "u" },
        driving.grants.map((grant) =>
          h(
            "li",
            { key: grant.verb },
            grant.rule,
            h(
              "button",
              {
                key: "r",
                type: "button",
                onClick: () => driving.revoke(grant.verb),
              },
              "Revoke",
            ),
          ),
        ),
      ),
    );
  };

  const components: PanelComponents = {
    Transcript,
    Said,
    StepRow,
    ApprovalCard,
    RunControlsBar,
    Composer,
    BudgetNotice,
    GrantList,
    Prose,
  };

  const DriverPanel: Component<DriverPanelProps> = (props) => {
    const driving = useDriver(props.driver, props.options);
    const parts: PanelComponents = {
      ...components,
      ...props.components,
      ...(props.Prose === undefined ? {} : { Prose: props.Prose }),
    };
    return h(
      "div",
      { className: "dk-panel", "data-dk": "panel" },
      h(parts.Transcript, {
        key: "log",
        driving,
        components: parts,
        notes: props.options.notes === true,
      }),
      h(parts.RunControlsBar, { key: "controls", driving }),
      h(parts.GrantList, { key: "grants", driving }),
      h(parts.BudgetNotice, { key: "budget", driving }),
      h(parts.Composer, {
        key: "composer",
        driving,
        ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
      }),
    );
  };

  return { useDriver, DriverPanel, components };
}

/**
 * The named speeds, re-declared for the same reason `COMMIT_ASK_ABOVE` is:
 * `src/widget/settings.ts` is the vanilla panel's, and importing it would pull
 * that area's `localStorage` access and its DOM types into a React bundle.
 * `test/react.test.ts` pins that the two lists agree.
 */
const SPEEDS: ReadonlyArray<{ id: string; label: string; ms: number }> = [
  { id: "fast", label: "Fast", ms: 250 },
  { id: "steady", label: "Steady", ms: 600 },
  { id: "slow", label: "Slow", ms: 1500 },
  { id: "crawl", label: "Crawl", ms: 3000 },
];

function nearest(ms: number): { id: string; label: string; ms: number } {
  let best = SPEEDS[0]!;
  for (const speed of SPEEDS) {
    if (Math.abs(speed.ms - ms) < Math.abs(best.ms - ms)) best = speed;
  }
  return best;
}

/** The arguments, short. Same shape and same clamp as the vanilla panel's, so
 *  one row does not read differently in the two. */
function argSummary(args: Record<string, Scalar>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${String(v)}`);
  if (parts.length === 0) return "";
  const text = parts.join(" ");
  return ` ${text.length > 60 ? text.slice(0, 57) + "…" : text}`;
}

function grantLabel(verb: string, allow: boolean): string {
  return allow ? `Always allow “${verb}”` : `Always refuse “${verb}”`;
}
