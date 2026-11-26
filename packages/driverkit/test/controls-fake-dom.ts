/**
 * A fake DOM, because there is no browser here and no dependency budget to buy
 * one with.
 *
 * It implements exactly the shapes `src/controls/dom.ts` declares --
 * `querySelector`, `querySelectorAll`, `textContent`, `getAttribute`, `click`,
 * `dataset`, `parentElement` -- and an `Event`. Nothing else. It is not a
 * browser and must never grow toward being one: the moment it starts guessing
 * at layout or event propagation, a passing test stops being evidence about
 * real pages.
 *
 * The selector support is a deliberate subset: tag, `.class`, `#id`,
 * `[attr]`, `[attr="value"]`, comma lists, and the descendant combinator. That
 * is all the adapters generate or accept in the tests, and a fuller engine
 * would be a second implementation of something the browser already ships.
 */

import type { ElementLike, QueryRootLike } from "../src/controls/dom.ts";

export class FakeElement implements ElementLike {
  readonly tag: string;
  readonly attrs: Map<string, string>;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  /** Text owned by this element directly, between its child tags. */
  own = "";
  /** Every `click()` this element received, in order. */
  clicks = 0;
  /** Fired on `click()`, so a test can assert the app's handler ran. */
  onclick: (() => void) | null = null;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag.toLowerCase();
    this.attrs = new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
    // A `value` attribute seeds the property, as it does in a real DOM. The
    // two then diverge, which is also real: typing changes the property and
    // leaves the attribute alone, so a test that asserted on the attribute
    // would pass on markup and fail on a keystroke.
    this.value = this.attrs.get("value") ?? "";
  }

  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }

  set textContent(text: string) {
    this.children.length = 0;
    this.own = text;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase());
  }

  /** `ElementLike.parentElement`, spelled as a real DOM spells it. The field
   *  above is the fake's own plumbing and is written by `append`; this is the
   *  name `controls.ts` reads, and having both is the point — the adapters see
   *  only what a real `Element` offers. */
  get parentElement(): FakeElement | null {
    return this.parent;
  }

  get dataset(): Record<string, string | undefined> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) {
      if (!k.startsWith("data-")) continue;
      out[k.slice(5).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
    }
    return out;
  }

  append(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (!siblings) return;
    const at = siblings.indexOf(this);
    if (at >= 0) siblings.splice(at, 1);
    this.parent = null;
  }

  /** What is in the field. Present on every element, as in a real DOM, where
   *  `value` is an `HTMLInputElement` property and `undefined` on a `div` —
   *  which is why `controls.ts` decides what is typable from the tag and the
   *  `type` attribute and never from whether this happens to be writable. */
  value: string;
  /** Every event this element was given, in order, as `type` strings. The
   *  assertion that matters for typing: assigning `value` and firing nothing
   *  looks typed on screen and tells the app nothing. */
  events: string[] = [];
  focused = 0;
  /** Fired on each dispatched event, so a test can stand in for the app's own
   *  `oninput` handler and assert it saw the text. */
  oninput: ((value: string) => void) | null = null;

  /** Tag name as a real DOM spells it: upper case. `controls.ts` lower-cases
   *  it, and the mismatch is worth having in the fake rather than papered
   *  over, because a fake that returns lower case would hide the bug where
   *  somebody compares `tagName` to `"input"` and it works here only. */
  get tagName(): string {
    return this.tag.toUpperCase();
  }

  click(): void {
    this.clicks += 1;
    this.onclick?.();
  }

  focus(): void {
    this.focused += 1;
  }

  dispatchEvent(event: unknown): boolean {
    const type = (event as { type?: string }).type ?? "";
    this.events.push(type);
    if (type === "input") this.oninput?.(this.value);
    return true;
  }

  querySelector(selectors: string): FakeElement | null {
    return this.queryAll(selectors)[0] ?? null;
  }

  querySelectorAll(selectors: string): FakeElement[] {
    return this.queryAll(selectors);
  }

  /** Document order, deduplicated across a comma list. */
  private queryAll(selectors: string): FakeElement[] {
    const groups = selectors.split(",").map(parseCompoundChain).filter((g) => g.length > 0);
    const out: FakeElement[] = [];
    walk(this, (el) => {
      if (el === this) return;
      if (groups.some((chain) => matchesChain(el, chain, this))) out.push(el);
    });
    return out;
  }
}

