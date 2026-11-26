/**
 * The DOM, one function per screen.
 *
 * Everything in here reads the store and writes elements; nothing in here
 * decides anything. The route, the filters, the selection and the settings all
 * live in `store.js`, which is why `check.mjs` can walk every one of these
 * screens with no browser in the picture — this file is the only part of the
 * demo that a headless harness cannot run, so it is the only part that has to
 * be free of rules.
 *
 * Each screen is rebuilt from scratch on every change rather than patched.
 * Three thousand rows never reach the DOM — twenty do, or whatever the
 * settings screen says — so the cheap thing and the simple thing are the same
 * thing here, and a renderer with no incremental path cannot drift out of step
 * with the snapshot the agent is being shown.
 *
 * The one rule: **a screen draws what `visible()` claims is on it.** If the
 * table shows a column the snapshot does not carry, an agent is driving a
 * screen that is not the one the person is looking at, and every refusal after
 * that is unexplainable.
 */

import { OWNERS, PAGE_SIZES, STATUSES } from "./store.js";
import { href } from "./router.js";

const n = (/** @type {number} */ x) => x.toLocaleString("en-US");
const money = (/** @type {number} */ x) => `$${x.toLocaleString("en-US")}`;

/**
 * `el("button.btn.btn-primary", { onclick }, "Accept")`.
 *
 * Hand-rolled and twelve lines, because the alternative in a no-build demo is
 * `innerHTML` with app data interpolated into it, and the first contact named
 * `O'Hara & Sons` would have been an injection bug in a file whose whole job
 * is to be read as an example.
 *
 * @param {string} spec tag, then `.class` parts
 * @param {Record<string, any> | null} [attrs]
 * @param {...(Node | string | null | undefined | (Node | string)[])} kids
 */
function el(spec, attrs, ...kids) {
  const [tag, ...classes] = spec.split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "html") {
      throw new Error("no");
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined) continue;
    node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

/** A status pill, which is the one piece of chrome every screen shares. */
function pill(status) {
  return el("span.pill", { "data-status": status, text: status });
}

/** The header every screen opens with: a title, a subtitle, and a slot. */
function head(title, sub, ...actions) {
  return el(
    "header.head",
    null,
    el("div", null, el("h1", { text: title }), el("p.sub", { text: sub })),
    actions.length ? el("div.head-actions", null, ...actions) : null,
  );
}

/**
 * The selection bar.
 *
 * On every screen that can select contacts, and it shows `selected.size` —
 * the whole selection, not the part on this page. That number is the one the
 * widget's commit gate quotes and the one `Snapshot.selectedCount` carries, so
 * a person and an agent are looking at the same figure. A bar that counted
 * only the rows in front of the person would disagree with the prompt.
 */
function selbar(app) {
  const { store, bump, applyToSelection } = app;
  const picked = store.selected.size;
  return el(
    "div.selbar",
    { "data-empty": picked === 0 ? "true" : "false", id: "selbar" },
    el("span.selcount", {
      id: "selcount",
      text:
        picked === 0
          ? "No contacts selected"
          : `${n(picked)} contact${picked === 1 ? "" : "s"} selected`,
    }),
    el(
      "div.selbar-actions",
      null,
      el("button.btn.btn-quiet", {
        type: "button",
        id: "clear-sel",
        disabled: picked === 0,
        text: "Clear",
        onclick: () => {
          store.selected.clear();
          bump();
        },
      }),
      el("button.btn.btn-quiet", {
        type: "button",
        id: "decline-sel",
        disabled: picked === 0,
        text: "Decline",
        onclick: () => {
          applyToSelection("declined");
          bump();
        },
      }),
      el("button.btn.btn-primary", {
        type: "button",
        id: "accept-sel",
        disabled: picked === 0,
        text: "Accept selected",
        onclick: () => {
          applyToSelection("accepted");
          bump();
        },
      }),
    ),
  );
}

/** The pager, shown on the two screens that page. */
function pager(app) {
  const { store, bump, pageCount, pageSize, pagedRows, windowRows } = app;
  const all = pagedRows() ?? [];
  const rows = windowRows();
  const first = rows.length ? store.page * pageSize() + 1 : 0;
  return el(
    "footer.pager",
    null,
    el("span.range", {
      id: "range",
      text: rows.length
        ? `${n(first)}–${n(first + rows.length - 1)} of ${n(all.length)}`
        : `0 of ${n(all.length)}`,
    }),
    el(
      "div.pager-buttons",
      null,
      el("button.btn.btn-quiet", {
        type: "button",
        id: "prev",
        disabled: store.page === 0,
        text: "Previous",
        onclick: () => {
          if (store.page > 0) {
            store.page -= 1;
            bump();
          }
        },
      }),
      el("button.btn.btn-quiet", {
        type: "button",
        id: "next",
        disabled: store.page >= pageCount() - 1,
        text: "Next",
        onclick: () => {
          if (store.page < pageCount() - 1) {
            store.page += 1;
            bump();
          }
        },
      }),
    ),
  );
}

