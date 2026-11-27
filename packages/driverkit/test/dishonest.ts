/**
 * Apps that lie, on purpose.
 *
 * The only way to know a checker works is to point it at something broken, and
 * the only way to know it does not cry wolf is to point it at something that
 * is merely unusual and watch it stay quiet. So each app in here tells exactly
 * one lie and is otherwise a correct, ordinary driverkit app — which is also
 * what makes a failure readable: if `forgetsRev()` produces two findings,
 * one of them is the checker's bug.
 *
 * Every one of these is a mistake somebody actually makes. The shape is always
 * the same: the author writes `visible()` once, it looks right, and nothing
 * ever reads it back. `honest()` is the control.
 */

import { mount, selectionId } from "../src/core/registry.ts";
import type { Driver, Scalar, Snapshot, VerbContext } from "../src/core/types.ts";

const ROWS = [
  { id: "c-1", name: "Ada", status: "new" },
  { id: "c-2", name: "Grace", status: "new" },
  { id: "c-3", name: "Alan", status: "new" },
];

/** The control: a small app that tells the truth about everything. */
export function honest(): Driver {
  let rev = 1;
  let selected: string[] = [];
  let index = 0;
  const pages = [ROWS, [{ id: "c-4", name: "Edsger", status: "new" }]];
  return mount({
    app: "Honest",
    visible: (): Snapshot => ({
      where: "contacts",
      screen: "contacts",
      rev,
      rows: pages[index]!.map((r) => ({ ...r })),
      // A window, declared as one. `total` is given because this app knows it.
      page: { index, size: 3, total: 4 },
      ...(selected.length ? { selected: [...selected], selectedCount: selected.length } : {}),
      selectionId: selectionId(selected),
    }),
    verbs: [
      {
        name: "next-page",
        kind: "read",
        describe: "show the next page of contacts",
        refuses: ["no-more-pages"],
        run: (_a: Record<string, Scalar>, ctx: VerbContext) => {
          if (index + 1 >= pages.length) return ctx.refuse("no-more-pages");
          index++;
          rev++;
        },
      },
      {
        name: "select-all",
        kind: "describe",
        describe: "select every contact on this page",
        run: () => {
          selected = pages[index]!.map((r) => r.id);
          rev++;
          return { count: selected.length };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        run: () => {
          const n = selected.length;
          selected = [];
          rev++;
          return { count: n };
        },
      },
    ],
  });
}

/**
 * The one that matters: a store with a `rev` nobody bumps.
 *
 * Written the way it really happens — the author bumps `rev` in the verb they
 * wrote first and not in the one they added later. `select-all` is correct and
 * `accept-selected` is not, which is also why this app is a better fixture
 * than one that never bumps at all: a `rev` that is sometimes right is what
 * makes the bug survive a casual look.
 */
export function forgetsRev(): Driver {
  let rev = 1;
  let selected: string[] = [];
  const accepted = new Set<string>();
  return mount({
    app: "ForgetsRev",
    visible: (): Snapshot => ({
      where: "contacts",
      screen: "contacts",
      rev,
      rows: ROWS.map((r) => ({ ...r, status: accepted.has(r.id) ? "accepted" : "new" })),
      page: { index: 0, size: 3, total: 3 },
      ...(selected.length ? { selected: [...selected], selectedCount: selected.length } : {}),
    }),
    verbs: [
      // Correct, and here so this app has something a `verbs` filter can leave
      // out: a report that skipped nothing cannot show what a skip looks like.
      {
        name: "clear-selection",
        kind: "read",
        describe: "clear the selection",
        run: () => {
          if (!selected.length) return;
          selected = [];
          rev++;
        },
      },
      {
        name: "select-all",
        kind: "describe",
        describe: "select every contact",
        run: () => {
          selected = ROWS.map((r) => r.id);
          rev++;
          return { count: selected.length };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        run: () => {
          const n = selected.length;
          for (const id of selected) accepted.add(id);
          selected = [];
          // AND NOT `rev++`. The rows change, the selection empties, and every
          // agent holding the old rev goes on passing the `stale` check.
          return { count: n };
        },
      },
    ],
  });
}

/**
 * A paging app that publishes no `page`, which is absence read as completeness.
 *
 * The commonest version of this is an adapter over a rendered table: it cannot
 * tell a virtualised grid from a short list, so it omits `page` and asserts a
 * completeness it has no way to know. Here it is hand-written, because the
 * hand-written one is the one that ships.
 */
export function windowWithoutPage(): Driver {
  let rev = 1;
  let index = 0;
  const pages = [ROWS, [{ id: "c-4", name: "Edsger", status: "new" }]];
  return mount({
    app: "NoPage",
    visible: (): Snapshot => ({
      where: "contacts",
      screen: "contacts",
      rev,
      rows: pages[index]!.map((r) => ({ ...r })),
      // No `page`. The renderer will print "rows 3 (all of them)" and the
      // agent will report that c-4 does not exist.
    }),
    verbs: [
      {
        name: "next-page",
        kind: "read",
        describe: "show the next page of contacts",
        refuses: ["no-more-pages"],
        run: (_a: Record<string, Scalar>, ctx: VerbContext) => {
          if (index + 1 >= pages.length) return ctx.refuse("no-more-pages");
          index++;
          rev++;
        },
      },
    ],
  });
}

/**
 * `selected` filled with the whole selection, off-screen ids included.
 *
 * The author's reasoning is impeccable and wrong: they were asked for the
 * selected ids and they gave all of them. `Snapshot.selected` is documented as
 * on-screen ids only, and the cost of the honest-looking version is tens of
 * kilobytes of ids in the uncached half of every result from then on.
 */
export function selectsOffScreen(): Driver {
  let rev = 1;
  let selected: string[] = [];
  return mount({
    app: "OffScreen",
    visible: (): Snapshot => ({
      where: "contacts",
      screen: "contacts",
      rev,
      // Only three rows on screen...
      rows: ROWS.map((r) => ({ ...r })),
      page: { index: 0, size: 3, total: 6 },
      // ...and six ids in `selected`.
      ...(selected.length ? { selected: [...selected], selectedCount: selected.length } : {}),
    }),
    verbs: [
      {
        name: "select-all",
        kind: "describe",
        describe: "select every contact in the table",
        run: () => {
          selected = ["c-1", "c-2", "c-3", "c-4", "c-5", "c-6"];
          rev++;
          return { count: selected.length };
        },
      },
    ],
  });
}

/** `visible()` that is not a read: it fills a lazy cache and counts itself. */
export function impureVisible(): Driver {
  let reads = 0;
  return mount({
    app: "Impure",
    visible: (): Snapshot => ({
      where: "contacts",
      screen: "contacts",
      rev: 1,
      rows: ROWS.map((r) => ({ ...r })),
      // The counter is in `note`, which is the version of this that survives
      // review: it looks like telemetry and it makes every snapshot differ
      // from the one before it.
      note: `read ${++reads} times`,
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
}

/** A `describe` verb that reports no count, which makes the commit pairing
 *  advisory. Everything else about the app is correct. */
export function describeWithoutCount(): Driver {
  let rev = 1;
  let selected: string[] = [];
  return mount({
    app: "NoCount",
    visible: (): Snapshot => ({
      where: "contacts",
      screen: "contacts",
      rev,
      rows: ROWS.map((r) => ({ ...r })),
      page: { index: 0, size: 3, total: 3 },
      ...(selected.length ? { selected: [...selected], selectedCount: selected.length } : {}),
    }),
    verbs: [
      {
        name: "select-all",
        kind: "describe",
        describe: "select every contact",
        run: () => {
          selected = ROWS.map((r) => r.id);
          rev++;
          // No `{ count }`. The verb did its job and said nothing about how
          // much, so a person has no number to approve.
        },
      },
    ],
  });
}
