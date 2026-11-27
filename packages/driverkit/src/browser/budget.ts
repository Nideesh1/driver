/**
 * driverkit/browser — keeping a spend ceiling across a page load.
 *
 * `MountOptions.budget` bounded one mounted driver, and that was one word short
 * of bounding anything. Navigation is one of the agent's own verbs: `goto` is a
 * `read`, an agent calls it freely, and a `goto` that is a full page load tears
 * the driver down and mounts a fresh one with the counters back at zero. So the
 * agent could refresh its way to a new allowance, and `budget-spent`'s hint —
 * "it does not refill, and waiting or retrying will not change it" — was a
 * sentence the library could not keep.
 *
 * This is the twenty lines that make it true. Nothing clever lives here: the
 * core owns what the numbers mean, when an allowance has expired, and what a
 * broken store does to the next call. See `BudgetStore` and `Budget.store` in
 * the core, which carry that argument. What is here is bytes, a scope, and one
 * decision about which way to fail.
 *
 * **WHY `localStorage` AND NOT `sessionStorage`, when the widget's transcript
 * goes the other way.** The two are scoped differently on purpose and the
 * reason is the same reason in both directions. A transcript belongs to a tab:
 * two tabs of one app are two conversations, and `sessionStorage` is per tab by
 * definition, which also means a conversation does not outlive the tab it was
 * had in. A ceiling belongs to the app: if it were per tab, "open a second tab"
 * would be a budget-doubling move, which is the reload bypass again in a
 * different hat. One allowance per app per origin, shared by every tab, spent by
 * whichever one gets there first. Yes — one tab can exhaust another's. That is
 * one ceiling behaving like one ceiling, exactly as a server-side counter would,
 * and the alternative fails in the direction that costs money.
 *
 * **IT IS A COST CONTROL AND NOT A SECURITY BOUNDARY.** The person sitting
 * there can edit this key in devtools, and clearing site data drops it. That is
 * fine — they own the machine and they are the one paying — and the type says so
 * plainly rather than implying a guarantee the browser cannot give. A ceiling
 * that must hold against the person belongs on the server, behind the API the
 * verbs call.
 */

import type { BudgetRecord, BudgetStore } from "../core/index.ts";
import type { StorageLike } from "../widget/dom.ts";
import { defaultStorage } from "../widget/position.ts";

export interface LocalBudgetStoreOptions {
  /** The app, as `MountOptions.app`. The key is namespaced by it so two
   *  driverkit apps on one origin do not share an allowance — which would make
   *  one app's runaway into the other app's outage. */
  app: string;
  /** Defaults to `localStorage`, or to nothing at all where reaching for it
   *  throws. Injectable so this is an ordinary unit test and not a browser one;
   *  see `StorageLike`. */
  storage?: StorageLike;
}

/** What a stored allowance is filed under. Exported so a host-side support
 *  tool, or a test, can clear it without guessing at the string. */
export function budgetKey(app: string): string {
  return `driverkit:budget:${app}`;
}

/** A `BudgetStore` with a `forget()`, which is the host-side reset in
 *  `Budget.epoch`'s list of ways an allowance can start again — and the only
 *  one that needs no deploy. Deliberately a method on an object the HOST holds:
 *  an agent drives through verbs and has no verb for this. */
export interface LocalBudgetStore extends BudgetStore {
  /** Drop the stored allowance. The next `mount()` starts a fresh one. */
  forget(): void;
}

/**
 * A `Budget.store` over `localStorage`, scoped per app per origin.
 *
 * ```ts
 * mount({
 *   app: "contacts",
 *   verbs,
 *   visible,
 *   budget: {
 *     calls: 200,
 *     // Two hundred calls a day, and a reload does not refill them.
 *     window: 24 * 60 * 60 * 1000,
 *     store: localBudgetStore({ app: "contacts" }),
 *   },
 * });
 * ```
 *
 * **WHICH WAY THIS FAILS, AND WHY IT IS THE OPPOSITE OF EVERYTHING ELSE IN THE
 * PACKAGE.** `position.ts` and `settings.ts` swallow every storage failure and
 * fall back to a default, because the worst case there is a forgotten pane
 * position and the alternative — a chat panel that does not render in a private
 * window — is a far worse bug. Here the worst case is an uncapped agent, so
 * every failure is reported rather than smoothed over: `load()` answers
 * `{ ok: false }` and `save()` throws, and the core turns either into a
 * `budget-spent` refusal that names the cause. The app stays usable by the
 * person; it is the agent that stops.
 *
 * A corrupt or garbled record is `{ ok: false }` too, and that is the one worth
 * saying out loud. It cannot be told apart from somebody having edited the key,
 * and of the two ways to guess, exactly one has a bill attached.
 */
export function localBudgetStore(options: LocalBudgetStoreOptions): LocalBudgetStore {
  const key = budgetKey(options.app);
  // Resolved once, at construction, like the widget's: `defaultStorage()`
  // itself throws where site data is blocked, which is why it is a function
  // with a try inside rather than a property read.
  const storage = options.storage ?? defaultStorage();

  return {
    load(): { ok: true; spent: BudgetRecord | null } | { ok: false } {
      // No storage at all is NOT "nothing stored". It is "I cannot look", which
      // is the distinction the whole fail-closed design rests on; collapsing
      // the two here would undo it a layer below the core that depends on it.
      if (storage === undefined) return { ok: false };
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        return { ok: false };
      }
      // Empty slot and empty string alike: storage worked and holds nothing, so
      // this is a genuinely fresh allowance. The one `{ ok: true, spent: null }`
      // in the file, and the only shape that may ever mean "spend from zero".
      if (!raw) return { ok: true, spent: null };
      try {
        const parsed = JSON.parse(raw) as Partial<BudgetRecord> | null;
        if (!parsed || typeof parsed !== "object") return { ok: false };
        const { calls, commits, since, epoch } = parsed;
        if (!Number.isInteger(calls) || !Number.isInteger(commits)) return { ok: false };
        if (!Number.isFinite(since)) return { ok: false };
        if (epoch !== undefined && typeof epoch !== "string") return { ok: false };
        return {
          ok: true,
          spent: {
            calls: calls as number,
            commits: commits as number,
            since: since as number,
            ...(epoch === undefined ? {} : { epoch }),
          },
        };
      } catch {
        return { ok: false };
      }
    },

    save(record: BudgetRecord): void {
      // Not `saveJson`, and this is the one place in the package that does not
      // use it. `saveJson` swallows, by design and correctly, for everything
      // whose failure costs a remembered preference. A swallowed failure here
      // is an allowance that quietly stops being kept, so the throw is the
      // contract: see `BudgetStore.save`.
      if (storage === undefined) throw new Error("driverkit: no storage for the spend ceiling");
      storage.setItem(key, JSON.stringify(record));
    },

    forget(): void {
      // Written empty rather than removed, because `StorageLike` is two methods
      // and `removeItem` is not one of them — and `load` above reads an empty
      // string as an empty slot, which is the same thing a removal would leave.
      // Swallowed, unlike `save`: a reset that could not be written has changed
      // nothing and broken nothing, and throwing out of a support action would
      // be noise.
      try {
        storage?.setItem(key, "");
      } catch {
        // No storage, blocked site data, a full quota. Nothing was spent and
        // nothing was reset; the ceiling stands where it stood.
      }
    },
  };
}
