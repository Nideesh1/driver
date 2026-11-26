/**
 * The demo, driven for real with no browser.
 *
 * `curl` proving every module returns 200 says the bytes arrive; it says
 * nothing about whether they run. This does the other half: it loads the
 * demo's own verb table and the library's modules — the same bytes the page
 * loads, through the same type-stripper — mounts a driver, drives it directly,
 * drives it through `drive()` with a scripted `think`, and then drives it from
 * OUTSIDE through the relay the server mounted at `/dk`, over real chunked
 * HTTP with a real SSE stream.
 *
 *     node --experimental-strip-types examples/contacts/check.mjs http://127.0.0.1:8791
 *
 * Normally run via `verify_app.py`, which fetches every module from a running
 * server first, so what is executed here is literally what the browser would
 * have got rather than a second copy read off disk.
 *
 * What it CANNOT check, and does not claim to: the widget's DOM and anything
 * about how the page looks. `mountWidget` needs a `document`, `connect` needs
 * the browser's own `EventSource` reconnect, and neither of those is in here.
 */

import assert from "node:assert/strict";
import http from "node:http";

import { createApp, COMPANIES, OWNERS, TOTAL } from "./app/store.js";
import { LANDINGS, href, parse } from "./app/router.js";
import { drive } from "../../packages/agent/src/loop.ts";
import { renderSnapshot } from "../../packages/agent/src/render.ts";
import { systemPrompt, toolsFor, READ_SCREEN } from "../../packages/agent/src/tools.ts";
import { connect } from "../../packages/browser/src/connect.ts";
import { mountWidget } from "../../packages/widget/src/widget.ts";
import { backendThink } from "../../packages/agent/src/backend.ts";
import { HttpEventSource } from "../../packages/relay/test/sse-client.ts";
import { FakeDocument } from "../../packages/widget/test/fake-dom.ts";

const BASE = process.argv[2] || "http://127.0.0.1:8791";

/**
 * JSON over HTTP, with an explicit `Content-Length`.
 *
 * The repository's own `postJson` in `relay/test/sse-client.ts` is not used
 * here, and the reason is a bug worth naming: it sets no `Content-Length`, so
 * Node sends the body with `Transfer-Encoding: chunked` — and
 * `driverkit.serve_relay` reads `int(self.headers.get("Content-Length") or 0)`
 * and therefore reads nothing at all. The relay then answers a call with no
 * `name`, and the undrained chunk framing is parsed as the start of the next
 * request on the keep-alive connection, which fails as
 * "Expected HTTP/, RTSP/ or ICE/". See the report.
 *
 * @param {string} method @param {string} url @param {unknown} [payload]
 */
