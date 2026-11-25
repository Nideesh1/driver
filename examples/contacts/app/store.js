/**
 * The store, the `visible()` read, and the verb table. No DOM in this file.
 *
 * Split out from `app.js` for one reason that turned out to matter: a verb
 * table tangled up with `document` can only be exercised in a browser, and
 * "open it and click about" is not a check anybody re-runs. Everything an
 * agent can reach is in here, so `check.mjs` drives the real verbs — the same
 * bytes the page loads, stripped by the same server — against the real relay
 * with no browser in the picture.
 *
 * THE VERB TABLE IS THE PART WORTH COPYING, and two decisions in it are not
 * obvious:
 *
 * **The predicate is on the `describe` verb and the `commit` verb has none.**
 * `select-where` takes the filter and reports a count; `accept-selected` takes
 * nothing and acts on whatever is selected. That is the core's pairing rule,
 * and it is what makes "accept everyone at Acme" one call with one number in
 * front of it rather than a thousand calls with nobody counting. A verb that
 * both selected and accepted is how fifty thousand rows get accepted because a
 * filter was wider than anybody thought.
 *
 * **The arguments are named fields with `oneOf`, not a predicate string.** A
 * `where: string` argument reads like a kindness to the model and is the
 * opposite: two models handed one invent two query languages — `company =
 * 'Acme'` and `employer = 'Acme'` — both syntactically fine and both
 * unparseable here, and the failure is a silently empty selection. `company`
 * with its eight real values enumerated cannot be got wrong, and a wrong value
 * comes back from the core as `bad-argument` *listing the accepted set*, which
 * the model can fix on its next turn without another read.
 */

import { mount } from "../../../packages/core/dist/registry.js";
import { buildContacts, COMPANIES, STATUSES, TOTAL } from "./data.js";

/** @typedef {import("./data.js").Contact} Contact */
/** @typedef {import("./data.js").Status} Status */

/** Twenty rows on screen. A screenful, which is the whole premise. */
export const PAGE_SIZE = 20;

export { COMPANIES, STATUSES, TOTAL };

/**
 * Build a fresh store and a driver over it.
 *
 * @param {() => void} [onChange] called after every mutation, once `rev` has
 *   moved. The page redraws and pushes a snapshot to the relay from here.
 */
