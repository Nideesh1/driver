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
import { LANDINGS, SCREEN_SPECS, href, parse } from "./app/router.js";
// The RFC 6570 oracle. `ScreenSpec.url` is documented as RFC 6570 and the core
// implements the one level a route needs by hand -- it has zero runtime
// dependencies, and this very file is loaded into a browser with no bundler --
// so the templates are checked against a real implementation rather than
// against the code that wrote them.
import uriTemplates from "uri-templates";
import { drive } from "../../packages/driverkit/src/agent/loop.ts";
import { renderSnapshot } from "../../packages/driverkit/src/agent/render.ts";
import { systemPrompt, toolsFor, READ_SCREEN } from "../../packages/driverkit/src/agent/tools.ts";
import { connect } from "../../packages/driverkit/src/browser/connect.ts";
import { mountWidget } from "../../packages/driverkit/src/widget/widget.ts";
import { backendThink } from "../../packages/driverkit/src/agent/backend.ts";
import { HttpEventSource } from "../../packages/driverkit/test/sse-client.ts";
import { FakeDocument } from "../../packages/driverkit/test/fake-dom.ts";

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

/**
 * The `plan` token off the newest rendered tool turn.
 *
 * What a model actually does: it reads the `plan:` line the describe's result
 * put in front of it and quotes it back on the commit. The scripted `think`s
 * below go through this rather than being handed the token out of band,
 * because the thing worth checking is that the token REACHES the transcript —
 * a plan the core mints and the renderer drops is a commit no model can ever
 * make.
 *
 * @param {Array<{ text?: string }>} messages
 */
function lastPlan(messages) {
  const found = messages
    .map((m) => /plan: (\S+)/.exec(m.text ?? "")?.[1])
    .filter((x) => Boolean(x));
  return found[found.length - 1];
}

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
      "goto",
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

await check("the scoped verbs carry a screen, and no app verb refuses wrong-screen", () => {
  // Both halves of the migration, pinned. The verb→screen mapping is in the
  // CACHED half, so a well-briefed agent reads it before calling rather than
  // discovering it by being refused — the same argument `refuses` is in there
  // for. And `wrong-screen` is the core's slug now: an app that declares it
  // cannot mount at all, so finding it here would mean the guard came back.
  const m = driver.manifest();
  const scoped = Object.fromEntries(
    m.verbs.filter((v) => v.screen).map((v) => [v.name, v.screen]),
  );
  assert.deepEqual(scoped, {
    search: "contacts",
    "sort-companies": "companies",
    "show-status": "company",
    "select-pending-here": "company",
    // The two pagers, which is what `Verb.screen` taking a list bought: these
    // genuinely work on two screens, and the single string that used to be the
    // only shape forced this app to declare neither and invent a refusal.
    "next-page": ["contacts", "company"],
    "prev-page": ["contacts", "company"],
  });
  for (const v of m.verbs) {
    assert.equal(
      (v.refuses || []).includes("wrong-screen"),
      false,
      `${v.name} declares the core's own refusal`,
    );
  }
  // And the invented slug is gone with the gap it covered. `no-pages-here` was
  // this app's own word for "you are not on a screen that pages", which is
  // what `wrong-screen` says now — and an app-invented word for it is exactly
  // what the reserved list exists to stop, because the next app would have
  // picked another one.
  for (const v of m.verbs) {
    assert.equal(
      (v.refuses || []).includes("no-pages-here"),
      false,
      `${v.name} still refuses the hand-rolled no-pages-here`,
    );
  }
  notes.push(
    `verb→screen in the cached half: ${Object.entries(scoped)
      .map(([n, s]) => `${n}→${Array.isArray(s) ? s.join("+") : s}`)
      .join(" ")}`,
  );
});

await check("the app's own briefing is in the manifest, not in every snapshot", () => {
  // The 130-character screen map used to be pasted into all six screens'
  // `note` — the uncached half, paid for on every single turn, for a sentence
  // that never changes. `MountOptions.instructions` is cached once and read by
  // both paths; the relay's copy of it is asserted further down.
  const m = driver.manifest();
  assert.equal(typeof m.instructions, "string");
  assert.match(m.instructions, /status moves new/);
  // Static means static: nothing per-user, per-screen or per-minute in it.
  assert.ok(!/\bc-\d{4}\b/.test(m.instructions), "a contact id is in the cached half");
  assert.ok(!/\brev\b/.test(m.instructions), "the briefing talks about the uncached half");
  // And it is in the system prompt, which is where the in-page path reads it.
  assert.ok(systemPrompt(m).includes(m.instructions));
  notes.push(`Manifest.instructions: ${m.instructions.length} chars, said once`);
});

await check("the prose screen-map is gone from the briefing AND from every note", () => {
  // The map went from `Snapshot.note` to `instructions` and from
  // `instructions` to `Manifest.screens`, and this check is the one that
  // keeps it from coming back. It was never wrong because it was wordy: it
  // was the app's route table written a second time in English, one file away
  // from the first and free to disagree with it, and nothing could tell.
  //
  // The whole of the uncached half is checked, not only the notes, because a
  // screen map in `where` would be exactly as expensive and exactly as
  // duplicated.
  const m = driver.manifest();
  const prose = [/six screens/i, /`?go`? reaches/i, /this app has screens/i, /one screen per/i];
  for (const pattern of prose) {
    assert.ok(!pattern.test(m.instructions), `${pattern} is still in the briefing`);
  }
  for (const name of Object.keys(app.screens)) {
    const snap = app.screens[name]();
    const uncached = `${snap.note ?? ""} ${snap.where}`;
    for (const pattern of prose) {
      assert.ok(!pattern.test(uncached), `${pattern} is still in ${name}'s uncached half`);
    }
  }
  // And no snapshot carries the map's replacement either: `screens` is static
  // and belongs in the manifest, so finding it on a snapshot would be the
  // same mistake in a new field.
  for (const name of Object.keys(app.screens)) {
    assert.equal(app.screens[name]().screens, undefined, `${name} publishes screens`);
    assert.equal(app.screens[name]().flows, undefined, `${name} publishes flows`);
  }
});

