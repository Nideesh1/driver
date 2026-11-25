/**
 * A fake DOM, with only the node shapes the widget touches.
 *
 * Not jsdom, and not because of the dependency rule alone: a full DOM would
 * let the widget quietly start depending on parts of the platform that are not
 * in `dom.ts`, and `dom.ts` is the list of what this package is allowed to
 * assume. If a change to the widget needs a new method here, that is the
 * signal to add it to `dom.ts` deliberately rather than to discover later that
 * the widget needs `querySelectorAll`.
 *
 * Two things are modelled properly rather than stubbed, and in both cases
 * because a stub would let a broken widget pass.
 *
 * Event bubbling, because Escape closing the panel depends on it: the handler
 * is on the wrapper and the keypress happens in the input. A fake that
 * dispatched only to the target would make that test pass against a widget
 * that was broken in a browser.
 *
 * And layout — a viewport with a size, and a `getBoundingClientRect` that runs
 * the same arithmetic as the `left`/`top`/`translate` declarations in
 * `css.ts`. Positioning is the one feature here whose whole correctness
 * condition is geometric: "the panel is still on the screen" is a claim about
 * pixels, and a fake that only recorded which custom property the widget wrote
 * could not check it. See `FakeWindow`.
 */

import type {
  DocumentLike,
  ElementLike,
  EventLike,
  Listener,
  NodeLike,
  RectLike,
  StorageLike,
  StyleLike,
  WindowLike,
} from "../src/index.ts";

/** The inset `--dk-gap` defaults to, and the one the layout below mirrors. */
export const GAP = 16;

/** `element.style`, as a map. */
/** Shadow a prototype method with `undefined`, which is how an API a browser
 *  does not have actually looks to a feature check. Through `unknown` because
 *  that is precisely the lie being told. */
export function hide(node: FakeNode, ...names: string[]): void {
  for (const name of names) (node as unknown as Record<string, undefined>)[name] = undefined;
}

export class FakeStyle implements StyleLike {
  props = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }

  /** The number behind a custom property, or `fallback` when nothing has set
   *  it — which is how the stylesheet's own `:host` default looks from here. */
  number(name: string, fallback: number): number {
    const raw = this.props.get(name);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
}

/**
 * The viewport, with a size that can change.
 *
 * It models layout, which is unusual for a fake and is the point: the widget
 * clamps a position it cannot see, so a fake that let the test assert only
 * "the widget wrote 1 into --dk-x" would pass against a widget whose
 * arithmetic put the panel off the left edge of a narrow window. The formula
 * in `FakeNode.getBoundingClientRect` is the same arithmetic as the `left`,
 * `top` and `translate` declarations in `css.ts`, written once more in
 * TypeScript so a test can ask the only question that matters — is the panel
 * on the screen — instead of asking about a custom property.
 */
export class FakeWindow implements WindowLike {
  innerWidth: number;
  innerHeight: number;
  /** What `matchMedia("(prefers-reduced-motion: reduce)")` answers. */
  reducedMotion = false;
  #listeners = new Map<string, Listener[]>();