function request(method, url, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = http.request(url, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* a non-JSON body is itself the finding in one check */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const postJson = (/** @type {string} */ url, /** @type {unknown} */ body) =>
  request("POST", url, body);
const getJson = (/** @type {string} */ url) => request("GET", url);

let failures = 0;
const results = [];

/** @param {string} name @param {() => unknown | Promise<unknown>} body */
async function check(name, body) {
  try {
    await body();
    results.push(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    results.push(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}

const notes = [];

// =========================================================================
// 1. The driver, in process
// =========================================================================

const app = createApp();
const { driver, store, visible } = app;

await check("the manifest lists eighteen verbs with a kind on every one", () => {
  const m = driver.manifest();
  assert.equal(m.app, "Northwind CRM");
  assert.equal(m.verbs.length, 18);
  for (const v of m.verbs) assert.ok(v.kind, `${v.name} has no kind`);
  assert.deepEqual(
    m.verbs.map((v) => v.name).sort(),
    [
      "accept-selected",
      "assign-owner",
      "back",
      "clear-selection",
      "decline-selected",
      "go",
      "next-page",
      "open-company",
      "open-contact",
      "prev-page",
      "search",
      "select-contact",
      "select-pending-here",
      "select-where",
      "set-setting",
      "set-status",
      "show-status",
      "sort-companies",
    ],
  );
  const kinds = {};
  for (const v of m.verbs) kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
  // The shape of the surface, asserted rather than described: most of a
  // six-screen app is getting about, and five verbs can change data.
  assert.deepEqual(kinds, { read: 9, describe: 4, commit: 5 });
  notes.push(
    `manifest version ${m.version}, ${m.verbs.length} verbs ` +
      `(${kinds.read} read, ${kinds.describe} describe, ${kinds.commit} commit)`,
  );
});

await check("every verb in the flat manifest is offered on every screen", () => {
  // Not a feature: a fact worth pinning, because it is the gap the report
  // leads with. `Manifest.verbs` has no screen on it, so `sort-companies` is
  // in the cached tool list while the person is on the settings form, and the
  // only way an agent finds out is the `wrong-screen` refusal below.
  const m = driver.manifest();
  for (const v of m.verbs) assert.equal("screen" in v, false, `${v.name} carries a screen`);
  const scoped = m.verbs.filter((v) => (v.refuses || []).includes("wrong-screen"));
  assert.equal(scoped.length, 6);
  notes.push(`screen-scoped verbs that must refuse wrong-screen: ${scoped.map((v) => v.name).join(" ")}`);
});

await check("select-where takes named fields with oneOf, not a predicate string", () => {
  const v = driver.manifest().verbs.find((x) => x.name === "select-where");
  assert.deepEqual(Object.keys(v.args), ["company", "status"]);
  assert.equal(v.args.company.oneOf.length, 8);
  assert.equal(v.args.status.optional, true);
  assert.equal(v.kind, "describe");
  const commit = driver.manifest().verbs.find((x) => x.name === "accept-selected");
  // The pairing rule, asserted: the commit verb has no arguments at all.
  assert.equal(commit.args, undefined);
  assert.equal(commit.kind, "commit");
});

await check("the table is 3,412 rows and the same 3,412 rows every time", () => {
  assert.equal(store.rows.length, TOTAL);
  assert.equal(TOTAL, 3412);
  const counts = COMPANIES.map(
    (c) => `${c}=${store.rows.filter((r) => r.company === c).length}`,
  );
  notes.push(`rows per company: ${counts.join(" ")}`);
  const byStatus = ["new", "pending", "accepted", "declined"].map(
    (s) => `${s}=${store.rows.filter((r) => r.status === s).length}`,
  );
  notes.push(`rows per status: ${byStatus.join(" ")}`);
  assert.equal(store.rows[0].id, "c-0001");
  assert.equal(store.rows[TOTAL - 1].id, `c-${TOTAL}`);
});

await check("the app opens on the dashboard, which is not a table", () => {
  const s = visible();
  assert.equal(s.where, "dashboard");
  assert.equal(s.page, undefined, "a dashboard must not claim to be a window onto more");
  // The compromise, pinned so it cannot be quietly forgotten: seven metric
  // tiles leave as `rows`, because `Snapshot` has no other shape to put them
  // in. `id` here names a tile, not a record.
  assert.ok(s.rows.length >= 7);
  assert.deepEqual(Object.keys(s.rows[0]).sort(), ["id", "metric", "value"]);
  assert.match(renderSnapshot(s), /rows 8 \(all of them\)/);
  assert.match(s.note, /not a table/);
});

await check("every screen's visible() names where it is and carries a rev", () => {
  // Driven through the store's own screen table rather than by navigating, so
  // one missing field in one screen cannot hide behind another.
  const names = Object.keys(app.screens);
  assert.deepEqual(names.sort(), ["companies", "company", "contact", "contacts", "dashboard", "settings"]);
  for (const name of names) {
    const s = app.screens[name]();
    assert.equal(typeof s.where, "string", `${name} has no where`);
    assert.ok(s.where.length > 0, `${name} has an empty where`);
    assert.equal(typeof s.rev, "number", `${name} has no rev`);
    // The screen has to be identifiable from the sentence alone: it is the
    // only thing in a snapshot that says which of the six you are looking at.
    assert.ok(
      renderSnapshot(s).startsWith(`where: ${s.where}`),
      `${name} does not render its own where first`,
    );
  }
});

await check("the contacts list is a twenty-row window with a real page block", async () => {
  const out = await driver.call("go", { screen: "contacts" });
  assert.equal(out.ok, true);
  const s = visible();
  assert.equal(s.rows.length, 20);
  assert.deepEqual(s.page, { index: 0, size: 20, total: TOTAL });
  assert.match(s.where, /^contacts list/);
  assert.equal(typeof s.rev, "number");
  assert.match(renderSnapshot(s), /more rows exist off screen/);
});

await check("read verbs page and search, and rev moves on every one", async () => {
  await driver.call("go", { screen: "contacts" });
  const before = visible().rev;
  const next = await driver.call("next-page");
  assert.equal(next.ok, true);
  assert.equal(next.snapshot.page.index, 1);
  assert.ok(next.snapshot.rev > before, "rev did not move on next-page");

  const prev = await driver.call("prev-page");
  assert.equal(prev.snapshot.page.index, 0);

  const first = await driver.call("prev-page");
  assert.equal(first.ok, false);
  assert.equal(first.refused, "at-first-page");

  const search = await driver.call("search", { q: "Acme" });
  assert.equal(search.ok, true);
  assert.ok(search.snapshot.page.total < TOTAL && search.snapshot.page.total > 0);
  assert.match(search.snapshot.where, /filtered to/);
  await driver.call("search", { q: "" });
});

await check("open-contact refuses an id that is not there, with the slug it declared", async () => {
  const bad = await driver.call("open-contact", { id: "c-9999" });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, "no-such-contact");
  assert.match(bad.hint, /c-0001/);
});

await check("a drill-down carries the record in `where` and its history in `rows`", async () => {
  const out = await driver.call("open-contact", { id: "c-0184" });
  assert.equal(out.ok, true);
  const s = out.snapshot;
  // The second compromise, pinned: there is no field for "the record I am on",
  // so the fields ride in the sentence documented as a location.
  assert.match(s.where, /^contact c-0184 — /);
  assert.match(s.where, /status \w+/);
  assert.match(s.where, /@fairmont-dental\.example/);
  assert.equal(s.page, undefined, "a record's history is complete, so there is no page block");
  assert.ok(s.rows.length >= 3);
  assert.deepEqual(Object.keys(s.rows[0]).sort(), ["id", "what", "when", "who"]);
  // The rows are NOT contacts, and only the note says so.
  assert.match(s.note, /activity history/);
  notes.push(`contact c-0184 history: ${s.rows.length} events`);
});

await check("a record-scoped commit takes no id and refuses off its own screen", async () => {
  // `set-status` acts on the record you drilled into. Nothing in the manifest
  // can say that: it has no arguments identifying a contact, so an agent that
  // has not read the description will call it from anywhere.
  const verb = driver.manifest().verbs.find((v) => v.name === "set-status");
  assert.deepEqual(Object.keys(verb.args), ["status"]);
  assert.equal(verb.kind, "commit");

  const on = await driver.call("set-status", { status: "pending" });
  assert.equal(on.ok, true);
  assert.equal(on.count, 1);
  assert.match(on.snapshot.where, /status pending/);

  const again = await driver.call("set-status", { status: "pending" });
  assert.equal(again.refused, "already-that-status");

  const owner = await driver.call("assign-owner", { owner: OWNERS[3] });
  assert.equal(owner.ok, true);
  assert.match(owner.snapshot.where, new RegExp(`owner ${OWNERS[3].replace(".", "\\.")}`));

  await driver.call("go", { screen: "dashboard" });
  const nowhere = await driver.call("set-status", { status: "accepted" });
  assert.equal(nowhere.ok, false);
  assert.equal(nowhere.refused, "no-contact-open");
  assert.match(nowhere.hint, /open-contact/);
});

await check("select-contact picks exactly one row — the failure this demo was built on", async () => {
  // The live bug: with only `select-where(company, status?)` on the surface,
  // asked for one named person at Grayson Robotics a model's only tool would
  // have selected all 410, and it correctly refused instead.
  const bulk = await driver.call("select-where", { company: "Grayson Robotics" });
  assert.equal(bulk.count, 410);

  const one = await driver.call("select-contact", { id: "c-0010" });
  assert.equal(one.ok, true);
  assert.equal(one.count, 1, "select-contact must replace the selection, not add to it");
  assert.equal(one.snapshot.selectedCount, 1);

  const two = await driver.call("select-contact", { id: "c-0031", add: true });
  assert.equal(two.count, 2);
  assert.equal(two.snapshot.selectedCount, 2);

  const missing = await driver.call("select-contact", { id: "c-9999" });
  assert.equal(missing.refused, "no-such-contact");
  await driver.call("clear-selection");
  notes.push("select-where(Grayson Robotics) = 410, select-contact = 1");
});

await check("navigation moves `where`, bumps `rev`, and `back` walks the trail", async () => {
  await driver.call("go", { screen: "dashboard" });
  const start = visible().rev;

  const opening = {
    dashboard: "dashboard",
    contacts: "contacts list",
    companies: "companies list",
    settings: "settings",
  };
  for (const screen of LANDINGS) {
    const out = await driver.call("go", { screen });
    assert.equal(out.ok, true, `go ${screen} refused`);
    assert.ok(
      out.snapshot.where.startsWith(opening[screen]),
      `go ${screen} landed on ${JSON.stringify(out.snapshot.where)}`,
    );
  }
  assert.ok(visible().rev > start, "navigating did not move rev");

  // `go` with a screen that needs an id is not offered at all: the core
  // refuses it as bad-argument and lists the four it accepts.
  const record = await driver.call("go", { screen: "contact" });
  assert.equal(record.refused, "bad-argument");
  assert.match(record.hint, /"dashboard", "contacts", "companies", "settings"/);

  const where = visible().where;
  await driver.call("open-company", { company: "Halloway Foods" });
  const back = await driver.call("back");
  assert.equal(back.ok, true);
  assert.equal(back.snapshot.where, where, "back did not return to the previous screen");

  // The trail is finite and runs out, which is a refusal and not a crash.
  let last;
  for (let i = 0; i < 40; i++) {
    last = await driver.call("back");
    if (!last.ok) break;
  }
  assert.equal(last.refused, "nothing-to-go-back-to");
});

await check("a screen-scoped verb refuses wrong-screen with the fix in the hint", async () => {
  await driver.call("go", { screen: "settings" });
  for (const [name, args] of [
    ["search", { q: "Ada" }],
    ["next-page", {}],
    ["prev-page", {}],
    ["sort-companies", { by: "pending" }],
    ["show-status", { status: "all" }],
    ["select-pending-here", {}],
  ]) {
    const out = await driver.call(name, args);
    assert.equal(out.ok, false, `${name} worked on the settings screen`);
    assert.equal(out.refused, "wrong-screen", `${name} refused ${out.refused}`);
    assert.match(out.hint, /settings screen/);
    assert.ok(out.hint.includes("`"), `${name}'s hint names no verb to call instead`);
  }
});

await check("the companies list rolls up from the same rows the contacts list shows", async () => {
  await driver.call("go", { screen: "companies" });
  const s = visible();
  assert.equal(s.rows.length, 8);
  assert.equal(s.page, undefined, "eight rows is all of them, so there is no window");
  const total = s.rows.reduce((sum, row) => sum + row.contacts, 0);
  assert.equal(total, TOTAL, "the companies screen disagrees with the contacts table");

  const sorted = await driver.call("sort-companies", { by: "pending" });
  assert.match(sorted.snapshot.where, /sorted by pending/);
  const pending = sorted.snapshot.rows.map((r) => r.pending);
  assert.deepEqual(pending, [...pending].sort((a, b) => b - a));
});

await check("the cross-screen job: find a company, open it, accept its pending", async () => {
  // The whole point of the exercise, driven end to end through the verbs an
  // agent would use and nothing else.
  await driver.call("go", { screen: "companies" });
  const listed = visible().rows.find((r) => r.name === "Berenson Health");
  assert.ok(listed, "Berenson Health is not on the companies list");
  const expected = listed.pending;
  assert.ok(expected > 0);

  const opened = await driver.call("open-company", { company: "Berenson Health" });
  assert.equal(opened.ok, true);
  assert.match(opened.snapshot.where, /^company Berenson Health — /);
  // The drill-down lands on the pending tab, so the rows in front of the
  // person are the ones the job is about.
  assert.match(opened.snapshot.where, /showing the pending ones/);
  assert.equal(opened.snapshot.page.total, expected);

  const picked = await driver.call("select-pending-here");
  assert.equal(picked.ok, true);
  assert.equal(picked.count, expected, "select-pending-here matched a different number");
  assert.equal(picked.snapshot.selectedCount, expected);
  // The honest window: the ids are the page, the count is the selection.
  assert.equal(picked.snapshot.selected.length, 20);
  assert.match(renderSnapshot(picked.snapshot), /only the ones on screen/);

  const done = await driver.call("accept-selected");
  assert.equal(done.ok, true);
  assert.equal(done.count, expected);

  // And the roll-up moved with it, on this screen and on the companies list.
  assert.match(done.snapshot.where, /0 pending/);
  await driver.call("go", { screen: "companies" });
  const after = visible().rows.find((r) => r.name === "Berenson Health");
  assert.equal(after.pending, 0);
  assert.equal(
    store.rows.filter((r) => r.company === "Berenson Health" && r.status === "pending").length,
    0,
  );
  await driver.call("clear-selection");
  notes.push(`cross-screen accept at Berenson Health: ${expected} pending contacts`);
});

await check("a selection made on one screen is still live, and committable, on another", async () => {
  // Not a feature either. The selection is global and survives navigation, so
  // a commit verb reached from the dashboard acts on rows nobody on that
  // screen can see. `selectedCount` is the only thing standing between an
  // agent and that, which is why it is a field and not prose.
  const picked = await driver.call("select-where", { company: "Acme Industrial", status: "new" });
  const count = picked.count;
  assert.ok(count > 100);

  await driver.call("go", { screen: "dashboard" });
  const s = visible();
  assert.equal(s.selected, undefined, "no contact rows are on the dashboard");
  assert.equal(s.selectedCount, count, "the dashboard forgot how much is selected");
  assert.match(renderSnapshot(s), /none of them are on screen/);
  assert.match(s.note, new RegExp(`${count} contacts are still selected`));

  const settings = app.screens.settings();
  assert.equal(settings.selectedCount, count);
  await driver.call("clear-selection");
});

await check("the settings form is rows with values, and reaches into the tables", async () => {
  await driver.call("go", { screen: "settings" });
  const s = visible();
  assert.equal(s.page, undefined);
  assert.deepEqual(s.rows.map((r) => r.id), [
    "rows-per-page",
    "default-owner",
    "confirm-bulk",
    "dense-rows",
  ]);
  // The form compromise: `value` is in a row because `ControlSummary` can say
  // an input exists and not what is in it.
  assert.deepEqual(Object.keys(s.rows[0]).sort(), ["accepts", "id", "setting", "value"]);
  assert.match(s.note, /a form, not a table/);

  const bad = await driver.call("set-setting", { name: "rows-per-page", value: "7" });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, "bad-setting-value");
  assert.match(bad.hint, /10, 20, 50, 100/);

  const set = await driver.call("set-setting", { name: "rows-per-page", value: "50" });
  assert.equal(set.ok, true);
  await driver.call("go", { screen: "contacts" });
  const after = visible();
  assert.equal(after.rows.length, 50, "the settings screen did not reach the contacts table");
  assert.equal(after.page.size, 50);
  await driver.call("go", { screen: "settings" });
  await driver.call("set-setting", { name: "rows-per-page", value: "20" });
  await driver.call("go", { screen: "contacts" });
});

await check("the router round-trips every screen, and a bad URL lands somewhere real", () => {
  // No DOM in here: the router is data, which is the only reason a deep link
  // can be checked without a browser.
  for (const route of [
    { screen: "dashboard", id: null },
    { screen: "contacts", id: null },
    { screen: "contact", id: "c-0184" },
    { screen: "companies", id: null },
    { screen: "company", id: "acme-industrial" },
    { screen: "settings", id: null },
  ]) {
    assert.deepEqual(parse(href(route)), route, `${href(route)} did not round-trip`);
  }
  assert.deepEqual(parse(""), { screen: "dashboard", id: null });
  assert.deepEqual(parse("#/nonsense/deeper"), { screen: "dashboard", id: null });
  // A deep link to a record that does not exist is a screen, not a throw.
  assert.deepEqual(parse("#/contacts/c-9999"), { screen: "contact", id: "c-9999" });
});

await check("a deep link straight to a record renders that record", async () => {
  const deep = createApp();
  deep.navigate(parse("#/contacts/c-0184"), { record: false });
  const s = deep.visible();
  assert.match(s.where, /^contact c-0184 — /);
  assert.ok(s.rows.length >= 3);
  // Seeded from the id alone, so a cold deep link shows the same history as
  // clicking through to it.
  assert.deepEqual(s.rows, deep.historyFor("c-0184").map((e) => ({ id: e.id, when: e.when, what: e.what, who: e.who })));

  const missing = createApp();
  missing.navigate(parse("#/contacts/c-9999"), { record: false });
  assert.match(missing.visible().where, /no such contact/);
  assert.equal(missing.visible().rows, undefined);
  assert.match(renderSnapshot(missing.visible()), /this screen reports no rows/);
});

await check("a bad `company` is bad-argument and the refusal lists the accepted set", async () => {
  const out = await driver.call("select-where", { company: "Acme" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "bad-argument");
  assert.match(out.hint, /must be one of/);
  assert.match(out.hint, /Acme Industrial/);
});

let selectedCount = 0;

await check("select-where reports a count, and the commit acts on it", async () => {
  const picked = await driver.call("select-where", {
    company: "Grayson Robotics",
    status: "new",
  });
  assert.equal(picked.ok, true);
  assert.equal(typeof picked.count, "number");
  assert.ok(picked.count > 0);
  selectedCount = picked.count;
  notes.push(`select-where(Grayson Robotics, new) = ${picked.count}`);

  const done = await driver.call("accept-selected");
  assert.equal(done.ok, true);
  assert.equal(done.count, selectedCount);
  // Everything the describe matched is now accepted, and nothing else moved.
  const accepted = store.rows.filter(
    (r) => r.company === "Grayson Robotics" && r.status === "accepted",
  ).length;
  assert.ok(accepted >= selectedCount);

  const again = await driver.call("clear-selection");
  assert.equal(again.count, 0, "clear-selection must report 0, not omit the count");

  const empty = await driver.call("accept-selected");
  assert.equal(empty.ok, false);
  assert.equal(empty.refused, "nothing-selected");
});

await check("a stale rev is refused rather than applied", async () => {
  await driver.call("go", { screen: "contacts" });
  const rev = visible().rev;
  await driver.call("next-page");
  const stale = await driver.call("prev-page", {}, { rev });
  assert.equal(stale.ok, false);
  assert.equal(stale.refused, "stale");
  await driver.call("search", { q: "" });
});

await check("a call aimed at one screen lands on another unless it quotes rev", async () => {
  // What happens to a pending call when the user navigates mid-run, which is
  // the question the report asks and this is the whole answer: `rev` or
  // nothing. There is no screen identity in a call, so a verb that is valid on
  // both screens simply runs on whichever one is there when it arrives.
  await driver.call("go", { screen: "contacts" });
  await driver.call("next-page");
  const read = visible();
  assert.match(read.where, /^contacts list/);

  // The person clicks away while the agent is thinking.
  await driver.call("open-company", { company: "Cordova Logistics" });

  // Quoting the rev it read is the only defence, and it works.
  const guarded = await driver.call("next-page", {}, { rev: read.rev });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.refused, "stale");

  // Without it, the same call pages a list the agent has never seen — a
  // different company's contacts — and reports success. Nothing in the
  // library can tell these two apart, because the call never said which
  // screen it was for.
  const unguarded = await driver.call("next-page");
  assert.equal(unguarded.ok, true, "the call was refused for some other reason");
  assert.match(unguarded.snapshot.where, /^company Cordova Logistics/);
  assert.equal(unguarded.snapshot.page.index, 1);
  notes.push("next-page with no rev, after a navigation, paged the screen it arrived at");

  await driver.call("go", { screen: "contacts" });
  await driver.call("search", { q: "" });
});

await check("an unknown verb comes back naming the real ones", async () => {
  const out = await driver.call("delete-everything");
  assert.equal(out.refused, "unknown-verb");
  assert.match(out.hint, /select-where/);
});

// =========================================================================
// 2. The loop, with a scripted think
// =========================================================================

await check("drive() runs describe → commit and the static half never changes", async () => {
  const seen = [];
  const script = [
    { calls: [{ id: "t1", name: "select-where", args: { company: "Fairmont Dental" } }] },
    { calls: [{ id: "t2", name: "accept-selected", args: {} }] },
    { text: "Done." },
  ];
  let step = 0;

  const out = await drive(driver, {
    think: async ({ system, tools, messages }) => {
      seen.push({ system, tools: JSON.stringify(tools), messages: messages.length });
      return script[step++];
    },
    task: "accept everyone at Fairmont Dental",
    onBeforeCommit: () => true,
  });

  assert.equal(out.stop, "answered");
  assert.equal(out.text, "Done.");
  assert.equal(out.steps, 3);
  // The cost argument, asserted: byte-identical prefix on every turn.
  assert.equal(new Set(seen.map((s) => s.system)).size, 1);
  assert.equal(new Set(seen.map((s) => s.tools)).size, 1);
  // And the screen is in the tail, not the prefix.
  assert.ok(!seen[0].system.includes("c-00"));
  const tool = out.messages.filter((m) => m.role === "tool");
  assert.equal(tool.length, 2);
  assert.match(tool[0].text, /count: /);
});

await check("a declined commit reaches the model as declined-by-user, not a crash", async () => {
  await driver.call("select-where", { company: "Berenson Health" });
  let told = "";
  const out = await drive(driver, {
    think: async ({ messages }) => {
      const last = messages[messages.length - 1];
      if (last.role === "tool") {
        told = last.text;
        return { text: "You declined, so I stopped." };
      }
      return { calls: [{ id: "x1", name: "accept-selected", args: {} }] };
    },
    task: "accept them",
    onBeforeCommit: () => false,
  });
  assert.equal(out.stop, "answered");
  assert.match(told, /refused: declined-by-user/);
  // Nothing moved.
  assert.ok(store.selected.size > 0);
  await driver.call("clear-selection");
});

await check("the tool list carries the commit banner and read_screen", () => {
  const tools = toolsFor(driver.manifest());
  assert.equal(tools.length, 19);
  assert.ok(tools.some((t) => t.name === READ_SCREEN));
  const commit = tools.find((t) => t.name === "accept-selected");
  assert.match(commit.description, /COMMIT: THIS CHANGES DATA/);
  const describe = tools.find((t) => t.name === "select-where");
  assert.deepEqual(describe.inputSchema.required, ["company"]);
  assert.equal(describe.inputSchema.properties.company.enum.length, 8);
  // `rev` is hoisted onto every verb so the model has somewhere to put it.
  assert.equal(describe.inputSchema.properties.rev.type, "integer");
  assert.ok(systemPrompt(driver.manifest()).includes("Northwind CRM"));

  // The gap the per-snapshot screen map exists to paper over: the static half
  // has no field for the app's own briefing, so there is nowhere in the
  // manifest to say that this app HAS six screens or how they relate. A
  // relay-driven agent never sees the widget's `instructions` either, which is
  // why `visible()` repeats the screen list in every note. See the report.
  const manifest = driver.manifest();
  assert.deepEqual(Object.keys(manifest).sort(), ["app", "verbs", "version"]);
  for (const verb of manifest.verbs) {
    assert.deepEqual(
      Object.keys(verb).filter((k) => !["name", "describe", "kind", "at", "args", "refuses"].includes(k)),
      [],
      `${verb.name} carries a field the manifest type does not have`,
    );
  }
});

// =========================================================================
// 2b. The widget, over the library's own fake DOM
//
// Not the browser, and not a claim to be one: no layout, no shadow CSS, no
// pixels. What it does cover is the widget's logic — the trace lines, the
// built-in commit confirmation and its count, and the `backendThink` fetch —
// which is the half that can be wrong without looking wrong.
// =========================================================================

await check("the widget confirms a commit with the count the describe reported", async () => {
  const fake = new FakeDocument();
  const wApp = createApp();
  const script = [
    { calls: [{ id: "w1", name: "select-where", args: { company: "Cordova Logistics" } }] },
    { calls: [{ id: "w2", name: "accept-selected", args: {} }] },
    { text: "Accepted them." },
  ];
  let step = 0;

  const panel = mountWidget(wApp.driver, {
    document: fake,
    think: async () => script[step++],
    // Zero, because the widget paces its steps for a person watching — 600ms
    // each by default — and a harness that polled against that would be
    // asserting on a stopwatch. The pace is the widget's, and it is checked in
    // the widget's own tests; what this check is about is the gate.
    pace: 0,
  });

  const run = panel.ask("accept everyone at Cordova Logistics");

  // The gate is a promise the loop is waiting on, so let the microtasks drain
  // until the question has been drawn.
  for (let i = 0; i < 400 && fake.body.find("dk-ask").length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const ask = fake.body.one("dk-ask");
  const question = ask.find("dk-ask-q")[0].textContent;
  const expected = wApp.store.rows.filter((r) => r.company === "Cordova Logistics").length;
  assert.match(
    question,
    new RegExp(`${expected.toLocaleString("en-US")} rows`),
    `the confirmation said ${JSON.stringify(question)}, with no count in it`,
  );
  assert.match(ask.find("dk-ask-why")[0].textContent, /may be irreversible/);

  // The safe answer is focused, so Enter on a dialog that appeared mid-typing
  // does not accept four hundred rows.
  assert.equal(fake.body.one("dk-no").focused, true);
  assert.equal(fake.body.one("dk-yes").focused, false);

  fake.body.one("dk-yes").dispatch("click");
  await run;

  const accepted = wApp.store.rows.filter(
    (r) => r.company === "Cordova Logistics" && r.status === "accepted",
  ).length;
  assert.equal(accepted, expected, "the commit did not run after the person said yes");

  const transcript = fake.body.text();
  assert.match(transcript, /select-where \(describe\)/);
  assert.match(transcript, /accept-selected \(commit\)/);
  assert.match(transcript, /Accepted them\./);
  panel.unmount();
});

await check("saying no to the widget's gate leaves the data alone", async () => {
  const fake = new FakeDocument();
  const wApp = createApp();
  const before = wApp.store.rows.filter((r) => r.status === "accepted").length;
  const script = [
    { calls: [{ id: "n1", name: "select-where", args: { company: "Everline Capital" } }] },
    { calls: [{ id: "n2", name: "accept-selected", args: {} }] },
    { text: "You said no, so I stopped." },
  ];
  let step = 0;
  const panel = mountWidget(wApp.driver, {
    document: fake,
    think: async () => script[step++],
    pace: 0,
  });
  const run = panel.ask("accept everyone at Everline Capital");
  for (let i = 0; i < 400 && fake.body.find("dk-no").length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  fake.body.one("dk-no").dispatch("click");
  await run;
  assert.equal(wApp.store.rows.filter((r) => r.status === "accepted").length, before);
  assert.match(fake.body.text(), /refused: declined-by-user/);
  panel.unmount();
});

await check("backendThink posts to the real /api/chat and the widget says so", async () => {
  const fake = new FakeDocument();
  const wApp = createApp();
  let caught;
  const panel = mountWidget(wApp.driver, {
    document: fake,
    think: backendThink(`${BASE}/api/chat`),
    pace: 0,
    onError: (err) => (caught = err),
  });
  await panel.ask("how many contacts are at Acme Industrial?");
  const transcript = fake.body.text();
  // With no key configured the proxy answers 503 and `backendThink` throws,
  // which the widget is supposed to say out loud rather than going quiet.
  if (caught) {
    assert.match(transcript, /Something went wrong talking to the model/);
    notes.push(`backendThink surfaced: ${String(caught.message)}`);
  } else {
    notes.push("backendThink reached a live model and the widget ran a turn");
  }
  panel.unmount();
});

// =========================================================================
// 3. The outside path, through the real relay
// =========================================================================

const connected = createApp();
let connection;
let tabId = "";

await check("a tab connects to /dk and the relay lists it with a manifest", async () => {
  connection = connect(connected.driver, {
    relay: BASE,
    app: "Northwind CRM",
    title: "Northwind CRM — check.mjs",
    url: "/examples/contacts/app/#/contacts",
    EventSource: HttpEventSource,
    storage: null,
    onError: (err) => {
      throw err;
    },
  });
  tabId = connection.tab;

  // `hello` rides a separate POST after the stream opens, so there is a real
  // window in which the tab is listed with no manifest. Wait for it.
  let listed;
  for (let i = 0; i < 100; i++) {
    const tabs = await getJson(`${BASE}/dk/tabs`);
    listed = (tabs.body.tabs || []).find((t) => t.tab === tabId);
    if (listed && listed.manifestVersion) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(listed, "the tab never appeared in /dk/tabs");
  assert.equal(listed.app, "Northwind CRM");
  assert.ok(listed.manifestVersion, "/dk/tabs never carried a manifestVersion");

  const manifest = await getJson(`${BASE}/dk/tabs/${tabId}/manifest`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.verbs.length, 18);

  // The URL the relay is listing is the one `hello` carried, and `hello` is
  // sent on connect and on reconnect only. Navigating does not resend it, so
  // this is already wrong the moment the tab moves; see the report.
  assert.equal(listed.url, "/examples/contacts/app/#/contacts");
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "go", args: { screen: "settings" } });
  const again = await getJson(`${BASE}/dk/tabs`);
  const moved = (again.body.tabs || []).find((t) => t.tab === tabId);
  assert.equal(
    moved.url,
    "/examples/contacts/app/#/contacts",
    "if this ever changes, the relay grew a way to hear about navigation",
  );
  notes.push("/dk/tabs still lists the URL from `hello` after the tab navigated away");
});

await check("an outside agent can walk screens and read where it is", async () => {
  for (const screen of LANDINGS) {
    const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
      name: "go",
      args: { screen },
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true, `go ${screen} refused over the relay`);
    assert.ok(out.body.snapshot.where.length > 0);
  }
  const snap = await getJson(`${BASE}/dk/tabs/${tabId}/snapshot`);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.where, "settings");
});

await check("the cross-screen job runs over the relay too", async () => {
  const opened = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "open-company",
    args: { company: "Fairmont Dental" },
  });
  assert.equal(opened.body.ok, true);
  const expected = opened.body.snapshot.page.total;
  assert.ok(expected > 0);

  const picked = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "select-pending-here" });
  assert.equal(picked.body.count, expected);
  assert.equal(picked.body.snapshot.selectedCount, expected);

  const done = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "accept-selected" });
  assert.equal(done.body.ok, true);
  assert.equal(done.body.count, expected);
  assert.equal(
    connected.store.rows.filter((r) => r.company === "Fairmont Dental" && r.status === "pending")
      .length,
    0,
  );
  notes.push(`relay cross-screen accept at Fairmont Dental = ${expected}`);
});

