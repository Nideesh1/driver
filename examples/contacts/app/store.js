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
 * **And the commit takes the `describe`'s plan token.** The pairing above is
 * two calls, which is necessary and was never sufficient: `accept-selected`
 * re-reads the selection when it runs, so a checkbox clicked between the two
 * calls meant the 410 the agent read was not the 410 that changed. So
 * BOTH selection commits declare `consumes: "plan"`, every screen publishes a
 * `selectionId`, and a commit holding a token from before the selection moved
 * is refused `stale-plan` with both counts named. Both, and not just the one
 * the demo script uses, because an eval found the hole: asked for a job this
 * app cannot do, an agent improvised its way to `decline-selected` and changed
 * 403 rows with nothing gated. The two record verbs — `set-status` and
 * `assign-owner` — declare nothing and are right not to: they act on the ONE
 * contact whose screen is open, so the count is 1 and the person is looking at
 * it. A plan is the receipt for a count larger than the screen.
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
 * **A screen-scoped verb declares `screen` and the core writes the refusal.**
 * The verb list is still flat and still cached — it has to be, or every
 * navigation would bust the prompt prefix — but each scoped verb now names the
 * screen it lives on, `visible()` returns the screen that is live, and
 * `wrong-screen` comes back from the core naming BOTH screens. This app used
 * to hand-roll that check and invent the slug for it, which is why the slug is
 * reserved now: the next app would have called it something else and no agent
 * would have recognised both.
 *
 * `next-page` and `prev-page` are where this app pushed the field. They
 * genuinely work on two screens — the contacts list and a company's contact
 * list, which both page — and `Verb.screen` used to be one string, so scoping
 * them to either would have made this app refuse a call on a screen it was
 * still publishing a `page` block for. The demo refused to write that
 * contradiction down and declared no `screen` at all, refusing an invented
 * `no-pages-here` instead; `Verb.screen` now takes a list, so the two carry
 * `screen: ["contacts", "company"]` and the core writes the refusal with every
 * screen named. The hand-rolled slug and the predicate behind it are gone,
 * which is the point: an app that invents a word for "you are not there" is an
 * app whose word the next agent will not recognise.
 */

import { mount, selectionId } from "../../../packages/driverkit/dist/core/registry.js";
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
import { HOME, SCREEN_SPECS, href, parse, same } from "./router.js";

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
 * The app's own briefing, said once.
 *
 * This used to be a 130-character screen map pasted into every screen's
 * `note`, because the only other place for it was the widget's own
 * `instructions` — which an agent arriving over the relay never sees. So the
 * app repeated itself in the UNCACHED half, on every single turn, for a
 * sentence that never changes.
 *
 * `MountOptions.instructions` is now where it goes. It lands in
 * `Manifest.instructions`, which is cached once and read by both paths: the
 * in-page loop folds it into the system prompt, and the MCP server puts it in
 * its server instructions. One place, both ways in.
 *
 * Static means static, which is the rule that keeps this cheap: no ids, no
 * counts, no user, nothing that differs between two people or two minutes. It
 * is in the manifest fingerprint for exactly that reason — it is part of what
 * a cached copy claims.
 */
const INSTRUCTIONS =
  "A drill-down replaces the screen you are on, and `back` walks out again — the trail is " +
  "this session's, not the browser's. Several verbs work on one screen only; their tool " +
  "description says which, and calling one elsewhere is refused as `wrong-screen` naming the " +
  "screen you are on and the screen it wants. A contact's status moves new → pending → " +
  "accepted or declined. The selection is global: it survives navigation, so a commit verb " +
  "can act on rows that are not on the screen in front of you, and `selectedCount` is its " +
  "honest size. `accept-selected` and `decline-selected` both take the `plan` token that a " +
  "select verb returns beside its count: pass it back on the same turn, because a person " +
  "clicking a checkbox while you think is the ordinary case here and not a rare one. If the " +
  "person asked for something this app cannot select, say so rather than selecting something " +
  "near it.";

/**
 * The cross-screen job, declared as a recipe rather than written in prose.
 *
 * This is the job the whole demo exists to exercise, and until `flows` existed
 * there was nowhere to say it: the five verbs were all declared and nothing
 * said they went together in that order, so every agent re-derived the
 * sequence and the ones that got it slightly wrong — committing before reading
 * the count — got it wrong invisibly. It used to be a paragraph in the
 * README, which is to say it was somewhere no model reads.
 *
 * NOTHING CALLS THIS. There is no `accept-a-companys-pending-contacts` tool,
 * and that is the design: step four reports a number, and what to do about a
 * number that is not what the person asked for is a judgement, not a branch.
 * An engine running these five would either accept 112 rows or stop, both
 * without saying why. The agent reads the recipe and keeps the judgement.
 *
 * `goto` is named like any other verb, because by the time the flow is checked
 * it is one: the core added it from `screens` and `navigate`, and `mount()`
 * throws if a step names a verb that does not exist.
 */
