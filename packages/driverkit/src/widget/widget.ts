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
 * exactly as in `driverkit/agent`; see that area's `types.ts` for why, and
 * `backendThink` for the thirty lines that make the realistic deployment work.
 */

import type { Approval, ApprovalRequest, Driver, Snapshot } from "../core/index.ts";
// A value import, and the only one that crosses an entry point's boundary:
// everything else between areas is `import type`, which
// `verbatimModuleSyntax` erases outright. It used to be the one line that
// forced an import map on every page loading the widget from a static host,
// because a bare `@driverkit/agent` is not something a browser can resolve.
// One package, one relative path, and that problem is gone -- see the
// packaging test, which pins that the emitted JavaScript names no bare
// specifier at all.
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
import { CSS } from "./css.ts";
import type {
  AbortControllerCtor,
  DocumentLike,
  ElementLike,
  NodeLike,
  StorageLike,
  WindowLike,
} from "./dom.ts";
import {
  closeDangling,
  defaultSession,
  forgetChat,
  loadChat,
  replayLines,
  restoredLines,
  saveChat,
  scrubTurns,
  trimTurns,
} from "./chat.ts";
import type { ChatInFlight } from "./chat.ts";
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

/**
 * The selection size at which a commit is confirmed even though the app said
 * it could be undone. A commit acting on MORE than this many rows is asked
 * about; `commitAskAbove` overrides it.
 *
 * **This number is a judgement and not a fact**, so here is the judgement. Two
 * lines could have been drawn and they are drawn in different places:
 *
 *   - Where can a person still check the claim themselves? A screenful. This
 *     library's premise is that an agent sees exactly what the person sees, and
 *     its own demo puts twenty rows on a screen; past a screenful the person
 *     cannot look at what is about to change, so "the app can undo it" is a
 *     promise they have no way to weigh.
 *   - Where does an app's undo stop being credible? Much higher — somewhere in
 *     the thousands, where a batch half-applies, a buffer sized for one row
 *     runs out, or a server gives up at row 1,800.
 *
 * The lower line is taken, and 25 rather than 20 because the first is the point
 * where the gate stops being able to help and the second is a page size that
 * differs per app: a selection a few rows past one screenful is an ordinary
 * thing a person was probably looking at, and tripping the dialog on it would
 * put us back to asking about the trivial. Anything that cannot be seen at once
 * is asked about, which is the side of the line to err on — the cost of a
 * needless question here is one click, and the cost of a missed one is an
 * "undo" that turns out to be partial.
 *
 * It is one number for every app and therefore wrong for some of them, which is
 * exactly why it is an option.
 */
export const COMMIT_ASK_ABOVE = 25;

/**
 * The word in the panel header when the host has not supplied one.
 *
 * It used to be the app's own name, and the app's own name is the one thing
 * that must not size this strip. "Northwind CRM" is a header full before the
 * three controls beside it get a place; "Mail" leaves it two thirds empty; and
 * neither of them tells the person anything they do not already know, because
 * the app they are looking at is the whole screen behind the panel. A chat
 * panel's title is only there to say what the panel IS.
 *
 * "Assistant" and not "Ask", which is the launcher's word, because the two are
 * different parts of speech doing different jobs: a button says what pressing
 * it does, and a title names the thing it is on top of. "Ask" as a header
 * would read as an instruction with nothing to instruct. It is also already
 * the word in the panel's `aria-label` — `"<app> assistant"` — so the visible
 * title and the announced one now agree instead of being two different names
 * for one surface.
 *
 * The app's name is NOT gone: it is in that `aria-label`, in the launcher's
 * and the input's accessible names, in the input's placeholder, in the
 * greeting, and on the title's own `title` tooltip. Those are the places where
 * naming the app answers a question somebody actually has — "what is this
 * thing reading my screen" — and none of them is a box whose width the name
 * gets to decide.
 */
export const PANEL_TITLE = "Assistant";


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
   *
   * This gates THE IN-PAGE RUN ONLY, which is the thing to know about it: it is
   * `drive`'s option, so a commit arriving over the relay or MCP never reaches
   * it, and its answer is not in the audit record — the core was never asked,
   * so `onAudit` reports `approval: "not-asked"`. The gate that covers every
   * path, and the one that lands in the record, is `MountOptions.approve`, and
   * `Widget.approve` is this panel's dialog in that shape.
   *
   * Passing this also stops the panel installing its own dialog as the core's
   * approver, which it otherwise does: you have said how you want to ask, and
   * two gates for one commit is two dialogs. One exception, and it is yours to
   * pick deliberately or not at all — when the APP declared `approve` as well,
   * that hook is asked inside `call()` whatever this option says, so an
   * in-page commit is asked about twice: once by you here and once by it.
   */
  onBeforeCommit?: DriveOptions["onBeforeCommit"];
  /** Shown in the header and on the launcher. Defaults to `PANEL_TITLE` in the
   *  header and "Ask" on the launcher — see `PANEL_TITLE` for why the app's own
   *  name is not either of them. The app name is still in every accessible
   *  name, in the placeholder and in the greeting. */
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
  /**
   * Where a remembered CONVERSATION is kept. Default `sessionStorage`.
   *
   * A second storage and not `storage`, because the two want different
   * lifetimes and the difference is the design rather than an accident. A pace
   * and a pane position are per viewer and belong in `localStorage`, where they
   * outlive the tab. A transcript is per TAB — two tabs of one app are two
   * conversations and must not stomp each other — and holds the person's
   * instructions and the model's prose about their records, which is a
   * different privacy class on a machine that may be shared. `sessionStorage`
   * survives a reload and dies with the tab, which is exactly the lifetime a
   * conversation should have. See `chat.ts`.
   */
  session?: StorageLike;
  /**
   * Bring the conversation back after a page reload. **Default off.**
   *
   * Off by default on purpose: a library must not start writing its users'
   * business prose to disk because somebody upgraded. Once an app has opted in,
   * the VIEWER's switch in the settings view defaults on, and turning it off
   * forgets what is already stored. This option is the harder of the two — an
   * app handling records that must not be written down sets `false` and no
   * viewer can undo it.
   *
   * What comes back is the conversation, not the run: see `chat.ts` on "restore
   * everything, resume nothing". A reload mid-commit comes back with the panel
   * saying which verb was in flight and that it cannot tell whether it landed.
   */
  rememberChat?: boolean;
  /**
   * Whether a call's elapsed time reaches the model. See `DriveOptions.timing`.
   *
   * **Defaults to `"slow"` here, where `drive` defaults to `"off"`**, and the
   * split is the same judgement `onBeforeCommit` gets one level up: `drive` is
   * a primitive whose existing callers must get byte-identical transcripts, and
   * this is a panel somebody is watching work on a live app, where "that verb
   * took twenty seconds" is a fact about the app worth a line. Nothing is
   * rendered below a second, so a snappy app pays nothing for it.
   *
   * Pass `"always"` for the run that was asked to compare two fast verbs, and
   * `"off"` to go back to a transcript with no durations in it at all.
   */
  timing?: DriveOptions["timing"];
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
   * Ask the person before a `commit` verb the app cannot undo. **Default
   * true.**
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
   * **A commit that declares `Verb.reversible` runs without a question**,
   * which is what that flag was added to buy. `set-setting("dense-rows",
   * "true")` and accepting 3,412 contacts were both getting the same dialog,
   * and a modal on a page-size change is how people learn to click Yes without
   * reading — the next one they skip is the bulk accept. An absent
   * `reversible` still makes no claim in either direction and is still gated:
   * a commit that has not said there is a way back is treated as one that has
   * not got one. See `commitAskAbove` for the selection size that overrides
   * the flag, and `confirmEveryCommit` for an app that wants the old
   * behaviour.
   *
   * Set it false to opt out entirely — for an app whose commits are all small,
   * where a question even on the irreversible ones is noise that teaches
   * people to click through questions.
   *
   * This, `commitAskAbove` and `confirmEveryCommit` decide whether the dialog
   * appears whichever path asked for it, because there is one dialog: see
   * `Widget.approve`. Switching confirmations off therefore switches them off
   * for an agent over the relay too, which is the honest reading of a switch
   * labelled "ask before changing data" and is also a thing to think about
   * before offering the switch at all.
   */
  confirmCommits?: boolean;
  /**
   * The selection size past which a commit is confirmed **even when it
   * declared itself reversible**. Default `COMMIT_ASK_ABOVE`.
   *
   * "Undo" over three thousand rows is a promise an app may not be able to
   * keep at that size, whatever it declared — an undo buffer sized for one
   * row, a half-applied batch, a server that gave up at row 1,800.
   * `reversible` is a claim about the KIND of change and not about its volume,
   * so the volume is checked separately and the flag does not get to answer
   * for it.
   *
   * The size is the count the run's last `describe` verb reported, or
   * `Snapshot.selectedCount`, or `Snapshot.selected.length` when the whole
   * selection is on screen. A commit with no count at all is never "large" by
   * this test; an irreversible one is gated anyway by the absence of a claim,
   * which is the stronger of the two reasons.
   */
  commitAskAbove?: number;
  /**
   * Ask before **every** `commit`, reversible or not. Default false.
   *
   * The behaviour the widget had before it read `Verb.reversible`, kept as an
   * option rather than as the default. An app that genuinely wants it exists:
   * one whose "undo" is a toast that vanishes in five seconds, or one under a
   * rule that a person signs for every write. Those are decisions about the
   * app and the app gets to make them; what they are not is the right default
   * for everybody, because a dialog on a page-size change teaches people to
   * click through dialogs.
   *
   * Moot when `confirmCommits` is false — nothing is asked either way — and
   * moot when the host supplies `onBeforeCommit`, which replaces the built-in
   * row outright.
   */
  confirmEveryCommit?: boolean;
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
  /**
   * The panel's confirmation dialog, as a `MountOptions.approve` hook.
   *
   * This is how the one working confirmation UI in the repository comes to
   * cover the relay path as well as the in-page one.
   *
   * YOU DO NOT HAVE TO WIRE THIS UP for the record to be true: a panel on a
   * driver that declared no `approve` installs this function as the core's
   * approver itself (`DriverApproval.adopt`), so a commit on any path renders
   * this dialog and `onAudit` says what the person clicked. Wire it up when the
   * app ALSO publishes the driver to a relay — `connect()` requires a
   * declaration in the app's own source, and a panel's gate is not one, because
   * it is gone when the panel is. Use a forward reference, because `mount()`
   * has to happen before the panel that will answer for it exists:
   *
   * ```ts
   * let panel: Widget;
   * const driver = mount({ …, approve: (req) => panel.approve(req) });
   * panel = mountWidget(driver, { think });
   * ```
   *
   * Then a commit arriving over the relay or MCP renders the same question,
   * with the same count, obeying the same `confirmCommits`, `commitAskAbove`
   * and `confirmEveryCommit`, and a "No" becomes the same `declined-by-user`
   * refusal that the in-page loop produces. The core holds its lock for the
   * duration, so the agent that is being asked cannot call anything else —
   * including `press` on an approve button — while the question is open.
   *
   * The count comes from the run's last `describe` when there is a run in
   * flight, and from the screen otherwise (`Snapshot.selectedCount`, then the
   * visible `selected`). An app whose selection size is only knowable from a
   * verb's `Report.count`, asked about a commit that arrived between runs, will
   * show "No count was reported" here — which is the honest answer and is
   * itself a reason to say no.
   */
  approve: (req: ApprovalRequest) => Promise<Approval>;
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
  // The one stop reason that is about the APP and not about the run, which is
  // why it names the limit rather than suggesting the person rephrase. A panel
  // that said "ask again, more specifically" here would be sending somebody to
  // reword a request against an app that will refuse the next one too — and a
  // panel that said nothing would be the silent mid-job stop that
  // `MountOptions.budget` is written to avoid. The settings view shows the
  // numbers; this says which thing happened.
  "over-budget":
    "Stopped: this app's limit on what one session may spend is reached. Asking again will " +
    "not help — the limit is set by the app, not by the panel.",
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
 * A `commit` verb the app cannot undo is confirmed with the person by default,
 * in the panel, with the count the preceding `describe` reported. One that
 * declares `Verb.reversible` runs without a question unless it acts on a large
 * selection. See `confirmCommits`, `commitAskAbove` and `confirmEveryCommit`.
 */