/**
 * A table of contacts, with checkboxes and a name that drills down.
 *
 * Shared by the contacts list and a company's screen, because they are the
 * same table over two different row sets. The name is an `<a href>` and not a
 * button: a contact has a URL in this app and a drill-down the person cannot
 * copy a link to is not a screen, it is a panel.
 *
 * @param {object} app
 * @param {Array<any>} rows
 * @param {string[]} columns which of name/company/title/status/owner to show
 */
function contactTable(app, rows, columns) {
  const { store, bump } = app;

  const headers = [
    el("th.col-check", { scope: "col" }, el("span.vh", { text: "Selected" })),
    el("th.col-id", { scope: "col", text: "ID" }),
    ...columns.map((c) =>
      el(c === "status" ? "th.col-status" : "th", { scope: "col", text: c }),
    ),
  ];

  const body = rows.map((row) => {
    const cells = columns.map((column) => {
      if (column === "status") return el("td", null, pill(row.status));
      if (column === "name") {
        return el(
          "td.cell-name",
          null,
          el("a.name-link", { href: href({ screen: "contact", id: row.id }), text: row.name }),
        );
      }
      return el("td", { text: String(row[column] ?? "—") });
    });

    const box = el("input", {
      type: "checkbox",
      "aria-label": `Select ${row.name}`,
      onchange: (event) => {
        if (event.target.checked) store.selected.add(row.id);
        else store.selected.delete(row.id);
        bump();
      },
    });
    box.checked = store.selected.has(row.id);

    return el(
      "tr",
      { "data-selected": store.selected.has(row.id) ? "true" : "false" },
      el("td", null, box),
      el("td.cell-id", { text: row.id }),
      ...cells,
    );
  });

  return el(
    "div.tablewrap",
    { "data-dense": store.settings.denseRows ? "true" : "false" },
    el(
      "table.table",
      null,
      el("thead", null, el("tr", null, ...headers)),
      el("tbody", { id: "rows" }, ...body),
    ),
    rows.length ? null : el("p.empty", { id: "empty", text: "Nothing matches that filter." }),
  );
}

// ---- the six screens -----------------------------------------------------

/**
 * The dashboard: tiles and a bar chart, and not one table row.
 *
 * It is here because a library that only handles tables is not a library, and
 * because this is the screen whose snapshot is least honest — see
 * `screens.dashboard` in `store.js`, where seven metric tiles have to leave as
 * `rows` with an `id` each.
 */
function dashboard(app) {
  const { store } = app;
  const snapshot = app.screens.dashboard();
  const byId = Object.fromEntries(snapshot.rows.map((r) => [r.id, r.value]));
  const most = Math.max(...STATUSES.map((s) => Number(byId[s])));

  return [
    head("Dashboard", `${n(Number(byId.contacts))} contacts across ${byId.companies} companies`),
    el(
      "div.tiles",
      null,
      el(
        "div.tile",
        null,
        el("span.tile-label", { text: "open pipeline" }),
        el("strong.tile-value", { text: money(Number(byId.pipeline)) }),
        el("span.tile-foot", { text: "new and pending contacts" }),
      ),
      ...STATUSES.map((status) =>
        el(
          "div.tile",
          null,
          el("span.tile-label", { text: status }),
          el("strong.tile-value", { text: n(Number(byId[status])) }),
          el("span.tile-foot", null, pill(status)),
        ),
      ),
    ),
    el(
      "section.panel",
      null,
      el("h2", { text: "Pipeline by stage" }),
      el(
        "div.bars",
        null,
        ...STATUSES.map((status) =>
          el(
            "div.bar-row",
            null,
            el("span.bar-label", { text: status }),
            el(
              "div.bar-track",
              null,
              el("div.bar-fill", {
                "data-status": status,
                style: `width:${(Number(byId[status]) / most) * 100}%`,
              }),
            ),
            el("span.bar-value", { text: n(Number(byId[status])) }),
          ),
        ),
      ),
    ),
    el(
      "section.panel",
      null,
      el("h2", { text: "Most pending" }),
      el("p.lead", { text: String(byId.hottest) }),
      el(
        "div.panel-actions",
        null,
        el("a.btn.btn-primary", { href: "#/companies", text: "Open companies" }),
        store.selected.size
          ? el("span.warn", {
              text: `${n(store.selected.size)} contacts are still selected elsewhere`,
            })
          : null,
      ),
    ),
  ];
}