const FLOWS = [
  {
    id: "accept-a-companys-pending-contacts",
    describe:
      "accept the contacts a company has waiting: find the company, look at what is pending " +
      "there, check how many, and accept them",
    steps: [
      // The two steps of this phase are the ones that are NOT always needed,
      // and `skipWhen` is where that now gets said. It used to be a clause in
      // the middle of step one's hint — "If the person named the company, you
      // can skip straight to `open-company`" — which is prose about the SHAPE
      // of the recipe hidden inside prose about what `goto` is for, so a reader
      // could not tell from the structure which of these five steps carry the
      // job. The condition is a sentence because nothing evaluates it: whether
      // the person named the company is a judgement about what was ASKED, and
      // no predicate over this app's state could answer it. That is the honest
      // half of conditions, and the enforced half is elsewhere — the count this
      // flow turns on is gated by `consumes: "plan"` and by the approval hook,
      // where the core holds it instead of the reader.
      {
        section: "find the company",
        verb: "goto",
        skipWhen: "the person already named the company, in which case go straight to `open-company`",
        hint: "`goto(screen: \"companies\")`. This step is for finding which company it is.",
      },
      {
        section: "find the company",
        verb: "sort-companies",
        skipWhen: "you already know which company you want",
        hint: "sort by `pending` so the companies with work waiting are at the top. The rows "
          + "carry the count per company, so this is also how you answer \"who has the most?\".",
      },
      {
        section: "look at what is waiting",
        verb: "open-company",
        hint: "open it by name. Its contact list opens on the pending tab, which is the one "
          + "this job is about.",
      },
      {
        section: "check the number before anything changes",
        verb: "select-pending-here",
        hint: "selects every pending contact of this company and reports the `count`. READ "
          + "THAT COUNT. It is the number of rows the next step will change, and it is "
          + "usually larger than the twenty you can see.",
      },
      {
        section: "check the number before anything changes",
        verb: "accept-selected",
        hint: "takes no filter and acts on the selection, so the count you just read is what "
          + "moves. If that count is not what the person asked for, stop and say so instead "
          + "of calling this.",
      },
    ],
  },
];

/**
 * Build a fresh store and a driver over it.
 *
 * @param {() => void} [onChange] called after every mutation, once `rev` has
 *   moved. The page redraws, syncs the address bar and pushes a snapshot to
 *   the relay from here.
 * @param {{ approve?: import("driverkit").ApprovalPolicy, approvalTimeout?: number,
 *           elsewhere?: import("driverkit").ElsewhereChannel,
 *           onAudit?: import("driverkit").AuditHook }} [options] who
 *   approves a commit and where the records go, passed straight through to
 *   `mount()`.
 *
 *   It is an argument rather than a constant in here because the answer is not
 *   the app's to give: this module is the store and the verb table, and WHO IS
 *   WATCHING is a property of the embedding. `app.js` wires the chat panel's
 *   own dialog, so a commit arriving over the relay renders the same question
 *   the person would have seen in the panel; `check.mjs` wires a policy of its
 *   own, because a test harness has nobody to ask.
 *
 *   Six of this app's commits have not declared `reversible`, so `connect()`
 *   refuses to publish this driver to a relay without one of the two. That is
 *   the point of the field: an agent in another process changing data with
 *   nothing in front of it is now a configuration somebody has to write down.
 */
