/**
 * driverkit/adapters — a `rev` for an app that has no store.
 *
 * `Snapshot.rev` is how staleness works: the agent echoes back the `rev` it was
 * looking at, and the core refuses the call rather than apply it to a row the
 * agent never saw. The core's documentation assumes the app has a monotonic
 * counter to expose. An app with a store usually does. An app built from
 * templates, jQuery, a grid widget and eleven years of patches does not, and
 * telling that app's author to add one is telling them to refactor before they
 * can adopt this at all.
 *
 * So: watch the DOM, and count renders.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE LIMITATION, stated plainly because it is real and permanent.
 *
 * This bumps on any DOM change under the target, including changes an agent
 * cannot see and does not care about: a tooltip opening, a relative timestamp
 * ticking from "2m" to "3m", a spinner, a row highlighting under the mouse.
 * Each of those moves `rev`, and an agent that read the screen a moment earlier
 * now gets `stale` on a call that would have been perfectly fine. It will read
 * again and retry, and the retry costs a round trip.
 *
 * That is the right direction to err, and the asymmetry is not close.
 *
 *   A false `stale` costs one wasted round trip. The agent re-reads, sees the
 *   same rows, calls again, succeeds. The user sees nothing.
 *
 *   A MISSED change costs correctness. The agent holds `rev` 7, the table
 *   silently re-sorted, `rev` is still 7 so the call is accepted -- and
 *   `accept(INV-1)` lands on whatever is in the row the agent was looking at,
 *   which is now a different invoice. Nothing refuses, nothing logs, and the
 *   wrong record is committed. That is precisely the failure `rev` was
 *   introduced to prevent, so a `rev` that can miss a change is not a cheap
 *   `rev` -- it is a `rev` that has stopped doing its job while continuing to
 *   look like it is doing it.
 *
 * Which is also why the ignore list is short and configurable rather than
 * clever. Every attribute added to it is a class of change this will now miss,
 * so the defaults cover only attributes that cannot carry data an agent reads
 * (`style`, `class`, and the focus/hover plumbing), and widening it is a
 * decision the app author makes with that trade in view.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { defaultDocument } from "./dom.ts";
import type {
  MutationObserverCtor,
  MutationObserverLike,
  MutationRecordLike,
  QueryRootLike,
  TimersLike,
} from "./dom.ts";

export interface RevOptions {
  /** Coalesce changes into one bump. Default 50ms.
   *
   *  A React commit, a jQuery `.html()` call or a grid re-render arrives as
   *  dozens of records, often in several microtask batches, and bumping per
   *  record would make `rev` move five times for one render -- which does not
   *  make staleness stricter, it just makes a well-behaved agent retry five
   *  times. */
  debounceMs?: number;
  /** Attributes whose churn cannot change what an agent reads.
   *
   *  Replaces the default list rather than adding to it, so the set is always
   *  visible at the call site. `class` is in the default and is the one to
   *  think about: an app that encodes state in a class (`row--selected`) and
   *  reads it back in `visible()` must NOT ignore `class`, or selection changes
   *  will be invisible to staleness. */
  ignoreAttributes?: string[];
  /** Watch attribute mutations at all. Default true. Turning this off is a
   *  bigger version of the same trade as `ignoreAttributes`. */
  attributes?: boolean;
  /** Watch text changes. Default true: a cell rewritten in place is a change to
   *  exactly what `rowsFromTable` reads. */
  characterData?: boolean;
  /** Watch the whole subtree. Default true, and there is no real reason to
   *  change it -- rows are never direct children of the element you name. */
  subtree?: boolean;
  /** Where `rev` starts. Default 1. Must be a positive integer: `0` is
   *  falsy and ends up `if (rev)`-tested out of existence somewhere. */
  start?: number;
  /** Fired when `rev` moves, with the new value. This is what you wire to
   *  `connection.changed()` so an agent mid-task learns the human moved. */
  onBump?: (rev: number) => void;

  /** Injected browser pieces, defaulting to the globals. See `dom.ts`. */
  MutationObserver?: MutationObserverCtor;
  timers?: TimersLike;
  document?: QueryRootLike;
}

export interface RevHandle {
  /** The current revision. Monotonic, positive, and never decreasing. */
  rev: () => number;
  /** Count a change the DOM cannot show -- a store write, a fetch landing.
   *  Lets an app mix this with a real counter instead of choosing. */
  bump: () => void;
  /** Stop observing. Idempotent. `rev()` keeps answering its last value, which
   *  is the truthful thing: nothing is watching, so nothing can claim it
   *  changed. */
  stop: () => void;
}

