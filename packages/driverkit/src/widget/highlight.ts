/**
 * The outline over the element a verb is about to touch.
 *
 * ## `at` is presentational, and that is the whole rule
 *
 * A verb may name a CSS selector, `Verb.at`, for the thing on screen it is
 * about. The widget is allowed to draw on top of what that names and is
 * allowed to do nothing else with it. It never queries it to decide what to
 * call, never clicks it, never reads a value out of it, and never lets its
 * absence change what runs. If `at` could steer a call then driverkit would
 * have a selector in its execution path, and a library whose entire argument
 * is "no pixels, no selectors" would have quietly grown the failure mode it
 * exists to avoid — a rename in somebody's CSS breaking an agent.
 *
 * So every failure here is silent and every failure means the same thing: no
 * outline, run unchanged. No `at` (which is most verbs), no `querySelector` on
 * the injected document, a selector that matches nothing, a selector that is
 * not valid CSS, an element with no measurable box, an element measuring zero
 * — all of them return false and draw nothing.
 *
 * ## It is an overlay, not a border
 *
 * Nothing is written to the host app's element. Not a class, not a style, not
 * an attribute. A 2px border added to somebody's button reflows their layout,
 * and an agent that nudges the page sideways every time it names an element is
 * not a passive observer of that page. Instead this draws a separate fixed,
 * `pointer-events: none` box at the element's measured rectangle.
 *
 * Nothing is added to the host app's document until there is something to
 * outline, either. Most verbs declare no `at`, so for most apps this file
 * creates no element and attaches no listener at all; the overlay host appears
 * the first time an outline is actually drawn and is removed on unmount.
 *
 * That box lives in its OWN host element with its own shadow root, rather than
 * inside the panel's. The panel's `:host` carries a `translate` — see the
 * positioning arithmetic in `css.ts` — and a transformed ancestor becomes the
 * containing block for `position: fixed` descendants, so an outline drawn
 * inside the panel would be offset by wherever the panel happens to sit. Two
 * hosts is the cost of the positioning design, and it is cheap: both are
 * removed on unmount.
 */

import { SPOT_CSS } from "./css.ts";
import type { DocumentLike, ElementLike, Listener, NodeLike, WindowLike } from "./dom.ts";

export interface SpotlightOptions {
  document: DocumentLike;
  /** Where the overlay host goes. The panel's container, so a host app that
   *  keeps driverkit inside one subtree keeps all of it there. */
  container: ElementLike;
  /** Watched for scroll and resize, so an outline follows an element that
   *  moved under it — which it will, because the verb being announced is quite
   *  often the one that scrolls the row into view. */
  window?: WindowLike;
}

export interface Spotlight {
  /** Draw over what `selector` names. True if an outline is now showing.
   *  Anything that did not work returns false and leaves nothing drawn. */
  show: (selector: string | undefined) => boolean;
  hide: () => void;
  /** The selector currently outlined, or undefined. For tests, and for the
   *  panel's own "is anything showing" check. */
  showing: () => string | undefined;
  dispose: () => void;
}

export function spotlight(options: SpotlightOptions): Spotlight {
  const doc = options.document;
  const win = options.window;

  /** The overlay, built on first use. See the header: an app whose verbs name
   *  nothing should not pay an element and two listeners for a feature it
   *  never reaches. */
  let overlay: { host: ElementLike; box: ElementLike } | null = null;
  let at: string | undefined;

  function ensure(): { host: ElementLike; box: ElementLike } {
    if (overlay) return overlay;
    const host = doc.createElement("div");
    host.className = "dk-spot-host";
    // Decorative, and the panel already says in words what is about to
    // happen. An outline announced to a screen reader would be the same
    // sentence twice.
    host.setAttribute("aria-hidden", "true");
    const root: NodeLike = host.attachShadow
      ? host.attachShadow({ mode: "open" })
      : (host as NodeLike);
    const style = doc.createElement("style");
    style.textContent = SPOT_CSS;
    root.appendChild(style);
    const box = doc.createElement("div");
    box.className = "dk-spot";
    root.appendChild(box);
    options.container.appendChild(host);
    win?.addEventListener?.("scroll", reflow);
    win?.addEventListener?.("resize", reflow);
    overlay = { host, box };
    return overlay;
  }

  const reflow: Listener = () => {
    // Only while something is showing, and re-resolved from the selector
    // rather than from a cached element: between a scroll and now the app may
    // have re-rendered the row entirely, and an outline anchored to a detached
    // node is an outline in the wrong place.
    if (at !== undefined) draw(at);
  };
  return { show, hide, showing: () => at, dispose };

  function show(selector: string | undefined): boolean {
    if (selector === undefined || selector === "") {
      hide();
      return false;
    }
    const drawn = draw(selector);
    at = drawn ? selector : undefined;
    return drawn;
  }

  function draw(selector: string): boolean {
    let target: ElementLike | null = null;
    try {
      // A selector from a manifest is an app author's string and may be
      // anything at all, including syntactically invalid, which throws.
      target = doc.querySelector?.(selector) ?? null;
    } catch {
      target = null;
    }
    const rect = target?.getBoundingClientRect?.();
    // A zero-sized box is a hidden element, a `display: none` row, or a fake
    // without layout. Outlining it would draw a dot in the top-left corner of
    // the screen, which looks like a bug in the panel rather than like nothing.
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      hide();
      return false;
    }
    const { box } = ensure();
    if (!box.style) return false;
    box.style.setProperty("--dk-spot-x", `${Math.round(rect.left)}px`);
    box.style.setProperty("--dk-spot-y", `${Math.round(rect.top)}px`);
    box.style.setProperty("--dk-spot-w", `${Math.round(rect.width)}px`);
    box.style.setProperty("--dk-spot-h", `${Math.round(rect.height)}px`);
    box.className = "dk-spot dk-spot-on";
    return true;
  }

  function hide(): void {
    at = undefined;
    if (overlay) overlay.box.className = "dk-spot";
  }

  function dispose(): void {
    hide();
    if (!overlay) return;
    win?.removeEventListener?.("scroll", reflow);
    win?.removeEventListener?.("resize", reflow);
    overlay.host.remove();
    overlay = null;
  }
}