  constructor(innerWidth = 1200, innerHeight = 800) {
    this.innerWidth = innerWidth;
    this.innerHeight = innerHeight;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type);
    if (list) list.push(listener);
    else this.#listeners.set(type, [listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((l) => l !== listener));
  }

  matchMedia(query: string): { matches: boolean } {
    return { matches: query.includes("prefers-reduced-motion") && this.reducedMotion };
  }

  /** Resize the window, as a person dragging the corner of it does. */
  resize(innerWidth: number, innerHeight: number): void {
    this.innerWidth = innerWidth;
    this.innerHeight = innerHeight;
    for (const listener of this.#listeners.get("resize") ?? []) listener({});
  }

  /** How many listeners are still attached. Unmount has to leave none: a
   *  resize handler that outlives its panel clamps a dead element forever. */
  listeners(type: string): number {
    return (this.#listeners.get(type) ?? []).length;
  }
}

/** `localStorage`, including the two ways it fails in a real browser. Both are
 *  ordinary — a private window, a person who blocked site data — and neither
 *  is a reason for a chat panel not to render. */
export class FakeStorage implements StorageLike {
  items = new Map<string, string>();
  throwOnRead = false;
  throwOnWrite = false;
  writes = 0;

  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error("SecurityError: access to storage is denied");
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes++;
    if (this.throwOnWrite) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
}

export class FakeNode implements ElementLike {
  tag: string;
  className = "";
  style = new FakeStyle();
  /** What this element measures. Only the host element's box matters, and it
   *  is settable because the panel and the collapsed launcher are very
   *  different sizes and the clamp depends on which one is showing. */
  size = { width: 0, height: 0 };
  /** The viewport this node is laid out in. */
  win: FakeWindow | null = null;
  /** Pointer ids captured and not yet released. A drag that leaks one has a
   *  handle that keeps eating the page's pointer events. */
  captured: number[] = [];
  textContent: string | null = "";
  value?: string;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attrs = new Map<string, string>();
  focused = false;
  shadow: FakeNode | null = null;
  removed = false;
  #listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tag = tag;
    if (tag === "input") this.value = "";
  }

  appendChild(child: ElementLike): ElementLike {
    const node = child as FakeNode;
    node.parent = this;
    this.children.push(node);
    return child;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type);
    if (list) list.push(listener);
    else this.#listeners.set(type, [listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((l) => l !== listener));
  }

  get tagName(): string {
    return this.tag.toUpperCase();
  }

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captured = this.captured.filter((id) => id !== pointerId);
  }

  /** The same arithmetic as `css.ts`, deliberately WITHOUT a clamp of its own:
   *  a viewport narrower than the panel really does put a fraction of 1 off
   *  the left edge, and a fake that quietly corrected that would hide the one
   *  case the widget has to handle in JavaScript. */
  getBoundingClientRect(): RectLike {
    const vw = this.win?.innerWidth ?? 0;
    const vh = this.win?.innerHeight ?? 0;
    const fx = this.style.number("--dk-x", 1);
    const fy = this.style.number("--dk-y", 1);
    return {
      left: GAP + fx * (vw - GAP * 2 - this.size.width),
      top: GAP + fy * (vh - GAP * 2 - this.size.height),
      width: this.size.width,
      height: this.size.height,
    };
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  focus(): void {
    this.focused = true;
  }

  remove(): void {
    this.removed = true;
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }

  attachShadow(): NodeLike {
    this.shadow = new FakeNode("#shadow");
    this.shadow.parent = this;
    return this.shadow;
  }

  // -- test helpers -------------------------------------------------------

  /** Fire an event on this node and let it bubble, the way a browser does. */
  dispatch(type: string, event: EventLike = {}): { defaultPrevented: boolean } {
    let defaultPrevented = false;
    // `target` defaults to the node the event was fired on, the way a real
    // event does, because telling "pointerdown on the header" from
    // "pointerdown on the Close button inside the header" is exactly what the
    // widget uses it for.
    const e: EventLike = {
      target: this,
      ...event,
      preventDefault: () => void (defaultPrevented = true),
    };
    for (let node: FakeNode | null = this; node; node = node.parent) {
      for (const listener of node.#listeners.get(type) ?? []) listener(e);
    }
    return { defaultPrevented };
  }

  /** Every node in this subtree, including the shadow tree. */
  all(): FakeNode[] {
    const out: FakeNode[] = [this];
    for (const child of [...(this.shadow ? [this.shadow] : []), ...this.children]) {
      out.push(...child.all());
    }
    return out;
  }

  /** Every node whose class list contains `name`. */
  find(name: string): FakeNode[] {
    return this.all().filter((n) => n.className.split(" ").includes(name));
  }

  one(name: string): FakeNode {
    const hits = this.find(name);
    if (hits.length !== 1) throw new Error(`expected one .${name}, found ${hits.length}`);
    return hits[0]!;
  }

  /** The text of this subtree, one node per line. The transcript, basically. */
  text(): string {
    return this.all()
      .map((n) => n.textContent ?? "")
      .filter((t) => t !== "")
      .join("\n");
  }
}

export class FakeDocument implements DocumentLike {
  body = new FakeNode("body");
  created: FakeNode[] = [];
  win: FakeWindow;
  /** The box every element it creates reports. Only the host's is read. */
  box: { width: number; height: number };
  /** False models a browser with no shadow DOM, which the widget has a
   *  deliberate fallback for. Shadowing the prototype method with `undefined`
   *  is how a missing API actually looks to the feature check in `widget.ts`. */
  shadow: boolean;

  constructor(shadow = true, win = new FakeWindow(), box = { width: 380, height: 520 }) {
    this.shadow = shadow;
    this.win = win;
    this.box = box;
  }

  createElement(tag: string): ElementLike {
    const node = new FakeNode(tag);
    node.win = this.win;
    node.size = { ...this.box };
    if (!this.shadow) hide(node, "attachShadow");
    this.created.push(node);
    return node;
  }

  /** The widget's host element, once mounted. */
  host(): FakeNode {
    const host = this.body.children[0];
    if (!host) throw new Error("nothing was mounted");
    return host;
  }
}
