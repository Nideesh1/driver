/**
 * The store, the per-screen `visible()` reads, and the verb table. No DOM in
 * this file.
 *
 * Split out from `app.js` for one reason that turned out to matter: a verb
 * table tangled up with `document` can only be exercised in a browser, and
 * "open it and click about" is not a check anybody re-runs. Everything an
 * agent can reach is in here, so `check.mjs` drives the real verbs — the same
 * bytes the page loads, stripped by the same server — against the real relay
 * with no browser in the picture. With six screens that stopped being a
 * nicety: a drill-down reachable only by clicking is a drill-down no harness
 * can walk.
 *
 * THE VERB TABLE IS THE PART WORTH COPYING, and four decisions in it are not
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
 *
 * **There is a verb for selecting exactly one row.** `select-contact` exists
 * because of a live failure in the first version of this demo: the only
 * selection verb was `select-where(company, status?)`, so asked to pick one
 * named person at Grayson Robotics the model correctly refused rather than
 * select all 410. The predicate rule says never `select(id)` *repeated a
 * thousand times*; it does not say an agent may not point at one row. A verb
 * surface that can only act in bulk cannot do the ordinary thing.
 *
 * **Screen-scoped verbs refuse `wrong-screen` rather than silently working.**
 * The manifest is flat and cached, so every verb in this app is offered on
 * every screen — there is no way to say "this one is only on the companies
 * list". `next-page` on the dashboard therefore has to be a refusal with the
 * fix in it ("the contacts list has pages; `go(contacts)` first"), which is
 * the closest this library gets to expressing a screen boundary. See the
 * report; this is the sharpest of the gaps.
 */

import { mount } from "../../../packages/core/dist/registry.js";
import {
  COMPANIES,
  OWNERS,
  STATUSES,
  TOTAL,
  buildCompanies,
  buildContacts,
  companySlug,
  historyFor,
} from "./data.js";
import { HOME, LANDINGS, href, parse, same } from "./router.js";

/** @typedef {import("./data.js").Contact} Contact */
/** @typedef {import("./data.js").Status} Status */
/** @typedef {import("./router.js").Route} Route */

/** Twenty rows on screen. A screenful, which is the whole premise. It is also
 *  now only the DEFAULT: the settings screen can change it, which is the one
 *  place a non-table screen reaches into a table one. */
export const PAGE_SIZE = 20;

/** What `set-setting` accepts for the page size. Strings because `ArgSpec` has
 *  no union type and one `value` argument has to carry a number, a name and
 *  two booleans; see the report. */
export const PAGE_SIZES = ["10", "20", "50", "100"];

export { COMPANIES, OWNERS, STATUSES, TOTAL };

/**
 * One line, on every screen, naming the other screens.
 *
 * It is here, in the snapshot, because there is nowhere better. `Manifest`
 * carries `app`, `version` and `verbs` and no field for the app's own
 * briefing: the widget can pass `instructions` to `drive()`, but an agent
 * coming in through the relay never sees those, so a screen map kept there
 * would be visible to one of driverkit's two paths and not the other. So it
 * rides in the uncached half and is paid for on every single turn. Kept to one
 * line for that reason, and listed in the report as a gap rather than
 * defended as a design.
 */
const MAP =
  "this app has screens: dashboard, contacts, companies, settings — `go` reaches those; " +
  "`open-contact`/`open-company` open one record";

/**
 * Build a fresh store and a driver over it.
 *
 * @param {() => void} [onChange] called after every mutation, once `rev` has
 *   moved. The page redraws, syncs the address bar and pushes a snapshot to
 *   the relay from here.
 */
