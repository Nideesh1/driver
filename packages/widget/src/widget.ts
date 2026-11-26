/**
 * driverkit/widget — the corner panel.
 *
 * Plain DOM. No React, no framework, no dependencies, because the whole point
 * is that it drops into an app somebody else built with tools nobody here
 * chose. A React widget is unusable in a Vue app and a Vue widget is unusable
 * in a Rails app, and either way the host now owns a version of a framework it
 * did not pick.
 *
 * It is also the file people will read to decide whether to trust the library,
 * so it is kept short and literal: one function, one tree of elements built by
 * hand, and every decision that is not obvious written down beside it.
 *
 * **What it adds over `drive` alone is visibility.** The loop is headless and
 * correct and would happily move a person's screen without saying a word. A
 * person watching their own app change under them needs to see what changed
 * it; silent mutation is alarming even when it is right, and it is the
 * difference between "the agent accepted two hundred rows" and "something
 * accepted two hundred rows". So every verb that runs appears in the
 * transcript, labelled with what it did to the world and what it answered.
 *
 * **And what it adds over visibility is time.** Seeing a verb after it ran is
 * not the same as being able to stop it. So the panel renders the run as a
 * step list — one row per call, appearing while the call is still pending —
 * paces the run slowly enough to follow, and puts Pause, Step and Stop beside
 * it. The pace, the step-every-call mode, the outlining of the element a call
 * is about, and the commit confirmation are all the person's to change in a
 * settings view under the ⚙, remembered per viewer. Everything about that
 * surface is one judgement: the person watching their own screen move is the
 * one who should be deciding how fast it moves.
 *
 * **What it does not do is hold a key.** `think` is the host app's function,
 * exactly as in `@driverkit/agent`; see that package's `types.ts` for why, and
 * `backendThink` for the thirty lines that make the realistic deployment work.
 */

import type { Driver } from "driverkit";
// The only cross-package VALUE import in the repository. Everything else
// between packages is `import type`, which `verbatimModuleSyntax` erases
// outright -- so this one line is the whole reason `@driverkit/widget` needs
// `@driverkit/agent` as a runtime dependency and not a types-only one.
import { commas, drive, runControls } from "@driverkit/agent";
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
} from "@driverkit/agent";
import { CSS } from "./css.ts";
import type {
  AbortControllerCtor,
  DocumentLike,
  ElementLike,
  NodeLike,
  StorageLike,
  WindowLike,
} from "./dom.ts";
import { spotlight } from "./highlight.ts";
import { defaultStorage, positioner } from "./position.ts";
import type { Fraction, Position } from "./position.ts";
import {
  SPEEDS,
  defaults as defaultSettings,
  load as loadSettings,
  nearestSpeed,
  pace as clampPace,
  save as saveSettings,
} from "./settings.ts";
import type { Settings } from "./settings.ts";

/**
 * How the panel gets a control surface, which is `runControls` by default.
 *
 * An option because `RunControls` is an interface and not only a factory: the
 * agent package says in as many words that a host with its own control surface
 * — a queue, a remote operator, a test — may implement it and `drive` will
 * drive it. The panel's buttons then drive that instead, and nothing here
 * needs to know the difference.
 */
export type RunControlsFactory = (options: RunControlsOptions) => RunControls;