export function createApp(onChange = () => {}, options = {}) {
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

  /** Whichever list the current screen pages through, or null on a screen with
   *  no list. The two screens named here are exactly the two `next-page` and
   *  `prev-page` declare, and the core refuses those verbs anywhere else — so
   *  the null branch is now unreachable through a verb and is kept only
   *  because `windowRows` and `pageCount` are also called while rendering the
   *  other four screens. */
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

  /**
   * `selectedCount` and `selectionId`, for every screen, from one place.
   *
   * Six screens build six snapshots and each one of them has to say the same
   * two things about the selection, which is the whole argument for this being
   * a function: a selection fingerprint that five screens publish and the
   * sixth forgets is a plan token that silently stops checking anything the
   * moment the person navigates. One place, so there is one answer.
   *
   * BOTH are published even when nothing is selected, and `selectedCount: 0`
   * is a change from what this app used to send. It used to omit the count for
   * an empty selection to save the bytes, and the type is explicit that an
   * absent one means "I DO NOT COUNT" rather than "none" — which was a small
   * lie, because this app counts perfectly well, and it cost something real:
   * the core cannot tell an agent "nothing is selected, so there is nothing for
   * a plan to be taken on" from a field that is not there. That sentence is the
   * difference between an agent asking the person and an agent going off to
   * select something so the commit has rows to run on, which is the failure an
   * eval caught. Two bytes for that is a bargain.
   *
   * `selectionId()` comes from the core rather than being hand-rolled here.
   * This app has the Set in hand and could hash it in a line, and that line is
   * where it would go wrong — `[...set].join(",")` is order-dependent, so
   * ticking the same two rows in the other order would read as a different
   * selection and refuse every commit. Hashing a few hundred ids inside
   * `visible()` is cheap; an app selecting tens of thousands would keep a
   * running value instead.
   */
  function selectionFields() {
    return { selectedCount: store.selected.size, selectionId: selectionId(store.selected) };
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
   * EVERY SCREEN FILLS IN BOTH `screen` AND `where`, and they are not two
   * spellings of one thing. `screen` is the stable kebab-case id — the same
   * string `Verb.screen` is matched against, comparable with `===`, and the
   * only honest answer to "did I navigate?". `where` is prose for a human and
   * carries everything else the person can see: the filter, the sort, the
   * status tab, and on a drill-down a sentence about the record that is open.
   * It changes constantly for reasons that are not navigation, which is why
   * diffing it was never an answer and why identity moved out of it.
   *
   * ONE HONEST COMPROMISE, written down because it is a gap in the `Snapshot`
   * type and not a shortcut here.
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
   * A record screen's own fields ride in `where` as well, and that one is no
   * longer a compromise. There is still no field in `Snapshot` for "the thing
   * I drilled into" — `rows` is a list of records and the open contact is not
   * one of its own history events, and putting it there produces the ragged
   * thirteen-column table full of dashes that the renderer makes of a union of
   * row keys. But `where` is documented as prose about what the person can
   * see, and the fields of the record they are looking at are exactly that.
   * What used to be wrong about it was that `where` was also carrying the
   * screen's identity; `screen` carries that now.
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
        screen: "dashboard",
        where: "the dashboard: seven metric tiles rolled up from the whole table",
        rev: store.rev,
        rows: [
          { id: "contacts", metric: "contacts in all", value: TOTAL },
          { id: "companies", metric: "companies", value: COMPANIES.length },
          ...STATUSES.map((s) => ({ id: s, metric: `contacts ${s}`, value: byStatus[s] })),
          { id: "pipeline", metric: "open pipeline, USD", value: pipeline },
          { id: "hottest", metric: "most pending", value: `${hottest.name} (${hottest.pending})` },
        ],
        ...selectionFields(),
        note:
          "this screen is a dashboard, not a table: each row above is one metric tile and " +
          "`id` names the tile, not a record." +
          // Only the half no field holds: that the selection was made on
          // ANOTHER screen and still reaches a commit verb from here. The
          // empty case used to be spelled out beside it — "nothing is selected
          // anywhere, so a commit verb that acts on the selection has nothing
          // to act on" — and that was this app patching a library defect at
          // the wrong layer, as the person who wrote it said at the time. `renderSnapshot` now prints "selected: none (0 rows; this
          // screen counts the selection)" off `selectedCount` itself, for
          // every app that mounts driverkit rather than for this one.
          (store.selected.size
            ? ` ${store.selected.size} contacts are still selected from another screen and a ` +
              "commit verb would act on them from here."
            : ""),
      };
    },

    /** The contacts list. The screen the first version of this demo was. */
    contacts() {
      const all = filtered();
      const visibleRows = windowRows();
      const q = store.query.trim();
      const onScreen = visibleRows.filter((r) => store.selected.has(r.id)).map((r) => r.id);

      return {
        screen: "contacts",
        where: q
          ? `the contacts list, filtered to “${q}” (${all.length} of ${TOTAL} rows match)`
          : `the contacts list, unfiltered (${TOTAL} rows)`,
        rev: store.rev,
        rows: visibleRows.map((r) => ({
          id: r.id,
          name: r.name,
          company: r.company,
          status: r.status,
        })),
        page: { index: store.page, size: pageSize(), total: all.length },
        ...(onScreen.length ? { selected: onScreen } : {}),
        ...selectionFields(),
        ...(store.selected.size > onScreen.length
          ? {
              note:
                "a commit verb acts on the whole selection, not just the rows on this page",
            }
          : {}),
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
          screen: "contact",
          where: `no such contact — nothing here has the id \`${store.route.id}\``,
          rev: store.rev,
          note: `there is no contact with id \`${store.route.id}\`.`,
        };
      }
      const events = historyFor(open.id);
      return {
        screen: "contact",
        where:
          `${open.name} (${open.id}), ${open.title} at ${open.company}; ` +
          `status ${open.status}; owner ${open.owner}; ${open.email}; ` +
          `added ${open.added}; deal value ${open.value}`,
        rev: store.rev,
        rows: events.map((e) => ({ id: e.id, when: e.when, what: e.what, who: e.who })),
        ...selectionFields(),
        note:
          "the rows above are this contact's activity history, oldest first — they are not " +
          "contacts. `set-status` and `assign-owner` act on this record and take no id." +
          (store.selected.size
            ? ` ${store.selected.size} contacts are selected elsewhere; a commit verb acting ` +
              "on the selection would not touch this record unless it is one of them."
            : ""),
      };
    },

    /** The companies list. Eight rows, no paging, sortable. */
    companies() {
      return {
        screen: "companies",
        where: `the companies list, ${store.companies.length} rows sorted by ${store.sortBy}`,
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
        ...selectionFields(),
        note:
          "`id` is the company's slug, which is what the URL uses; `open-company` takes the " +
          "`name`." +
          (store.selected.size
            ? ` ${store.selected.size} contacts are selected on another screen and a commit ` +
              "verb would act on them from here."
            : ""),
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
          screen: "company",
          where: `no such company — nothing here has the slug \`${store.route.id}\``,
          rev: store.rev,
          note: `there is no company with slug \`${store.route.id}\`.`,
        };
      }
      const all = companyRows();
      const visibleRows = windowRows();
      const onScreen = visibleRows.filter((r) => store.selected.has(r.id)).map((r) => r.id);

      return {
        screen: "company",
        where:
          `${open.name} — ${open.tier}, ${open.region}, lead ${open.lead}; ` +
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
        ...selectionFields(),
        note:
          "the rows are this company's contacts under the current status tab. " +
          "`select-pending-here` selects every pending contact at this company in one call and " +
          "reports the count." +
          (store.selected.size > onScreen.length
            ? " a commit verb acts on the whole selection, which reaches past this page and " +
              "past this company."
            : ""),
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
        screen: "settings",
        where: "the settings form: four inputs, each with its current value",
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
        ...selectionFields(),
        note:
          "this screen is a form, not a table: each row is one input, `id` is the setting to " +
          "pass to `set-setting`, `value` is what the box says now and `accepts` is what it " +
          "will take.",
      };
    },
  };

  /** The dispatch. One `visible()` for the whole app is what the core takes. */
  function visible() {
    const screen = screens[store.route.screen];
    return screen ? screen() : screens.dashboard();
  }

  // ---- the verbs ---------------------------------------------------------

  const driver = mount({
    app: "Northwind CRM",
    // Absent unless the embedding gave one, so this file still produces the
    // driver it produced before the gate existed when nobody says otherwise.
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.approvalTimeout === undefined
      ? {}
      : { approvalTimeout: options.approvalTimeout }),
    // The cross-tab commit channel, when the embedding passed one. Absent
    // otherwise, for the reason above: this file still produces the driver it
    // produced before the channel existed when nobody says otherwise, and
    // `check.mjs` mounts without one.
    //
    // This demo is the hazard in its purest form, which is why the browser
    // test wires it: every tab builds its OWN 3,412 contacts, so a commit in
    // one tab changes nothing in the other's store and the other's `rev` does
    // not move. Without a channel the second tab reports accepted rows as
    // `new`, at a `rev` that passes every staleness check there is.
    ...(options.elsewhere === undefined ? {} : { elsewhere: options.elsewhere }),
    // Where this driver's audit records go, when the embedding wants them.
    // Absent otherwise, for the reason the three above are: an app that passes
    // no hook behaves byte-identically to one mounted before `onAudit` existed.
    // The interesting case to wire it for is a page that mounts the panel and
    // declares no `approve`: the panel installs its dialog as the core's
    // approver, so the record says `approval: "allowed", policy: "adopted"`
    // for a commit a person clicked Approve on — which it could not say when
    // the dialog gated outside `call()`.
    ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
    // Said once, in the cached half, and read by both ways in. See
    // `INSTRUCTIONS` for why it is no longer pasted into every snapshot.
    instructions: INSTRUCTIONS,
    visible,
    // The app's map, straight out of the router. Not retyped here: see
    // `SCREEN_SPECS` in `router.js` for why the declaration lives beside
    // `href()` and not beside the verbs.
    screens: SCREEN_SPECS,
    /**
     * How this app navigates. The body of the core's reserved `goto`.
     *
     * The core has no router and will not guess at one, so this three-line
     * function is the whole of what the app had to supply to replace its own
     * `go` verb — and what it got back is a verb with the same name, the same
     * arguments and the same refusals as every other driverkit app that
     * declares a map, instead of a `go` that only this app's agents have ever
     * heard of.
     *
     * `navigate` here is the store's own function a few dozen lines up; the
     * key is the hook and the call inside it is the app's. The two record
     * screens are refused rather than navigated to when the record does not
     * exist, which is the hook's other job: a per-call, per-user "no" with a
     * reason, which is where such a no belongs — `screens` itself must list
     * all six for everybody, or an agent cannot tell a screen it may not open
     * from a screen that is not there.
     */
    navigate: ({ screen, args }, ctx) => {
      if (screen === "contact" && !contact(String(args.id))) {
        return ctx.refuse(
          "no-such-contact",
          `there is no contact with id \`${args.id}\`. Ids run from c-0001 to c-${TOTAL}.`,
        );
      }
      if (screen === "company" && !company(String(args.slug))) {
        return ctx.refuse(
          "no-such-company",
          `there is no company with the slug \`${args.slug}\`. The eight are ` +
            `${store.companies.map((c) => c.id).join(", ")} — or call \`open-company\`, ` +
            `which takes the name as it is written.`,
        );
      }
      navigate({ screen, id: args.id ?? args.slug ?? null });
    },
    // The recipe, not an engine. See `FLOWS`.
    flows: FLOWS,
    verbs: [
      // ---- getting about ------------------------------------------------
      //
      // THE `go` VERB USED TO BE HERE. It took one of the four landing screens
      // from a hand-written `oneOf`, called the store's `navigate`, and was
      // named `go` because that is what this author typed — while the app next
      // door named the same verb `navigate` or `open-screen` or `route-to`,
      // and an agent that had learned one did not recognise the next. The core
      // offers `goto` now, built from `screens` and the `navigate` hook above,
      // and it is strictly more than `go` was: all six screens instead of four
      // (`goto("contact", { id: "c-0184" })` works, because a screen's own
      // arguments become the verb's), the url template expanded for whoever
      // wants to paste it, and a refusal that lists the screens when the id is
      // wrong. What was lost is the `at: ".nav"` outline the widget used to
      // draw on the navigation bar: `ScreenSpec` has no `at`, and inventing
      // one here would be the app guessing at a library field.
      //
      // `open-contact` and `open-company` STAY, and they are not duplicates of
      // `goto`. `open-company` takes the company's NAME as a person writes it,
      // out of an eight-value `oneOf`, and does the slug conversion itself —
      // `goto` takes the slug, because a url template takes what goes in the
      // url. A verb surface in the user's own vocabulary is the point of the
      // whole library, so the app keeps the verb that speaks it; what it no
      // longer keeps is the generic one it had to write itself.
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
        // `read`, unambiguously now. `describe` used to say it was for a verb
        // that changes what is "SELECTED or FILTERED", and by that sentence
        // this was a `describe` — while none of the rest of what `describe`
        // means applied: it reports no count, so there is no number a
        // following commit turns on, and the count/commit pair is the whole
        // safety mechanism. The two words came apart and `read` is the honest
        // one: it narrows a list and leaves nothing pending.
        kind: "read",
        screen: "contacts",
        describe: "filter the contacts list by a search term, the way typing in the box does",
        at: "#q",
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
        name: "next-page",
        kind: "read",
        // BOTH the screens that page, which is the shape `Verb.screen` grew
        // for. This verb used to declare no screen and refuse an invented
        // `no-pages-here`, because one string could not say "the contacts list
        // and a company's contact list" and naming either would have refused a
        // call on a screen still publishing a `page` block. Now the mapping is
        // in the cached half where an agent reads it before calling, and the
        // core's `wrong-screen` names the live screen and both of these.
        //
        // The app's own predicate went with the slug, and it could because the
        // two questions turned out to have the same answer here: the screens
        // that page are exactly these two, so "does this list page" was only
        // ever "are you on one of them" spelled in the app's words.
        screen: ["contacts", "company"],
        describe:
          "show the next page of whichever list you are on. The contacts list and a " +
          "company's contact list have pages; no other screen does.",
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
        // Both screens, for the reason on `next-page` above.
        screen: ["contacts", "company"],
        describe:
          "show the previous page of whichever list you are on. The contacts list and a " +
          "company's contact list have pages; no other screen does.",
        refuses: ["at-first-page"],
        run: (_args, ctx) => {
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
        screen: "companies",
        describe: "reorder the companies list",
        at: ".table",
        args: {
          by: {
            type: "string",
            describe: "the column to sort by. Everything but `name` sorts highest first.",
            oneOf: ["name", "contacts", "new", "pending", "accepted"],
          },
        },
        run: ({ by }) => {
          store.sortBy = by;
          bump();
        },
      },

      {
        name: "show-status",
        kind: "read",
        screen: "company",
        describe: "switch which status tab of a company's contacts is listed",
        args: {
          status: {
            type: "string",
            describe: "the status to list, or `all` for every status",
            oneOf: [...STATUSES, "all"],
          },
        },
        run: ({ status }) => {
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
          "select every contact at one company, optionally only those with one status, and " +
          "report HOW MANY there are. This is also the verb that answers a `how many` " +
          "question: one call from any screen, no navigating and nothing to read off a " +
          "table, and the `count` it returns is the answer. It matches across the whole " +
          "table and not just the page or the screen you are on, and replaces any existing " +
          "selection.",
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
        screen: "company",
        describe:
          "select every pending contact at THIS company in one call and report how many. The " +
          "company is the one whose screen you are on.",
        refuses: ["nothing-pending"],
        run: (_args, ctx) => {
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
        // The verb the plan token was built for, and the one this demo exists
        // to make the case with. Accepting the selection is the irreversible
        // bulk act in this app: `select-where(Grayson Robotics)` matches 410
        // rows, the agent reads 410, a person approves 410 — and before this,
        // the only thing that connected that number to the rows that actually
        // changed was that the two calls happened close together. A click on a
        // checkbox in between, or a `snapshot` frame landing, and the commit
        // accepted a set nobody had counted. Now it cannot: the token binds the
        // `rev` and the selection's identity, and a commit presented with a
        // stale one is refused with both numbers named. Navigating does not
        // spend it -- every screen in here publishes a `selectionId`, so an
        // agent that goes back to the companies list to check which company it
        // opened arrives at the commit with its receipt intact.
        //
        // `decline-selected` deliberately does NOT declare this, and the
        // contrast is the point rather than an oversight: a verb that has not
        // adopted the field behaves exactly as it did, which is what makes this
        // a feature an app can take up one commit at a time instead of a
        // migration it has to finish.
        consumes: "plan",
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
        // The sibling, and the reason this is not optional once `accept-selected`
        // has it. An eval asked this app to "archive everyone who has not
        // replied in six months" — a job it cannot do — and the agent
        // improvised: `select-where(Halloway Foods)`, then THIS verb, and 403
        // rows changed status with no plan, no count read and nothing gated. It
        // reached for the ungated one precisely because it was improvising.
        //
        // So the rule is all or none: a guarantee is only as strong as the
        // least-declared commit that acts on the same ambient state, and an
        // agent that is off its intended path will find that one. See
        // `Verb.consumes`, where this is now stated as a rule rather than left
        // to each app, and `mount()`, which warns about exactly this shape.
        consumes: "plan",
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
        // `commit`, because it changes stored state that outlives the screen,
        // and `reversible` because every one of the four settings is one call
        // to put back: `set-setting` with the old value, which the settings
        // screen reports in each row's `value`. Nothing is written anywhere
        // else and nothing else depends on the previous value.
        //
        // This verb is the motivating example for the flag. It and accepting
        // 3,412 contacts were both just `commit`, so both were shouted about
        // in identical capitals — and a banner that fires on a page-size
        // change is a banner a model learns to read past, the same way a
        // person learns to click Yes without reading. `reversible` is a claim
        // that there is a way back, not that nobody minds: the page size still
        // changes and the person still sees it.
        kind: "commit",
        reversible: true,
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