export function createApp(onChange = () => {}) {
  const store = {
    /** @type {Contact[]} */
    rows: buildContacts(),
    query: "",
    page: 0,
    /** @type {Set<string>} */
    selected: new Set(),
    /** @type {string | null} */
    openId: null,
    /** Monotonic. Moved by `bump()` and by nothing else. */
    rev: 1,
  };

  /** The rows the search matches, in id order. @returns {Contact[]} */
  function filtered() {
    const q = store.query.trim().toLowerCase();
    if (!q) return store.rows;
    return store.rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.company.toLowerCase().includes(q) ||
        r.status.includes(q) ||
        r.id.includes(q),
    );
  }

  /** The twenty rows actually on screen, or fewer on the last page. */
  function windowRows() {
    const all = filtered();
    const start = store.page * PAGE_SIZE;
    return all.slice(start, start + PAGE_SIZE);
  }

  function pageCount() {
    return Math.max(1, Math.ceil(filtered().length / PAGE_SIZE));
  }

  /**
   * One change.
   *
   * Every mutation goes through here, because `rev` is what an agent echoes
   * back to prove it is acting on the screen it read. A path that changes the
   * table without moving `rev` hands out a `rev` that is a lie, the `stale`
   * check silently stops working, and the only symptom is an agent editing the
   * wrong row an hour later.
   */
  function bump() {
    store.rev += 1;
    onChange();
  }

  /** Mark every selected contact accepted. @returns {number} how many moved */
  function acceptSelected() {
    let changed = 0;
    for (const row of store.rows) {
      if (store.selected.has(row.id) && row.status !== "accepted") {
        row.status = "accepted";
        changed += 1;
      }
    }
    return changed;
  }

  /**
   * What a person could see right now.
   *
   * ONE HONEST COMPROMISE, written down because it is a gap in the `Snapshot`
   * type and not a shortcut here. `selected` is documented as "row ids the
   * user has selected", and `select-where` can select three thousand of them.
   * Putting them all in would make a snapshot that is mostly ids — tens of
   * kilobytes on every verb result, in the half that is never cached, and on a
   * bigger table straight through the relay's 1 MiB body limit. So this
   * reports the selected ids that are ON SCREEN, which is the set "this one"
   * can refer to, and puts the real total in `note` where a model will read
   * it. `Snapshot` has nowhere to say "n selected in total", and it should.
   */
  function visible() {
    const all = filtered();
    const rows = windowRows();
    const q = store.query.trim();
    const onScreen = rows.filter((r) => store.selected.has(r.id)).map((r) => r.id);

    const notes = [];
    if (store.selected.size > 0) {
      notes.push(
        `${store.selected.size} contact(s) selected in total, ${onScreen.length} of them on ` +
          "this page; a commit verb acts on the whole selection",
      );
    }
    if (store.openId) notes.push(`contact ${store.openId} is open in the detail panel`);

    return {
      where: q ? `contacts, filtered to “${q}”` : "contacts",
      rev: store.rev,
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        company: r.company,
        status: r.status,
      })),
      page: { index: store.page, size: PAGE_SIZE, total: all.length },
      ...(onScreen.length ? { selected: onScreen } : {}),
      ...(notes.length ? { note: notes.join(". ") } : {}),
    };
  }

  const driver = mount({
    app: "Contacts",
    visible,
    verbs: [
      {
        name: "search",
        kind: "read",
        describe:
          "filter the contacts table by a search term, the way typing in the search box does",
        args: {
          q: {
            type: "string",
            describe:
              "what to search for, matched against name, company, status and id. " +
              "Pass an empty string to clear the search.",
          },
        },
        run: ({ q }) => {
          store.query = q;
          store.page = 0;
          bump();
        },
      },

      {
        name: "open",
        kind: "read",
        describe: "open one contact's detail panel",
        args: { id: { type: "string", describe: "the contact's id, e.g. c-0184" } },
        refuses: ["no-such-contact"],
        run: ({ id }, ctx) => {
          const row = store.rows.find((r) => r.id === id);
          if (!row) {
            return ctx.refuse(
              "no-such-contact",
              `there is no contact with id \`${id}\`. Ids run from c-0001 to c-${TOTAL}.`,
            );
          }
          store.openId = id;
          bump();
        },
      },

      {
        name: "next-page",
        kind: "read",
        describe: "show the next page of contacts",
        refuses: ["at-last-page"],
        run: (_args, ctx) => {
          if (store.page >= pageCount() - 1) {
            return ctx.refuse(
              "at-last-page",
              "this is already the last page of the current filter",
            );
          }
          store.page += 1;
          bump();
        },
      },

      {
        name: "prev-page",
        kind: "read",
        describe: "show the previous page of contacts",
        refuses: ["at-first-page"],
        run: (_args, ctx) => {
          if (store.page === 0) {
            return ctx.refuse("at-first-page", "this is already the first page");
          }
          store.page -= 1;
          bump();
        },
      },

      {
        name: "select-where",
        kind: "describe",
        describe:
          "select every contact at one company, optionally only those with one status. " +
          "Selects across the whole table and not just the page on screen, replaces any " +
          "existing selection, and reports how many it matched.",
        args: {
          company: {
            type: "string",
            describe: "the company whose contacts to select",
            oneOf: [...COMPANIES],
          },
          status: {
            type: "string",
            describe: "only select contacts with this status. Omit to select every status.",
            oneOf: [...STATUSES],
            optional: true,
          },
        },
        run: ({ company, status }) => {
          store.selected.clear();
          let count = 0;
          for (const row of store.rows) {
            if (row.company !== company) continue;
            if (status !== undefined && status !== null && row.status !== status) continue;
            store.selected.add(row.id);
            count += 1;
          }
          bump();
          const which = `${company}${status ? ` with status ${status}` : ""}`;
          return {
            count,
            note: count === 0 ? `nothing at ${which} matched` : `selected ${count} at ${which}`,
          };
        },
      },

      {
        name: "clear-selection",
        kind: "describe",
        describe: "deselect everything",
        run: () => {
          store.selected.clear();
          bump();
          // `0`, not an omitted count. The core forwards it with `?? undefined`
          // precisely so "I matched nothing" stays distinguishable from "I do
          // not count", and those two decide different next moves.
          return { count: 0, note: "the selection is now empty" };
        },
      },

      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the currently selected contacts",
        refuses: ["nothing-selected"],
        run: (_args, ctx) => {
          if (store.selected.size === 0) {
            return ctx.refuse(
              "nothing-selected",
              "nothing is selected. Use `select-where` first and read the count it reports.",
            );
          }
          const total = store.selected.size;
          const changed = acceptSelected();
          bump();
          return {
            count: total,
            note:
              changed === total
                ? `accepted ${total} contact(s)`
                : `accepted ${total} contact(s); ${total - changed} were already accepted`,
          };
        },
      },
    ],
  });

  return {
    driver,
    store,
    visible,
    filtered,
    windowRows,
    pageCount,
    bump,
    acceptSelected,
  };
}