export interface WidgetOptions
  extends Pick<DriveOptions, "think" | "instructions" | "maxSteps" | "refusalLimit"> {
  /**
   * Your own confirmation, replacing the built-in one.
   *
   * It overrides rather than stacks: a host that supplies this has said how it
   * wants to ask, and showing its dialog and then the panel's own row would be
   * two questions about one commit, which is how people learn to click yes
   * without reading. Supplying this also means `confirmCommits` is moot — your
   * function is called for every commit either way.
   */
  onBeforeCommit?: DriveOptions["onBeforeCommit"];
  /** Shown in the header and on the launcher. Defaults to the app name from
   *  the manifest, which is already a name a human recognises. */
  title?: string;
  /** The first line in the transcript. Defaults to a line naming the app. */
  greeting?: string;
  placeholder?: string;
  /** Start open. Default closed: a panel that opens itself is a panel over
   *  something the person was reading. */
  open?: boolean;
  /** Where to put the host element. Default `document.body`. */
  container?: ElementLike;
  /** Injected browser, defaulting to the real one. See `dom.ts` — this is a
   *  design requirement, not a testing shim. */
  document?: DocumentLike;
  /** The viewport, for the clamp and for `prefers-reduced-motion`. Default
   *  `globalThis`. */
  window?: WindowLike;
  /** Where a remembered position and the settings are kept. Default
   *  `localStorage`, if reaching for it does not throw. */
  storage?: StorageLike;
  AbortController?: AbortControllerCtor;
  /**
   * Where the panel starts: one of the four corners, or `{ x, y }` pixels from
   * the top-left of the viewport.
   *
   * Leave it out and the stylesheet decides — `--dk-x` and `--dk-y` on
   * `:host`, bottom-right by default — which is the only way a host app can
   * place the panel from its own CSS without JavaScript. Passing anything here
   * writes those properties inline and takes that away, so it is worth not
   * passing it unless you mean it.
   *
   * A remembered position beats this one, because this is the author's idea of
   * where the panel goes and that is where this particular person put it.
   * `{ x, y }` is converted to a fraction of the free space against the
   * viewport it was measured in; see `position.ts` for why nothing is kept in
   * pixels.
   */
  position?: Position;
  /** Default true. False nails the panel to wherever the option and the
   *  stylesheet put it — for an app that has its own idea about chrome. */
  draggable?: boolean;
  /** How close to a corner a drop has to be to land in it, in pixels. Default
   *  72. 0 switches snapping off. */
  snapThreshold?: number;
  /** Remember the position and the settings in `localStorage`, per app and per
   *  viewer. Default true. Every read and write is wrapped: storage throws in a private window
   *  and with site data blocked, and a chat panel that fails to render because
   *  it could not remember where it was is a much worse bug than one that
   *  opens in the default corner. */
  persist?: boolean;
  /** Must match `--dk-gap`, the inset the CSS arithmetic uses. Only worth
   *  passing if the host app overrode that property. */
  gap?: number;
  /**
   * Ask the person before every `commit` verb. **Default true.**
   *
   * This is the one place where the widget's default differs from `drive`'s,
   * and the difference is deliberate. `drive` is a library primitive and a
   * headless caller may have its own policy, so it gates nothing unless asked.
   * The widget is a chatbot in the corner of somebody's screen, and a person
   * watching a chatbot move their own app should not find out about a thousand
   * accepted rows afterwards.
   *
   * The cost of the gate is one question, not one per row: a `commit` verb
   * takes no predicate and acts on the whole current selection, so accepting a
   * thousand contacts is one call and therefore one prompt. That makes this
   * the cheapest possible place to put a human in front of the expensive
   * failure.
   *
   * Set it false to opt out — for an app whose commits are all small and
   * reversible, where a question every time is noise that teaches people to
   * click through questions.
   */
  confirmCommits?: boolean;
  /**
   * Where Pause, Resume and Step are sent. Default `runControls`.
   *
   * Built once per run, because "paused" is a statement about a run: a surface
   * that remembered a pause from the last one would silently hold the next.
   * Stop is not on it — stopping is the abort signal, which it always was.
   */
  controls?: RunControlsFactory;
  /** The timer the pace waits on. Default `setTimeout`, via the agent
   *  package's `realClock`. Injectable for the same reason every other global
   *  here is: a suite that actually slept its paces would be a slow suite, and
   *  a slow suite is a suite nobody runs. */
  clock?: Clock;
  /**
   * The starting delay between steps, in milliseconds. Default
   * `WATCHABLE_PACE`.
   *
   * It is a starting value and not a setting: this is the person's to change,
   * in the settings view, and once they have changed it their choice is
   * remembered and outranks this. See `SPEEDS` in `settings.ts` for why the
   * offered range is 250ms to 3s.
   *
   * Note which way the default falls. `drive` paces nothing by default,
   * because it is also driven by backend jobs with nobody watching; the widget
   * paces by default, because a panel in a page has a person in front of it
   * and the whole reason it exists is that they should be able to see what is
   * being done to their screen in time to stop it.
   */
  pace?: number;
  /** A failed `think` lands here as well as in the transcript. Default:
   *  ignore it. */
  onError?: (err: unknown) => void;
}

export interface Widget {
  unmount: () => void;
  open: () => void;
  close: () => void;
  /** Ask something as if it had been typed. Returns when the run ends. */
  ask: (text: string) => Promise<void>;
  /** Move the panel, as `WidgetOptions.position`. Persisted like a drag. */
  moveTo: (position: Position) => void;
  /** Where the panel is, as fractions of the free space in `[0, 1]`, or null
   *  while nobody has moved it and the stylesheet is still in charge. */
  position: () => Fraction | null;
}

const STOP_NOTE: Record<StopReason, string | null> = {
  // Nothing to add: the model's own prose is already in the transcript.
  answered: null,
  silent: "The model replied with nothing. That is usually a bug in `think`.",
  // Named in the transcript rather than logged, because the person is the one
  // who has to decide whether to ask again. A run that quietly stops looks
  // like a run that is still thinking.
  "max-steps": "Stopped: this took more steps than allowed. Ask again, more specifically.",
  stuck: "Stopped: the same call kept being refused, so going on would not have helped.",
  aborted: "Stopped.",
};

/**
 * Put a chat panel in the corner of the app and let it drive the app.
 *
 * ```ts
 * const panel = mountWidget(driver, { think: backendThink("/api/chat") });
 * // later
 * panel.unmount();
 * ```
 *
 * Every `commit` verb is confirmed with the person by default, in the panel,
 * with the count the preceding `describe` reported. See `confirmCommits`.
 */
