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

import type { Approval, ApprovalRequest, Driver, Snapshot } from "driverkit";
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
   * it. The gate that covers every path is `MountOptions.approve`, and
   * `Widget.approve` is this panel's dialog in that shape. When the driver was
   * mounted with an `approve` hook, the panel installs no gate of its own —
   * but passing this one puts it back, and then a commit from the in-page run
   * is asked about twice: once by you here and once by the core's hook. That
   * is a combination to pick deliberately or not at all.
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
   * cover the relay path as well as the in-page one. Wire it up with a
   * forward reference, because `mount()` has to happen before the panel that
   * will answer for it exists:
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
   * The one difference from the in-page path, and it is unavoidable: the count
   * comes from the screen (`Snapshot.selectedCount`, then the visible
   * `selected`) because there is no run whose last `describe` could have
   * reported one. An app whose selection size is only knowable from a verb's
   * `Report.count` will show "No count was reported" here, which is the honest
   * answer and is itself a reason to say no.
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
  if (options.open) setOpen(true);

  // ---- the run -----------------------------------------------------------

  async function ask(text: string): Promise<void> {
    if (!live || running) return;
    say("dk-you", text);
    conversed = true;
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

    // The last count a `describe` verb reported in this run, and the reason the
    // confirmation row is worth building at all: "accept the current
    // selection?" is a question nobody can answer, and "accept 1,000
    // contacts?" is one anybody can. Only from a `describe` — a count from a
    // `read` verb is about something else — and cleared once a commit has been
    // asked about, because that selection has now been spoken for.
    let lastCount: number | undefined;

    // Always installed when the host has not replaced it AND the core is not
    // already gating, and the SETTING is read inside — so turning
    // confirmations off, or back on, in the middle of a run takes effect on
    // the next commit rather than the next run. That is what somebody who has
    // just watched a commit go past expects of the switch they reached for.
    //
    // Nothing is installed when the driver was mounted with an `approve` hook.
    // That hook is called inside `driver.call()` for every path, this one
    // included, so installing the panel's gate as well would be two questions
    // about one commit — which is the thing this panel's own documentation
    // says teaches people to click Yes without reading. An app that wants the
    // panel to be that hook wires `approve: (req) => panel.approve(req)`; see
    // `Widget.approve`.
    const gate =
      options.onBeforeCommit ?? (driver.approval?.policy === "hook" ? undefined : confirmCommit);

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
      return withLock(req.name, () => askPerson(req, count, controller?.signal));
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
      },
      onControl: ({ state }) => show(state),
      onResult: ({ call, kind, result }) => {
        if (era !== mine) return;
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
      onSay: ({ text: prose }) => {
        if (era !== mine) return;
        say("dk-me", prose);
      },
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
      const note = STOP_NOTE[out.stop];
      if (note) say("dk-note", note);
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
   * Render the question in the transcript and wait for an answer.
   *
   * `signal` is the run's abort, when there is a run. Without it a stop or an
   * unmount would leave the loop waiting on a promise nobody will ever resolve
   * and the panel stuck busy forever — so the abort answers the question, and
   * the only safe answer is no. A call that arrived over the relay has no run
   * and therefore no signal: that question stays open until somebody answers
   * it or `MountOptions.approvalTimeout` lapses, which is the core's business
   * and not the panel's.
   */
  function askPerson(
    req: ApprovalRequest,
    count: number | undefined,
    signal?: { addEventListener?: (type: string, fn: () => void) => void },
  ): Promise<CommitDecision> {
    // A question nobody can see is not a question. The person may have hit
    // Escape while the model was thinking, or be reading the settings view.
    setOpen(true);
    setSettingsOpen(false);

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
      signal?.addEventListener?.("abort", () =>
        answer("the run was stopped before this ran", "Stopped before this ran."),
      );
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
    // No `withLock` here: the core took its lock before it called this, and a
    // second take would be the panel asserting a thing that is already true.
    // No count from `lastCount` either — see `Widget.approve`.
    approve: async (req: ApprovalRequest): Promise<Approval> => {
      const count = countFor(req.snapshot);
      if (!shouldAsk(req, count)) return true;
      // The run in flight's signal, when there is one, so that stopping a run
      // also answers a question the relay asked during it. Usually there is
      // no run at all, and then only an answer or the core's
      // `approvalTimeout` ends the wait.
      const decision = await askPerson(req, count, running?.signal);
      return decision as Approval;
    },
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
