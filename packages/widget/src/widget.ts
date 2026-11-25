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
 * **What it does not do is hold a key.** `think` is the host app's function,
 * exactly as in `@driverkit/agent`; see that package's `types.ts` for why, and
 * `backendThink` for the thirty lines that make the realistic deployment work.
 */

import type { Driver, VerbKind } from "driverkit";
// The only cross-package VALUE import in the repository. Everything else
// between packages is `import type`, which `verbatimModuleSyntax` erases
// outright -- so this one line is the whole reason `@driverkit/widget` needs
// `@driverkit/agent` as a runtime dependency and not a types-only one.
import { commas, drive } from "@driverkit/agent";
import type {
  CommitDecision,
  CommitRequest,
  DriveOptions,
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
import { positioner } from "./position.ts";
import type { Fraction, Position } from "./position.ts";

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
  /** Where a remembered position is kept. Default `localStorage`, if reaching
   *  for it does not throw. */
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
  /** Remember the position in `localStorage`, per app and per viewer. Default
   *  true. Every read and write is wrapped: storage throws in a private window
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

  const app = options.title ?? driver.manifest().app;

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
  const close = el("button", "dk-x");
  close.textContent = "Close";
  close.setAttribute("type", "button");
  head.appendChild(title);
  head.appendChild(move);
  head.appendChild(close);
  panel.appendChild(head);

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

  // The header drags the panel, and `"ignore"` is what keeps the two buttons
  // in it clickable: a press that starts on Close is Close's, even if the hand
  // moves two pixels before it lifts.
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

  if (options.open) setOpen(true);

  // ---- the run -----------------------------------------------------------

  async function ask(text: string): Promise<void> {
    if (!live || running) return;
    say("dk-you", text);

    const controller = Abort ? new Abort() : null;
    running = controller;
    busy(true);

    // One trace line per call, filled in when the result arrives. Keyed by the
    // model's call id so a turn with several calls does not cross its wires.
    const lines = new Map<string, ElementLike>();

    // The last count a `describe` verb reported in this run, and the reason the
    // confirmation row is worth building at all: "accept the current
    // selection?" is a question nobody can answer, and "accept 1,000
    // contacts?" is one anybody can. Only from a `describe` — a count from a
    // `read` verb is about something else — and cleared once a commit has been
    // asked about, because that selection has now been spoken for.
    let lastCount: number | undefined;

    const gate =
      options.onBeforeCommit ??
      (options.confirmCommits === false ? undefined : confirmCommit);

    /** The built-in gate. Renders a question in the transcript and waits. */
    function confirmCommit(req: CommitRequest): Promise<CommitDecision> {
      // A question nobody can see is not a question. The person may have hit
      // Escape while the model was thinking.
      setOpen(true);

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

    try {
      const out = await drive(driver, {
        think: options.think,
        task: text,
        history: messages,
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.refusalLimit === undefined ? {} : { refusalLimit: options.refusalLimit }),
        ...(gate === undefined ? {} : { onBeforeCommit: gate }),
        ...(controller ? { signal: controller.signal } : {}),

        onCall: ({ call, kind }) => {
          lines.set(call.id, trace(call.name, kind, argSummary(call.args)));
        },
        onResult: ({ call, kind, result }) => {
          if (kind === "describe" && result?.ok) lastCount = result.count;
          const line = lines.get(call.id);
          if (!line) return;
          if (result === null) {
            line.textContent = `${line.textContent} · looked`;
            return;
          }
          if (result.ok) {
            // The count is repeated here on purpose. It is the number the
            // commit decision turns on, and the person watching should be able
            // to see "1,000 matched" without reading the model's summary of
            // it.
            line.textContent =
              `${line.textContent} · ok` +
              (result.count === undefined ? "" : ` · ${commas(result.count)} matched`);
          } else {
            line.className = `${line.className} dk-step-refused`;
            line.textContent = `${line.textContent} · refused: ${result.refused}`;
          }
        },
        onSay: ({ text: prose }) => say("dk-me", prose),
      });

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

  function trace(name: string, kind: VerbKind | undefined, args: string): ElementLike {
    // `commit` is marked in the trace as well as in the prompt. The model being
    // told is not the same as the person being told, and this is the line
    // someone scrolls back to when they want to know what changed their data.
    const line = el("div", `dk-step${kind === "commit" ? " dk-step-commit" : ""}`);
    line.textContent = `${name}${kind ? ` (${kind})` : ""}${args}`;
    log.appendChild(line);
    scroll();
    return line;
  }

  function scroll(): void {
    // Both guarded: `scrollHeight` does not exist on a fake and `scrollTop` is
    // a courtesy, not part of the contract.
    if (typeof log.scrollTop === "number" && typeof log.scrollHeight === "number") {
      log.scrollTop = log.scrollHeight;
    }
  }

  function setOpen(next: boolean): void {
    wrap.className = next ? "dk-wrap dk-open" : "dk-wrap";
    launcher.setAttribute("aria-expanded", next ? "true" : "false");
    // Focus follows the panel in both directions. A keyboard user who opens a
    // panel and is left on the launcher has to tab back through the whole app
    // to reach it, and one who closes it and is left nowhere has lost their
    // place entirely.
    (next ? input : launcher).focus?.();
  }

  function busy(on: boolean): void {
    const base = wrap.className.replace(/ ?dk-busy/, "");
    wrap.className = on ? `${base} dk-busy` : base;
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
      host.remove();
    },
  };
}

/** A short, safe rendering of a call's arguments for the trace line.
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