await check("the manifest carries the app's map: six screens with working templates", () => {
  // The map is DATA now, in the cached half, so an agent learns a companies
  // list exists before it has ever been to one. Before this it could only
  // learn where it was (`Snapshot.screen`) and where it was not
  // (`wrong-screen`).
  const m = driver.manifest();
  assert.deepEqual(
    m.screens.map((s) => s.id),
    ["dashboard", "contacts", "contact", "companies", "company", "settings"],
  );
  for (const screen of m.screens) {
    assert.ok(screen.describe.length > 20, `${screen.id} has no sentence for the model`);
    assert.ok(screen.describe.length <= 1024, `${screen.id} is over the describe budget`);
    assert.ok(screen.url.startsWith("#/"), `${screen.id} has no address`);
  }

  // THE TEMPLATES ARE THE ROUTER'S OWN. Every one of them expands to exactly
  // what `href()` produces for the same route, and that equality is the whole
  // authoring claim: the map is not a second route table, it is the one the
  // app already had. `uri-templates` is the oracle rather than the core's own
  // expansion, so this fails if the core's RFC 6570 subset drifts.
  for (const screen of m.screens) {
    const args = screen.id === "contact" ? { id: "c-0184" } : {};
    if (screen.id === "company") args.slug = "acme-industrial";
    const expanded = uriTemplates(screen.url).fill(args);
    assert.equal(
      expanded,
      href({ screen: screen.id, id: args.id ?? args.slug ?? null }),
      `${screen.id}: the template and href() disagree`,
    );
  }
  // And the declared list is the router's, not a copy of it.
  assert.deepEqual(m.screens, [...SCREEN_SPECS]);
  notes.push(`Manifest.screens: ${m.screens.map((s) => s.url).join(" ")}`);
});

await check("goto is the core's verb, reaches a screen by id, and refuses what it cannot", async () => {
  // The app no longer has a `go`. It declared `screens` and a three-line
  // `navigate` hook, and the core gave it a verb named the same thing in every
  // app that does — which is the point, because an agent that learned `go`
  // here met `navigate` or `open-screen` in the next app.
  const m = driver.manifest();
  assert.equal(m.verbs.some((v) => v.name === "go"), false, "the hand-rolled `go` is back");
  const goto = m.verbs.find((v) => v.name === "goto");
  // A `read`: it changes no data and reports no count. It does move the
  // person's screen, which is what `read` now says out loud a read may do.
  assert.equal(goto.kind, "read");
  assert.deepEqual(goto.args.screen.oneOf, m.screens.map((s) => s.id));
  // Every screen's own arguments, hoisted onto the one verb and all optional,
  // because whether one is required depends on which screen was asked for.
  assert.deepEqual(Object.keys(goto.args), ["screen", "id", "slug"]);
  assert.equal(goto.args.id.optional, true);
  assert.equal(goto.args.slug.optional, true);

  // Driven on a FRESH app, so the walk does not leave the shared one standing
  // somewhere a later check does not expect.
  const walked = createApp().driver;
  for (const id of m.screens.map((s) => s.id)) {
    const args = { screen: id };
    if (id === "contact") args.id = "c-0184";
    if (id === "company") args.slug = "acme-industrial";
    const out = await walked.call("goto", args);
    assert.equal(out.ok, true, `goto ${id} refused: ${out.hint}`);
    assert.equal(out.snapshot.screen, id, `goto ${id} landed elsewhere`);
  }

  // The app's hook refuses a record that is not there, in the app's own
  // vocabulary. That is where a "no" belongs: `screens` lists all six for
  // everybody, because an agent cannot tell a screen that was filtered out of
  // its map from a screen that does not exist.
  const bad = await walked.call("goto", { screen: "company", slug: "no-such-firm" });
  assert.equal(bad.refused, "no-such-company");
  assert.match(bad.hint, /acme-industrial/);
});

await check("the flow is declared, names only real verbs, and nothing runs it", async () => {
  const m = driver.manifest();
  assert.equal(m.flows.length, 1);
  const [flow] = m.flows;
  assert.equal(flow.id, "accept-a-companys-pending-contacts");
  // One line, within the budget Apple's app skills use and for the same
  // reason: it is the field a model picks a flow on, not a paragraph it
  // reasons from.
  assert.ok(flow.describe.length <= 1024 && !/[\n\r]/.test(flow.describe));
  // The cross-screen job the demo exists to exercise, in the order the README
  // used to describe in prose.
  assert.deepEqual(
    flow.steps.map((s) => s.verb),
    ["goto", "sort-companies", "open-company", "select-pending-here", "accept-selected"],
  );
  const names = new Set(m.verbs.map((v) => v.name));
  for (const step of flow.steps) {
    assert.ok(names.has(step.verb), `the flow names ${step.verb}, which does not exist`);
    assert.ok(step.hint.length > 20, `${step.verb} has no hint worth reading`);
  }

  // THERE IS NO TOOL THAT RUNS IT. A flow is a recipe the agent follows with
  // the verbs it already has, so that step four's count can be read by
  // something that can decide what to do about it.
  const tools = toolsFor(m);
  assert.equal(tools.some((t) => t.name === flow.id), false, "the flow became a tool");
  const ran = await createApp().driver.call(flow.id);
  assert.equal(ran.refused, "unknown-verb");

  // It rides in the cached prompt, where it costs nothing per turn, and in the
  // manifest version, because an agent holding the old copy holds the old
  // recipe — one that may cite a verb this version renamed.
  const prompt = systemPrompt(m);
  assert.ok(prompt.includes(flow.describe), "the flow is not in the cached prompt");
  assert.ok(prompt.includes("There is no tool that runs a"), "the prompt does not say so");
  for (const screen of m.screens) {
    assert.ok(prompt.includes(screen.describe), `${screen.id} is not in the cached prompt`);
  }
  notes.push(`systemPrompt with the map and the flow: ${prompt.length} chars, cached once`);
});

