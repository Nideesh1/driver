/**
 * Where the panel sits, and how it gets out of the way.
 *
 * **This is not decoration.** The widget drives the app underneath itself. A
 * person asks it to select rows and the panel is now sitting on top of the
 * rows they asked about, so moving it is how they see the thing the agent just
 * did. That is the whole design brief for this file: one gesture, one
 * keystroke, and the panel is somewhere else — and it is still there tomorrow.
 *
 * ## The unit is a fraction of the free space, not pixels
 *
 * A position is two numbers in `[0, 1]`: `fx = 0` means flush with the left
 * edge, `fx = 1` flush with the right, `0.5` centred. The pixel position is
 * derived in CSS, not here:
 *
 * ```css
 * left: calc(var(--dk-gap) + var(--dk-x) * (100vw - var(--dk-gap) * 2));
 * translate: calc(var(--dk-x) * -100%) calc(var(--dk-y) * -100%);
 * ```
 *
 * At `fx = 1` the element is pushed to `100vw - gap` and then pulled back by
 * its own full width, so its right edge lands on the gap. Work the algebra
 * through for any `fx` and the left edge is `gap + fx * (vw - 2*gap - w)`,
 * which is inside the viewport for every `fx` in `[0, 1]` and every viewport
 * at least as wide as the panel. **A stored fraction cannot describe an
 * off-screen panel.** Pixels can, and a panel 1,100px from the left of a
 * window that is now 600px wide is unreachable — no header to grab, no corner
 * to snap from — and the only cure is clearing site data, which nobody knows
 * to do. So pixels are accepted as input (`{ x, y }`, which is what a host
 * app has on hand) and converted once, against the viewport they were measured
 * in; after that there are only fractions.
 *
 * The one case the algebra does not cover is a viewport narrower than the
 * panel. There `vw - 2*gap - w` is negative and `fx = 1` would drag the panel
 * off the LEFT edge, so `clamp` collapses that axis to 0 and the panel hugs
 * the near edge where the header is still grabbable. The person's chosen
 * fraction is kept, not overwritten, so widening the window puts it back.
 *
 * ## Nothing is written unless it has to be
 *
 * The default position is a declaration in `css.ts` and nothing else, so a
 * host app can place the panel from its own stylesheet with no JavaScript, the
 * same way it can retheme it. Inline custom properties appear only once
 * somebody has actually chosen a position — an explicit `position` option, a
 * remembered one, a drag, a keypress — because at that point the person
 * outranks the author's stylesheet.
 */

import type { ElementLike, EventLike, RectLike, StorageLike, WindowLike } from "./dom.ts";

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** A corner, or a pixel offset from the viewport's top-left corner. Pixels are
 *  converted to a fraction the moment they are applied; see the file header. */
export type Position = Corner | { x: number; y: number };

/** Fractions of the free space, both in `[0, 1]`. */
export interface Fraction {
  fx: number;
  fy: number;
}

const CORNERS: Record<Corner, Fraction> = {
  "top-left": { fx: 0, fy: 0 },
  "top-right": { fx: 1, fy: 0 },
  "bottom-left": { fx: 0, fy: 1 },
  "bottom-right": { fx: 1, fy: 1 },
};

/** The order the keyboard cycles, starting where the panel starts. */
const CYCLE: Corner[] = ["bottom-right", "bottom-left", "top-left", "top-right"];

export function isCorner(p: Position): p is Corner {
  return typeof p === "string" && p in CORNERS;
}

/**
 * How far a release can be from a corner and still land in it, in pixels.
 *
 * Corners are where a panel belongs nearly all the time — out of the way of
 * the middle of the screen, which is where the app's content is — so a magnet
 * is cheaper than asking for precision. Far from a corner the drop is honoured
 * exactly, because somebody who dragged the panel to the middle of the screen
 * meant it.
 */
export const SNAP = 72;

/**
 * How far a pointer must travel before it is a drag and not a click, in
 * pixels.
 *
 * Distance and not time, because time is wrong in both directions: a slow,
 * deliberate click on the launcher is not a drag, and a fast flick of the
 * panel across the screen is not a click. Fingers and pens also wobble by a
 * pixel or two on a tap that was never meant to move anything, which is the
 * other reason this is not zero.
 */
export const SLOP = 4;