export function createApp(onChange = () => {}) {
  const rows = buildContacts();

  const store = {
    /** @type {Contact[]} */
    rows,
    /** The eight companies, rolled up from `rows`. Recomputed by `reroll()`
     *  after anything that moves a status, because a cached roll-up would tell
     *  the companies screen a number the contacts screen disagrees with. */
    companies: buildCompanies(rows),
    /**
     * Where the user is. The single source of truth for the screen: `app.js`
     * syncs the address bar FROM this, never the other way round, so a
     * navigation verb can report the screen it landed on synchronously.
     * @type {Route}
     */
    route: { ...HOME },
    /** Routes to pop for `back`. The app's own stack, not the browser's; see
     *  the `back` verb for why they are not the same thing. @type {Route[]} */
    trail: [],
    query: "",
    page: 0,
    /** @type {Set<string>} */
    selected: new Set(),
    /** Which status the open company's contact list is filtered to: `"all"` or
     *  one of STATUSES. */
    statusTab: "pending",
    /** How the companies list is ordered. */
    sortBy: "name",
    settings: {
      rowsPerPage: PAGE_SIZE,
      defaultOwner: OWNERS[0],
      confirmBulk: true,
      denseRows: false,
    },
    /** Monotonic. Moved by `bump()` and by nothing else. */
    rev: 1,
  };

  const pageSize = () => store.settings.rowsPerPage;

  /** @param {string} id */
  const contact = (id) => store.rows.find((r) => r.id === id);

  /** @param {string | null} slug */
  const company = (slug) => store.companies.find((c) => c.id === slug);

  /** The company whose record is open, or undefined. */
  const openCompany = () =>
    store.route.screen === "company" ? company(store.route.id) : undefined;

  /** The contact whose record is open, or undefined. */
  const openContact = () =>
    store.route.screen === "contact" && store.route.id ? contact(store.route.id) : undefined;

  /** Recompute the company roll-ups. */
  function reroll() {
    store.companies = buildCompanies(store.rows);
  }

  /** The rows the contacts-screen search matches, in id order. @returns {Contact[]} */
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

  /** The contacts of the open company, under the current status tab. */
  function companyRows() {
    const open = openCompany();
    if (!open) return [];
    return store.rows.filter(
      (r) => r.company === open.name && (store.statusTab === "all" || r.status === store.statusTab),
    );
  }

  /** Whichever list the current screen pages through, or null if it does not
   *  page. One function so `next-page` need not know which screen it is on
   *  beyond "does this one page at all". */
  function pagedRows() {
    if (store.route.screen === "contacts") return filtered();
    if (store.route.screen === "company") return companyRows();
    return null;
  }

  /** The rows actually on screen, or fewer on the last page. */
  function windowRows() {
    const all = pagedRows() ?? [];
    const start = store.page * pageSize();
    return all.slice(start, start + pageSize());
  }

  function pageCount() {
    return Math.max(1, Math.ceil((pagedRows() ?? []).length / pageSize()));
  }

  /** The companies list in its current order. */
  function sortedCompanies() {
    const by = store.sortBy;
    const copy = [...store.companies];
    if (by === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
    return copy.sort((a, b) => Number(b[by]) - Number(a[by]) || a.name.localeCompare(b.name));
  }

  /**
   * One change.
   *
   * Every mutation goes through here, because `rev` is what an agent echoes
   * back to prove it is acting on the screen it read. A path that changes the
   * table without moving `rev` hands out a `rev` that is a lie, the `stale`
   * check silently stops working, and the only symptom is an agent editing the
   * wrong row an hour later.
   *
   * Navigation goes through it too, and that is the ONLY protection an agent
   * gets against the screen changing shape under a queued call: there is no
   * separate "you are somewhere else now" signal, so a `rev` quoted on the
   * contacts list refuses `stale` on the company record. It works, and it
   * works only for agents that bother to quote `rev`.
   */
  function bump() {
    store.rev += 1;
    onChange();
  }

  /**
   * Go somewhere, recording where we were.
   *
   * Synchronous and authoritative. The address bar is updated afterwards by
   * `app.js` watching `onChange`; doing it the other way round — the verb
   * calls `history.pushState`, `hashchange` eventually updates the store —
   * would mean a navigation verb returning a snapshot of the screen it just
   * left, since `Result.snapshot` is read the instant `run` returns.
   *
   * @param {Route} route
   * @param {{ record?: boolean }} [opts] `record: false` for a move that came
   *   FROM the browser's own history, which must not be pushed back onto the
   *   trail or Back would alternate between two screens forever.
   */
  function navigate(route, opts = {}) {
    if (same(store.route, route)) return;
    if (opts.record !== false) store.trail.push({ ...store.route });
    store.route = { ...route };
    // Paging and the status tab are per-visit. A company record opened at page
    // 4 because the contacts list happened to be at page 4 is the kind of bug
    // that only shows up in a demo video.
    store.page = 0;
    if (route.screen === "company") store.statusTab = "pending";
    bump();
  }

  /** Mark every selected contact with one status. @param {Status} status */
  function applyToSelection(status) {
    let changed = 0;
    for (const row of store.rows) {
      if (store.selected.has(row.id) && row.status !== status) {
        row.status = status;
        changed += 1;
      }
    }
    reroll();
    return changed;
  }

  // ---- the screens -------------------------------------------------------

  /**
   * What a person could see right now, per screen.
   *
   * ONE `visible()` PER SCREEN AND A DISPATCH, not one function with six
   * branches of `if`. Six screens have six shapes: the dashboard has no rows
   * in any meaningful sense, the record screens have no pages, and the two
   * lists page over different things. `MountOptions.visible` is a single
   * `() => Snapshot` for the whole app, so the dispatch is hand-written here —
   * see the report, where "should each screen declare its own visible()" is
   * the question this shape is an answer to.
   *
   * TWO HONEST COMPROMISES, written down because they are gaps in the
   * `Snapshot` type and not shortcuts here.
   *
   * 1. `selected` reports only the selected ids ON SCREEN and `selectedCount`
   *    carries the true size. `select-where` can select three thousand rows;
   *    putting them all in `selected` would make a snapshot that is mostly
   *    ids — tens of kilobytes on every verb result, in the half that is never
   *    cached, and on a bigger table straight through the relay's 1 MiB body
   *    limit. The type says as much, and the renderer turns the pair into
   *    "selected 410 rows in all; the 20 ids above are only the ones on
   *    screen".
   *
   * 2. A record screen's own fields are in `where`. There is no field in
   *    `Snapshot` for "the thing I drilled into": `rows` is a list of records
   *    and the open contact is not one of its own history events. The
   *    alternative was one record row plus five activity rows in the same flat
   *    `rows` array, which the agent-side renderer prints as a ragged
   *    thirteen-column table full of dashes, because it takes the union of
   *    every row's keys. So the fields went into the sentence documented as
   *    "where the user is, in their words", and the report says plainly that
   *    this is the wrong place for them.
   */
  const screens = {
    /**
     * The dashboard. Not a table, and the screen that shows what `Snapshot`
     * cannot say.
     *
     * These `rows` are not records: each one is a tile, with an `id` nothing
     * can be done to and a `value` that is a number rather than a field of
     * anything. The renderer prints them as a table and an agent reads them as
     * a table, and that is a lie neither of them can catch. `page` is omitted,
     * which at least claims truthfully that there is no more to see.
     */
    dashboard() {
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      let pipeline = 0;
      for (const row of store.rows) {
        byStatus[row.status] += 1;
        if (row.status === "new" || row.status === "pending") pipeline += row.value;
      }
      const hottest = [...store.companies].sort((a, b) => b.pending - a.pending)[0];

      return {
        where: "dashboard",
        rev: store.rev,
        rows: [
          { id: "contacts", metric: "contacts in all", value: TOTAL },
          { id: "companies", metric: "companies", value: COMPANIES.length },
          ...STATUSES.map((s) => ({ id: s, metric: `contacts ${s}`, value: byStatus[s] })),
          { id: "pipeline", metric: "open pipeline, USD", value: pipeline },
          { id: "hottest", metric: "most pending", value: `${hottest.name} (${hottest.pending})` },
        ],
        ...(store.selected.size ? { selectedCount: store.selected.size } : {}),
        note:
          "this screen is a dashboard, not a table: each row above is one metric tile and " +
          "`id` names the tile, not a record. " +
          (store.selected.size
            ? `${store.selected.size} contacts are still selected from another screen and a ` +
              "commit verb would act on them from here. "
            : "") +
          MAP,
      };
    },

    /** The contacts list. The screen the first version of this demo was. */
    contacts() {
      const all = filtered();
      const visibleRows = windowRows();
      const q = store.query.trim();
      const onScreen = visibleRows.filter((r) => store.selected.has(r.id)).map((r) => r.id);

      const notes = [];
      if (store.selected.size > onScreen.length) {
        notes.push("a commit verb acts on the whole selection, not just the rows on this page");
      }
      notes.push(MAP);

      return {
        where: q
          ? `contacts list, filtered to “${q}” (${all.length} of ${TOTAL})`
          : `contacts list (${TOTAL} rows)`,
        rev: store.rev,
        rows: visibleRows.map((r) => ({
          id: r.id,
          name: r.name,
          company: r.company,
          status: r.status,
        })),
        page: { index: store.page, size: pageSize(), total: all.length },
        ...(onScreen.length ? { selected: onScreen } : {}),
        ...(store.selected.size ? { selectedCount: store.selected.size } : {}),
        note: notes.join(". "),
      };
    },

    /**
     * One contact's own screen: their details, and their history as rows.
     *
     * The fields are in `where` and the reason is above. `rows` is the
     * activity history, oldest first, and `page` is absent because there is no
     * more of it — the one claim this screen gets to make cleanly.
     */
    contact() {
      const open = openContact();
      if (!open) {
        return {
          where: `contact ${store.route.id} — no such contact`,
          rev: store.rev,
          note: `there is no contact with id \`${store.route.id}\`. ${MAP}`,
        };
      }
      const events = historyFor(open.id);
      return {
        where:
          `contact ${open.id} — ${open.name}, ${open.title} at ${open.company}; ` +
          `status ${open.status}; owner ${open.owner}; ${open.email}; ` +
          `added ${open.added}; deal value ${open.value}`,
        rev: store.rev,
        rows: events.map((e) => ({ id: e.id, when: e.when, what: e.what, who: e.who })),
        ...(store.selected.size ? { selectedCount: store.selected.size } : {}),
        note:
          "the rows above are this contact's activity history, oldest first — they are not " +
          "contacts. `set-status` and `assign-owner` act on this record and take no id. " +
          (store.selected.size
            ? `${store.selected.size} contacts are selected elsewhere; a commit verb acting on ` +
              "the selection would not touch this record unless it is one of them. "
            : "") +
          MAP,
      };
    },

    /** The companies list. Eight rows, no paging, sortable. */
    companies() {
      return {
        where: `companies list (${store.companies.length} rows), sorted by ${store.sortBy}`,
        rev: store.rev,
        rows: sortedCompanies().map((c) => ({
          id: c.id,
          name: c.name,
          tier: c.tier,
          contacts: c.contacts,
          new: c.new,
          pending: c.pending,
          accepted: c.accepted,
        })),
        ...(store.selected.size ? { selectedCount: store.selected.size } : {}),
        note:
          "`id` is the company's slug, which is what the URL uses; `open-company` takes the " +
          "`name`. " +
          (store.selected.size
            ? `${store.selected.size} contacts are selected on another screen and a commit verb ` +
              "would act on them from here. "
            : "") +
          MAP,
      };
    },

    /**
     * One company's own screen, and the one that makes the multi-screen job
     * possible: its contacts, filtered to a status tab, paged, selectable.
     *
     * This is where "find Grayson Robotics, open it, look at its pending
     * contacts, accept them" ends up, and the reason `select-pending-here`
     * exists: on this screen the predicate the person means is "the ones in
     * front of me", which `select-where(company, status)` can only express by
     * repeating the company the screen already knows.
     */
    company() {
      const open = openCompany();
      if (!open) {
        return {
          where: `company ${store.route.id} — no such company`,
          rev: store.rev,
          note: `there is no company with slug \`${store.route.id}\`. ${MAP}`,
        };
      }
      const all = companyRows();
      const visibleRows = windowRows();
      const onScreen = visibleRows.filter((r) => store.selected.has(r.id)).map((r) => r.id);

      return {
        where:
          `company ${open.name} — ${open.tier}, ${open.region}, lead ${open.lead}; ` +
          `${open.contacts} contacts (${open.new} new, ${open.pending} pending, ` +
          `${open.accepted} accepted, ${open.declined} declined); ` +
          `showing the ${store.statusTab} ones`,
        rev: store.rev,
        rows: visibleRows.map((r) => ({
          id: r.id,
          name: r.name,
          title: r.title,
          status: r.status,
          owner: r.owner,
        })),
        page: { index: store.page, size: pageSize(), total: all.length },
        ...(onScreen.length ? { selected: onScreen } : {}),
        ...(store.selected.size ? { selectedCount: store.selected.size } : {}),
        note:
          "the rows are this company's contacts under the current status tab. " +
          "`select-pending-here` selects every pending contact at this company in one call and " +
          "reports the count. " +
          (store.selected.size > onScreen.length
            ? "a commit verb acts on the whole selection, which reaches past this page and past " +
              "this company. "
            : "") +
          MAP,
      };
    },

    /**
     * Settings. A form, which `Snapshot` has no way to describe.
     *
     * Each "row" is one input: `id` is the setting's name, `value` is what the
     * box currently says, `accepts` is the set it will take. `Snapshot.controls`
     * exists and would say that an input is THERE, but `ControlSummary` carries
     * `field: true` and no value — so an agent given the controls would know
     * this screen has a rows-per-page box and not what is in it. So the form is
     * rows, with the values in them, and the report says what should exist
     * instead.
     */
    settings() {
      const s = store.settings;
      return {
        where: "settings",
        rev: store.rev,
        rows: [
          {
            id: "rows-per-page",
            setting: "rows per page",
            value: String(s.rowsPerPage),
            accepts: PAGE_SIZES.join(" | "),
          },
          {
            id: "default-owner",
            setting: "default owner for new contacts",
            value: s.defaultOwner,
            accepts: OWNERS.join(" | "),
          },
          {
            id: "confirm-bulk",
            setting: "confirm before a bulk accept",
            value: String(s.confirmBulk),
            accepts: "true | false",
          },
          {
            id: "dense-rows",
            setting: "dense table rows",
            value: String(s.denseRows),
            accepts: "true | false",
          },
        ],
        ...(store.selected.size ? { selectedCount: store.selected.size } : {}),
        note:
          "this screen is a form, not a table: each row is one input, `id` is the setting to " +
          "pass to `set-setting`, `value` is what the box says now and `accepts` is what it " +
          "will take. " +
          MAP,
      };
    },
  };

  /** The dispatch. One `visible()` for the whole app is what the core takes. */
  function visible() {
    const screen = screens[store.route.screen];
    return screen ? screen() : screens.dashboard();
  }

  // ---- the verbs ---------------------------------------------------------

  /**
   * The guard every screen-scoped verb starts with.
   *
   * Returns a refusal, or null when the verb is on its own screen. The hint
   * names the verb that would get the agent to the right place, because
   * `wrong-screen` on its own is a dead end: the manifest is one flat list
   * with no screen on any entry, so an agent has no structural way to know
   * which screen a verb belongs to until it has been refused once.
   *
   * @param {{ refuse: (reason: string, hint?: string) => any }} ctx
   * @param {string[]} want
   * @param {string} fix
   */
  function here(ctx, want, fix) {
    if (want.includes(store.route.screen)) return null;
    return ctx.refuse(
      "wrong-screen",
      `you are on the ${store.route.screen} screen; this verb works on ${want.join(" or ")}. ${fix}`,
    );
  }

  const driver = mount({
    app: "Northwind CRM",
    visible,
    verbs: [
      // ---- getting about ------------------------------------------------
      {
        name: "go",
        // `read` under protest. The three kinds are read / describe / commit
        // and navigation is none of them: it changes no data, so it is not a
        // commit, and it reports no count, so it is not a describe — but it is
        // emphatically not "changes nothing", which is what `read` promises in
        // the cached half. It moves the person's screen out from under them.
        // See the report: the ladder needs a fourth rung, or `read` has to
        // stop claiming that nothing changes.
        kind: "read",
        describe:
          "go to one of the app's main screens, the way clicking the left-hand nav does. " +
          "The two record screens are not here: use `open-contact` or `open-company`.",
        at: ".nav",
        args: {
          screen: {
            type: "string",
            describe: "which screen to show",
            oneOf: [...LANDINGS],
          },
        },
        run: ({ screen }) => {
          navigate({ screen, id: null });
        },
      },

      {
        name: "open-contact",
        kind: "read",
        describe:
          "open one contact's own screen: their details and their activity history. " +
          "This is a drill-down and it replaces the screen you are on.",
        args: { id: { type: "string", describe: "the contact's id, e.g. c-0184" } },
        refuses: ["no-such-contact"],
        run: ({ id }, ctx) => {
          if (!contact(id)) {
            return ctx.refuse(
              "no-such-contact",
              `there is no contact with id \`${id}\`. Ids run from c-0001 to c-${TOTAL}.`,
            );
          }
          navigate({ screen: "contact", id });
        },
      },

      {
        name: "open-company",
        kind: "read",
        describe:
          "open one company's own screen: its details, and its contacts filtered to a status " +
          "tab which starts on pending.",
        args: {
          company: {
            type: "string",
            describe: "the company's name",
            oneOf: [...COMPANIES],
          },
        },
        run: ({ company: name }) => {
          navigate({ screen: "company", id: companySlug(name) });
        },
      },

      {
        name: "back",
        kind: "read",
        describe: "go back to the screen you were on before",
        refuses: ["nothing-to-go-back-to"],
        run: (_args, ctx) => {
          const previous = store.trail.pop();
          if (!previous) {
            return ctx.refuse(
              "nothing-to-go-back-to",
              "this is the first screen of the session. `go` takes you anywhere directly.",
            );
          }
          // `record: false`: the screen being left must not go onto the trail,
          // or `back` twice would bounce between two screens.
          navigate(previous, { record: false });
        },
      },

      // ---- the contacts list --------------------------------------------
      {
        name: "search",
        // `read`, and the ladder is genuinely ambiguous about it: the doc
        // comment on `VerbKind` says `describe` is for a verb that "changes
        // what is SELECTED or FILTERED", which this does. It is `read` because
        // the rest of what `describe` means does not apply — there is no count
        // a commit decision turns on, and nothing is left pending afterwards.
        // Both readings are defensible, which is the problem. See the report.
        kind: "read",
        describe:
          "filter the contacts list by a search term, the way typing in the search box does. " +
          "Only on the contacts list.",
        at: "#q",
        args: {
          q: {
            type: "string",
            describe:
              "what to search for, matched against name, company, status and id. " +
              "Pass an empty string to clear the search.",
          },
        },
        refuses: ["wrong-screen"],
        run: ({ q }, ctx) => {
          const no = here(ctx, ["contacts"], "`go` with screen `contacts` first.");
          if (no) return no;
          store.query = q;
          store.page = 0;
          bump();
        },
      },

      {
        name: "next-page",
        kind: "read",
        describe: "show the next page of whichever list you are on",
        refuses: ["at-last-page", "wrong-screen"],
        run: (_args, ctx) => {
          const no = here(
            ctx,
            ["contacts", "company"],
            "only the contacts list and a company's contact list have pages: `go` with screen " +
              "`contacts`, or `open-company`.",
          );
          if (no) return no;
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
        describe: "show the previous page of whichever list you are on",
        refuses: ["at-first-page", "wrong-screen"],
        run: (_args, ctx) => {
          const no = here(
            ctx,
            ["contacts", "company"],
            "only the contacts list and a company's contact list have pages: `go` with screen " +
              "`contacts`, or `open-company`.",
          );
          if (no) return no;
          if (store.page === 0) {
            return ctx.refuse("at-first-page", "this is already the first page");
          }
          store.page -= 1;
          bump();
        },
      },

      // ---- the companies list and a company's screen ---------------------
      {
        name: "sort-companies",
        kind: "read",
        describe: "reorder the companies list",
        at: ".table",
        args: {
          by: {
            type: "string",
            describe: "the column to sort by. Everything but `name` sorts highest first.",
            oneOf: ["name", "contacts", "new", "pending", "accepted"],
          },
        },
        refuses: ["wrong-screen"],
        run: ({ by }, ctx) => {
          const no = here(ctx, ["companies"], "`go` with screen `companies` first.");
          if (no) return no;
          store.sortBy = by;
          bump();
        },
      },

      {
        name: "show-status",
        kind: "read",
        describe: "on a company's screen, switch which status tab of its contacts is listed",
        args: {
          status: {
            type: "string",
            describe: "the status to list, or `all` for every status",
            oneOf: [...STATUSES, "all"],
          },
        },
        refuses: ["wrong-screen"],
        run: ({ status }, ctx) => {
          const no = here(ctx, ["company"], "`open-company` first.");
          if (no) return no;
          store.statusTab = status;
          store.page = 0;
          bump();
        },
      },

      // ---- selecting ----------------------------------------------------
      {
        name: "select-where",
        kind: "describe",
        describe:
          "select every contact at one company, optionally only those with one status. " +
          "Selects across the whole table and not just the page or the screen you are on, " +
          "replaces any existing selection, and reports how many it matched.",
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
        run: ({ company: name, status }) => {
          store.selected.clear();
          let count = 0;
          for (const row of store.rows) {
            if (row.company !== name) continue;
            if (status !== undefined && status !== null && row.status !== status) continue;
            store.selected.add(row.id);
            count += 1;
          }
          bump();
          const which = `${name}${status ? ` with status ${status}` : ""}`;
          return {
            count,
            note: count === 0 ? `nothing at ${which} matched` : `selected ${count} at ${which}`,
          };
        },
      },

      {
        name: "select-contact",
        kind: "describe",
        describe:
          "select exactly one contact by id, from any screen. Use this when the person named " +
          "one person: the bulk verb `select-where` would take their whole company.",
        args: {
          id: { type: "string", describe: "the contact's id, e.g. c-0184" },
          add: {
            type: "boolean",
            describe:
              "true to add to the current selection instead of replacing it. Use it to build a " +
              "small selection of named people; do not loop it over hundreds of ids, which is " +
              "what `select-where` is for.",
            optional: true,
          },
        },
        refuses: ["no-such-contact"],
        run: ({ id, add }, ctx) => {
          const row = contact(id);
          if (!row) {
            return ctx.refuse(
              "no-such-contact",
              `there is no contact with id \`${id}\`. Ids run from c-0001 to c-${TOTAL}. ` +
                "Search the contacts list by name to find an id.",
            );
          }
          if (!add) store.selected.clear();
          store.selected.add(id);
          bump();
          return {
            count: store.selected.size,
            note: `${row.name} (${row.company}, ${row.status}) is selected`,
          };
        },
      },

      {
        name: "select-pending-here",
        kind: "describe",
        describe:
          "on a company's screen, select every pending contact at THIS company in one call and " +
          "report how many. The company is the one whose screen you are on.",
        refuses: ["wrong-screen", "nothing-pending"],
        run: (_args, ctx) => {
          const no = here(ctx, ["company"], "`open-company` first.");
          if (no) return no;
          const open = openCompany();
          const pending = store.rows.filter(
            (r) => r.company === open.name && r.status === "pending",
          );
          if (pending.length === 0) {
            return ctx.refuse(
              "nothing-pending",
              `${open.name} has no pending contacts. \`show-status\` with \`all\` lists the rest.`,
            );
          }
          store.selected.clear();
          for (const row of pending) store.selected.add(row.id);
          bump();
          return {
            count: pending.length,
            note: `selected ${pending.length} pending contacts at ${open.name}`,
          };
        },
      },

      {
        name: "clear-selection",
        kind: "describe",
        describe: "deselect everything, on every screen",
        run: () => {
          store.selected.clear();
          bump();
          // `0`, not an omitted count. The core forwards it with `?? undefined`
          // precisely so "I matched nothing" stays distinguishable from "I do
          // not count", and those two decide different next moves.
          return { count: 0, note: "the selection is now empty" };
        },
      },

      // ---- committing ---------------------------------------------------
      {
        name: "accept-selected",
        kind: "commit",
        describe:
          "accept the currently selected contacts, wherever they were selected. Takes no " +
          "filter: it acts on the selection, which may reach past this screen.",
        at: "#accept-sel",
        refuses: ["nothing-selected"],
        run: (_args, ctx) => {
          if (store.selected.size === 0) {
            return ctx.refuse(
              "nothing-selected",
              "nothing is selected. Use `select-where`, `select-contact` or " +
                "`select-pending-here` first and read the count it reports.",
            );
          }
          const total = store.selected.size;
          const changed = applyToSelection("accepted");
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

      {
        name: "decline-selected",
        kind: "commit",
        describe: "decline the currently selected contacts. Takes no filter; see the selection.",
        refuses: ["nothing-selected"],
        run: (_args, ctx) => {
          if (store.selected.size === 0) {
            return ctx.refuse(
              "nothing-selected",
              "nothing is selected. Use a select verb first and read the count it reports.",
            );
          }
          const total = store.selected.size;
          const changed = applyToSelection("declined");
          bump();
          return {
            count: total,
            note:
              changed === total
                ? `declined ${total} contact(s)`
                : `declined ${total} contact(s); ${total - changed} were already declined`,
          };
        },
      },

      {
        name: "set-status",
        kind: "commit",
        describe:
          "set the status of the ONE contact whose screen is open. Takes no id: the record is " +
          "the one you drilled into. Nothing to do with the selection.",
        args: {
          status: { type: "string", describe: "the status to set", oneOf: [...STATUSES] },
        },
        refuses: ["no-contact-open", "already-that-status"],
        run: ({ status }, ctx) => {
          const open = openContact();
          if (!open) {
            return ctx.refuse(
              "no-contact-open",
              "no contact's screen is open, so there is no record to change. `open-contact` " +
                "with an id first. To change many at once, select them and use " +
                "`accept-selected` or `decline-selected`.",
            );
          }
          if (open.status === status) {
            return ctx.refuse("already-that-status", `${open.name} is already ${status}`);
          }
          open.status = status;
          reroll();
          bump();
          return { count: 1, note: `${open.name} is now ${status}` };
        },
      },

      {
        name: "assign-owner",
        kind: "commit",
        describe:
          "assign the ONE contact whose screen is open to a sales owner. Takes no id: the " +
          "record is the one you drilled into.",
        args: {
          owner: { type: "string", describe: "who to assign it to", oneOf: [...OWNERS] },
        },
        refuses: ["no-contact-open", "already-that-owner"],
        run: ({ owner }, ctx) => {
          const open = openContact();
          if (!open) {
            return ctx.refuse(
              "no-contact-open",
              "no contact's screen is open. `open-contact` with an id first.",
            );
          }
          if (open.owner === owner) {
            return ctx.refuse("already-that-owner", `${open.name} is already assigned to ${owner}`);
          }
          open.owner = owner;
          bump();
          return { count: 1, note: `${open.name} is now assigned to ${owner}` };
        },
      },

      // ---- the form -----------------------------------------------------
      {
        name: "set-setting",
        // `commit`, because it changes stored state that outlives the screen —
        // and the ladder has nothing weaker to say about a change that is one
        // click to undo. Calling it `describe` would be a lie about what it
        // touches; calling it `commit` makes the widget stop and ask a person
        // before the app changes its own page size, which is a question nobody
        // needs. The report says what the third rung is missing.
        kind: "commit",
        describe:
          "change one setting on the settings screen. The settings screen lists each setting's " +
          "name, its current value and what it accepts.",
        at: ".form",
        args: {
          name: {
            type: "string",
            describe: "which setting",
            oneOf: ["rows-per-page", "default-owner", "confirm-bulk", "dense-rows"],
          },
          value: {
            type: "string",
            // Everything is a string because `ArgSpec.type` is one of three
            // scalars and cannot be "a number here, a name there, a boolean
            // for those two" — nor can `oneOf` depend on another argument. So
            // the accepted set is prose, the parse is below, and a wrong value
            // comes back as an app refusal where it should have been the
            // core's `bad-argument` with the set listed. See the report.
            describe:
              "the new value, as a string: a page size (10, 20, 50, 100), an owner's name, or " +
              "`true`/`false` for the two switches. The settings screen's `accepts` column " +
              "lists the exact set for each setting.",
          },
        },
        refuses: ["bad-setting-value"],
        run: ({ name, value }, ctx) => {
          const s = store.settings;
          if (name === "rows-per-page") {
            if (!PAGE_SIZES.includes(value)) {
              return ctx.refuse(
                "bad-setting-value",
                `rows-per-page must be one of ${PAGE_SIZES.join(", ")}; got ${JSON.stringify(value)}`,
              );
            }
            s.rowsPerPage = Number(value);
            store.page = 0;
          } else if (name === "default-owner") {
            if (!OWNERS.includes(value)) {
              return ctx.refuse(
                "bad-setting-value",
                `default-owner must be one of ${OWNERS.join(", ")}; got ${JSON.stringify(value)}`,
              );
            }
            s.defaultOwner = value;
          } else if (name === "confirm-bulk" || name === "dense-rows") {
            if (value !== "true" && value !== "false") {
              return ctx.refuse(
                "bad-setting-value",
                `${name} must be \`true\` or \`false\`; got ${JSON.stringify(value)}`,
              );
            }
            const on = value === "true";
            if (name === "confirm-bulk") s.confirmBulk = on;
            else s.denseRows = on;
          }
          bump();
          return { note: `${name} is now ${value}` };
        },
      },
    ],
  });

  return {
    driver,
    store,
    visible,
    screens,
    navigate,
    parse,
    href,
    contact,
    company,
    openContact,
    openCompany,
    filtered,
    companyRows,
    sortedCompanies,
    windowRows,
    pagedRows,
    pageCount,
    pageSize,
    bump,
    reroll,
    applyToSelection,
    historyFor,
  };
}