await check("the flow says which steps are optional, and which step the plan comes from", async () => {
  // THE THING THE FLAT LIST COULD NOT SAY. This recipe has five steps and only
  // three of them are the job: the first two exist for the case where you do
  // not already know which company it is. That used to be a clause in the
  // middle of step one's hint -- prose about the shape of the recipe hidden
  // inside prose about what `goto` is for -- so a reader could not tell from
  // the structure which steps carry the work. Now two steps declare it and
  // three do not.
  const [flow] = driver.manifest().flows;
  assert.deepEqual(
    flow.steps.map((s) => Boolean(s.skipWhen)),
    [true, true, false, false, false],
  );
  // A SENTENCE AND NOT AN EXPRESSION, and this app is why that is the right
  // answer rather than a compromise: "the person already named the company" is
  // a fact about what was ASKED, and no predicate over this app's state could
  // evaluate it. The conditions that must be ENFORCED are enforced elsewhere --
  // `accept-selected` declares `consumes: "plan"`, and the core refuses it
  // without the token from the count.
  const prompt = systemPrompt(driver.manifest());
  assert.match(
    prompt,
    /\n {2}1\. `goto` \(OPTIONAL — skip it when the person already named the company, in which case go straight to `open-company`\) —/,
  );
  assert.match(prompt, /\n {2}2\. `sort-companies` \(OPTIONAL — skip it when you already know which company you want\) —/);
  assert.match(prompt, /A step marked OPTIONAL may be skipped when the condition beside it holds/);

  // And the one value that crosses two steps, named where the recipe is read.
  // Step 4 counts and mints, step 5 commits and consumes; the mark is DERIVED
  // from `kind` and `consumes` in the manifest, so the app declares it once, on
  // the verb, where the core is the thing that checks it.
  assert.match(
    prompt,
    /\n {2}5\. `accept-selected` \(takes the `plan` token step 4 returned\) —/,
  );
  const counting = driver.manifest().verbs.find((v) => v.name === "select-pending-here");
  const committing = driver.manifest().verbs.find((v) => v.name === "accept-selected");
  assert.equal(counting.kind, "describe");
  assert.equal(committing.consumes, "plan");
  notes.push(
    `flow steps: 5, of which 2 optional; the plan handoff is step 4 → step 5`,
  );
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
  assert.equal(s.screen, "dashboard");
  assert.match(s.where, /^the dashboard/);
  assert.equal(s.page, undefined, "a dashboard must not claim to be a window onto more");
  // The compromise, pinned so it cannot be quietly forgotten: seven metric
  // tiles leave as `rows`, because `Snapshot` has no other shape to put them
  // in. `id` here names a tile, not a record.
  assert.ok(s.rows.length >= 7);
  assert.deepEqual(Object.keys(s.rows[0]).sort(), ["id", "metric", "value"]);
  assert.match(renderSnapshot(s), /rows 8 \(all of them\)/);
  assert.match(s.note, /not a table/);
});

await check("every screen names itself in `screen` and describes itself in `where`", () => {
  // Driven through the store's own screen table rather than by navigating, so
  // one missing field in one screen cannot hide behind another.
  const names = Object.keys(app.screens);
  assert.deepEqual(names.sort(), ["companies", "company", "contact", "contacts", "dashboard", "settings"]);
  for (const name of names) {
    const s = app.screens[name]();
    // `screen` is the identity and is the key of the table it came from, so a
    // `Verb.screen` is checked against the same string the router uses.
    assert.equal(s.screen, name, `${name} reports the wrong screen id`);
    assert.equal(typeof s.where, "string", `${name} has no where`);
    assert.ok(s.where.length > 0, `${name} has an empty where`);
    assert.equal(typeof s.rev, "number", `${name} has no rev`);
    // `where` is prose for a human now and must NOT be the id again: the two
    // fields answer different questions, and a `where` that is just the screen
    // name is a screen that has stopped saying what the person can see.
    assert.notEqual(s.where, name, `${name}'s where is only its own id`);
    // `screen` renders above the prose, so a model diffing two reads sees the
    // navigation on its own line.
    assert.ok(
      renderSnapshot(s).startsWith(`screen: ${name}\nwhere: ${s.where}`),
      `${name} does not render its screen above its where`,
    );
  }
});

await check("the contacts list is a twenty-row window with a real page block", async () => {
  const out = await driver.call("goto", { screen: "contacts" });
  assert.equal(out.ok, true);
  const s = visible();
  assert.equal(s.rows.length, 20);
  assert.deepEqual(s.page, { index: 0, size: 20, total: TOTAL });
  assert.equal(s.screen, "contacts");
  assert.match(s.where, /^the contacts list/);
  assert.equal(typeof s.rev, "number");
  assert.match(renderSnapshot(s), /more rows exist off screen/);
});