await check("a verb called from the wrong screen refuses, over the relay, with a snapshot", async () => {
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "go", args: { screen: "dashboard" } });
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "search",
    args: { q: "Ada" },
  });
  assert.equal(out.status, 200, "a wrong-screen refusal is still a 200");
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, "wrong-screen");
  assert.match(out.body.hint, /dashboard screen/);
  assert.ok(out.body.snapshot, "a refusal must still carry the screen");
  assert.equal(out.body.snapshot.where, "dashboard");
});

await check("an outside call runs the verb and comes back with the count", async () => {
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "select-where",
    args: { company: "Halloway Foods", status: "new" },
  });
  assert.equal(out.status, 200, "PROTOCOL.md: /call is 200 whatever the outcome");
  assert.equal(out.body.ok, true);
  assert.equal(typeof out.body.count, "number");
  assert.ok(out.body.count > 0);
  assert.ok(out.body.snapshot, "a result must carry the snapshot after the call");
  notes.push(`relay select-where(Halloway Foods, new) = ${out.body.count}`);

  const size = JSON.stringify(out.body.snapshot).length;
  notes.push(
    `snapshot after selecting ${out.body.count} rows: ${size} bytes ` +
      "(selected ids capped to the visible page — see the report)",
  );
});

await check("a refusal from the app is 200 with ok:false, not a 4xx", async () => {
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "go", args: { screen: "contacts" } });
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "prev-page" });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, "at-first-page");
  assert.ok(out.body.snapshot, "an app refusal must still carry a snapshot");
});