/** The keyboard nudge, as a fraction of the free space. Deliberately coarse:
 *  the goal is "off the thing I am reading", and a 1px-at-a-time nudge would
 *  take sixty keystrokes to achieve it. */
const STEP = 0.1;

export interface PositionerOptions {
  /** The element custom properties are written to — the widget's host element,
   *  which is what `:host` positions. */
  host: ElementLike;
  /** Namespaces the storage key, so two driverkit apps on one origin do not
   *  fight over one remembered position. */
  app: string;
  position?: Position;
  window?: WindowLike;
  storage?: StorageLike;
  /** Default true. */
  persist?: boolean;
  /** Default true. False leaves the panel wherever the option and the
   *  stylesheet put it. */
  draggable?: boolean;
  /** Pixels. 0 switches snapping off. */
  snapThreshold?: number;
  /** Must match `--dk-gap`, which is what the arithmetic in `css.ts` insets
   *  by. Only worth passing if the host app overrode that property. */
  gap?: number;
  /** Spoken to a screen reader. A panel that moves silently has moved only
   *  for the people who can see it. */
  announce?: (text: string) => void;
}

export interface Positioner {
  /**
   * Make `el` draggable, and return the predicate its own click handler has to
   * consult first: true means the click that just arrived is the tail of a
   * drag of THIS element and belongs to the drag.
   *
   * Per element rather than one flag for the whole widget, because a drag of
   * the header produces a click on the header — which nothing listens for —
   * and a single shared flag would then still be set when the person's next
   * real click landed on the launcher.
   *
   * `controls: "ignore"` refuses to start a drag from a button or input
   * inside `el`, which is what keeps the header's Close button clickable.
   */
  handle: (el: ElementLike, controls?: "ignore" | "allow") => () => boolean;
  /** Arrow keys. `plain` allows bare arrows, which only the move button does;
   *  everywhere else it takes Alt. Returns true if the key was used. */
  key: (event: EventLike, plain?: boolean) => boolean;
  moveTo: (position: Position) => void;
  /** The next corner round, or the nearest one if the panel is between them. */
  cycle: () => void;
  /** The chosen position, or null while the stylesheet is still in charge. */
  chosen: () => Fraction | null;
  dispose: () => void;
}

export function storageKey(app: string): string {
  return `driverkit:widget:position:${app}`;
}

/** The real `localStorage`, if reaching for it does not throw — which it does
 *  when site data is blocked, before any read has even been attempted. */
export function defaultStorage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read one JSON value out of storage, or null for every way that can fail: no
 * storage, a throwing read, an empty slot, malformed JSON, or a shape `parse`
 * does not recognise.
 *
 * All of them mean the same thing to the caller — use the default — so none is
 * worth distinguishing, and none is worth breaking a chat panel over. A
 * private window and a person who blocked site data both throw on the way IN,
 * before any value has been looked at, which is why the `getItem` call and the
 * parsing are inside one try and not two.
 *
 * This is the only place in the package that reads persisted state. The
 * settings view keeps its own key and its own shape and goes through here, so
 * there is one mechanism to get the try/catch right in rather than two.
 */
export function loadJson<T>(
  storage: StorageLike | undefined,
  key: string,
  parse: (value: unknown) => T | null,
): T | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write one JSON value, and swallow every reason it can fail. */
export function saveJson(storage: StorageLike | undefined, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // A full quota, a private window, a user who blocked site data. The
    // position is still correct for this session; it just will not be
    // remembered, and that is not worth a thrown error inside a pointerup
    // handler that would leave the drag state wedged.
  }
}

/** A remembered position, or null if there is not one to be had. */
export function read(storage: StorageLike | undefined, app: string): Fraction | null {
  return loadJson(storage, storageKey(app), (value) => {
    const at = value as { fx?: unknown; fy?: unknown } | null;
    const fx = finite(at?.fx);
    const fy = finite(at?.fy);
    if (fx === null || fy === null) return null;
    return { fx: unit(fx), fy: unit(fy) };
  });
}

export function write(storage: StorageLike | undefined, app: string, at: Fraction): void {
  saveJson(storage, storageKey(app), at);
}

/** The corner nearest `at`, and how far away it is in pixels. */
export function nearestCorner(at: Fraction, freeW: number, freeH: number): { corner: Corner; away: number } {
  let best: { corner: Corner; away: number } | null = null;
  for (const corner of CYCLE) {
    const c = CORNERS[corner]!;
    const away = Math.hypot((at.fx - c.fx) * Math.max(freeW, 0), (at.fy - c.fy) * Math.max(freeH, 0));
    if (!best || away < best.away) best = { corner, away };
  }
  return best!;
}