await check("read verbs page and search, and rev moves on every one", async () => {
  await driver.call("goto", { screen: "contacts" });
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
  assert.equal(search.snapshot.screen, "contacts");
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
  assert.equal(s.screen, "contact");
  assert.match(s.where, /^Quentin Grunwald \(c-0184\), Finance Partner at Fairmont Dental; /);
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

  await driver.call("goto", { screen: "dashboard" });
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
  await driver.call("goto", { screen: "dashboard" });
  const start = visible().rev;

  for (const screen of LANDINGS) {
    const out = await driver.call("goto", { screen });
    assert.equal(out.ok, true, `goto ${screen} refused`);
    // Where it landed is a string equality now rather than a prefix match on
    // prose. That is `Snapshot.screen`'s whole job.
    assert.equal(
      out.snapshot.screen,
      screen,
      `goto ${screen} landed on ${JSON.stringify(out.snapshot.screen)}`,
    );
  }
  assert.ok(visible().rev > start, "navigating did not move rev");

  // A record screen IS offered now — `go` could only reach the four landings,
  // because an argument required on two of six values had nowhere to live in
  // one `ArgSpec` — and the core refuses the pair with no record, naming the
  // screen that wanted the argument.
  const record = await driver.call("goto", { screen: "contact" });
  assert.equal(record.refused, "bad-screen-argument");
  assert.match(record.hint, /the `contact` screen needs its own arguments and missing/);
  const byId = await driver.call("goto", { screen: "contact", id: "c-0184" });
  assert.equal(byId.ok, true);
  assert.equal(byId.snapshot.screen, "contact");
  // And a screen that is not one of the app's six is the core's own argument
  // check, which lists every accepted value rather than counting them.
  const nowhere = await driver.call("goto", { screen: "billing" });
  assert.equal(nowhere.refused, "bad-argument");
  assert.match(nowhere.hint, /"dashboard", "contacts", "contact", "companies", "company", "settings"/);

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

await check("the core refuses a scoped verb off its screen, naming BOTH screens", async () => {
  // The hand-rolled guard named one screen and left the agent to guess the
  // other. The core names where you are AND where the verb lives, which is the
  // difference between a dead end and a next move.
  await driver.call("goto", { screen: "settings" });
  for (const [name, wants, args] of [
    ["search", "contacts", { q: "Ada" }],
    ["sort-companies", "companies", { by: "pending" }],
    ["show-status", "company", { status: "all" }],
    ["select-pending-here", "company", {}],
  ]) {
    const out = await driver.call(name, args);
    assert.equal(out.ok, false, `${name} worked on the settings screen`);
    assert.equal(out.refused, "wrong-screen", `${name} refused ${out.refused}`);
    assert.match(out.hint, /you are on the `settings` screen/);
    assert.ok(
      out.hint.includes(`\`${wants}\` screen`),
      `${name}'s hint does not name the screen it wants: ${JSON.stringify(out.hint)}`,
    );
    // And the screen it refused from still comes back, so the agent need not
    // read again to find out where it is.
    assert.equal(out.snapshot.screen, "settings");
  }
  notes.push("wrong-screen from the core names the live screen and the verb's own");
});

await check("the two pagers are refused by the core on a screen with no pages, naming both of theirs", async () => {
  // The workaround this replaced: these two verbs work on two screens, and
  // while `Verb.screen` was one string they declared neither and refused an
  // `no-pages-here` of the app's own invention. The core answers it now, and
  // the hint names every screen they do work on rather than sending an agent
  // to the first of them.
  for (const screen of ["settings", "dashboard"]) {
    await driver.call("goto", { screen });
    for (const name of ["next-page", "prev-page"]) {
      const out = await driver.call(name);
      assert.equal(out.ok, false, `${name} worked on the ${screen} screen`);
      assert.equal(out.refused, "wrong-screen", `${name} refused ${out.refused}`);
      assert.match(out.hint, new RegExp(`you are on the \`${screen}\` screen`));
      assert.match(out.hint, /`contacts` and `company` screens/);
      assert.match(out.hint, /Go to one of those first/);
    }
  }
  // And they really do work on both of the screens that page.
  await driver.call("goto", { screen: "contacts" });
  assert.equal((await driver.call("next-page")).snapshot.page.index, 1);
  await driver.call("open-company", { company: "Grayson Robotics" });
  const paged = await driver.call("next-page");
  assert.equal(paged.ok, true, "a company's contact list stopped paging");
  assert.equal(paged.snapshot.screen, "company");
  assert.equal(paged.snapshot.page.index, 1);
  await driver.call("goto", { screen: "contacts" });
});

await check("the companies list rolls up from the same rows the contacts list shows", async () => {
  await driver.call("goto", { screen: "companies" });
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
  await driver.call("goto", { screen: "companies" });
  const listed = visible().rows.find((r) => r.name === "Berenson Health");
  assert.ok(listed, "Berenson Health is not on the companies list");
  const expected = listed.pending;
  assert.ok(expected > 0);

  const opened = await driver.call("open-company", { company: "Berenson Health" });
  assert.equal(opened.ok, true);
  assert.equal(opened.snapshot.screen, "company");
  assert.match(opened.snapshot.where, /^Berenson Health — /);
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

  // The commit takes the describe's plan token, which is the receipt for the
  // count asserted just above. Without it `accept-selected` is refused, and
  // that is the whole point of the field: the number that was read is the
  // number that moves.
  assert.match(picked.plan, /^dkp1\./, "select-pending-here minted no plan");
  const done = await driver.call("accept-selected", {}, { plan: picked.plan });
  assert.equal(done.ok, true);
  assert.equal(done.count, expected);

  // And the roll-up moved with it, on this screen and on the companies list.
  assert.match(done.snapshot.where, /0 pending/);
  await driver.call("goto", { screen: "companies" });
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

  await driver.call("goto", { screen: "dashboard" });
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
  await driver.call("goto", { screen: "settings" });
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
  await driver.call("goto", { screen: "contacts" });
  const after = visible();
  assert.equal(after.rows.length, 50, "the settings screen did not reach the contacts table");
  assert.equal(after.page.size, 50);
  await driver.call("goto", { screen: "settings" });
  await driver.call("set-setting", { name: "rows-per-page", value: "20" });
  await driver.call("goto", { screen: "contacts" });
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
  assert.equal(s.screen, "contact");
  assert.match(s.where, /\(c-0184\)/);
  assert.ok(s.rows.length >= 3);
  // Seeded from the id alone, so a cold deep link shows the same history as
  // clicking through to it.
  assert.deepEqual(s.rows, deep.historyFor("c-0184").map((e) => ({ id: e.id, when: e.when, what: e.what, who: e.who })));

  const missing = createApp();
  missing.navigate(parse("#/contacts/c-9999"), { record: false });
  assert.equal(missing.visible().screen, "contact");
  assert.match(missing.visible().where, /^no such contact/);
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

  const done = await driver.call("accept-selected", {}, { plan: picked.plan });
  assert.equal(done.ok, true);
  assert.equal(done.count, selectedCount);
  // Everything the describe matched is now accepted, and nothing else moved.
  const accepted = store.rows.filter(
    (r) => r.company === "Grayson Robotics" && r.status === "accepted",
  ).length;
  assert.ok(accepted >= selectedCount);

  const again = await driver.call("clear-selection");
  assert.equal(again.count, 0, "clear-selection must report 0, not omit the count");

  // With a FRESH plan, so what comes back is the app's own refusal and not the
  // core's. `clear-selection` is a `describe` that reports 0, so it mints a
  // token like any other — a plan for an empty selection is a real plan, and
  // "commit on nothing" is a decision an agent can make and should make
  // against a receipt like any other.
  const empty = await driver.call("accept-selected", {}, { plan: again.plan });
  assert.equal(empty.ok, false);
  assert.equal(empty.refused, "nothing-selected");
});

await check("the count a person approved is the set that moves, or nothing moves", async () => {
  // THE CHECK THIS WHOLE MECHANISM EXISTS FOR, and the one that would have
  // failed before it.
  //
  // The library's headline claim was "two calls, so a count is always seen
  // before data moves". It was not true. `accept-selected` re-reads the
  // selection when it runs, so between the describe and the commit a person
  // can tick a row, page the list, or a websocket can land — and then the
  // number the agent read, and a person approved, was not the set that changed.
  // Django shipped that exact bug for fifteen years: `select_across` silently
  // lost, so a confirmed bulk action ran on page one only.
  //
  // So: take the count, move the selection behind the agent's back, commit with
  // the receipt it was given, and assert that the refusal names BOTH numbers
  // and that nothing was accepted.
  await driver.call("goto", { screen: "contacts" });
  await driver.call("clear-selection");

  const picked = await driver.call("select-where", { company: "Halloway Foods" });
  assert.equal(picked.ok, true);
  const counted = picked.count;
  assert.ok(counted > 20, "the point is a selection larger than the screen");
  assert.match(picked.plan, /^dkp1\./, "the describe minted no plan");

  // Behind the agent's back: not through a verb, the way a person's click
  // reaches this store. One row goes in, so the count moves by one and the
  // identity moves with it — a swap of one row for another would move the
  // identity and not the count, which is why the token binds the identity and
  // not the number.
  const extra = store.rows.find((r) => r.company !== "Halloway Foods");
  const extraWas = extra.status;
  const acceptedBefore = store.rows.filter(
    (r) => r.company === "Halloway Foods" && r.status === "accepted",
  ).length;
  store.selected.add(extra.id);

  const out = await driver.call("accept-selected", {}, { plan: picked.plan });
  assert.equal(out.ok, false, "a commit ran on a selection nobody counted");
  assert.equal(out.refused, "stale-plan");
  // BOTH numbers, the way `wrong-screen` names both screens. This is the
  // sentence a model repeats to the person who approved the first one.
  assert.match(
    out.hint,
    new RegExp(`You were shown ${counted}; the selection is now ${counted + 1}\\.`),
    `the refusal did not name both counts: ${JSON.stringify(out.hint)}`,
  );
  // And the thing that actually matters: nothing moved. Measured against what
  // was there a moment ago rather than against zero — this table starts with
  // contacts in every status, and a check that assumed an empty one would be
  // asserting on the fixture instead of on the refusal.
  assert.equal(
    store.rows.filter((r) => r.company === "Halloway Foods" && r.status === "accepted").length,
    acceptedBefore,
    "the rows the agent counted were accepted anyway",
  );
  assert.equal(extra.status, extraWas, "the row nobody counted was changed");

  // The repair works, which is what keeps the refusal from being a dead end:
  // count again, read the new number, commit on that.
  const again = await driver.call("select-where", { company: "Halloway Foods" });
  assert.equal(again.count, counted, "the re-count moved for a reason this check did not cause");
  const done = await driver.call("accept-selected", {}, { plan: again.plan });
  assert.equal(done.ok, true);
  assert.equal(done.count, counted);
  assert.equal(
    store.rows.filter((r) => r.company === "Halloway Foods" && r.status === "accepted").length,
    counted,
    "the repair accepted a different set from the one it counted",
  );
  // And the receipt is spent: a second commit on it cannot happen, which is
  // what stops one approved count from moving twice.
  const twice = await driver.call("accept-selected", {}, { plan: again.plan });
  assert.equal(twice.refused, "stale-plan");

  await driver.call("clear-selection");
  notes.push(
    `stale-plan: shown ${counted}, selection became ${counted + 1}, nothing accepted`,
  );
});

await check("both bulk commits demand a plan, so an improvising agent cannot find a bare one", async () => {
  // The hole an eval found on its first run. `accept-selected` declared
  // `consumes: "plan"` and `decline-selected` did not, and an agent asked for a
  // job this app cannot do — "archive everyone who has not replied in six
  // months" — improvised: it selected a company and called the sibling with no
  // receipt, and 403 rows changed status with no count read and nothing gated.
  //
  // The verb an agent reaches for when it is off its intended path is the
  // least-declared one, which is exactly when the receipt matters most. So the
  // rule is all or none, and this pins it for this app's surface rather than
  // for the one verb the demo script happens to use.
  const selectionCommits = driver
    .manifest()
    .verbs.filter((v) => v.kind === "commit" && v.args === undefined);
  assert.deepEqual(
    selectionCommits.map((v) => v.name).sort(),
    ["accept-selected", "decline-selected"],
    "a commit with no arguments acts on the selection; if this list grew, it needs a plan",
  );
  for (const v of selectionCommits) {
    assert.equal(v.consumes, "plan", `${v.name} can move the selection with no counted plan`);
  }

  // And the improvised call is refused, with a hint that does NOT tell it to go
  // and select something.
  await driver.call("goto", { screen: "contacts" });
  const picked = await driver.call("select-where", { company: "Halloway Foods" });
  const before = store.rows.filter((r) => r.status === "declined").length;
  const improvised = await driver.call("decline-selected");
  assert.equal(improvised.refused, "stale-plan");
  assert.equal(store.rows.filter((r) => r.status === "declined").length, before);
  // It works with the receipt, so the refusal above is the check and not the
  // verb being broken.
  const done = await driver.call("decline-selected", {}, { plan: picked.plan });
  assert.equal(done.ok, true);
  await driver.call("clear-selection");
});

await check("a commit with no plan and nothing selected is told to ask, not to go and select something", async () => {
  // The second thing the eval found. "Accept the selected contacts" with
  // nothing selected is answered `stale-plan` rather than the app's own
  // `nothing-selected`, because the token check runs before the verb body —
  // and both outcomes are correct, since nothing moved and the agent was told
  // why. The problem was the wording: the generic repair says "run the describe
  // again", and with an empty selection the only describe that mints a
  // non-empty plan is one that INVENTS a selection. That is the worst possible
  // advice in the one situation where improvising is most expensive, as the
  // check above shows.
  await driver.call("clear-selection");
  const out = await driver.call("accept-selected");
  assert.equal(out.refused, "stale-plan");
  assert.match(out.hint, /Nothing is selected right now/);
  assert.match(out.hint, /do NOT select something near enough/);
  // And it is NOT the sentence for a plan that went out of date.
  assert.ok(
    !out.hint.includes("Do not re-send this one"),
    "an agent with no plan was told to stop re-sending the plan it does not have",
  );
});

await check("a stale rev is refused rather than applied", async () => {
  await driver.call("goto", { screen: "contacts" });
  const rev = visible().rev;
  await driver.call("next-page");
  const stale = await driver.call("prev-page", {}, { rev });
  assert.equal(stale.ok, false);
  assert.equal(stale.refused, "stale");
  await driver.call("search", { q: "" });
});

await check("a call that says which screen it meant is refused when the person moved", async () => {
  // The live bug this used to VERIFY: `next-page` sent with no `rev`, after
  // the person clicked away, paged a different company's contact list and
  // answered `ok`. Both screens page, so nothing about the call was wrong —
  // the call simply never said which list it was for. `CallOptions.screen` is
  // how it says so, and it needs no `Verb.screen` to work.
  await driver.call("goto", { screen: "contacts" });
  await driver.call("next-page");
  const read = visible();
  assert.equal(read.screen, "contacts");

  // The person clicks away while the agent is thinking.
  await driver.call("open-company", { company: "Cordova Logistics" });

  // Naming the screen it read is the better defence: it says what is actually
  // wrong, and the fix it implies is "navigate back", not "read again".
  const aimed = await driver.call("next-page", {}, { screen: read.screen });
  assert.equal(aimed.ok, false, "the call paged a list the agent had never seen");
  assert.equal(aimed.refused, "wrong-screen");
  assert.match(aimed.hint, /you believed you were on the `contacts` screen/);
  assert.match(aimed.hint, /the app is on `company`/);
  assert.equal(aimed.snapshot.page.index, 0, "the refused call paged anyway");

  // Quoting the rev still works and is a different answer: the number moved.
  // Checked AFTER the screen, so an agent that is in the wrong place is told
  // that rather than sent to re-read a screen it should be leaving.
  const guarded = await driver.call("next-page", {}, { rev: read.rev });
  assert.equal(guarded.refused, "stale");
  const both = await driver.call("next-page", {}, { screen: read.screen, rev: read.rev });
  assert.equal(both.refused, "wrong-screen", "the wider mistake must win");

  // With neither, it still pages whatever it arrived at. That is the opt-out,
  // and it is the behaviour every call had before these two fields existed.
  const unguarded = await driver.call("next-page");
  assert.equal(unguarded.ok, true);
  assert.equal(unguarded.snapshot.screen, "company");
  assert.equal(unguarded.snapshot.page.index, 1);
  notes.push("next-page aimed at `contacts` after a navigation: wrong-screen, naming both");

  await driver.call("goto", { screen: "contacts" });
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
    // Read off the previous turn, the way a model reads it. `accept-selected`
    // declares `consumes: "plan"`, so a scripted call with empty args would be
    // refused `stale-plan` — which is the feature working, and would make this
    // check about the wrong thing.
    (messages) => ({
      calls: [{ id: "t2", name: "accept-selected", args: { plan: lastPlan(messages) } }],
    }),
    { text: "Done." },
  ];
  let step = 0;

  const out = await drive(driver, {
    think: async ({ system, tools, messages }) => {
      seen.push({ system, tools: JSON.stringify(tools), messages: messages.length });
      const next = script[step++];
      return typeof next === "function" ? next(messages) : next;
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
      return {
        calls: [{ id: "x1", name: "accept-selected", args: { plan: lastPlan(messages) } }],
      };
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

  // The reversible commit is not shouted at, and the irreversible one still
  // is. That distinction is the whole point of the flag: a banner that fires
  // on a page-size change is a banner a model learns to read past.
  const setting = tools.find((t) => t.name === "set-setting");
  assert.match(setting.description, /COMMIT \(reversible\)/);
  assert.ok(
    !/THIS CHANGES DATA AND MAY BE IRREVERSIBLE/.test(setting.description),
    "a reversible commit is still being shouted about",
  );
  // And a scoped verb says where it works in the CACHED half, so a
  // well-briefed agent never makes the call that would be refused.
  const scoped = tools.find((t) => t.name === "select-pending-here");
  assert.match(scoped.description, /ONLY ON THE `company` SCREEN/);
  // A verb on two screens names both, in the same cached half. Naming one of
  // two would be worse than naming none: a model told `next-page` is only on
  // the contacts list navigates off the company list it was already standing
  // on to do something it could have done where it was.
  const pager = tools.find((t) => t.name === "next-page");
  assert.match(pager.description, /ONLY ON THE `contacts` AND `company` SCREENS/);
  // `screen` is hoisted onto every verb that has not claimed the name itself,
  // exactly as `rev` is. `goto` has claimed it, so `goto` keeps its own — and
  // it is REQUIRED there, which is how you can tell the app's argument from
  // the hoisted one, since the hoisted one is always optional.
  assert.equal(scoped.inputSchema.properties.screen.type, "string");
  assert.deepEqual(tools.find((t) => t.name === "goto").inputSchema.required, ["screen"]);
  // The six screen ids are in the cached tool schema as an enum, so a model
  // can enumerate the app's screens even from a client that drops the
  // instructions text.
  assert.deepEqual(tools.find((t) => t.name === "goto").inputSchema.properties.screen.enum, [
    "dashboard",
    "contacts",
    "contact",
    "companies",
    "company",
    "settings",
  ]);

  // The manifest's shape, pinned so a new field cannot arrive unnoticed.
  const manifest = driver.manifest();
  assert.deepEqual(Object.keys(manifest).sort(), [
    "app",
    "flows",
    "instructions",
    "screens",
    "verbs",
    "version",
  ]);
  const allowed = [
    "name",
    "describe",
    "kind",
    "at",
    "screen",
    "reversible",
    // HOW a verb may be called, beside WHERE: `"plan"` on a commit that will
    // only run with the token from the describe that counted its selection.
    "consumes",
    "args",
    "refuses",
  ];
  for (const verb of manifest.verbs) {
    assert.deepEqual(
      Object.keys(verb).filter((k) => !allowed.includes(k)),
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
    (messages) => ({
      calls: [{ id: "w2", name: "accept-selected", args: { plan: lastPlan(messages) } }],
    }),
    { text: "Accepted them." },
  ];
  let step = 0;

  const panel = mountWidget(wApp.driver, {
    document: fake,
    think: async ({ messages }) => {
      const next = script[step++];
      return typeof next === "function" ? next(messages) : next;
    },
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
    (messages) => ({
      calls: [{ id: "n2", name: "accept-selected", args: { plan: lastPlan(messages) } }],
    }),
    { text: "You said no, so I stopped." },
  ];
  let step = 0;
  const panel = mountWidget(wApp.driver, {
    document: fake,
    think: async ({ messages }) => {
      const next = script[step++];
      return typeof next === "function" ? next(messages) : next;
    },
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

/**
 * Who approves a commit on the tab that is published to the relay.
 *
 * A function the checks below swap out, because the interesting thing about
 * the gate is not that it exists but that every answer it can give is
 * reachable FROM OUTSIDE. Before it moved into `mount()`, the confirmation
 * lived in the in-page loop: the panel asked the person, and
 * `POST /dk/tabs/<id>/call {"name":"accept-selected"}` from any other process
 * ran with nothing in the way.
 *
 * @type {(req: unknown) => unknown}
 */
let approver = () => true;
const asked = [];

const connected = createApp(() => {}, {
  approve: (req) => {
    asked.push(req.name);
    return approver(req);
  },
});
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
  // The other half of the briefing argument, over the wire: an agent that
  // arrives here and never sees the widget still reads the app's own words,
  // and reads them once rather than in every snapshot.
  assert.match(manifest.body.instructions, /status moves new/);
  // And so are the map and the recipe. The MAP is the one that used to be
  // impossible out here: the prose version lived in `instructions`, which at
  // least crossed the relay, but before that it was in `Snapshot.note` and an
  // outside agent paid for it on every turn. It is data now, fetched once.
  assert.deepEqual(
    manifest.body.screens.map((x) => x.id),
    ["dashboard", "contacts", "contact", "companies", "company", "settings"],
  );
  assert.equal(manifest.body.screens.find((x) => x.id === "company").url, "#/companies/{slug}");
  assert.equal(manifest.body.flows.length, 1);
  assert.equal(manifest.body.flows[0].steps[0].verb, "goto");
  assert.equal(
    manifest.body.verbs.find((v) => v.name === "select-pending-here").screen,
    "company",
  );
  assert.equal(manifest.body.verbs.find((v) => v.name === "set-setting").reversible, true);

  // The URL the relay is listing is the one `hello` carried, and `hello` is
  // sent on connect and on reconnect only. Navigating does not resend it, so
  // this is already wrong the moment the tab moves; see the report.
  assert.equal(listed.url, "/examples/contacts/app/#/contacts");
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "goto", args: { screen: "settings" } });
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
      name: "goto",
      args: { screen },
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true, `go ${screen} refused over the relay`);
    assert.ok(out.body.snapshot.where.length > 0);
  }
  const snap = await getJson(`${BASE}/dk/tabs/${tabId}/snapshot`);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.screen, "settings");
  assert.ok(snap.body.where.length > 0, "a screen id is not a substitute for the prose");
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

  const done = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "accept-selected",
    plan: picked.body.plan,
  });
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
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "goto", args: { screen: "dashboard" } });
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "search",
    args: { q: "Ada" },
  });
  assert.equal(out.status, 200, "a wrong-screen refusal is still a 200");
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, "wrong-screen");
  assert.match(out.body.hint, /you are on the `dashboard` screen/);
  assert.match(out.body.hint, /`contacts` screen/);
  assert.ok(out.body.snapshot, "a refusal must still carry the screen");
  assert.equal(out.body.snapshot.screen, "dashboard");
});