/** The contacts list: the screen this demo used to be, unchanged in substance. */
function contacts(app) {
  const { store, bump, filtered, windowRows } = app;
  const all = filtered();
  const q = store.query.trim();

  const search = el("label.search", { for: "q" }, el("span.search-icon", { "aria-hidden": "true", text: "⌕" }));
  const input = el("input", {
    id: "q",
    type: "search",
    autocomplete: "off",
    placeholder: "Search name, company, status or id",
    "aria-label": "Search contacts",
    oninput: (event) => {
      store.query = event.target.value;
      store.page = 0;
      bump();
    },
  });
  input.value = store.query;
  search.append(input);

  return [
    head(
      "Contacts",
      q ? `${n(all.length)} of ${n(store.rows.length)} contacts match “${q}”` : `${n(store.rows.length)} contacts`,
      search,
    ),
    selbar(app),
    contactTable(app, windowRows(), ["name", "company", "status"]),
    pager(app),
  ];
}

/**
 * One contact's screen: the drill-down.
 *
 * Deep-linkable, which is the point: `#/contacts/c-0184` pasted cold lands
 * here with the same history, because `historyFor` is seeded from the id and
 * nothing else.
 */
function contact(app) {
  const { store, bump, openContact, historyFor } = app;
  const open = openContact();

  if (!open) {
    return [
      head("Contact", `no contact with id ${store.route.id}`),
      el(
        "section.panel",
        null,
        el("p.lead", { text: "That id is not in this table. Ids run from c-0001 to c-3412." }),
        el("a.btn.btn-primary", { href: "#/contacts", text: "Back to contacts" }),
      ),
    ];
  }

  const field = (label, value) => el("div.field", null, el("dt", { text: label }), el("dd", { text: value }));

  return [
    el(
      "nav.crumbs",
      null,
      el("a", { href: "#/contacts", text: "Contacts" }),
      el("span", { text: "/" }),
      el("a", {
        href: href({ screen: "company", id: open.company.toLowerCase().replace(/[^a-z0-9]+/g, "-") }),
        text: open.company,
      }),
      el("span", { text: "/" }),
      el("span", { text: open.id }),
    ),
    head(open.name, `${open.title} at ${open.company}`, pill(open.status)),
    el(
      "section.panel",
      null,
      el(
        "dl.fields",
        null,
        field("ID", open.id),
        field("Email", open.email),
        field("Owner", open.owner),
        field("Added", open.added),
        field("Deal value", money(open.value)),
      ),
      el(
        "div.panel-actions",
        null,
        el("span.action-label", { text: "Set status" }),
        ...STATUSES.map((status) =>
          el("button.btn.btn-quiet", {
            type: "button",
            disabled: open.status === status,
            text: status,
            onclick: () => {
              open.status = status;
              app.reroll();
              bump();
            },
          }),
        ),
      ),
      el(
        "div.panel-actions",
        null,
        el("span.action-label", { text: "Owner" }),
        ...OWNERS.map((owner) =>
          el("button.btn.btn-quiet", {
            type: "button",
            disabled: open.owner === owner,
            text: owner,
            onclick: () => {
              open.owner = owner;
              bump();
            },
          }),
        ),
      ),
    ),
    el(
      "section.panel",
      null,
      el("h2", { text: "History" }),
      el(
        "ol.timeline",
        null,
        ...historyFor(open.id).map((event) =>
          el(
            "li",
            null,
            el("span.when", { text: event.when }),
            el("span.what", { text: event.what }),
            el("span.who", { text: event.who }),
          ),
        ),
      ),
    ),
  ];
}

/** The companies list: eight rows, sortable, every name a drill-down. */
function companies(app) {
  const { store, bump, sortedCompanies } = app;
  const columns = [
    ["name", "Company"],
    ["tier", "Tier"],
    ["contacts", "Contacts"],
    ["new", "New"],
    ["pending", "Pending"],
    ["accepted", "Accepted"],
  ];

  return [
    head("Companies", `${store.companies.length} companies, sorted by ${store.sortBy}`),
    el(
      "div.tablewrap",
      null,
      el(
        "table.table",
        null,
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            ...columns.map(([key, label]) =>
              el(
                "th",
                { scope: "col", "data-sorted": store.sortBy === key ? "true" : "false" },
                // The header is the sort control, which is what
                // `sort-companies` drives. One behaviour, two ways in.
                el("button.sort", {
                  type: "button",
                  text: label,
                  onclick: () => {
                    store.sortBy = key;
                    bump();
                  },
                }),
              ),
            ),
          ),
        ),
        el(
          "tbody",
          null,
          ...sortedCompanies().map((company) =>
            el(
              "tr",
              null,
              el(
                "td.cell-name",
                null,
                el("a.name-link", {
                  href: href({ screen: "company", id: company.id }),
                  text: company.name,
                }),
              ),
              el("td", { text: company.tier }),
              el("td", { text: n(company.contacts) }),
              el("td", { text: n(company.new) }),
              el("td.strong", { text: n(company.pending) }),
              el("td", { text: n(company.accepted) }),
            ),
          ),
        ),
      ),
    ),
  ];
}