await check("a stale rev through the relay is refused as stale", async () => {
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "go", args: { screen: "contacts" } });
  const snap = await getJson(`${BASE}/dk/tabs/${tabId}/snapshot`);
  assert.equal(snap.status, 200);
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "next-page",
    rev: snap.body.rev - 1,
  });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, "stale");
});

await check("an unknown tab is a relay refusal with no snapshot", async () => {
  const out = await postJson(`${BASE}/dk/tabs/not-a-tab/call`, { name: "search", args: { q: "x" } });
  assert.equal(out.status, 200);
  assert.equal(out.body.refused, "no-such-tab");
  assert.equal(out.body.snapshot, undefined, "a relay refusal must not invent a snapshot");
});

await check("a commit through the relay changes data and reports the count", async () => {
  const picked = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "select-where",
    args: { company: "Delacroix Media", status: "pending" },
  });
  const expected = picked.body.count;
  const done = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "accept-selected" });
  assert.equal(done.body.ok, true);
  assert.equal(done.body.count, expected);
  const accepted = connected.store.rows.filter(
    (r) => r.company === "Delacroix Media" && r.status === "accepted",
  ).length;
  assert.ok(accepted >= expected);
});

await check("a call with no name is a 400, not a WireResult", async () => {
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { args: { q: "x" } });
  assert.equal(out.status, 400);
  assert.equal(out.body.error, "bad-request");
});