/** A `Document`, for the adapters' `document` option. */
export class FakeDocument implements QueryRootLike {
  readonly root: FakeElement;
  constructor(root: FakeElement) {
    this.root = root;
  }
  querySelector(selectors: string): ElementLike | null {
    return matchesChain(this.root, parseCompoundChain(selectors.split(",")[0]!), null)
      ? this.root
      : this.root.querySelector(selectors);
  }
  querySelectorAll(selectors: string): FakeElement[] {
    const inner = this.root.querySelectorAll(selectors);
    const groups = selectors.split(",").map(parseCompoundChain);
    return groups.some((chain) => matchesChain(this.root, chain, null)) ? [this.root, ...inner] : inner;
  }
}

// ── selectors ───────────────────────────────────────────────────────────────

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

function parseCompoundChain(selector: string): Compound[] {
  return selector
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(parseCompound);
}

function parseCompound(part: string): Compound {
  const out: Compound = { classes: [], attrs: [] };
  const pattern = /^([a-z][a-z0-9-]*)|^\.([a-z0-9_-]+)|^#([a-z0-9_-]+)|^\[([a-z0-9-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/i;
  let rest = part;
  while (rest.length) {
    const m = pattern.exec(rest);
    if (!m) throw new Error(`fake-dom: unsupported selector fragment \`${rest}\``);
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.id = m[3];
    else if (m[4]) {
      const value = m[5] ?? m[6] ?? m[7];
      out.attrs.push(value === undefined ? { name: m[4].toLowerCase() } : { name: m[4].toLowerCase(), value });
    }
    rest = rest.slice(m[0].length);
  }
  return out;
}

function matchesCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id !== undefined && el.getAttribute("id") !== c.id) return false;
  const classes = (el.getAttribute("class") ?? "").split(/\s+/);
  if (!c.classes.every((cls) => classes.includes(cls))) return false;
  return c.attrs.every(({ name, value }) => {
    const actual = el.getAttribute(name);
    return actual !== null && (value === undefined || actual === value);
  });
}

/** Right-to-left, the way a browser does it. `stopAt` bounds the ancestor walk
 *  to the subtree the query was run on. */
function matchesChain(el: FakeElement, chain: Compound[], stopAt: FakeElement | null): boolean {
  if (chain.length === 0) return false;
  if (!matchesCompound(el, chain[chain.length - 1]!)) return false;
  let i = chain.length - 2;
  let node = el.parent;
  while (i >= 0) {
    if (!node || node === stopAt?.parent) return false;
    if (matchesCompound(node, chain[i]!)) i -= 1;
    if (node === stopAt) return i < 0;
    node = node.parent;
  }
  return true;
}

function walk(el: FakeElement, visit: (el: FakeElement) => void): void {
  visit(el);
  for (const child of [...el.children]) walk(child, visit);
}

// ── html ────────────────────────────────────────────────────────────────────

/**
 * Parse a scrap of HTML into fake elements.
 *
 * A builder API would have been less code; this exists because the tests read
 * better with the markup in them. A table with a merged header is a thing you
 * recognise on sight in HTML and have to decode in builder calls, and these
 * tests are meant to be read by whoever is about to change the slugging rule.
 */
export function html(source: string): FakeElement {
  const root = new FakeElement("fragment");
  let node = root;
  const tokens = source.matchAll(/<\/?([a-z][a-z0-9-]*)((?:\s+[^<>]*?)?)\/?>|([^<]+)/gi);
  for (const token of tokens) {
    const [raw, tag, rawAttrs, text] = token;
    if (text !== undefined) {
      node.own += text;
      continue;
    }
    if (raw.startsWith("</")) {
      node = node.parent ?? root;
      continue;
    }
    const el = node.append(new FakeElement(tag!, parseAttrs(rawAttrs ?? "")));
    if (!raw.endsWith("/>") && !VOID.has(el.tag)) node = el;
  }
  // A fragment with exactly one element is that element: `html("<table>…")`
  // should hand back the table, not a wrapper nobody asked about.
  return root.children.length === 1 && root.own.trim() === "" ? root.children[0]! : root;
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);

function parseAttrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([a-z0-9-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/gi)) {
    out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/** `Event`, to the extent anything here reads one. A real `Event` carries
 *  bubbling, a target, a phase and cancellation; none of that can change the
 *  answer to "did the adapter tell the app the text changed", which is the only
 *  question these tests ask of it. */
export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  constructor(type: string, init?: { bubbles?: boolean }) {
    this.type = type;
    this.bubbles = init?.bubbles ?? false;
  }
}
