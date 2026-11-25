/**
 * The Contacts demo: one screen, one driver, two ways in.
 *
 * `store.js` holds the store and the verb table. This file is the part that
 * touches the DOM: it draws the table, wires the human's controls, and then
 * opens BOTH of driverkit's paths over the one driver —
 *
 *   `mountWidget(driver, …)` — a chat panel in the corner of this page, which
 *       drives the app in-process with no transport at all.
 *   `connect(driver, { relay: "" })` — an SSE stream held open to the relay
 *       that this page's own server mounted at `/dk`, so an agent in another
 *       process drives the same screen through the same verbs.
 *
 * One page, both cases, and the point of the exercise: they are not two
 * integrations. Everything arrives at `driver.call()`, which is the only place
 * arguments are validated and `rev` is checked.
 *
 * Plain `.js` with JSDoc, importing the library's BUILT output from `dist/`.
 * The demo deliberately has no build step of its own, so the first thing that
 * had to work in a browser was the library rather than this file.
 */

import { mountWidget } from "../../../packages/widget/dist/widget.js";
import { connect } from "../../../packages/browser/dist/connect.js";
import { backendThink } from "../../../packages/agent/dist/backend.js";
import { createApp, PAGE_SIZE, TOTAL } from "./store.js";

/**
 * The relay connection. Declared before `createApp` because the change
 * callback notifies it, and it is opened after the driver exists.
 *
 * @type {{ changed: () => void, disconnect: () => void } | undefined}
 */
let connection;

const app = createApp(() => {
  render();
  connection?.changed();
});

const { driver, store, filtered, windowRows, pageCount, bump, acceptSelected } = app;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const n = (/** @type {number} */ x) => x.toLocaleString("en-US");

const els = {
  q: /** @type {HTMLInputElement} */ ($("q")),
  rows: $("rows"),
  empty: $("empty"),
  range: $("range"),
  sub: $("sub"),
  prev: /** @type {HTMLButtonElement} */ ($("prev")),
  next: /** @type {HTMLButtonElement} */ ($("next")),
  selbar: $("selbar"),
  selcount: $("selcount"),
  clearSel: /** @type {HTMLButtonElement} */ ($("clear-sel")),
  acceptSel: /** @type {HTMLButtonElement} */ ($("accept-sel")),
  detail: $("detail"),
  connDot: $("conn-dot"),
  connText: $("conn-text"),
};

// ---- rendering ----------------------------------------------------------

function render() {
  const all = filtered();
  const rows = windowRows();

  els.rows.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      tr.dataset.selected = store.selected.has(row.id) ? "true" : "false";

      const check = document.createElement("td");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = store.selected.has(row.id);
      box.setAttribute("aria-label", `Select ${row.name}`);
      box.addEventListener("change", () => {
        if (box.checked) store.selected.add(row.id);
        else store.selected.delete(row.id);
        bump();
      });
      check.appendChild(box);

      const id = document.createElement("td");
      id.className = "cell-id";
      id.textContent = row.id;

      const name = document.createElement("td");
      name.className = "cell-name";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "name-link";
      link.textContent = row.name;
      link.addEventListener("click", () => {
        store.openId = row.id;
        bump();
      });
      name.appendChild(link);

      const company = document.createElement("td");
      company.textContent = row.company;

      const status = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.dataset.status = row.status;
      pill.textContent = row.status;
      status.appendChild(pill);

      tr.append(check, id, name, company, status);
      return tr;
    }),
  );

  els.empty.hidden = rows.length > 0;

  const first = rows.length ? store.page * PAGE_SIZE + 1 : 0;
  els.range.textContent = rows.length
    ? `${n(first)}–${n(first + rows.length - 1)} of ${n(all.length)}`
    : `0 of ${n(all.length)}`;

  const q = store.query.trim();
  els.sub.textContent = q
    ? `${n(all.length)} of ${n(TOTAL)} contacts match “${q}”`
    : `${n(TOTAL)} contacts`;

  els.prev.disabled = store.page === 0;
  els.next.disabled = store.page >= pageCount() - 1;

  const picked = store.selected.size;
  els.selbar.dataset.empty = picked === 0 ? "true" : "false";
  els.selcount.textContent =
    picked === 0
      ? "No contacts selected"
      : `${n(picked)} contact${picked === 1 ? "" : "s"} selected`;
  els.clearSel.disabled = picked === 0;
  els.acceptSel.disabled = picked === 0;

  const open = store.openId ? store.rows.find((r) => r.id === store.openId) : undefined;
  els.detail.hidden = !open;
  if (open) {
    $("detail-name").textContent = open.name;
    $("detail-id").textContent = open.id;
    $("detail-company").textContent = open.company;
    $("detail-status").textContent = open.status;
    $("detail-owner").textContent = open.owner;
  }

  if (els.q.value !== store.query) els.q.value = store.query;
}

// ---- the human's controls -----------------------------------------------

els.q.addEventListener("input", () => {
  store.query = els.q.value;
  store.page = 0;
  bump();
});

els.prev.addEventListener("click", () => {
  if (store.page > 0) {
    store.page -= 1;
    bump();
  }
});

els.next.addEventListener("click", () => {
  if (store.page < pageCount() - 1) {
    store.page += 1;
    bump();
  }
});

els.clearSel.addEventListener("click", () => {
  store.selected.clear();
  bump();
});

els.acceptSel.addEventListener("click", () => {
  acceptSelected();
  bump();
});

$("detail-close").addEventListener("click", () => {
  store.openId = null;
  bump();
});

render();

// ---- the two ways in ----------------------------------------------------

mountWidget(driver, {
  think: backendThink("/api/chat"),
  greeting:
    "Ask me to do things in Contacts. Try: “select everyone at Grayson Robotics " +
    "whose status is new, tell me how many, then accept them”.",
  instructions:
    "This is a CRM contacts table. A contact's status moves new → pending → accepted " +
    "or declined. `accept-selected` is the only verb that changes data.",
  onError: (err) => console.error("driverkit widget:", err),
});

/**
 * The outside path, to the relay this page's own server mounted at `/dk`.
 *
 * `relay: ""` means same origin, so there is one process, one port and no
 * CORS. `watchMs` is deliberately not set: every mutation here goes through
 * the store's `bump()`, which calls `changed()`, and that is the better shape
 * — polling `visible()` is the escape hatch for a codebase too scattered to
 * instrument.
 */
try {
  connection = connect(driver, {
    relay: "",
    app: "Contacts",
    title: document.title,
    onError: (err) => {
      els.connDot.dataset.state = "down";
      els.connText.textContent = "relay unreachable";
      console.error("driverkit relay:", err);
    },
  });
  els.connDot.dataset.state = "live";
  // Deliberately not the tab id. PROTOCOL.md: a tab id is a capability, so it
  // goes neither on the screen nor in a log.
  els.connText.textContent = "drivable from outside";
} catch (err) {
  els.connDot.dataset.state = "down";
  els.connText.textContent = "relay not mounted";
  console.error("driverkit relay:", err);
}

// For poking at from the console, which is how the first real run of anything
// like this actually gets debugged.
Object.assign(globalThis, { driver, store });