await check("an unknown /dk route is a 404 with no-route, and a bad method a 405", async () => {
  const gone = await getJson(`${BASE}/dk/nothing`);
  assert.equal(gone.status, 404);
  const wrong = await postJson(`${BASE}/dk/tabs`, {});
  assert.equal(wrong.status, 405);
  assert.equal(wrong.body.error, "bad-method");
});

await check("the page's own routes answer, with the right content types", async () => {
  const page = await getJson(`${BASE}/examples/contacts/app/`);
  assert.equal(page.status, 200);
  assert.match(String(page.body), /<title>Northwind CRM<\/title>/);
  for (const module of ["app.js", "store.js", "screens.js", "router.js", "data.js", "styles.css"]) {
    const got = await getJson(`${BASE}/examples/contacts/app/${module}`);
    assert.equal(got.status, 200, `${module} did not serve`);
  }
  const refused = await getJson(`${BASE}/examples/contacts/server.py`);
  assert.equal(refused.status, 403, "the server must not serve its own source");
  const traversal = await getJson(`${BASE}/../../etc/passwd`);
  assert.ok(traversal.status >= 400);
});

await check("/api/chat translates a Think request and reports a missing key clearly", async () => {
  const out = await postJson(`${BASE}/api/chat`, {
    system: "s",
    tools: [],
    messages: [{ role: "user", text: "hello" }],
  });
  // 503 when no key is configured, 200 or 502 when one is. Never a traceback,
  // and never the key.
  assert.ok([200, 502, 503].includes(out.status), `unexpected ${out.status}`);
  const text = JSON.stringify(out.body);
  assert.ok(!/sk-ant/.test(text), "the response must never carry a key");
  if (out.status === 503) assert.match(out.body.error, /ANTHROPIC_API_KEY/);
  notes.push(`/api/chat answered ${out.status}`);
});

await check("a human-driven change is pushed to /watch", async () => {
  const seen = [];
  const watch = new HttpEventSource(`${BASE}/dk/tabs/${tabId}/watch`);
  watch.addEventListener("snapshot", (e) => seen.push(JSON.parse(String(e.data))));
  await new Promise((r) => setTimeout(r, 250));
  // The human types in the search box: the store moves and `changed()` fires.
  connected.navigate({ screen: "contacts", id: null });
  connected.store.query = "Everline";
  connected.store.page = 0;
  connected.bump();
  connection.changed();
  for (let i = 0; i < 60 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  watch.close();
  assert.ok(seen.length >= 1, "no snapshot frame reached /watch");
  const last = seen[seen.length - 1];
  assert.ok(last.snapshot, "a watch frame must carry a snapshot");
});

connection?.disconnect();

// =========================================================================

console.log(`\ndriverkit contacts demo — live checks against ${BASE}\n`);
for (const line of results) console.log(line);
console.log("\nreproducible numbers:");
for (const line of notes) console.log(`  · ${line}`);
console.log(
  `\n${results.length - failures}/${results.length} checks passed` +
    (failures ? ` — ${failures} FAILED` : ""),
);
process.exit(failures ? 1 : 0);