await check("a call that names a stale screen is refused over the relay too", async () => {
  // `screen` on the wire, which is the field that makes the in-page defence
  // reachable from outside: the agent sends the `screen` it last read and the
  // core answers before it looks at `rev` or the arguments.
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "goto", args: { screen: "contacts" } });
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "next-page",
    screen: "company",
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, "wrong-screen");
  assert.match(out.body.hint, /you believed you were on the `company` screen/);
  assert.equal(out.body.snapshot.page.index, 0, "the refused call paged anyway");
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
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "goto", args: { screen: "contacts" } });
  const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "prev-page" });
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, false);
  assert.equal(out.body.refused, "at-first-page");
  assert.ok(out.body.snapshot, "an app refusal must still carry a snapshot");
});

await check("a stale rev through the relay is refused as stale", async () => {
  await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "goto", args: { screen: "contacts" } });
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
  // The plan token rides out on the describe's result and back in on the
  // commit's body, over real HTTP and through the real relay. A hop that
  // stripped it would leave this commit permanently uncallable from outside —
  // which is the failure the two-relay forwarding rule exists to prevent.
  assert.match(picked.body.plan, /^dkp1\./, "the relay did not forward the minted plan");
  const done = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "accept-selected",
    plan: picked.body.plan,
  });
  assert.equal(done.body.ok, true);
  assert.equal(done.body.count, expected);
  const accepted = connected.store.rows.filter(
    (r) => r.company === "Delacroix Media" && r.status === "accepted",
  ).length;
  assert.ok(accepted >= expected);
});

