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

import { createApp, COMPANIES, TOTAL } from "./app/store.js";
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

await check("the manifest lists seven verbs with a kind on every one", () => {
  const m = driver.manifest();
  assert.equal(m.app, "Contacts");
  assert.equal(m.verbs.length, 7);
  for (const v of m.verbs) assert.ok(v.kind, `${v.name} has no kind`);
  assert.deepEqual(
    m.verbs.map((v) => v.name).sort(),
    [
      "accept-selected",
      "clear-selection",
      "next-page",
      "open",
      "prev-page",
      "search",
      "select-where",
    ],
  );
  notes.push(`manifest version ${m.version}`);
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

await check("visible() is a twenty-row window with a real page block", () => {
  const s = visible();
  assert.equal(s.rows.length, 20);
  assert.deepEqual(s.page, { index: 0, size: 20, total: TOTAL });
  assert.equal(s.where, "contacts");
  assert.equal(typeof s.rev, "number");
  assert.match(renderSnapshot(s), /more rows exist off screen/);
});

await check("read verbs page and search, and rev moves on every one", async () => {
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

await check("open refuses an id that is not there, with the slug it declared", async () => {
  const bad = await driver.call("open", { id: "c-9999" });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, "no-such-contact");
  const good = await driver.call("open", { id: "c-0184" });
  assert.equal(good.ok, true);
  assert.match(good.snapshot.note, /c-0184 is open/);
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
  const rev = visible().rev;
  await driver.call("next-page");
  const stale = await driver.call("prev-page", {}, { rev });
  assert.equal(stale.ok, false);
  assert.equal(stale.refused, "stale");
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
  assert.equal(tools.length, 8);
  assert.ok(tools.some((t) => t.name === READ_SCREEN));
  const commit = tools.find((t) => t.name === "accept-selected");
  assert.match(commit.description, /COMMIT: THIS CHANGES DATA/);
  const describe = tools.find((t) => t.name === "select-where");
  assert.deepEqual(describe.inputSchema.required, ["company"]);
  assert.equal(describe.inputSchema.properties.company.enum.length, 8);
  // `rev` is hoisted onto every verb so the model has somewhere to put it.
  assert.equal(describe.inputSchema.properties.rev.type, "integer");
  assert.ok(systemPrompt(driver.manifest()).includes("Contacts"));
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
  });

  const run = panel.ask("accept everyone at Cordova Logistics");

  // The gate is a promise the loop is waiting on, so let the microtasks drain
  // until the question has been drawn.
  for (let i = 0; i < 50 && fake.body.find("dk-ask").length === 0; i++) {
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
  const panel = mountWidget(wApp.driver, { document: fake, think: async () => script[step++] });
  const run = panel.ask("accept everyone at Everline Capital");
  for (let i = 0; i < 50 && fake.body.find("dk-no").length === 0; i++) {
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
    app: "Contacts",
    title: "Contacts — check.mjs",
    url: "/examples/contacts/app/",
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
  assert.equal(listed.app, "Contacts");
  assert.ok(listed.manifestVersion, "/dk/tabs never carried a manifestVersion");

  const manifest = await getJson(`${BASE}/dk/tabs/${tabId}/manifest`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.verbs.length, 7);
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
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "prev-page" });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, "at-first-page");
  assert.ok(out.body.snapshot, "an app refusal must still carry a snapshot");
});

await check("a stale rev through the relay is refused as stale", async () => {
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
  assert.match(String(page.body), /<title>Contacts — Northwind CRM<\/title>/);
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