export function mountWidget(driver: Driver, options: WidgetOptions): Widget {
  const doc = options.document ?? (globalThis as { document?: DocumentLike }).document;
  if (!doc) throw new Error("driverkit: no document; pass one");
  const Abort =
    options.AbortController ??
    (globalThis as { AbortController?: AbortControllerCtor }).AbortController;

  const manifest = driver.manifest();
  const app = options.title ?? manifest.app;

  // One place, shared with positioning, because two storage mechanisms would
  // be two places to get the try/catch wrong. `persist: false` means neither
  // the position nor the settings are remembered.
  const storage = options.persist === false ? undefined : (options.storage ?? defaultStorage());

  // The person's choices beat the host's options, because the host's options
  // are an author's default and these are what this particular viewer, looking
  // at their own screen, decided.
  const settings: Settings = loadSettings(storage, app, {
    ...defaultSettings(options.confirmCommits !== false),
    ...(options.pace === undefined ? {} : { pace: clampPace(options.pace) }),
  });

  const host = doc.createElement("div");
  // A class on the host element, in the light DOM, because the positioning
  // state has to be visible to `:host(...)` selectors inside the shadow tree
  // and that is the only place a shadow tree can read anything from.
  host.className = "dk-host";
  // A shadow root if there is one, the host element itself if not. The
  // fallback is honest rather than ideal: without a shadow tree the host app's
  // CSS can reach these elements, so the panel may look wrong. Refusing to
  // mount would be worse — a chat panel is not worth failing an app's boot
  // over — and the class names are all prefixed so nothing collides.
  const root: NodeLike = host.attachShadow
    ? host.attachShadow({ mode: "open" })
    : (host as NodeLike);

  const style = doc.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  // One wrapper inside the shadow root, because the open/busy state is a class
  // and a shadow root cannot carry one.
  const wrap = el("div", "dk-wrap");
  root.appendChild(wrap);

  // In the document BEFORE the rest is built, which positioning depends on:
  // `getBoundingClientRect` on an element that is not in the document answers
  // zero for everything, and a clamp that believes the panel is 0x0 will
  // happily leave it half off the screen. Everything below is appended into a
  // live tree, which costs one synchronous reflow and buys a measurable box.
  (options.container ?? doc.body).appendChild(host);

  const launcher = el("button", "dk-launcher");
  launcher.textContent = `Ask ${app}`;
  launcher.setAttribute("type", "button");
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.setAttribute("aria-expanded", "false");
  wrap.appendChild(launcher);

  const panel = el("section", "dk-panel");
  // Not `aria-modal`: the person is meant to keep using the app while this is
  // open, and claiming modality would tell a screen reader to hide the rest of
  // the page — the opposite of what a panel that drives that page wants.
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", `${app} assistant`);
  wrap.appendChild(panel);

  const head = el("div", "dk-head");
  const title = el("div", "dk-title");
  title.textContent = app;
  // The grab affordance AND the keyboard control, which is deliberate: a
  // shortcut nobody can see is a shortcut nobody uses, and a drag handle with
  // no focusable element in it is a feature that exists only for people with a
  // mouse. One button answers both.
  const move = el("button", "dk-move");
  move.textContent = "Move";
  move.setAttribute("type", "button");
  move.setAttribute("aria-label", "Move panel: arrow keys to nudge, Enter for the next corner");
  move.setAttribute("title", "Drag to move. Arrow keys to nudge, Enter for the next corner, Alt (Option) and an arrow from anywhere.");
  // A glyph, not the word "Settings". The header is the drag handle as well as
  // the chrome, and a title plus three labelled buttons is a strip with
  // nowhere left to grab. It is still a real button with a real label.
  const gear = el("button", "dk-gear");
  gear.textContent = "\u2699";
  gear.setAttribute("type", "button");
  gear.setAttribute("aria-label", "Settings");
  gear.setAttribute("title", "Settings: speed, highlighting, step mode, confirmations");
  // `aria-expanded` and not `aria-pressed`: this discloses a panel section
  // rather than turning something on, and claiming both would be two
  // different promises about one button.
  gear.setAttribute("aria-expanded", "false");
  const close = el("button", "dk-x");
  close.textContent = "Close";
  close.setAttribute("type", "button");
  head.appendChild(title);
  head.appendChild(gear);
  head.appendChild(move);
  head.appendChild(close);
  panel.appendChild(head);

  // The run controls, directly above the step list they act on, and only while
  // a run is in flight.
  const bar = el("div", "dk-run");
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Run controls");
  const pause = el("button", "dk-pause");
  pause.textContent = "Pause";
  pause.setAttribute("type", "button");
  const once = el("button", "dk-once");
  once.textContent = "Step";
  once.setAttribute("type", "button");
  once.setAttribute("title", "Run one more call, then wait");
  const note = el("div", "dk-run-note");
  bar.appendChild(pause);
  bar.appendChild(once);
  bar.appendChild(note);
  panel.appendChild(bar);

  // Outside the panel on purpose: a live region inside a `display: none` panel
  // is not announced at all, and moving the COLLAPSED widget is exactly the
  // case that needs announcing.
  const status = el("div", "dk-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  wrap.appendChild(status);

  const log = el("div", "dk-log");
  // `log`, not `alert`: entries are announced as they arrive and do not
  // interrupt. `polite` for the same reason — the person may be typing.
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  panel.appendChild(log);

  // ---- the settings view -------------------------------------------------
  //
  // In the panel and not a window of its own: it is four preferences, and the
  // person is already looking here. It replaces the transcript rather than
  // covering it, so nothing is half-readable behind it, and the header stays
  // put so the panel can still be dragged out of the way while it is open.

  const settingsView = el("div", "dk-settings");
  settingsView.setAttribute("role", "group");
  settingsView.setAttribute("aria-label", "Settings");
  panel.appendChild(settingsView);

  const speedRow = setRow(
    "Speed",
    "How long the agent waits between steps, so you can see each one before the next.",
  );
  const speeds = el("div", "dk-speeds");
  speeds.setAttribute("role", "radiogroup");
  speeds.setAttribute("aria-label", "Speed");
  const speedButtons = SPEEDS.map((speed) => {
    const button = el("button", "dk-speed");
    button.textContent = speed.label;
    button.setAttribute("type", "button");
    button.setAttribute("role", "radio");
    button.setAttribute("title", `${speed.ms} ms between steps`);
    button.addEventListener("click", () => setPace(speed.ms));
    speeds.appendChild(button);
    return { speed, button };
  });
  speedRow.appendChild(speeds);
  settingsView.appendChild(speedRow);

  const highlightRow = setRow(
    "Highlight",
    "Outline the thing on screen a step is about to touch, when the app named one. Many verbs name nothing, and those are simply not outlined.",
  );
  highlightRow.appendChild(
    toggle(
      "dk-t-highlight",
      "Outline what a step will touch",
      () => settings.highlight,
      (on) => {
        settings.highlight = on;
        // Immediately, not at the next step: somebody switching this off is
        // looking at an outline they want gone.
        if (!on) spot.hide();
      },
    ),
  );
  settingsView.appendChild(highlightRow);

  const stepRow = setRow(
    "Step mode",
    "Wait for you before every single call, not just after a pause. Slow, and the right setting the first time you watch this drive something that matters.",
  );
  stepRow.appendChild(
    toggle("dk-t-stepmode", "Ask before every call", () => settings.stepMode, (on) => {
      settings.stepMode = on;
      // Step mode is not a mode the controls have: it IS "paused, and stepped
      // one call at a time", which is why turning it on mid-run holds the run
      // and turning it off lets it go. The next run starts in the right state
      // because `runControls` is built with it.
      if (on) active?.pause();
      else active?.resume();
    }),
  );
  settingsView.appendChild(stepRow);

  // Hidden when the host supplied its own confirmation: that option overrides
  // this one outright, so a switch here would be a switch that does nothing.
  if (!options.onBeforeCommit) {
    const commitRow = setRow(
      "Confirm commits",
      "Ask before any step that changes data. One question per call, not per row — a commit acts on the whole selection.",
    );
    commitRow.appendChild(
      toggle("dk-t-commits", "Ask before changing data", () => settings.confirmCommits, (on) => {
        settings.confirmCommits = on;
      }),
    );
    settingsView.appendChild(commitRow);
  }

  const done = el("button", "dk-done");
  done.textContent = "Done";
  done.setAttribute("type", "button");
  done.addEventListener("click", () => setSettingsOpen(false));
  settingsView.appendChild(done);

  const form = el("form", "dk-form");
  const input = el("input", "dk-input");
  input.setAttribute("type", "text");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-label", `Ask ${app} to do something`);
  input.setAttribute("placeholder", options.placeholder ?? `Ask ${app} to do something…`);
  const send = el("button", "dk-send");
  send.textContent = "Send";
  send.setAttribute("type", "submit");
  const stop = el("button", "dk-stop");
  stop.textContent = "Stop";
  stop.setAttribute("type", "button");
  form.appendChild(input);
  form.appendChild(send);
  form.appendChild(stop);
  panel.appendChild(form);

  say("dk-note", options.greeting ?? `Ask me to do things in ${app}. I use the app the way you do.`);

  // The conversation lives here, not in `drive`: the loop is stateless between
  // runs, so a widget is simply the thing that remembers.
  let messages: Turn[] = [];
  let running: InstanceType<AbortControllerCtor> | null = null;
  let live = true;
  /** The control surface for the run in flight, or null between runs.
   *  "Paused" has no meaning between runs, which is why this is per run. */
  let active: RunControls | null = null;
  /** What the loop last said it was doing. Never inferred from the panel's own
   *  buttons: `drive` moves this too — a spent step permit leaves the run
   *  paused again, and the commit gate parks it in `awaiting-approval` — and a
   *  panel that tracked its own presses would be wrong in exactly those
   *  cases. */
  let runState: RunState = "running";
  // The wrapper's classes, as flags. Written in one place and in one order,
  // because three separate string edits to `className` is three chances for
  // one of them to drop another's class.
  let isOpen = false;
  let isBusy = false;
  let isSettings = false;

  // ---- wiring ------------------------------------------------------------

  // Positioning. Built before the wiring because the launcher's click handler
  // has to ask it whether that click is really the tail of a drag.
  const place = positioner({
    host,
    app,
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.window === undefined ? {} : { window: options.window }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.persist === undefined ? {} : { persist: options.persist }),
    ...(options.draggable === undefined ? {} : { draggable: options.draggable }),
    ...(options.snapThreshold === undefined ? {} : { snapThreshold: options.snapThreshold }),
    ...(options.gap === undefined ? {} : { gap: options.gap }),
    announce: (text) => {
      status.textContent = text;
    },
  });

  // The outline over the element a step is about to touch. Its own host
  // element, because the panel's is translated and a transformed ancestor
  // becomes the containing block for `position: fixed` children; see
  // `highlight.ts`. Nothing is written to the host app's own elements.
  const spot = spotlight({
    document: doc,
    container: options.container ?? doc.body,
    ...(options.window === undefined ? {} : { window: options.window }),
  });

  // The header drags the panel, and `"ignore"` is what keeps the buttons in it
  // clickable: a press that starts on Close — or on the gear — is that
  // button's, even if the hand moves two pixels before it lifts.
  place.handle(head, "ignore");
  // The move button is its own handle, so the thing that LOOKS like a grip is
  // a grip.
  const movedMove = place.handle(move);
  // And the launcher, because a collapsed widget is over the app just as much
  // as an open one.
  const movedLauncher = place.handle(launcher);

  launcher.addEventListener("click", () => {
    // A drag is not a click. Without this, shoving the collapsed launcher off
    // the rows somebody wants to read opens the panel back over them.
    if (movedLauncher()) return;
    setOpen(true);
  });
  close.addEventListener("click", () => setOpen(false));
  gear.addEventListener("click", () => setSettingsOpen(!isSettings));
  pause.addEventListener("click", () => {
    if (runState === "paused") active?.resume();
    else active?.pause();
    // Not painted here. The loop answers through `onControl`, and it is the
    // only thing that knows — including in the case where a run ended between
    // the person deciding to press this and pressing it.
  });
  once.addEventListener("click", () => active?.step());
  move.addEventListener("click", () => {
    if (movedMove()) return;
    place.cycle();
  });
  // Bare arrows, and only here, where the panel's own control has focus. Alt
  // is left to the wrapper's handler so the two do not both act on one press.
  move.addEventListener("keydown", (e) => {
    if (e.altKey === true) return;
    place.key(e, true);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault?.();
    const text = (input.value ?? "").trim();
    if (!text) return;
    input.value = "";
    void ask(text);
  });

  // Stop is the abort signal and nothing else, which is also why it is not on
  // `RunControls`: an abort outranks a pause, so a held run is still stoppable
  // and never wedged.
  stop.addEventListener("click", () => running?.abort());

  // On the wrapper and not on the input, so Escape closes the panel from
  // anywhere inside it — the transcript, the buttons, the input. Keydown
  // bubbles, and a handler per focusable element would be three handlers that
  // drift apart.
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault?.();
      setOpen(false);
      return;
    }
    // Alt+arrow, from anywhere in the widget including the collapsed launcher
    // and including the text input mid-sentence. Dragging is pointer-only and
    // a panel that can only be moved with a mouse cannot be moved at all by
    // the people most likely to be stuck behind it.
    place.key(e);
  });

  paintSpeeds();
  show("running");
  if (options.open) setOpen(true);

  // ---- the run -----------------------------------------------------------

  async function ask(text: string): Promise<void> {
    if (!live || running) return;
    say("dk-you", text);

    const controller = Abort ? new Abort() : null;
    running = controller;
    busy(true);

    // One control surface per run, started paused if step mode is on — which
    // is all step mode is, and deliberately so: a separate flag beside the
    // state would be a second source of truth able to disagree with it.
    const control = (options.controls ?? runControls)({
      pace: settings.pace,
      stepMode: settings.stepMode,
    });
    active = control;
    show("running");

    // One step per call, keyed by the model's call id so a turn with several
    // calls does not cross its wires.
    const steps = new Map<string, Step>();

    // The last count a `describe` verb reported in this run, and the reason the
    // confirmation row is worth building at all: "accept the current
    // selection?" is a question nobody can answer, and "accept 1,000
    // contacts?" is one anybody can. Only from a `describe` — a count from a
    // `read` verb is about something else — and cleared once a commit has been
    // asked about, because that selection has now been spoken for.
    let lastCount: number | undefined;

    // Always installed when the host has not replaced it, and the SETTING is
    // read inside — so turning confirmations off, or back on, in the middle of
    // a run takes effect on the next commit rather than the next run. That is
    // what somebody who has just watched a commit go past expects of the
    // switch they reached for.
    const gate = options.onBeforeCommit ?? confirmCommit;

    /** The built-in gate. Renders a question in the transcript and waits. */
    function confirmCommit(req: CommitRequest): Promise<CommitDecision> {
      if (!settings.confirmCommits) return Promise.resolve(true);
      // A question nobody can see is not a question. The person may have hit
      // Escape while the model was thinking, or be reading the settings view.
      setOpen(true);
      setSettingsOpen(false);

      // `Snapshot.selectedCount` as the fallback, because a commit verb takes
      // no predicate and acts on the current selection — so the size of that
      // selection is the number this question is about, whether or not a
      // `describe` verb happened to report one in this run. It matters most in
      // the case where `lastCount` is missing for a good reason: the person
      // selected the rows themselves, or did it in an earlier run.
      const count = lastCount ?? req.snapshot.selectedCount;

      const row = el("div", "dk-ask");
      const question = el("div", "dk-ask-q");
      question.textContent =
        count === undefined
          ? `${req.verb.describe}?`
          : `${req.verb.describe} — ${commas(count)} rows?`;
      const why = el("div", "dk-ask-why");
      why.textContent =
        "This changes data and may be irreversible." +
        (count === undefined
          ? " No count was reported, so nobody can tell you how many rows it affects."
          : "") +
        argSummary(req.args);
      const yes = el("button", "dk-yes");
      yes.textContent = "Yes, do it";
      yes.setAttribute("type", "button");
      const no = el("button", "dk-no");
      no.textContent = "No";
      no.setAttribute("type", "button");

      row.appendChild(question);
      row.appendChild(why);
      row.appendChild(no);
      row.appendChild(yes);
      log.appendChild(row);
      scroll();
      // Focus the safe answer, not the destructive one. A person pressing
      // Enter on a dialog that appeared while they were typing should not
      // thereby accept a thousand rows; reaching "Yes" takes one deliberate
      // key.
      no.focus?.();

      lastCount = undefined;

      return new Promise<CommitDecision>((resolve) => {
        let answered = false;
        const answer = (decision: CommitDecision, said: string): void => {
          if (answered) return;
          answered = true;
          // The buttons go and the answer stays. Scrolling back through a
          // transcript and finding a live "Yes, do it" button beside something
          // that already happened is worse than no record at all.
          yes.remove();
          no.remove();
          const outcome = el("div", "dk-ask-said");
          outcome.textContent = said;
          row.appendChild(outcome);
          scroll();
          resolve(decision);
        };

        yes.addEventListener("click", () => answer(true, "You allowed this."));
        no.addEventListener("click", () => answer(false, "You said no."));
        // Stop, or unmount, while a question is open. Without this the loop
        // waits on a promise nobody will ever resolve and the panel is stuck
        // busy forever — the abort has to answer the question, and the only
        // safe answer is no.
        controller?.signal.addEventListener?.("abort", () =>
          answer("the run was stopped before this ran", "Stopped before this ran."),
        );
      });
    }

    const paced: DriveOptions = {
      think: options.think,
      task: text,
      history: messages,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.refusalLimit === undefined ? {} : { refusalLimit: options.refusalLimit }),
      onBeforeCommit: gate,
      ...(controller ? { signal: controller.signal } : {}),

      controls: control,
      // The person's remembered speed, which `setPace` then changes live on the
      // controls. Passed here as well because `drive`'s own option is what a run
      // starts from, and a panel that only set it afterwards would pace its
      // first call differently from its second.
      pace: settings.pace,
      ...(options.clock === undefined ? {} : { clock: options.clock }),

      // A step appears HERE: `onBeforeCall` fires before the pace wait and
      // before any hold, which is the only way "you can see it coming and stop
      // it" is true rather than aspirational. `onCall` is then the moment the
      // app is actually touched, and `onResult` the outcome — the three states
      // of one row.
      onBeforeCall: (e) => {
        mark(step(steps, e), "pending");
        aim(e);
      },
      onCall: (e) => {
        mark(step(steps, e), "running");
        aim(e);
      },
      onControl: ({ state }) => show(state),
      onResult: ({ call, kind, result }) => {
        if (kind === "describe" && result?.ok) lastCount = result.count;
        // The step stops being highlighted the moment it is over, whatever
        // the outcome. An outline left behind is an outline about nothing.
        spot.hide();
        const entry = steps.get(call.id);
        if (!entry) return;
        if (result === null) {
          outcome(entry, " · looked", "done");
          return;
        }
        if (result.ok) {
          // The count is repeated here on purpose. It is the number the
          // commit decision turns on, and the person watching should be able
          // to see "1,000 matched" without reading the model's summary of
          // it.
          outcome(
            entry,
            " · ok" + (result.count === undefined ? "" : ` · ${commas(result.count)} matched`),
            "done",
          );
        } else {
          // A refusal is an OUTCOME and not an error. The app said no, on
          // purpose, in its own vocabulary, and the model is about to adapt
          // to it; rendering it as a failure would teach the person to read
          // a working app as a broken one.
          outcome(entry, ` · refused: ${result.refused}`, "refused");
        }
      },
      onSay: ({ text: prose }) => say("dk-me", prose),
    };

    try {
      const out = await drive(driver, paced);

      messages = out.messages;
      const note = STOP_NOTE[out.stop];
      if (note) say("dk-note", note);
    } catch (err) {
      // A `think` that throws — a 500 from the app's own backend, usually. Said
      // in the transcript as well as handed to `onError`, because the person is
      // sitting in front of a panel that just went quiet and the console is
      // not where they are looking.
      options.onError?.(err);
      say("dk-note", `Something went wrong talking to the model: ${message(err)}`);
    } finally {
      running = null;
      active = null;
      show("running");
      spot.hide();
      // Pending rows for calls that never ran. A stop during a pace wait or a
      // hold abandons them unrun and no `onResult` is coming, so leaving them
      // mid-flight would be a panel saying something is about to happen when
      // the run is already over.
      for (const entry of steps.values()) {
        if (entry.line.className.includes("dk-step-pending")) {
          outcome(entry, " · not run", "skipped");
        }
      }
      busy(false);
      if (live) input.focus?.();
    }
  }

  // ---- bits --------------------------------------------------------------

  function el(tag: string, className: string): ElementLike {
    const node = doc!.createElement(tag);
    node.className = className;
    return node;
  }

  function say(className: string, text: string): ElementLike {
    const line = el("div", className);
    line.textContent = text;
    log.appendChild(line);
    scroll();
    return line;
  }

  /** One row of the step list, created the first time a call is mentioned and
   *  returned every time after, so the plan and the call and the result are
   *  three states of ONE row rather than three rows about one call. */
  function step(steps: Map<string, Step>, e: CallEvent): Step {
    const { call, kind } = e;
    const found = steps.get(call.id);
    if (found) return found;
    const entry: Step = {
      line: el("div", "dk-step"),
      // `commit` is marked for the person as well as in the prompt for the
      // model. Those are not the same thing, and this is the row somebody
      // scrolls back to when they want to know what changed their data.
      commit: kind === "commit",
      text: `${call.name}${kind ? ` (${kind})` : ""}${argSummary(call.args)}`,
    };
    entry.line.textContent = entry.text;
    if (entry.commit) {
      entry.line.setAttribute("title", "Changes data, and may be irreversible.");
    }
    steps.set(call.id, entry);
    log.appendChild(entry.line);
    scroll();
    return entry;
  }

  /** The state, as classes. Never as text: the row's text is the record of the
   *  call and should read the same whether somebody looked at it while it was
   *  pending or a minute afterwards. The marker is a `::before` in `css.ts`. */
  function mark(entry: Step, state: StepState): void {
    entry.line.className = `dk-step dk-step-${state}${entry.commit ? " dk-step-commit" : ""}`;
  }

  function outcome(entry: Step, said: string, state: StepState): void {
    entry.text += said;
    entry.line.textContent = entry.text;
    mark(entry, state);
    scroll();
  }

  /**
   * Outline whatever this call's `at` names, if it names anything.
   *
   * `at` is PRESENTATIONAL and this is the only thing done with it. It is
   * never used to find something to call, never clicked, never read for a
   * value, and its absence never changes what runs — which is most calls,
   * since most verbs declare no `at` at all. A selector anywhere in the
   * execution path is the failure mode this library exists to avoid; see
   * `highlight.ts`.
   */
  function aim(e: CallEvent): void {
    if (!settings.highlight) return;
    spot.show(e.at);
  }

  /** A labelled block in the settings view: what it is, and why anybody would
   *  touch it. A settings view that only names its switches is a settings view
   *  people change at random. */
  function setRow(label: string, why: string): ElementLike {
    const row = el("div", "dk-set-row");
    const name = el("div", "dk-set-label");
    name.textContent = label;
    const reason = el("div", "dk-set-why");
    reason.textContent = why;
    row.appendChild(name);
    row.appendChild(reason);
    return row;
  }

  /** A real `<button role="switch">`, so it is reachable by keyboard and
   *  announced as on or off, rather than a styled div with a click handler. */
  function toggle(
    className: string,
    label: string,
    get: () => boolean,
    set: (on: boolean) => void,
  ): ElementLike {
    const button = el("button", `dk-toggle ${className}`);
    button.textContent = label;
    button.setAttribute("type", "button");
    button.setAttribute("role", "switch");
    const paint = (): void => button.setAttribute("aria-checked", get() ? "true" : "false");
    paint();
    button.addEventListener("click", () => {
      set(!get());
      paint();
      remember();
    });
    return button;
  }

  function setPace(ms: number): void {
    settings.pace = clampPace(ms);
    paintSpeeds();
    show(runState);
    remember();
    // Live, and that is the whole reason the controls have a setter: the
    // moment somebody wants the agent slowed down is while it is going. A
    // slider that quietly applied next run would be worse than no slider —
    // they move it, nothing happens, and they conclude it is broken.
    active?.pace(settings.pace);
  }

  function paintSpeeds(): void {
    const now = nearestSpeed(settings.pace);
    for (const { speed, button } of speedButtons) {
      button.setAttribute("aria-checked", speed.id === now.id ? "true" : "false");
    }
  }

  /** What the run is doing, in the one place that says it. */
  function show(state: RunState): void {
    const was = runState;
    runState = state;
    const held = state === "paused";
    pause.textContent = held ? "Resume" : "Pause";
    pause.setAttribute("aria-label", held ? "Resume the run" : "Pause the run");
    const speed = nearestSpeed(settings.pace);
    note.textContent =
      state === "paused"
        ? "Paused"
        : // Not "running": the run is waiting for the person, and a panel that
          // said "running" there would be telling them to wait for the thing
          // that is waiting for them.
          state === "awaiting-approval"
          ? "Waiting for you"
          : `${speed.label} · ${settings.pace} ms a step`;
    // Announced on a change and only while a run is in flight. A pause is a
    // change to what the app is about to do next, and the panel is not
    // necessarily where the person is looking.
    if (isBusy && state !== was) {
      status.textContent = held ? "Run paused" : state === "awaiting-approval" ? "Waiting for you" : "Run continuing";
    }
  }

  function setSettingsOpen(next: boolean): void {
    isSettings = next;
    gear.setAttribute("aria-expanded", next ? "true" : "false");
    paintWrap();
    // Focus follows, in both directions, and lands on the first thing worth
    // changing rather than on the container.
    (next ? speedButtons[0]?.button ?? done : input).focus?.();
  }

  function remember(): void {
    saveSettings(storage, app, settings);
  }

  function scroll(): void {
    // Both guarded: `scrollHeight` does not exist on a fake and `scrollTop` is
    // a courtesy, not part of the contract.
    if (typeof log.scrollTop === "number" && typeof log.scrollHeight === "number") {
      log.scrollTop = log.scrollHeight;
    }
  }

  function paintWrap(): void {
    wrap.className = `dk-wrap${isOpen ? " dk-open" : ""}${isBusy ? " dk-busy" : ""}${
      isSettings ? " dk-set-open" : ""
    }`;
  }

  function setOpen(next: boolean): void {
    isOpen = next;
    // A closed panel is not a panel with a settings view open inside it. The
    // alternative is that reopening lands somebody in the settings instead of
    // the conversation they were having.
    if (!next) {
      isSettings = false;
      gear.setAttribute("aria-expanded", "false");
    }
    paintWrap();
    launcher.setAttribute("aria-expanded", next ? "true" : "false");
    // Focus follows the panel in both directions. A keyboard user who opens a
    // panel and is left on the launcher has to tab back through the whole app
    // to reach it, and one who closes it and is left nowhere has lost their
    // place entirely.
    (next ? input : launcher).focus?.();
  }

  function busy(on: boolean): void {
    isBusy = on;
    paintWrap();
    if (on) send.setAttribute("disabled", "disabled");
    else send.removeAttribute("disabled");
  }

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    ask,
    moveTo: place.moveTo,
    position: place.chosen,
    unmount: () => {
      // Idempotent, and it aborts a run in flight. Unmounting while a commit
      // is pending is the case worth thinking about: the abort stops the loop
      // before the next verb, but a verb already inside `driver.call()` runs
      // to completion. That is the right behaviour — tearing down a panel must
      // not leave a half-applied bulk edit — but it means `unmount` is not a
      // promise that nothing further will change.
      live = false;
      running?.abort();
      running = null;
      // Before the element goes, because the resize listener is on the window
      // and would otherwise outlive the panel it was clamping.
      place.dispose();
      // The outline has its own host element and its own window listeners, and
      // both would otherwise outlive the panel that drew them.
      spot.dispose();
      host.remove();
    },
  };
}

/** Where a step is in its life. `refused` is a kind of done — the app said no,
 *  on purpose — and not a kind of error. */
type StepState = "pending" | "running" | "done" | "refused" | "skipped";

interface Step {
  line: ElementLike;
  commit: boolean;
  /** The row's text so far, kept here rather than read back off the element,
   *  because appending to `textContent` twice is how an outcome ends up on a
   *  row twice. */
  text: string;
}

/** A short, safe rendering of a call's arguments for a step row.
 *
 *  Truncated, because an argument can be a predicate and a predicate can be
 *  long, and a trace line that wraps to four lines stops being skimmable —
 *  which is the only thing the trace is for. */
function argSummary(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${String(v)}`);
  if (!parts.length) return "";
  const text = parts.join(" ");
  return ` ${text.length > 60 ? text.slice(0, 57) + "…" : text}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