/** What a screen reader is told. Corners get their name; anywhere else gets
 *  percentages, because "0.37" is not a place. */
export function describe(at: Fraction): string {
  for (const corner of CYCLE) {
    const c = CORNERS[corner]!;
    if (c.fx === at.fx && c.fy === at.fy) return corner.replace("-", " ");
  }
  return `${Math.round(at.fx * 100)}% across, ${Math.round(at.fy * 100)}% down`;
}

export function positioner(options: PositionerOptions): Positioner {
  const host = options.host;
  const win = options.window ?? (globalThis as WindowLike);
  const gap = options.gap ?? 16;
  const threshold = options.snapThreshold ?? SNAP;
  const persist = options.persist !== false;
  const storage = persist ? (options.storage ?? defaultStorage()) : undefined;

  /** The position somebody chose, unclamped, or null while nobody has — in
   *  which case `css.ts` is still in charge. */
  let chosen: Fraction | null = null;
  /** Where the stylesheet put the panel, read back off the layout once at
   *  mount. Needed because the clamp has to be able to rescue the DEFAULT
   *  position too: `:host` says "flush right", a window narrower than the
   *  panel makes that mean "off the left edge", and no amount of CSS can
   *  notice. */
  let fromCss: Fraction | null = null;
  /** Sticky. Once a custom property has been written inline there is no way to
   *  un-write it with `StyleLike`, so after the first write this keeps writing
   *  — otherwise a clamp applied in a narrow window would survive the window
   *  being widened again, which is the bug the clamp exists to prevent. */
  let wrote = false;
  let dragging = false;
  let snapped = false;
  let disposed = false;

  {
    const m = measure();
    if (m) fromCss = fromLayout(m);
  }

  // Remembered beats the option: the option is the author's idea of where the
  // panel goes and the remembered one is where this particular person put it,
  // and the person was looking at their own screen when they decided.
  const remembered = read(storage, options.app);
  if (remembered) set(remembered, { save: false });
  // Not saved: the option is the author's default and saving it would turn
  // this person's storage into a copy of it, so the day the author changed the
  // option nobody would ever see the new one.
  else if (options.position !== undefined) applyPosition(options.position, false);
  // Mounting into a window that is already too narrow for the panel is the
  // same problem as resizing into one.
  else paint();

  const onResize: (event: EventLike) => void = () => {
    // Re-applied rather than recomputed: the chosen position is unchanged, but
    // the clamp it goes through is not, so a panel that was flush right in a
    // wide window and does not fit in a narrow one comes back to the near edge
    // — and returns to the right edge when the window is widened again.
    paint();
  };
  win.addEventListener?.("resize", onResize);

  return {
    handle,
    key,
    moveTo,
    cycle,
    chosen: () => (chosen ? { ...chosen } : null),
    dispose: () => {
      disposed = true;
      win.removeEventListener?.("resize", onResize);
    },
  };

  // -- applying ------------------------------------------------------------

  function set(at: Fraction, opts: { save: boolean; animate?: boolean }): void {
    chosen = { fx: unit(at.fx), fy: unit(at.fy) };
    snapped = opts.animate === true && !reducedMotion();
    paint();
    if (opts.save) write(storage, options.app, chosen);
  }

  function paint(): void {
    host.className = `dk-host${dragging ? " dk-dragging" : ""}${snapped ? " dk-snap" : ""}`;
    const at = chosen ?? fromCss;
    if (!at || !host.style) return;
    const m = measure();
    // The clamp, and the only place the viewport is allowed to override the
    // person: a panel wider than the window has to give up its fraction on
    // that axis or it ends up off the OPPOSITE edge, header first, with
    // nothing left to grab. The chosen value is not overwritten, so widening
    // the window puts the panel back where the person left it.
    const fx = m && m.freeW <= 0 ? 0 : at.fx;
    const fy = m && m.freeH <= 0 ? 0 : at.fy;
    // Nothing is written while the stylesheet is still in charge and the clamp
    // has nothing to say — that silence is what lets a host app position the
    // panel from its own CSS.
    if (chosen === null && !wrote && fx === at.fx && fy === at.fy) return;
    wrote = true;
    host.style.setProperty("--dk-x", String(round(fx)));
    host.style.setProperty("--dk-y", String(round(fy)));
  }

  function moveTo(position: Position): void {
    applyPosition(position, true);
  }

  function applyPosition(position: Position, save: boolean): void {
    if (isCorner(position)) {
      set(CORNERS[position], { save, animate: true });
      if (save) options.announce?.(`Panel moved to ${describe(CORNERS[position])}`);
      return;
    }
    const m = measure();
    // Without a measurable box there is no way to turn a pixel offset into a
    // fraction, and guessing would put the panel somewhere nobody asked for.
    // Leaving the stylesheet in charge is the honest failure.
    if (!m) return;
    set(
      {
        fx: m.freeW > 0 ? (position.x - gap) / m.freeW : 0,
        fy: m.freeH > 0 ? (position.y - gap) / m.freeH : 0,
      },
      { save, animate: true },
    );
    if (save) options.announce?.(`Panel moved to ${describe(chosen!)}`);
  }

  function cycle(): void {
    const m = measure();
    const at = current(m);
    if (!at || !m) return;
    const near = nearestCorner(at, m.freeW, m.freeH);
    // From between corners, the first press lands on the nearest one rather
    // than jumping across the screen; from a corner it advances.
    const next = near.away === 0 ? CYCLE[(CYCLE.indexOf(near.corner) + 1) % CYCLE.length]! : near.corner;
    set(CORNERS[next], { save: true, animate: true });
    options.announce?.(`Panel moved to ${describe(CORNERS[next])}`);
  }

  // -- geometry ------------------------------------------------------------

  interface Measurement {
    rect: RectLike;
    freeW: number;
    freeH: number;
  }

  function measure(): Measurement | null {
    const rect = host.getBoundingClientRect?.();
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    // Null, rather than a zero-sized viewport, when the window cannot say how
    // big it is — which is what every non-browser host looks like. A clamp
    // against a viewport of 0x0 concludes that nothing fits and drags the
    // panel to the corner, which would be a confident answer derived from no
    // information at all.
    if (!rect || vw === undefined || vh === undefined || vw <= 0 || vh <= 0) return null;
    return { rect, freeW: vw - gap * 2 - rect.width, freeH: vh - gap * 2 - rect.height };
  }

  /** Where the panel is now, as a fraction. Derived from the measured box when
   *  nobody has chosen a position, because in that case the answer lives in
   *  the stylesheet and the layout is the only thing that knows it. */
  function current(m: Measurement | null): Fraction | null {
    if (chosen) return chosen;
    if (!m) return null;
    return fromLayout(m);
  }

  /** The fraction that produced this layout — the inverse of the arithmetic in
   *  `css.ts`. On an axis with no free space the inverse does not exist, so it
   *  falls back to the stylesheet's own default of 1 rather than inventing a
   *  position; that is the case where the clamp is about to take over anyway. */
  function fromLayout(m: Measurement): Fraction {
    return {
      fx: m.freeW > 0 ? unit((m.rect.left - gap) / m.freeW) : 1,
      fy: m.freeH > 0 ? unit((m.rect.top - gap) / m.freeH) : 1,
    };
  }

  function reducedMotion(): boolean {
    try {
      return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    } catch {
      return false;
    }
  }

  // -- dragging ------------------------------------------------------------

  function handle(el: ElementLike, controls: "ignore" | "allow" = "allow"): () => boolean {
    let swallow = false;
    const swallowsClick = (): boolean => {
      const was = swallow;
      swallow = false;
      return was;
    };
    if (options.draggable === false) return swallowsClick;

    let drag: { id?: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;

    el.addEventListener("pointerdown", (e) => {
      // Cleared on every press, not only on the presses that start a drag, so
      // a drag that ended without a click — released outside the handle, which
      // pointer capture makes normal — cannot leave a flag that swallows the
      // person's next real press of this same button.
      swallow = false;
      if (disposed) return;
      if (e.button !== undefined && e.button !== 0) return;
      if (controls === "ignore" && isControl(e.target)) return;
      const m = measure();
      if (!m) return;
      drag = {
        ...(e.pointerId === undefined ? {} : { id: e.pointerId }),
        x: e.clientX ?? 0,
        y: e.clientY ?? 0,
        left: m.rect.left,
        top: m.rect.top,
        moved: false,
      };
      // Stops the text selection and the native image-drag that otherwise
      // happen while a person is dragging a panel by its title.
      e.preventDefault?.();
      if (e.pointerId !== undefined) el.setPointerCapture?.(e.pointerId);
    });

    el.addEventListener("pointermove", (e) => {
      if (!drag || !mine(e, drag.id)) return;
      const dx = (e.clientX ?? 0) - drag.x;
      const dy = (e.clientY ?? 0) - drag.y;
      // Below the slop NOTHING moves — not by a pixel. A launcher that shifts
      // under a click that was meant to open it reads as a bug.
      if (!drag.moved && Math.hypot(dx, dy) < SLOP) return;
      drag.moved = true;
      dragging = true;
      const m = measure();
      if (!m) return;
      // Clamped here and not only on release, so the panel never spends even
      // one frame with its header under the edge of the window.
      set(
        {
          fx: m.freeW > 0 ? (drag.left + dx - gap) / m.freeW : 0,
          fy: m.freeH > 0 ? (drag.top + dy - gap) / m.freeH : 0,
        },
        { save: false },
      );
    });

    const end = (e: EventLike): void => {
      if (!drag || !mine(e, drag.id)) return;
      const moved = drag.moved;
      const id = drag.id;
      drag = null;
      dragging = false;
      if (id !== undefined) el.releasePointerCapture?.(id);
      if (!moved) {
        paint();
        return;
      }
      // The click that follows a drag belongs to the drag. Without this,
      // nudging the collapsed launcher aside opens the panel on top of the
      // thing the person was trying to uncover.
      swallow = true;
      const m = measure();
      const at = current(m);
      if (!at || !m) return;
      const near = nearestCorner(at, m.freeW, m.freeH);
      const snapping = threshold > 0 && near.away <= threshold;
      set(snapping ? CORNERS[near.corner] : at, { save: true, animate: snapping });
      options.announce?.(`Panel moved to ${describe(chosen!)}`);
    };

    el.addEventListener("pointerup", end);
    // A cancelled pointer is a pointer that is not coming back — the browser
    // took it for a scroll, the pen left the tablet. Treating it as a release
    // is what keeps the panel from being stuck to a pointer that no longer
    // exists.
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
    return swallowsClick;
  }

  function mine(e: EventLike, id: number | undefined): boolean {
    return id === undefined || e.pointerId === undefined || e.pointerId === id;
  }

  // -- keyboard ------------------------------------------------------------

  /**
   * Alt plus an arrow throws the panel to that edge; a bare arrow, which only
   * the move button sees, nudges it.
   *
   * Alt is the modifier because the bare arrows inside this panel already
   * belong to the text input and the transcript, and a positioning feature
   * that eats the Left arrow in a text field has broken typing to gain a
   * convenience. Alt+Arrow also works from the collapsed launcher, which is
   * the case that matters: the quickest way to see what the agent just did is
   * one keystroke that does not require finding anything first.
   *
   * The edge rather than a nudge, for the modified form, for the same reason
   * the snap exists — "get out of my way" is a corner, not an offset.
   */
  function key(event: EventLike, plain = false): boolean {
    const dir = ARROWS[event.key ?? ""];
    if (!dir) return false;
    const alt = event.altKey === true;
    if (!alt && !plain) return false;
    const m = measure();
    const at = current(m);
    if (!at) return false;
    const next = alt
      ? { fx: dir.x === 0 ? at.fx : dir.x < 0 ? 0 : 1, fy: dir.y === 0 ? at.fy : dir.y < 0 ? 0 : 1 }
      : { fx: at.fx + dir.x * STEP, fy: at.fy + dir.y * STEP };
    event.preventDefault?.();
    set(next, { save: true, animate: alt });
    options.announce?.(`Panel moved to ${describe(chosen!)}`);
    return true;
  }
}

const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** Something a click belongs to. A header is a drag handle and also the place
 *  the Close button lives, and a person who presses Close and twitches two
 *  pixels still meant Close. */
function isControl(target: ElementLike | undefined): boolean {
  const tag = target?.tagName;
  return tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "A";
}

function unit(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function finite(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Four places is a tenth of a pixel on a 4K screen, and it keeps the value
 *  written into CSS and into storage short enough to read in devtools. */
function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