await check("a relay commit the gate declines is refused declined-by-user, and the rows do not move", async () => {
  // THE GAP, CLOSED, over real HTTP. This is the same POST as the check above
  // and the only difference is what the approver answered.
  const picked = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "select-where",
    args: { company: "Grayson Robotics", status: "pending" },
  });
  const before = connected.store.rows.filter(
    (r) => r.company === "Grayson Robotics" && r.status === "pending",
  ).length;
  assert.ok(picked.body.count > 0, "nothing was selected, so this would prove nothing");

  approver = () => "narrow it to one owner first";
  try {
    const out = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
      name: "accept-selected",
      plan: picked.body.plan,
    });
    // 200 with ok:false, like any other refusal: the app said no on purpose.
    assert.equal(out.status, 200);
    assert.equal(out.body.refused, "declined-by-user");
    // The reason reaches the agent, which is the whole reason a decision is
    // not a boolean. "Declined" sends a model looking for another way to do
    // the same thing.
    assert.match(out.body.hint, /narrow it/);
    // And a snapshot, because the app is still there — unlike a transport
    // refusal, which has none.
    assert.ok(out.body.snapshot, "an app refusal must carry the screen");
  } finally {
    approver = () => true;
  }

  const after = connected.store.rows.filter(
    (r) => r.company === "Grayson Robotics" && r.status === "pending",
  ).length;
  assert.equal(after, before, "a declined commit moved rows anyway");
});