const IGNORED_BY_DEFAULT = [
  "style",
  "class",
  "tabindex",
  "aria-busy",
  "aria-activedescendant",
  "data-focus-visible-added",
];

/**
 * Count changes under `target`.
 *
 * ```ts
 * const rev = revFromMutations("#invoices", { onBump: () => connection.changed() });
 * mount({ app: "Invoices", verbs, visible: () => ({ where: "invoices", rev: rev.rev(), rows }) });
 * ```
 */
export function revFromMutations(
  target: string | object,
  opts: RevOptions = {},
): RevHandle {
  const ignore = new Set((opts.ignoreAttributes ?? IGNORED_BY_DEFAULT).map((a) => a.toLowerCase()));
  const debounceMs = opts.debounceMs ?? 50;
  const timers: TimersLike = opts.timers ?? {
    setTimeout: (fn, ms) => (globalThis as unknown as TimersLike).setTimeout(fn, ms),
    clearTimeout: (h) => (globalThis as unknown as TimersLike).clearTimeout(h),
  };
  const Observer =
    opts.MutationObserver ??
    (globalThis as { MutationObserver?: MutationObserverCtor }).MutationObserver;

  const start = opts.start ?? 1;
  if (!Number.isInteger(start) || start < 1) {
    throw new Error(`driverkit: revFromMutations wants a positive integer start, got ${start}`);
  }
  if (!Observer) {
    throw new Error("driverkit: no MutationObserver. Pass options.MutationObserver.");
  }

  const node = resolveTarget(target, opts.document);

  let rev = start;
  let pending = false;
  let timer: unknown = null;
  let live = true;

  function flush(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    pending = false;
    rev += 1;
    opts.onBump?.(rev);
  }

  const observer: MutationObserverLike = new Observer((records) => {
    if (!live || !interesting(records, ignore)) return;
    pending = true;
    // Scheduled from the FIRST interesting change in a window and not reset by
    // later ones. A trailing debounce would be the usual choice and is wrong
    // here: a subtree that never settles -- a live clock, a progress bar, a
    // chart that animates -- would reset the timer forever and `rev` would
    // never move, which is the missed-change failure in the file comment,
    // arrived at by being careful. One bump per window, at most, always.
    if (timer === null) timer = timers.setTimeout(flush, debounceMs);
  });

  observer.observe(node, {
    childList: true,
    subtree: opts.subtree ?? true,
    attributes: opts.attributes ?? true,
    characterData: opts.characterData ?? true,
  });

  return {
    rev: () => {
      // Reads flush. The timer exists to coalesce a burst for `onBump`, not to
      // delay the truth: a caller asking for `rev` is about to put it in a
      // snapshot, and answering 7 when a change is already queued hands an
      // agent a number that will be wrong by the time it calls back -- and the
      // call will then be ACCEPTED, because 7 is what both sides believe.
      // Flushing here keeps the coalescing (one burst is still one bump) and
      // removes the window where `rev` is knowingly behind.
      flush();
      return rev;
    },
    bump: () => {
      pending = true;
      flush();
    },
    stop: () => {
      if (!live) return;
      live = false;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      observer.disconnect();
    },
  };
}

/** Does any record in this batch describe something an agent could read?
 *
 * Only attribute records are ever dismissed. A `childList` record means nodes
 * came or went, and `characterData` means text was rewritten -- both are
 * exactly what `rowsFromTable` reads, and no inspection of the record can rule
 * out that it mattered. */
function interesting(records: MutationRecordLike[], ignore: Set<string>): boolean {
  for (const record of records) {
    if (record.type !== "attributes") return true;
    const name = record.attributeName?.toLowerCase();
    // An attribute record with no name is unnameable and therefore unjudgeable,
    // so it counts. Erring toward a bump; see the file comment.
    if (!name || !ignore.has(name)) return true;
  }
  return false;
}

function resolveTarget(target: string | object, doc: QueryRootLike | undefined): object {
  if (typeof target !== "string") return target;
  const document = doc ?? defaultDocument();
  if (!document) {
    throw new Error("driverkit: revFromMutations has no document. Pass options.document.");
  }
  const found = document.querySelector(target);
  if (!found) {
    // Observing nothing would leave `rev` frozen at its start value forever,
    // and a frozen `rev` never refuses a stale call. Silent, permanent, and
    // indistinguishable from a very calm app.
    throw new Error(
      `driverkit: revFromMutations found no element matching \`${target}\`. ` +
        `Observing nothing would freeze rev, and a frozen rev accepts every stale call.`,
    );
  }
  return found;
}