/**
 * One company's screen, and the screen the multi-step job ends on: its
 * contacts, tabbed by status, selectable, acceptable.
 */
function company(app) {
  const { store, bump, openCompany, companyRows, windowRows } = app;
  const open = openCompany();

  if (!open) {
    return [
      head("Company", `no company with slug ${store.route.id}`),
      el(
        "section.panel",
        null,
        el("p.lead", { text: "That company is not in this CRM." }),
        el("a.btn.btn-primary", { href: "#/companies", text: "Back to companies" }),
      ),
    ];
  }

  const tabs = ["all", ...STATUSES].map((status) =>
    el("button.tab", {
      type: "button",
      "data-on": store.statusTab === status ? "true" : "false",
      text: status === "all" ? `all (${open.contacts})` : `${status} (${open[status]})`,
      onclick: () => {
        store.statusTab = status;
        store.page = 0;
        bump();
      },
    }),
  );

  return [
    el(
      "nav.crumbs",
      null,
      el("a", { href: "#/companies", text: "Companies" }),
      el("span", { text: "/" }),
      el("span", { text: open.name }),
    ),
    head(
      open.name,
      `${open.tier} · ${open.region} · lead ${open.lead} · ${n(open.contacts)} contacts · ` +
        `${money(open.value)} open`,
    ),
    el(
      "section.panel.panel-tight",
      null,
      el("div.tabs", null, ...tabs),
      el(
        "div.panel-actions",
        null,
        el("button.btn.btn-primary", {
          type: "button",
          disabled: open.pending === 0,
          text: `Select the ${open.pending} pending`,
          onclick: () => {
            store.selected.clear();
            for (const row of store.rows) {
              if (row.company === open.name && row.status === "pending") store.selected.add(row.id);
            }
            bump();
          },
        }),
      ),
    ),
    selbar(app),
    contactTable(app, windowRows(), ["name", "title", "status", "owner"]),
    companyRows().length ? pager(app) : null,
  ];
}

/**
 * Settings: a form, and the screen that proves the library is not only about
 * tables. `rows per page` reaches into the two list screens, so a change here
 * is visible over there — which is the cheapest possible demonstration that
 * these are one app and not six.
 */
function settings(app) {
  const { store, bump } = app;
  const s = store.settings;

  const row = (label, hint, control) =>
    el(
      "div.form-row",
      null,
      el("div", null, el("span.form-label", { text: label }), el("span.form-hint", { text: hint })),
      control,
    );

  const select = (id, values, current, onpick) => {
    const node = el("select.input", {
      id,
      onchange: (event) => onpick(event.target.value),
    });
    for (const value of values) {
      const option = el("option", { value, text: value });
      if (String(current) === String(value)) option.selected = true;
      node.append(option);
    }
    return node;
  };

  const toggle = (id, on, onpick) => {
    const box = el("input", { id, type: "checkbox", onchange: (e) => onpick(e.target.checked) });
    box.checked = on;
    return el("label.switch", { for: id }, box, el("span", { text: on ? "on" : "off" }));
  };

  return [
    head("Settings", "four preferences, and one of them changes the tables"),
    el(
      "section.panel.form",
      null,
      row(
        "Rows per page",
        "how many rows the contacts list and a company's list show at once",
        select("set-rows-per-page", PAGE_SIZES, s.rowsPerPage, (value) => {
          s.rowsPerPage = Number(value);
          store.page = 0;
          bump();
        }),
      ),
      row(
        "Default owner",
        "who new contacts are assigned to",
        select("set-default-owner", OWNERS, s.defaultOwner, (value) => {
          s.defaultOwner = value;
          bump();
        }),
      ),
      row(
        "Confirm bulk accepts",
        "ask before a commit verb touches more than one row",
        toggle("set-confirm-bulk", s.confirmBulk, (on) => {
          s.confirmBulk = on;
          bump();
        }),
      ),
      row(
        "Dense rows",
        "tighter table rows",
        toggle("set-dense-rows", s.denseRows, (on) => {
          s.denseRows = on;
          bump();
        }),
      ),
    ),
  ];
}

const SCREENS = { dashboard, contacts, contact, companies, company, settings };

/**
 * Draw the current screen into `host`.
 *
 * Reads `store.route` and nothing else about where we are, which is the same
 * thing `visible()` reads. One source of truth for "which screen", so the
 * person and the agent cannot be looking at two different answers.
 *
 * @param {object} app the object `createApp` returned
 * @param {HTMLElement} host
 */
export function renderScreen(app, host) {
  const draw = SCREENS[app.store.route.screen] || dashboard;
  host.replaceChildren(...draw(app).filter(Boolean));
  host.dataset.screen = app.store.route.screen;
}