await check("a second relay call cannot race the open question; it is refused approval-pending", async () => {
  // webmachinelearning/webmcp#288, over the wire. The call an agent is most
  // likely to make while a question is open is the Approve button of the
  // dialog asking it, and the second most likely is the same commit again. The
  // driver answers both the same way: nothing runs while somebody is being
  // asked.
  let answer;
  // A fresh plan first, because the plan check runs BEFORE the approval gate:
  // nobody should be asked to approve a commit that was going to be refused
  // anyway, so a commit with a stale token never opens a question at all.
  const planned = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
    name: "select-where",
    args: { company: "Halloway Foods", status: "pending" },
  });
  approver = () => new Promise((resolve) => (answer = resolve));
  try {
    const held = postJson(`${BASE}/dk/tabs/${tabId}/call`, {
      name: "accept-selected",
      plan: planned.body.plan,
    });
    // Wait for the question to actually be open before trying to get round it.
    for (let i = 0; i < 100 && answer === undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(answer, "the approval never opened");

    // `press` is the verb the issue above is about; this app has no controls
    // layer, so `search` stands in for "any other call at all", which is the
    // rule actually being pinned.
    const sneak = await postJson(`${BASE}/dk/tabs/${tabId}/call`, {
      name: "search",
      args: { q: "anything" },
    });
    assert.equal(sneak.body.refused, "approval-pending");
    assert.match(sneak.body.hint, /approve or confirm control/);

    answer("not this time");
    const out = await held;
    assert.equal(out.body.refused, "declined-by-user");
  } finally {
    approver = () => true;
  }

  // Released, so one question does not wedge the tab for everybody.
  const after = await postJson(`${BASE}/dk/tabs/${tabId}/call`, { name: "search", args: { q: "" } });
  assert.equal(after.body.ok, true);
});

