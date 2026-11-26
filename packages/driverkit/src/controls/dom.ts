/**
 * driverkit/controls — the browser, as structural types.
 *
 * The controls layer takes its browser globals as options and defaults them to
 * the real ones. That is a design requirement, not a testing convenience, and
 * it is the same argument the page side makes in `driverkit/browser`: code
 * that can only run inside a browser can only be verified inside a browser,
 * which in practice means verified by hand, by someone clicking through the
 * happy path. The parts of this layer that actually bite -- a control that was
 * on screen when the snapshot was taken and gone by the time of the call, a
 * disabled button that accepts a click and does nothing, a confirm button an
 * agent must not reach -- are the parts nobody clicks through.
 *
 * These interfaces describe ONLY what this layer touches. A real `Element`
 * satisfies them; so does the hundred-line fake in `test/fake-dom.ts`. Keeping
 * them this narrow is what makes that second thing possible.
 */

/** Anything you can run a selector against: a `Document`, an `Element`, or a
 *  `DocumentFragment`. Named for what it is used for rather than what it is,
 *  because the controls layer does not care which one it was handed. */
export interface QueryRootLike {
  querySelector(selectors: string): ElementLike | null;
  querySelectorAll(selectors: string): ArrayLike<ElementLike> & Iterable<ElementLike>;
}

/**
 * One node.
 *
 * `dataset` is declared and deliberately unused. The controls layer reads
 * `data-dk-*` through `getAttribute` instead, for two reasons: it is one
 * code path rather than two, and `data-dk-col` is the spelling the app author
 * types into their markup. `dataset.dkCol` is a second spelling of the same
 * thing and therefore a second thing to get wrong in a bug report. It stays in
 * the type because a caller writing an `idFrom`/`cellValue` hook gets the
 * element and may reasonably want it.
 */
export interface ElementLike extends QueryRootLike {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  click(): void;
  readonly dataset?: Record<string, string | undefined>;
  /**
   * This element's parent, for the one question that genuinely needs one:
   * is this control inside something marked `data-dk-human-only`?
   *
   * OPTIONAL, AND THAT IS THE WHOLE DESIGN. A real `Element` has it, so a real
   * page gets the ancestor check for free. A fake that does not implement it
   * reads as "no parent", which is exactly the behaviour this package had
   * before the field existed: the element's own attribute and nothing above
   * it. So no existing fake, and no hand-rolled `ElementLike`, is broken by
   * this being here — it only gains.
   *
   * It is deliberately the ONLY upward link in these types, and
   * `controls.ts`'s row test still does not use it. "Is this element inside
   * one of the rows the snapshot is showing" is a containment question with a
   * known set to test against, and answering it by walking up and matching
   * `tr` is a different question that a nested table answers wrongly. An
   * opt-out is the other shape: there is no set to test against, because what
   * carried the mark is whatever the author wrapped around their dialog.
   */
  readonly parentElement?: ElementLike | null;
}

/**
 * An element you can put text into.
 *
 * Every member is optional, and that is the honest shape rather than a
 * convenience: the controls layer finds its elements by an attribute the author
 * marked, so it cannot know it was handed an `<input>` until it looks. A real
 * `HTMLInputElement` satisfies this; so does a `<div contenteditable>`, badly,
 * which is why `controls.ts` checks what it got and refuses rather than
 * assuming.
 *
 * `dispatchEvent` is here because setting `value` is not typing. A framework
 * learns about a keystroke from an event, so an adapter that assigns `value`
 * and stops has changed what the screen looks like and told the app nothing —
 * the user's own re-render then wipes it, and the verb reported success.
 */
export interface FieldLike extends ElementLike {
  value?: string;
  readonly tagName?: string;
  focus?(): void;
  blur?(): void;
  dispatchEvent?(event: unknown): boolean;
}

/** `Event`, injectable like every other global here. Only the two-argument
 *  constructor is used: `new Event("input", { bubbles: true })`. */
export interface EventCtor {
  new (type: string, init?: { bubbles?: boolean }): unknown;
}

/** The default `Event`, or null when there is not one. */
export function defaultEvent(): EventCtor | null {
  return (globalThis as { Event?: EventCtor }).Event ?? null;
}

/** Collapse every run of whitespace to one space and trim.
 *
 * Exported because it is the normalisation the whole layer applies to text,
 * and a caller writing an `idFrom` hook should be able to apply the same one
 * rather than a near-miss of it. Rendered HTML is full of newlines and indent
 * that are invisible to the person at the keyboard, and a row whose id is
 * `"\n      INV-1\n    "` matches nothing an agent types back.
 */
export function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** The default document, or null when there is not one. Null rather than a
 *  throw: each caller throws its own message naming its own option, which is
 *  more use than a shared "no document" from three call sites. */
export function defaultDocument(): QueryRootLike | null {
  return (globalThis as { document?: QueryRootLike }).document ?? null;
}

/** Resolve a root that may be a selector, an element, or absent. */
export function resolveRoot(
  root: string | QueryRootLike | undefined,
  doc: QueryRootLike | undefined,
  who: string,
): QueryRootLike {
  const document = doc ?? defaultDocument();
  if (root === undefined) {
    if (!document) throw new Error(`driverkit: ${who} has no document. Pass options.document.`);
    return document;
  }
  if (typeof root !== "string") return root;
  if (!document) throw new Error(`driverkit: ${who} has no document. Pass options.document.`);
  const found = document.querySelector(root);
  if (!found) throw new Error(`driverkit: ${who} found no element matching \`${root}\`.`);
  return found;
}