export function mountWidget(driver: Driver, options: WidgetOptions): Widget {
  const doc = options.document ?? (globalThis as { document?: DocumentLike }).document;
  if (!doc) throw new Error("driverkit: no document; pass one");
  const Abort =
    options.AbortController ??
    (globalThis as { AbortController?: AbortControllerCtor }).AbortController;

  const manifest = driver.manifest();
  const app = options.title ?? manifest.app;

  // The launcher's accessible name, and the one place the app's name is still
  // read out loud about that button. A screen reader reads a name in
  // isolation, with none of the context a sighted person gets from the app
  // behind it, so the visible word can be one word and this cannot.
  const ASK_LABEL = `Ask ${app} to do something`;
  // The same name with the state the dot shows, in words. A dot is not a thing
  // a screen reader can read, and "there is a conversation in here" is exactly
  // the fact somebody who cannot see the dot is missing.
  const WAITING_LABEL = `${ASK_LABEL}. Your conversation is still here.`;

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

  // Not a `Settings` field, deliberately: the three settings and the commit
  // switch are the viewer's to change because they are about how fast this
  // person reads and how much they trust this run, and "how many rows is too
  // many to take an app's undo on faith for" is not that — it is a property of
  // the app's own undo, which the author knows and the viewer does not. So it
  // is a mount option and nothing else, and it is not remembered.
  const askAbove =
    options.commitAskAbove === undefined ? COMMIT_ASK_ABOVE : options.commitAskAbove;

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
  // ONE WORD, and the app's name is deliberately not in it. `Ask Northwind
  // CRM` grew with the app, so the button was a different size in every app
  // that used it, and it reads as an instruction to the person rather than as
  // a label on a control — a button says what it is, not what you should do
  // with it. The app's name belongs in the panel header, where there is room
  // for it and where it is still the first thing read on opening, and it is
  // still in the accessible name here. `title` overrides this for a host that
  // wants its own word; a long one is ellipsised rather than allowed to
  // stretch the pill.
  launcher.textContent = options.title ?? "Ask";
  launcher.setAttribute("type", "button");
  // The app's name survives for anybody who cannot see the panel behind the
  // button. A screen reader reads a name in isolation, with none of the
  // context a sighted person gets from the app around it, so "Ask" alone would
  // be a button that could be about anything; a visual label has the whole
  // screen for context and needs no more than a word. Same reasoning as the
  // input's `aria-label`, which is why they read the same.
  launcher.setAttribute("aria-label", ASK_LABEL);
  // And on hover, for the case the visible word was clipped.
  launcher.setAttribute("title", ASK_LABEL);
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.setAttribute("aria-expanded", "false");
  /**
   * The "there is a conversation behind this" dot.
   *
   * Minimising keeps the transcript, which is the whole point of change one —
   * but a person who minimised mid-run then has a pill that looks exactly like
   * a pill they have never pressed, and no way to tell that the agent is still
   * working or that what they asked is still in there. So the pill carries a
   * dot, which pulses while a run is in flight.
   *
   * INSIDE the pill, absolutely positioned, and with its own class so its
   * rules never mention `.dk-launcher`: the launcher's box is 96x40 and
   * nothing is allowed to change it — a badge hanging off the corner would
   * grow the element, and the remembered position is a fraction of the
   * viewport less the element's own width, so a launcher that grew would also
   * have moved itself. See the launcher's rule in `css.ts`.
   *
   * Appended AFTER the label is written, because `textContent =` replaces
   * every child and would throw the dot away. `aria-hidden`, because the state
   * it shows is said in words in the launcher's own accessible name — a
   * screen reader hearing "dot" has learnt nothing.
   */
  const dot = el("span", "dk-dot");
  dot.setAttribute("aria-hidden", "true");
  launcher.appendChild(dot);
  wrap.appendChild(launcher);

  const panel = el("section", "dk-panel");
  // Not `aria-modal`: the person is meant to keep using the app while this is
  // open, and claiming modality would tell a screen reader to hide the rest of
  // the page — the opposite of what a panel that drives that page wants.
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", `${app} assistant`);
  wrap.appendChild(panel);

  const head = el("div", "dk-head");
  /**
   * The grip: the drag handle, and the only drag surface on the panel.
   *
   * A glyph and not the word "Move", because what a drag handle has to do is
   * LOOK like one. Six dots is the one thing on a screen people already read
   * as "pick this up", and the word "Move" read as a button that teleports the
   * panel somewhere \u2014 which is only half of what it does.
   *
   * It is a real `<button>`, and that is deliberate: it is the grab affordance
   * AND the keyboard control. A drag handle with no focusable element in it is
   * a feature that exists only for people with a mouse, and a shortcut nobody
   * can see is a shortcut nobody uses. One control answers both.
   *
   * First in the strip, at the far end from the gear and the minimise button.
   * The whole complaint this change answers is that an imprecise press near a
   * button started a drag; putting the thing that drags as far as the strip
   * allows from the things that do not is the cheap half of the fix.
   */
  const grip = el("button", "dk-move");
  grip.textContent = "\u283f";
  grip.setAttribute("type", "button");
  grip.setAttribute("aria-label", "Move panel: arrow keys to nudge, Enter for the next corner");
  grip.setAttribute("title", "Drag to move. Arrow keys to nudge, Enter for the next corner, Alt (Option) and an arrow from anywhere.");
  const title = el("div", "dk-title");
  // A short word, not the app's name. See `PANEL_TITLE`.
  title.textContent = options.title ?? PANEL_TITLE;
  // And the app's name on hover, so a generic title is still answerable for
  // what it is attached to without being sized by it.
  title.setAttribute("title", `${app} assistant`);
  // A glyph, not the word "Settings". The header is a 380px strip with a title
  // and three controls in it, and three words would not fit; it is still a
  // real button with a real label.
  const gear = el("button", "dk-gear");
  gear.textContent = "\u2699";
  gear.setAttribute("type", "button");
  gear.setAttribute("aria-label", "Settings");
  gear.setAttribute("title", "Settings: speed, highlighting, step mode, confirmations, clear");
  // `aria-expanded` and not `aria-pressed`: this discloses a panel section
  // rather than turning something on, and claiming both would be two
  // different promises about one button.
  gear.setAttribute("aria-expanded", "false");
  /**
   * Minimise, which is what this button always did and is now what it says.
   *
   * It hid the panel and kept the conversation, and it was labelled "Close" \u2014
   * so people read it as "throw this conversation away" and stopped pressing
   * it. That is a real failure even though the behaviour was right: a control
   * whose label overstates what it does is a control people avoid, and the
   * person who avoids this one is left with a panel sitting on top of the rows
   * they asked about. The behaviour is untouched; the word and the glyph are
   * the fix.
   *
   * A minus and not a chevron, because a chevron points somewhere and this
   * panel can be in any of four corners, so "down" is wrong a quarter to three
   * quarters of the time. The destructive option people were looking for when
   * they read "Close" is now in the settings view, where destructive things
   * belong, and it says what it does.
   */
  const minimise = el("button", "dk-min");
  minimise.textContent = "\u2212";
  minimise.setAttribute("type", "button");
  minimise.setAttribute("aria-label", "Minimise the panel. The conversation is kept.");
  minimise.setAttribute("title", "Minimise. Your conversation is kept \u2014 reopen to carry on.");
  head.appendChild(grip);
  head.appendChild(title);
  head.appendChild(gear);
  head.appendChild(minimise);
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
      options.confirmEveryCommit
        ? "Ask before any step that changes data. One question per call, not per row — a commit acts on the whole selection."
        : "Ask before a step that changes data the app cannot undo, and before any step that changes a lot of rows. One question per call, not per row — a commit acts on the whole selection.",
    );
    commitRow.appendChild(
      toggle("dk-t-commits", "Ask before changing data", () => settings.confirmCommits, (on) => {
        settings.confirmCommits = on;
      }),
    );
    settingsView.appendChild(commitRow);
  }

  // Hidden unless the APP opted in, because a switch for a thing that cannot
  // happen is a switch that teaches somebody the wrong thing about where their
  // conversation goes. The app's `false` is the harder of the two keys; see
  // `WidgetOptions.rememberChat`.
  if (options.rememberChat === true) {
    const rememberRow = setRow(
      "Remember this conversation",
      "Bring the conversation back if this page reloads. It is kept in this tab only, and it goes when you close the tab. Turning this off forgets what is already stored. Nothing is resumed either way — a run does not restart by itself.",
    );
    rememberRow.appendChild(
      toggle("dk-t-remember", "Remember this conversation", () => settings.rememberChat, (on) => {
        settings.rememberChat = on;
        // Acted on at once, in both directions. Switching it off is a request
        // about what is on the disk right now and not only about what happens
        // next: somebody turning this off on a shared machine means "and get
        // rid of it", and a panel that waited until the next write to honour
        // that would have kept the transcript through the one moment they
        // asked for it to be gone. `rememberNow` does the forgetting itself
        // when the switch is off, which keeps the two directions in one place.
        rememberNow();
      }),
    );
    settingsView.appendChild(rememberRow);
  }

  /**
   * Clear the conversation: the destructive option, in the one place a person
   * goes looking for one.
   *
   * It is here and not in the header for the same reason the header button is
   * now a minus. There were two controls and one of them was lying: minimise
   * read as "destroy the conversation" and nothing actually destroyed it. Now
   * the header is where you put the panel away and the settings view is where
   * you throw things away — and this is the LAST row of it, below four
   * preferences, which is where a destructive action is least likely to be hit
   * by somebody reaching for something else.
   *
   * **No confirmation**, deliberately. A confirmation is worth a click when
   * the thing behind it cannot be undone and cost somebody something: a
   * commit, which is why this panel has a dialog for those. A lost chat costs
   * one retyped sentence, and the panel's own doctrine is that a dialog on the
   * cheap thing is how people learn to click through the dialog on the
   * expensive one. The transcript is not a record of anything but itself — the
   * app's data is untouched by this, and the steps that ran stay run.
   *
   * **It stops a run in flight**, through the run's own `AbortController` and
   * not a second stop path, because that controller is already the one thing
   * that stops a run and a second one could disagree with it. The alternative
   * was letting the loop go on holding `messages` the panel has just thrown
   * away, which is a panel and a model disagreeing about what has been said —
   * and the model would win, so the next answer would refer to a conversation
   * the person is looking at the absence of.
   */
  /**
   * What this session has spent, and against what ceiling — SHOWN, never
   * offered.
   *
   * This row is the whole reason `Driver.budget` exists. `MountOptions.budget`
   * is declared by whoever mounted the app and a viewer must not be able to
   * raise their own ceiling, so this is the only thing in the settings view
   * with no control beside it: everything above it is a comfort (speed, step
   * mode, confirmations) and this is somebody else's money.
   *
   * It is here rather than in the header for the reason the ceiling exists at
   * all. A run that stops mid-job and does not say why is read as a broken
   * app, and `STOP_NOTE["over-budget"]` says which thing happened — but that
   * only appears AFTER the ceiling is hit. This is where a person who is
   * wondering whether they are close can look before they are.
   *
   * Absent when the app declared no ceiling. A row reading "no limit" would be
   * one more thing to read in a view of four, and the counter is still on
   * `Driver.budget` for anybody debugging.
   */
  const spend = driver.budget?.();
  const budgetRow =
    spend && (spend.calls.limit !== undefined || spend.commits.limit !== undefined)
      ? setRow(
          "This session's limit",
          "Set by the app, not by this panel, so it cannot be changed from here. It counts " +
            "steps for the whole time this page has been open and does not refill.",
        )
      : undefined;
  const budgetText = budgetRow ? el("div", "dk-set-budget") : undefined;
  if (budgetRow && budgetText) {
    budgetRow.appendChild(budgetText);
    settingsView.appendChild(budgetRow);
  }

  /** Repaint the spend numbers. Read on every open rather than subscribed to:
   *  the numbers only matter while somebody is looking at them, and a listener
   *  on every call would be work done for a view that is usually closed. */
  const paintBudget = (): void => {
    if (!budgetText) return;
    const now = driver.budget?.();
    if (!now) return;
    const parts: string[] = [];
    if (now.calls.limit !== undefined) {
      parts.push(`${now.calls.used} of ${now.calls.limit} steps used`);
    }
    if (now.commits.limit !== undefined) {
      parts.push(`${now.commits.used} of ${now.commits.limit} changes to data used`);
    }
    budgetText.textContent = parts.join(" · ");
  };
  paintBudget();

  const clearRow = setRow(
    "Clear conversation",
    "Throw away everything in this panel and start over. Nothing in the app changes and steps that already ran stay run. A run in flight is stopped, because a transcript the model still remembers and the panel does not is worse than no transcript.",
  );
  const clear = el("button", "dk-clear");
  clear.textContent = "Clear conversation";
  clear.setAttribute("type", "button");
  clear.addEventListener("click", () => clearConversation());
  clearRow.appendChild(clear);
  settingsView.appendChild(clearRow);

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

  /**
   * Every element in the transcript, in the order it was added.
   *
   * Kept because clearing has to be able to empty the log, and there is no way
   * to do that through `ElementLike` — `innerHTML` is not in `dom.ts` and
   * putting it there to clear a container would be adding the one DOM property
   * whose whole reputation is for being misused. Each line can remove itself,
   * which is a method the fake and every browser already have, so the list of
   * what to remove is the only missing piece. Declared above the greeting
   * because the greeting is the first thing to go in it.
   */
  const lines: ElementLike[] = [];

  // Kept rather than inlined, because clearing the conversation puts it back:
  // an empty panel with no greeting looks broken, and a fresh panel is what
  // clearing promises.
  const greeting =
    options.greeting ?? `Ask me to do things in ${app}. I use the app the way you do.`;
  say("dk-note", greeting);

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
  /**
   * The last count a `describe` reported in the run in flight, or undefined.
   *
   * Lifted out of `ask()` when the dialog became the core's approver, and the
   * lift is the point rather than a tidy-up: the question used to be asked
   * from inside the run, where this was in scope, and is now asked from inside
   * `driver.call()`, where nothing of the run is. Without it every in-page
   * commit would have gone back to asking "accept the current selection?"
   * instead of "accept 1,000 contacts?" -- which is the number the whole
   * dialog exists to put in front of somebody.
   *
   * Cleared when a run starts and when one ends, so a count from a finished
   * run can never be read as the size of a commit that arrived afterwards over
   * the relay. Cleared when a question is ASKED, because at that moment the
   * number has been put in front of somebody and is spoken for.
   */
  let lastCount: number | undefined;
  /**
   * Every question on screen with no answer yet, as the function that answers
   * it.
   *
   * Only ever non-empty while somebody is being asked something. It exists for
   * `unmount`: a question asked through the core's gate has no run behind it
   * when it came over the relay, so there is no abort signal to answer it, and
   * a panel that is torn down with one open would leave `driver.call()` waiting
   * on a promise nobody can resolve -- forever, since `approvalTimeout` is
   * absent by default. That is a dead app, caused by closing a chat panel.
   */
  const openQuestions = new Set<() => void>();
  // The wrapper's classes, as flags. Written in one place and in one order,
  // because three separate string edits to `className` is three chances for
  // one of them to drop another's class.
  let isOpen = false;
  let isBusy = false;
  let isSettings = false;
  /** Whether anything has been asked since the panel was last cleared. What
   *  the launcher's dot is about: "there is a conversation in here", which is
   *  not the same question as "is a run in flight". */
  let conversed = false;
  /**
   * Which conversation the panel is on. Bumped by clearing.
   *
   * A run that was in flight when the person cleared is aborted, but an abort
   * is not instant: the loop resolves at its next await, and everything it
   * does on the way out — the stop note, the `messages` it hands back, the
   * sweep that marks abandoned steps — is about a conversation that no longer
   * exists. Checking a counter is how those writes know not to land in the
   * fresh transcript. A boolean would not do: clear twice during one run and
   * the second clear has to invalidate the run too.
   */
  let era = 0;
  /**
   * Where a remembered conversation goes, or undefined when none is kept.
   *
   * Resolved once, at mount, and `undefined` whenever the app did not opt in —
   * so an app that passed no `rememberChat` never reaches storage at all, not
   * even to read it. The viewer's switch is checked at each write rather than
   * here, because they can turn it off halfway through a conversation and the
   * point of the switch is that doing so forgets what is already stored.
   */
  const session = options.rememberChat === true ? (options.session ?? defaultSession()) : undefined;
  /**
   * What the panel believes is happening to the app right now, for the record.
   *
   * The whole of "a reload mid-commit comes back saying so". Set when a call is
   * announced and when a question goes on screen, cleared when either settles,
   * and written into storage as it stands — so a page that dies between the
   * two is a page whose stored record says which verb was open and in what
   * state. See `ChatInFlight` for why `asked` and `sent` are different facts.
   */
  let inFlight: ChatInFlight | undefined;
  /**
   * The conversation as the run in flight is building it, or null between runs.
   *
   * **Why this exists at all, when `drive` hands back `messages` already.** It
   * hands them back when the run ENDS, and the whole case this feature is
   * shaped by is a page that dies five steps in. Without this, a reload
   * mid-commit came back with the notice about the in-flight verb and an empty
   * conversation — it had the alarming half and not the useful half, and the
   * person's own question, the one they would have to retype, was the first
   * thing lost.
   *
   * So the three per-call events are used to rebuild exactly what the loop is
   * pushing: `onSay` is an assistant turn, `onBeforeCall` adds that turn's
   * calls, and `onResult` carries the rendered tool turn verbatim as `text`. It
   * is a mirror and never a second source of truth — `out.messages` replaces it
   * outright when the run ends, and that is the pruned, authoritative version.
   * Nothing reads this but `rememberNow`. Named for the turns and not `live`,
   * which is already this file's "is the panel mounted" flag.
   */
  let liveTurns: Turn[] | null = null;
  /**
   * Milliseconds this panel has spent waiting on a PERSON, cumulative.
   *
   * Handed to `drive` as `waited` so the duration a MODEL is shown is the
   * app's own work and not somebody reading a dialog. Cumulative and
   * monotonic rather than per call, because the loop diffs it either side of
   * `driver.call()` and a counter cannot be got wrong by a dialog that opens
   * twice. See `DriveOptions.waited`.
   *
   * It has to be counted here, and this is the reason: the panel's dialog is
   * installed as the CORE's approver — see `adoptDialog` — so the wait happens
   * inside `driver.call()`, where the loop can see only that the call took a
   * long time. Every path to a question goes through `askPerson`, which is the
   * one place this is incremented.
   */
  let waitedMs = 0;

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

  /**
   * The grip is the handle, and the header is NOT one any more.
   *
   * The header used to be the drag surface, which is why `position.ts` has a
   * `controls: "ignore"` mode at all: a press that landed on a button inside
   * the handle had to be rescued from the drag it would otherwise have
   * started. That guard works, and it is still the wrong shape for this
   * header. "Ignore the controls" is a rule about the pixels a button covers,
   * and a header is also the 4px between two of them, the strip above them,
   * and the few pixels of padding a pointer lands on when somebody aims at the
   * gear and misses by two — all of which drag, and none of which the person
   * meant to drag.
   *
   * So the handle is now exactly the thing that looks like a handle, and the
   * header is inert. The cost is forgiveness: somebody who grabs the title
   * text and pulls gets nothing, where before they got a moving panel. That is
   * the trade taken deliberately, and in this direction, for three reasons.
   * The grip is visible and the header's grabbability never was — it was a
   * `cursor: grab` and no more, so nobody who had not already discovered it
   * ever would. Predictability is worth more than reach HERE because there is
   * no reach to lose: the keyboard path still moves the panel from anywhere in
   * the widget with Alt and an arrow, and the grip's own bare arrows and Enter
   * still work. And a surface that is not a handle cannot grow a new header
   * button that is accidentally draggable, which is this bug's shape and the
   * shape it would come back in.
   *
   * `"ignore"` stays in `position.ts` with no caller here on purpose: it is
   * the right answer for any container handle, and the next person who makes
   * one should find it rather than rediscover the bug.
   */
  const movedGrip = place.handle(grip);
  // And the launcher, because a collapsed widget is over the app just as much
  // as an open one.
  const movedLauncher = place.handle(launcher);

  launcher.addEventListener("click", () => {
    // A drag is not a click. Without this, shoving the collapsed launcher off
    // the rows somebody wants to read opens the panel back over them.
    if (movedLauncher()) return;
    setOpen(true);
  });
  minimise.addEventListener("click", () => setOpen(false));
  gear.addEventListener("click", () => setSettingsOpen(!isSettings));
  pause.addEventListener("click", () => {
    if (runState === "paused") active?.resume();
    else active?.pause();
    // Not painted here. The loop answers through `onControl`, and it is the
    // only thing that knows — including in the case where a run ended between
    // the person deciding to press this and pressing it.
  });
  once.addEventListener("click", () => active?.step());
  grip.addEventListener("click", () => {
    if (movedGrip()) return;
    place.cycle();
  });
  // Bare arrows, and only here, where the panel's own control has focus. Alt
  // is left to the wrapper's handler so the two do not both act on one press.
  grip.addEventListener("keydown", (e) => {
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
  // Before `options.open`, so a panel told to start open starts open with its
  // conversation already in it rather than appearing empty and then filling.
  // A no-op unless the app opted in; see `restoreConversation`.
  restoreConversation();
  if (options.open) setOpen(true);

  /**
   * Hand this panel's dialog to the core, and hold the release.
   *
   * WHY THIS IS HERE AND NOT IN THE RUN. Until this, the panel gated OUTSIDE
   * `driver.call()`: hold the core's lock, ask the person, then let the loop
   * make the call. The core therefore never saw the question, and an app that
   * mounted this panel and wired `onAudit` recorded
   * `approval: "not-asked", policy: "none"` for a commit somebody had just
   * clicked Approve on. The record read as complete and said the opposite of
   * what happened. Correlating the two afterwards was the alternative and it
   * cannot be made sound: between the dialog's answer and the call that
   * follows, another agent on the relay can call the same verb, and an audit
   * trail that is usually right is not an audit trail. So the dialog becomes
   * the approver, and the answer is written down by the thing that asked.
   *
   * `null` back means somebody else is the gate: the app's own `approve`, or
   * a panel that mounted first. Then this panel keeps its in-page gate or
   * drops it according to `coreAsks`, and nothing about the arrangement is
   * silent — the core warns about a second panel, and the `unattended` case is
   * warned about below.
   */
  const release = adoptDialog();

  function adoptDialog(): (() => void) | null {
    // A host that supplied its own confirmation has said HOW it wants to ask,
    // and `onBeforeCommit` is documented as replacing this panel's dialog
    // rather than stacking with it. Adopting anyway would stack them: the
    // host's dialog out here and this panel's inside `driver.call()`, two
    // questions about one commit, which is the thing that teaches people to
    // click Yes without reading.
    //
    // The cost is that such a gate is still outside the core, so its answer is
    // not in the audit record -- `onBeforeCommit`'s own documentation already
    // says it gates the in-page run only and that the gate covering every path
    // is `MountOptions.approve`. Unchanged by this, deliberately: a host that
    // wants its dialog in the record passes it as `approve`.
    if (options.onBeforeCommit) return null;
    const adopt = driver.approval?.adopt;
    // A driver from before adoption existed — hand-written, or an older
    // build. Nothing to install and nothing to say: the panel's in-page gate
    // is what it has always been, and it still works.
    if (!adopt) return null;
    const won = adopt(approveRequest);
    if (won) return won;
    // Refused because the app declared `unattended`, which `adopt` will not
    // overrule. The panel goes on asking in-page, which is right — somebody
    // is plainly sitting there — but the core is not asked, so those
    // confirmations do not appear in `onAudit` and the records say
    // `not-asked, unattended` for commits a person clicked Approve on. That is
    // the bug this change fixes, in the one configuration where it cannot be
    // fixed without overruling the app, so it is said out loud instead.
    if (driver.approval?.declared === "unattended") {
      warn(
        `\`${app}\` was mounted with \`approve: "unattended"\` and also mounts this panel, ` +
          `which asks before a commit. The panel's question is NOT in the audit record: ` +
          `\`onAudit\` will report \`approval: "not-asked", policy: "unattended"\` for commits ` +
          `somebody confirmed here, because the core was never asked. Wire the panel up as the ` +
          `gate — \`approve: (req) => panel.approve(req)\` — if those confirmations should be ` +
          `in the record, or drop this panel if the run really is unattended.`,
      );
    }
    return null;
  }

  // ---- the run -----------------------------------------------------------

  async function ask(text: string): Promise<void> {
    if (!live || running) return;
    say("dk-you", text);
    conversed = true;
    // The person's words go into the mirror before anything can go wrong, so a
    // page that dies on the very first call still comes back with the question
    // they asked. `drive` appends the screen to its own copy of this turn; the
    // mirror carries the words alone, which is what a restored transcript and a
    // resumed conversation both want.
    liveTurns = [...messages, { role: "user", text }];
    // Which conversation this run belongs to. Clearing bumps it, and
    // everything below that would write into the transcript checks it first.
    const mine = era;

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

    // Nothing of the last run's selection survives into this one. The field
    // itself is at the top of the panel, because the dialog that reads it is
    // now called from inside `driver.call()` rather than from inside the loop.
    lastCount = undefined;

    // Always installed when the host has not replaced it AND the core is not
    // already gating, and the SETTING is read inside — so turning
    // confirmations off, or back on, in the middle of a run takes effect on
    // the next commit rather than the next run. That is what somebody who has
    // just watched a commit go past expects of the switch they reached for.
    //
    // Nothing is installed when the core already has an approver — the app's
    // own `approve` hook, or this panel's dialog, which `mountWidget` adopted
    // at the bottom of this file. That approver is called inside
    // `driver.call()` for every path, this one included, so installing the
    // panel's gate as well would be two questions about one commit — which is
    // the thing this panel's own documentation says teaches people to click Yes
    // without reading.
    //
    // Read per run, not once at mount, because the answer moves: a second
    // panel on the same driver does not get the gate, and a panel whose
    // adoption was refused because the app declared `approve: "unattended"`
    // keeps its own in-page gate and always did. See `coreAsks`.
    const gate = options.onBeforeCommit ?? (coreAsks() ? undefined : confirmCommit);

    /** The built-in gate, per run: find the count, then ask. */
    function confirmCommit(req: CommitRequest): Promise<CommitDecision> {
      // `lastCount` first, because it is the number the MODEL just put on the
      // screen in this run. The two fallbacks and their order are
      // `countFor`'s, which the out-of-run path shares.
      const count = lastCount ?? countFor(req.snapshot);
      if (!shouldAsk(req, count)) return Promise.resolve(true);
      // Cleared when a question is ASKED, because that is when the number has
      // been put in front of somebody and spoken for. A commit that ran
      // without asking has not used it up, and the next commit — which may
      // well be the irreversible one — still needs it to be answerable.
      lastCount = undefined;
      return withLock(
        req.name,
        async () =>
          (await askPerson(req, count, controller?.signal, CLOSED_VETO)) as CommitDecision,
      );
    }

    const paced: DriveOptions = {
      think: options.think,
      task: text,
      history: messages,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.refusalLimit === undefined ? {} : { refusalLimit: options.refusalLimit }),
      ...(gate ? { onBeforeCommit: gate } : {}),
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
        // Nothing from a cleared conversation reaches the one that replaced
        // it. An abort stops the loop at its next await, so a call it had
        // already announced can still arrive here afterwards, and a step row
        // about it would appear in a transcript the person has just emptied.
        if (era !== mine) return;
        mark(step(steps, e), "pending");
        aim(e);
      },
      onCall: (e) => {
        if (era !== mine) return;
        mark(step(steps, e), "running");
        aim(e);
        // `onCall` and not `onBeforeCall`, and the distinction is the whole
        // honesty of the restored notice. `onBeforeCall` fires before the pace
        // wait and before any hold, so a page dying there is a page that died
        // while a call was QUEUED -- nothing was sent, nothing can have
        // landed. `onCall` is the moment the app is actually touched. Recording
        // `sent` from the earlier event would have the panel come back telling
        // somebody to go and check a verb that was never called.
        inFlight = { verb: e.call.name, phase: "sent" };
        // The assistant turn the loop pushed, rebuilt. `index === 0` starts it,
        // and a fan-out's later calls join the same turn rather than making one
        // each -- which matters because a `tool_use` must be answered within
        // the turn that made it.
        if (liveTurns) {
          const last = liveTurns[liveTurns.length - 1];
          if (e.index === 0 && last?.role === "assistant" && last.calls === undefined) {
            liveTurns[liveTurns.length - 1] = { ...last, calls: [e.call] };
          } else if (e.index > 0 && last?.role === "assistant" && last.calls) {
            last.calls.push(e.call);
          } else {
            liveTurns.push({ role: "assistant", calls: [e.call] });
          }
        }
        rememberNow(mine);
      },
      onControl: ({ state }) => show(state),
      onResult: ({ call, kind, result, text: answered }) => {
        if (era !== mine) return;
        // Settled, so nothing is in flight any more. Before the early returns
        // below -- a call whose step row has gone missing has still finished,
        // and leaving the flag set would have the panel come back after a
        // reload claiming a verb was interrupted when it had answered.
        if (inFlight?.verb === call.name && inFlight.phase === "sent") inFlight = undefined;
        // The tool turn, verbatim as the loop renders it, screen and all. Taken
        // from the event rather than rebuilt here, so the stored conversation
        // and the one the model is reading cannot come to differ by a word.
        liveTurns?.push({ role: "tool", callId: call.id, name: call.name, text: answered });
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
        rememberNow(mine);
      },
      onSay: ({ text: prose }) => {
        if (era !== mine) return;
        say("dk-me", prose);
        liveTurns?.push({ role: "assistant", text: prose });
        // The model's own words are the half of a transcript a person would
        // most miss, and a run can be many steps away from its next write.
        rememberNow(mine);
      },
      // The duration a MODEL is shown, and the human wait kept out of it. See
      // `waitedMs`: the panel's dialog is the core's approver, so the wait
      // happens inside `driver.call()` and the loop can only subtract what it
      // is told.
      timing: options.timing ?? "slow",
      waited: () => waitedMs,
    };

    try {
      const out = await drive(driver, paced);

      // The conversation this run was part of was cleared while it was
      // running. Its history is exactly what clearing threw away and its stop
      // note is about a transcript nobody can see, so neither is kept: `drive`
      // has already stopped, the panel already said so, and the person is
      // looking at a fresh panel.
      if (era !== mine) return;
      messages = out.messages;
      // The mirror is discarded the moment the real thing arrives.
      // `out.messages` is pruned -- one screen, not one per step -- so it is
      // both the authoritative version and the smaller one.
      liveTurns = null;
      const note = STOP_NOTE[out.stop];
      if (note) say("dk-note", note);
      // The authoritative write of the run. `out.messages` is the pruned
      // conversation `drive` hands back -- one screen, not one per step -- so
      // this is both the most complete and the smallest version of it, and it
      // is what a reload should come back to.
      rememberNow(mine);
    } catch (err) {
      // A `think` that throws — a 500 from the app's own backend, usually. Said
      // in the transcript as well as handed to `onError`, because the person is
      // sitting in front of a panel that just went quiet and the console is
      // not where they are looking.
      // Handed to `onError` whichever conversation it belonged to — a host
      // logging its own backend's 500 wants it either way — and said in the
      // transcript only if that transcript is still the one it is about.
      options.onError?.(err);
      if (era === mine) {
        say("dk-note", `Something went wrong talking to the model: ${message(err)}`);
      }
    } finally {
      running = null;
      active = null;
      // Also here, for the paths that never reach the assignment above: a
      // `think` that threw, and a run whose conversation was cleared while it
      // was in flight. A mirror left behind would be persisted on the next
      // write as though a run were still going.
      liveTurns = null;
      // The run's last count dies with the run. A commit arriving afterwards
      // from somewhere else is about the selection on screen now, and labelling
      // its question with a number this run happened to report would be the
      // dialog making up the one fact it exists to show.
      lastCount = undefined;
      show("running");
      spot.hide();
      // Pending rows for calls that never ran. A stop during a pace wait or a
      // hold abandons them unrun and no `onResult` is coming, so leaving them
      // mid-flight would be a panel saying something is about to happen when
      // the run is already over.
      if (era === mine) {
        for (const entry of steps.values()) {
          if (entry.line.className.includes("dk-step-pending")) {
            outcome(entry, " · not run", "skipped");
          }
        }
      }
      busy(false);
      // Not after a clear: `clearConversation` has already put focus where a
      // fresh panel starts, and it may well have been in the settings view
      // that the person pressed the button.
      if (live && era === mine) input.focus?.();
    }
  }

  // ---- the gate ----------------------------------------------------------
  //
  // Two answers for one event, and the difference between them is the whole
  // argument of this file's half of the audit trail. The panel is unmounted
  // with a question on screen:
  //
  //   from the in-page run, the run is being torn down with it, so the commit
  //   is vetoed and the model is told why. `unmount` aborts the run first, so
  //   in practice the abort usually answers before this does; this is the
  //   backstop for a gate reached without one.
  //
  //   from the core's approver, somebody is waiting on an approval that will
  //   now never be answered. That is `{ timedOut: true }` and not a denial:
  //   `timed-out` says the verb did not run and nobody decided, `declined`
  //   says a person refused, and a record that cannot tell those apart is the
  //   record this change exists to stop writing.
  const CLOSED_VETO = "the panel was closed before this was approved";
  const CLOSED_LAPSE: Approval = {
    timedOut: true,
    hint:
      "the approval panel was closed while this was waiting to be approved, so nobody " +
      "answered. **The verb did not run and nothing changed.** Ask the person to reopen the " +
      "assistant, then call it again.",
  };
  //
  // Lifted out of `ask()` so that the panel's dialog is an IMPLEMENTATION of
  // `MountOptions.approve` rather than the only gate in the system. The same
  // three functions serve both callers: the in-page loop's `onBeforeCommit`,
  // which has a run and a `lastCount` and an abort signal, and `approve()`
  // below, which has none of those because the call it is about arrived over
  // the relay. One dialog, one set of rules, two paths — which is the whole
  // point of the gate moving into the core.

  /**
   * How many rows the question is about, from the screen alone.
   *
   * `Snapshot.selectedCount` first, because a commit verb takes no predicate
   * and acts on the current selection, so the size of that selection is the
   * number this question is about whether or not a `describe` verb happened to
   * report one. `selected.length` last and only as a floor: that field carries
   * just the ids that are ON SCREEN, so it is the true size exactly when the
   * whole selection is in front of the person and an undercount otherwise. An
   * app that fills `selectedCount` is believed over it.
   */
  function countFor(snapshot: Snapshot): number | undefined {
    return snapshot.selectedCount ?? snapshot.selected?.length;
  }

  /** Whether this commit gets a question. The three options' whole meaning. */
  function shouldAsk(req: ApprovalRequest, count: number | undefined): boolean {
    if (!settings.confirmCommits) return false;

    // Absent means the app made no claim, which is gated: a commit that has
    // not said there is a way back is treated as one that has not got one.
    const reversible = req.verb.reversible === true;

    // A size check beside the flag rather than folded into it, because they
    // answer different questions. `reversible` is a claim about the kind of
    // change; this is about how much of it there is, and an undo over
    // thousands of rows is a promise an app may not be able to keep at that
    // size whatever it declared. Strictly greater than, so the option reads as
    // "ask above this many". See `COMMIT_ASK_ABOVE`.
    const large = count !== undefined && count > askAbove;

    return !reversible || options.confirmEveryCommit === true || large;
  }

  /**
   * Hold the core's no-other-calls lock while this dialog is open.
   *
   * This is the panel's share of the webmcp#288 defence. The agent being asked
   * is not the only agent that can reach this driver: a second one over the
   * relay can call `press("approve")` while the question sits in the
   * transcript, and in-page nothing was stopping it. With the lock held, every
   * `call()` on this driver is refused `approval-pending` until the person
   * answers — including a press of this panel's own Yes, if a host ever put an
   * approval control in the light DOM.
   *
   * Via the driver rather than by the panel keeping a flag of its own, because
   * the thing that has to refuse the call is the thing that runs it. An older
   * hand-written driver with no `approval` simply asks without the lock, which
   * is what it did before this existed.
   */
  function withLock<T>(verb: string, ask: () => Promise<T>): Promise<T> {
    const hold = driver.approval?.hold;
    return hold ? hold(verb, ask) : ask();
  }

  /**
   * Whether `driver.call()` already asks about commits, so this panel must not.
   *
   * `hook` is the app's own `approve`. `adopted` is a dialog installed through
   * `DriverApproval.adopt` — this panel's, in the ordinary case, or the first
   * panel's when a page mounted two. Either way the question is asked inside
   * the call, on every path, and a second gate out here would be a second
   * dialog about one commit.
   *
   * `none` and `unattended` both mean the core asks nothing, and the panel's
   * own in-page gate stands exactly as it did: `none` is a driver this
   * mechanism could not reach — hand-written, or an adoption somebody else
   * won and then released — and `unattended` is an app that said commits here
   * run with nobody in front of them, which `adopt` refuses to overrule.
   */
  function coreAsks(): boolean {
    const policy = driver.approval?.policy;
    return policy === "hook" || policy === "adopted";
  }

  /**
   * This panel's dialog, in the shape of `MountOptions.approve`.
   *
   * One function behind two callers: `Widget.approve`, for an app that wires it
   * up itself, and the hook this panel adopts at mount. Both are the same
   * question with the same rules, which is the whole reason the gate moved into
   * the core.
   */
  async function approveRequest(req: ApprovalRequest): Promise<Approval> {
    // `lastCount` only while a run is in flight, and then first, because it is
    // the number the model just put on the screen. A commit that arrived from
    // somewhere else between runs has no run to have counted anything, and
    // `countFor` reads the selection the commit is about to act on.
    const count = (running ? lastCount : undefined) ?? countFor(req.snapshot);
    // Not `true`. A gate that let this through without asking must not be
    // recorded as a person saying yes — see `Approval`'s `{ asked: false }`,
    // which is in the core's vocabulary for exactly this answer.
    if (!shouldAsk(req, count)) return { asked: false };
    // Spoken for, as in the in-page path: the number is now in front of
    // somebody, so the next commit cannot borrow it.
    lastCount = undefined;
    // The run, when there is one, says "waiting for you" rather than
    // "running". `drive` marks that state itself when the gate is its own
    // `onBeforeCommit`; asked from inside `driver.call()` the loop has no idea
    // a question is open, so the panel says so. Restored to whatever the run
    // was doing before — which may be `paused` — rather than to `running`.
    const was = runState;
    if (active) show("awaiting-approval");
    try {
      // No `withLock`: the core takes its lock before it calls an approver,
      // and a second take would assert a thing that is already true.
      //
      // The run's signal when there is one, so stopping a run also answers a
      // question asked during it. A commit that arrived over the relay has no
      // run and no signal: that question stays open until somebody answers it,
      // `MountOptions.approvalTimeout` lapses, or this panel is unmounted.
      return await askPerson(req, count, running?.signal, CLOSED_LAPSE);
    } finally {
      if (active) show(was);
    }
  }

  /**
   * Render the question in the transcript and wait for an answer.
   *
   * `signal` is the run's abort, when there is a run. Without it a stop or an
   * unmount would leave the loop waiting on a promise nobody will ever resolve
   * and the panel stuck busy forever — so the abort answers the question, and
   * the only safe answer is no. A call that arrived over the relay has no run
   * and therefore no signal: that question stays open until somebody answers
   * it, `MountOptions.approvalTimeout` lapses, or this panel is unmounted.
   *
   * `teardown` is that last one: the answer to give if the panel is unmounted
   * with the question still on screen. It is a parameter rather than a
   * constant because the two callers are owed different answers. The in-page
   * run is being stopped, so a veto is the truth and the model is told. A
   * question asked from inside `driver.call()` has somebody waiting on an
   * approval, and "the panel went away" is nobody answering rather than
   * somebody refusing — `{ timedOut: true }`, which the record keeps apart
   * from `declined`. Confusing those two is the thing this whole mechanism
   * exists to stop doing.
   */
  function askPerson(
    req: ApprovalRequest,
    count: number | undefined,
    signal: { addEventListener?: (type: string, fn: () => void) => void } | undefined,
    teardown: Approval,
  ): Promise<Approval> {
    // A question nobody can see is not a question. The person may have hit
    // Escape while the model was thinking, or be reading the settings view.
    setOpen(true);
    setSettingsOpen(false);

    // From here until somebody answers, the stored record says a question was
    // open on this verb. `asked` and not `sent`: the core asks BEFORE it runs,
    // so if the page dies now the verb provably did not run, and the restored
    // panel can say that flatly instead of hedging. Written down at once rather
    // than at the next transcript change, because the event this is for is a
    // page that goes away without warning.
    inFlight = { verb: req.verb.name, phase: "asked" };
    rememberNow();

    // The clock on the human wait starts here and stops in the `finally`
    // below, whichever way the question is answered -- yes, no, a timeout, the
    // panel being torn down. See `waitedMs`.
    const askedAt = Date.now();

    const reversible = req.verb.reversible === true;
    const large = count !== undefined && count > askAbove;

    const row = el("div", "dk-ask");
    const question = el("div", "dk-ask-q");
    question.textContent =
      count === undefined
        ? `${req.verb.describe}?`
        : `${req.verb.describe} — ${commas(count)} rows?`;
    const why = el("div", "dk-ask-why");
    // The two dialogs must not read alike. Two questions with the same words
    // are one question as far as a person's attention is concerned, and the
    // person who stops reading the reversible one has stopped reading the
    // other one too — which is the failure this whole change exists to avoid,
    // reintroduced one level down. So a reversible commit says there is a way
    // back, and says why it is being asked about at all when the only reason
    // is the size.
    why.textContent =
      (reversible
        ? "This changes data, but the app says this can be undone." +
          (large
            ? " You are being asked because of how many rows it affects: an undo over" +
              " this many is a promise an app may not be able to keep."
            : "")
        : "This changes data and may be irreversible.") +
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
    post(row);
    // Focus the safe answer, not the destructive one. A person pressing Enter
    // on a dialog that appeared while they were typing should not thereby
    // accept a thousand rows; reaching "Yes" takes one deliberate key.
    no.focus?.();

    return new Promise<Approval>((resolve) => {
      let answered = false;
      const answer = (decision: Approval, said: string): void => {
        if (answered) return;
        answered = true;
        // The human wait is over, however it ended. Counted on EVERY exit --
        // yes, no, a stopped run, the panel being torn down -- because a model
        // told a declined commit "took 40 seconds" has learnt the same false
        // thing about the app's speed as one told it about an approved commit.
        waitedMs += Math.max(0, Date.now() - askedAt);
        // The question is no longer open. Whether the verb then RUNS is the
        // core's business and the call path's; `onCall` sets `sent` a moment
        // later for an approved commit, and for a declined one nothing runs and
        // the record correctly says nothing was in flight.
        if (inFlight?.phase === "asked" && inFlight.verb === req.verb.name) {
          inFlight = undefined;
        }
        openQuestions.delete(onTeardown);
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
      signal?.addEventListener?.("abort", () =>
        answer("the run was stopped before this ran", "Stopped before this ran."),
      );
      // Registered last, so the set only ever holds questions that are
      // genuinely open — a signal that had already fired answered above and
      // deleted this before it was ever added.
      openQuestions.add(onTeardown);
      function onTeardown(): void {
        answer(teardown, "The panel was closed before this was answered.");
      }
    });
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
    return post(line);
  }

  /** Put one element in the transcript, and remember that it is in there.
   *  Everything that appends to the log goes through here, because a line that
   *  skipped it would be a line "clear conversation" could not clear — which
   *  is a transcript that is half gone, the one outcome worse than either
   *  keeping it or dropping it. */
  function post(node: ElementLike): ElementLike {
    lines.push(node);
    log.appendChild(node);
    scroll();
    return node;
  }

  /**
   * Write the conversation down as it stands.
   *
   * Called after every event that changes what a restored panel would show: a
   * question going up or coming down, a call being announced or settling, the
   * model saying something, a run ending. Not debounced and not deferred to
   * `beforeunload`. The event this whole feature exists for is a page that goes
   * away WITHOUT warning — a crash, a navigation the agent itself caused — so a
   * scheme that batches is a scheme that loses exactly the moment it was built
   * to remember. Each write is a `JSON.stringify` of an already-pruned
   * conversation and one `setItem`, which is cheaper than the model round trip
   * on either side of it.
   *
   * `at` is the caller's `era`, where the caller is inside a run. A write from a
   * run the person has cleared must not land, for the reason `era` exists at
   * all: an abort resolves at the loop's next await, so a run can still be
   * speaking after its conversation has been thrown away — and here that write
   * would go to DISK, where a reload brings it back. The clear itself forgets
   * the key, so the only way a cleared conversation could return is a stray
   * write afterwards, and this is what stops it.
   *
   * Three things make this a no-op, in order of how often they happen: the app
   * did not opt in, the viewer switched it off, or there is nothing to store. On
   * the viewer's switch it also FORGETS — turning the setting off is a request
   * about what is on the disk, not just about what happens next.
   */
  function rememberNow(at?: number): void {
    if (session === undefined) return;
    if (at !== undefined && at !== era) return;
    if (!settings.rememberChat) {
      forgetChat(session, app);
      return;
    }
    // The run in flight, when there is one, because a conversation stored
    // halfway through a run is the entire point. See `live`.
    const conversation = liveTurns ?? messages;
    if (conversation.length === 0 && inFlight === undefined) {
      // Nothing worth coming back to. Written as a forget rather than as an
      // empty record so that a fresh panel in a reloaded tab is a fresh panel,
      // not one announcing that it restored nothing.
      forgetChat(session, app);
      return;
    }

    // Scrub, then trim, in that order and not the other way round. Scrubbing
    // replaces a value with a shorter marker, so doing it first can only make
    // the record smaller -- and trimming first would decide what to keep on the
    // strength of bytes that are about to be thrown away anyway. Both at this
    // one boundary: see `scrubTurns` on why the redaction is here and not at
    // the call sites that build turns.
    const scrubbed = scrubTurns(conversation, driver.manifest());
    const { messages: kept, trimmed } = trimTurns(scrubbed);
    saveChat(session, app, {
      at: Date.now(),
      messages: kept,
      conversed,
      ...(inFlight === undefined ? {} : { inFlight }),
      ...(trimmed ? { trimmed } : {}),
    });
  }

  /**
   * Bring back whatever the last page load left, and resume nothing.
   *
   * Run once, at mount, after the greeting. What comes back is the
   * conversation: the model turns go into `messages`, so the person's next
   * message carries on from where they were, and a readable line per turn goes
   * into the transcript so the panel does not look empty while secretly
   * remembering everything.
   *
   * **What is deliberately NOT restored, and why none of it is an oversight.**
   * No run is restarted and no verb is called — see `chat.ts` on "restore
   * everything, resume nothing". The step list's live states are not redrawn,
   * because a marker that says "running" about a run which ended at a reload is
   * a panel lying about the present. The screen blocks in the stored turns are
   * not displayed, though the newest is still handed to the model, because a
   * wall of table is not what somebody wants to see first.
   *
   * The notice goes LAST, under the restored history, because that is where the
   * panel scrolls to and where the eye lands — and the first of its lines is
   * the one about what may have happened to the data.
   */
  function restoreConversation(): void {
    if (session === undefined || !settings.rememberChat) return;
    const found = loadChat(session, app);
    if (!found) return;

    // Every dangling `tool_use` gets an answer before this history can ever
    // reach a provider. Not optional and not cosmetic: a `tool_use` with no
    // result is a 400 on the person's next message and on every message after
    // it, with a transcript on screen that looks fine. See `closeDangling`.
    messages = closeDangling(found.messages, found.inFlight);
    conversed = found.conversed;

    for (const line of replayLines(found)) say(line.className, line.text);
    for (const line of restoredLines(found)) say("dk-note", line);

    // Rewritten at once, with the dangling calls now answered and `inFlight`
    // cleared. Otherwise a second reload would re-announce a call that is two
    // reloads old as though it had just been interrupted, and the person would
    // be sent to check the same verb again.
    inFlight = undefined;
    rememberNow();
  }

  /**
   * Drop the transcript, the step list and the history, and stop whatever is
   * running. See the settings row for why this is where it lives and why it
   * asks nothing first.
   */
  function clearConversation(): void {
    // First, and through the run's own controller: the loop must not be left
    // holding `messages` the panel has just thrown away. `era` is what keeps
    // that run's dying words — its stop note, its abandoned steps, the history
    // it hands back — out of the conversation that replaces it.
    era++;
    running?.abort();
    messages = [];
    // Before anything else that could write, and unconditional. `era` already
    // stops a dying run's words landing in the fresh transcript, and a stored
    // record is the same hazard with a longer fuse: clear the panel, reload,
    // and a cleared conversation comes back off disk. The destructive option
    // has to be destructive all the way down -- and `rememberNow` below is
    // era-guarded, so the aborted run cannot write the old transcript back
    // after this.
    inFlight = undefined;
    forgetChat(session, app);
    for (const line of lines) line.remove();
    lines.length = 0;
    conversed = false;
    say("dk-note", greeting);
    // Out of the settings view, because the thing the person just acted on is
    // the conversation and that is not the view they are looking at. This also
    // puts focus in the input, which is where a fresh panel starts.
    setSettingsOpen(false);
    // Said out loud as well, because the panel going empty is a change
    // somebody who cannot see it has no other way to notice.
    status.textContent = "Conversation cleared";
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
    post(entry.line);
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
    // Before the paint, so the numbers a person reads are the numbers as of the
    // moment they opened the view and not as of whenever the panel was built.
    if (next) paintBudget();
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
    paintLauncher();
  }

  /**
   * The dot in the launcher, and the launcher's accessible name with it.
   *
   * On when the panel is minimised AND there is something behind it: a
   * conversation, or a run still going. Both, because they are different
   * reasons to look: the run is the urgent one and the transcript is the one
   * that is still true an hour later. Not on while the panel is open, where
   * the transcript is the thing the person is looking at and a dot would be
   * saying so to somebody already reading it.
   */
  function paintLauncher(): void {
    const waiting = !isOpen && (conversed || isBusy);
    dot.className = waiting ? "dk-dot dk-dot-on" : "dk-dot";
    launcher.setAttribute("aria-label", waiting ? WAITING_LABEL : ASK_LABEL);
    launcher.setAttribute("title", waiting ? WAITING_LABEL : ASK_LABEL);
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
    // The same function the panel adopts as the core's approver, so an app
    // that wires this up by hand and an app that wires up nothing get the
    // identical dialog, the identical rules and the identical record.
    approve: approveRequest,
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
      // The gate goes back to whatever the app declared, BEFORE the questions
      // are drained: a commit arriving in between must not be sent to a dialog
      // that is already being torn down. After this the core's policy is
      // `declared` again — `none` for a widget-only app — so a later commit is
      // ungated and records `not-asked, none`, which is then the truth.
      release?.();
      // Nobody is going to answer these. An unmount with a question open is
      // ordinary — the person closes the app's tab, the host swaps a route —
      // and `driver.call()` is sitting on a promise that only this panel can
      // resolve, with no `approvalTimeout` by default. Left alone that is a
      // driver that refuses every later call `approval-pending` until the page
      // is reloaded: a dead app, caused by closing a chat panel.
      for (const answer of [...openQuestions]) answer();
      openQuestions.clear();
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

/**
 * Said once, for an arrangement the author has to fix in their own source.
 *
 * The core's shape, deliberately copied rather than imported: `registry.ts`
 * keeps its `warn` private, and a panel that printed the same sentence on every
 * commit would be a panel people learn to mute. Deduped per message, so a run
 * that confirms forty commits says this once.
 */
const warned = new Set<string>();

function warn(text: string): void {
  if (warned.has(text)) return;
  warned.add(text);
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`driverkit: ${text}`);
  }
}