await check("an approval nobody answers is approval-timeout, which is not the relay's timeout", async () => {
  // The two must stay tellable apart. The relay's `timeout` means the call was
  // accepted and no answer came back, so the commit MAY ALREADY HAVE RUN and
  // the only safe move is to read the screen; `approval-timeout` means the
  // question lapsed, so the verb was never reached. Different slug, and a
  // snapshot where the transport refusal has none — the two documented signals
  // both agree.
  const lapsing = createApp(() => {}, {
    approve: () => new Promise(() => {}),
    approvalTimeout: 20,
  });
  const picked = await lapsing.driver.call("select-where", {
    company: "Acme Industrial",
    status: "pending",
  });
  const before = lapsing.store.rows.filter((r) => r.status === "accepted").length;

  // With the plan, so the question is actually asked: the plan check is before
  // the gate, so a commit holding a stale token is refused without troubling
  // anybody — which is deliberate, and would make this check about the wrong
  // refusal.
  const out = await lapsing.driver.call("accept-selected", {}, { plan: picked.plan });
  assert.equal(out.refused, "approval-timeout");
  assert.ok(out.snapshot, "an approval timeout happened in the app and has a screen to report");
  assert.match(out.hint, /did not\s+run/);
  assert.equal(
    lapsing.store.rows.filter((r) => r.status === "accepted").length,
    before,
    "a lapsed approval let the commit through",
  );

  // The contrast, in the same check: the relay's timeout has no snapshot at
  // all, which is how a client tells "nothing ran" from "nobody knows".
  const unknown = await postJson(`${BASE}/dk/tabs/not-a-tab/call`, { name: "search", args: { q: "x" } });
  assert.equal(unknown.body.snapshot, undefined);
});

await check("publishing a driver whose commits nobody approves is refused outright", async () => {
  // Three deliberate acts to let an outside agent change data: a commit verb,
  // a relay connection, and a statement of who approves. This app has six
  // commits that have not declared `reversible`, so the third one is not
  // optional — exactly as a relay with remote access and no way to identify
  // callers refuses to start rather than serving.
  const undeclared = createApp();
  assert.throws(
    () =>
      connect(undeclared.driver, {
        relay: BASE,
        app: "Northwind CRM",
        EventSource: HttpEventSource,
        storage: null,
      }),
    (err) => {
      assert.match(err.message, /refusing to connect/);
      assert.match(err.message, /accept-selected/);
      assert.match(err.message, /"unattended"/);
      return true;
    },
  );
  // And the live tab in this file got through because it declared one.
  assert.equal(connected.driver.approval.policy, "hook");
  assert.ok(asked.length > 0, "the gate was never reached from outside");
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
