/**
 * driverkit/adapters — the browser, as structural types.
 *
 * Every adapter in this package takes its browser globals as options and
 * defaults them to the real ones. That is a design requirement, not a testing
 * convenience, and it is the same argument the page side makes in
 * `@driverkit/browser`: an adapter that can only run inside a browser can only
 * be verified inside a browser, which in practice means verified by hand, by
 * someone clicking through the happy path. The parts of this package that
 * actually bite -- a header row that slugs two columns to the same key, a
 * `rev` that must never go backwards, a handle that was present at mount and
 * is gone after a re-render -- are the parts nobody clicks through.
 *
 * These interfaces describe ONLY what this package touches. A real `Element`
 * satisfies them; so does the hundred-line fake in `test/fake-dom.ts`. Keeping
 * them this narrow is what makes that second thing possible.
 */

/** Anything you can run a selector against: a `Document`, an `Element`, or a
 *  `DocumentFragment`. Named for what it is used for rather than what it is,
 *  because the adapters do not care which one they were handed. */
export interface QueryRootLike {
  querySelector(selectors: string): ElementLike | null;
  querySelectorAll(selectors: string): ArrayLike<ElementLike> & Iterable<ElementLike>;
}

/**
 * One node.
 *
 * `dataset` is declared and deliberately unused by this package. The adapters
 * read `data-dk-*` through `getAttribute` instead, for two reasons: it is one
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
}

/** What `revFromMutations` reads off a `MutationRecord`. A real record carries
 *  far more; none of the rest can change the answer to "could this have
 *  changed what an agent reads". */
export interface MutationRecordLike {
  readonly type: string;
  readonly attributeName?: string | null;
}

export interface MutationObserverLike {
  observe(target: unknown, options?: MutationObserverInitLike): void;
  disconnect(): void;
  takeRecords?(): MutationRecordLike[];
}

export interface MutationObserverInitLike {
  childList?: boolean;
  subtree?: boolean;
  attributes?: boolean;
  characterData?: boolean;
  attributeFilter?: string[];
}

export interface MutationObserverCtor {
  new (callback: (records: MutationRecordLike[]) => void): MutationObserverLike;
}

/** The two timer functions, injectable together because a fake that provides
 *  one and not the other leaks a pending bump into the next test. */
export interface TimersLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Collapse every run of whitespace to one space and trim.
 *
 * Exported because it is the normalisation the whole package applies to text,
 * and a caller writing a `cellValue` hook should be able to apply the same one
 * rather than a near-miss of it. Rendered HTML is full of newlines and indent
 * that are invisible to the person at the keyboard, and a row whose id is
 * `"\n      INV-1\n    "` matches nothing an agent types back.
 */
export function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** The default document, or null when there is not one. Null rather than a
 *  throw: each adapter throws its own message naming its own option, which is
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
