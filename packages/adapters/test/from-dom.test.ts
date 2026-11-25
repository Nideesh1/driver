/**
 * The specification for the one-call integration. These tests drive the REAL
 * `mount()` from the core rather than asserting on the shape `fromDom`
 * returns, because the shape is not the claim being made -- the claim is that
 * a messy app's entire integration is one object literal and the core accepts
 * it. A test that checked the literal would still pass if `mount` stopped
 * taking it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "../../core/src/index.ts";
import { fromDom } from "../src/index.ts";
import {
  childListChange,
  FakeDocument,
  FakeMutationObserver,
  FakeTimers,
  html,
} from "./fake-dom.ts";

const MARKUP = `
  <div id="app">
    <table id="invoices" data-dk-total="3412" data-dk-page="0">
      <thead><tr><th>Invoice</th><th>State</th></tr></thead>
      <tbody>
        <tr data-dk-id="a1" class="row selected"><td>INV-1</td><td>paid</td></tr>
        <tr data-dk-id="b2" class="row"><td>INV-2</td><td>due</td></tr>
      </tbody>
    </table>
    <button data-dk="next-page">Next</button>
    <button data-dk="accept" disabled>Accept</button>
  </div>`;

/** The whole of a messy app's integration, in the shape the README sells. */
function app(extra: Record<string, unknown> = {}) {
  const root = html(MARKUP);
  const doc = new FakeDocument(root);
  const timers = new FakeTimers();
  const dom = fromDom({
    where: "invoices",
    table: "#invoices",
    clicks: {
      "next-page": { describe: "show the next page of invoices", kind: "read" },
      accept: { describe: "accept the open invoice", kind: "commit" },
    },
    document: doc,
    MutationObserver: FakeMutationObserver,
    timers,
    ...extra,
  });
  const driver = mount({ app: "Invoices", ...dom });
  return { root, doc, timers, dom, driver, observer: FakeMutationObserver.last() };
}

test("fromDom produces a {verbs, visible} that mount() accepts and drives", async () => {
  const { root, driver, dom } = app();

  const result = await driver.call("next-page");

  assert.equal(result.ok, true);
  assert.equal(root.querySelector(`[data-dk="next-page"]`)!.clicks, 1);
  // And the manifest the core built out of it is the static half an agent
  // caches: names, descriptions, kinds, no selectors anywhere.
  assert.deepEqual(
    driver.manifest().verbs.map((v) => [v.name, v.kind]),
    [["next-page", "read"], ["accept", "commit"]],
  );
  dom.stop();
});

test("the snapshot mount() serves carries the rendered rows, the page and a rev", async () => {
  const { driver, dom } = app();

  const snapshot = driver.snapshot();

  assert.equal(snapshot.where, "invoices");
  assert.ok(snapshot.rev >= 1);
  assert.deepEqual(snapshot.rows, [
    { id: "a1", invoice: "INV-1", state: "paid" },
    { id: "b2", invoice: "INV-2", state: "due" },
  ]);
  // The table declares its total, so `page` is present and the agent knows the
  // two rows it can see are a window onto 3412.
  assert.deepEqual(snapshot.page, { index: 0, size: 2, total: 3412 });
  dom.stop();
});

test("a click verb refuses on a disabled control instead of clicking it and reporting ok", async () => {
  // Clicking a disabled button succeeds, does nothing, and the call reports
  // ok. The agent then reports success to the user. This is the failure the
  // whole click tier has to guard, so the guard is on by default.
  const { root, driver, dom } = app();

  const result = await driver.call("accept");

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refused, "disabled");
  assert.equal(root.querySelector(`[data-dk="accept"]`)!.clicks, 0);
  // And it was declared in the cached half, so an agent could have known.
  assert.deepEqual(driver.manifest().verbs[1]!.refuses, ["disabled"]);
  dom.stop();
});

test("aria-disabled counts as disabled, because plenty of apps never set the real attribute", async () => {
  const root = html(`
    <div id="app">
      <table id="t"><tbody><tr><td>INV-1</td></tr></tbody></table>
      <button data-dk="accept" aria-disabled="true">Accept</button>
    </div>`);
  const dom = fromDom({
    where: "invoices",
    table: "#t",
    clicks: { accept: { describe: "accept", kind: "commit" } },
    document: new FakeDocument(root),
    MutationObserver: FakeMutationObserver,
    timers: new FakeTimers(),
  });
  const driver = mount({ app: "Invoices", ...dom });

  const result = await driver.call("accept");

  assert.equal(result.ok === false && result.refused, "disabled");
  dom.stop();
});

test("a change to the observed table moves rev, and the core then refuses a stale call", async () => {
  // The end-to-end claim of this package: an app with no store gets working
  // staleness out of a MutationObserver and one object literal. If this test
  // breaks, tier 3 does not deliver what the README says it delivers.
  const { driver, dom, timers, observer } = app();
  const before = driver.snapshot().rev;

  observer.emit(childListChange);
  timers.advance(100);

  const after = driver.snapshot().rev;
  assert.ok(after > before, `rev must move: ${before} -> ${after}`);

  const stale = await driver.call("next-page", {}, { rev: before });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.refused, "stale");

  const fresh = await driver.call("next-page", {}, { rev: after });
  assert.equal(fresh.ok, true);
  dom.stop();
});

test("a missing table yields a snapshot with no rows and a note, never rows: []", () => {
  // `rows: []` says "there are no records". Absent `rows` says "this snapshot
  // carries no row information", which is the truth while a view is mounting.
  // Only one of those two keeps an agent from concluding an invoice does not
  // exist.
  const root = html(`<div id="app"><div id="anchor"></div></div>`);
  const dom = fromDom({
    where: "invoices",
    table: "#not-rendered-yet",
    rev: { target: "#anchor" },
    document: new FakeDocument(root),
    MutationObserver: FakeMutationObserver,
    timers: new FakeTimers(),
  });

  const snapshot = mount({ app: "Invoices", ...dom }).snapshot();

  assert.equal("rows" in snapshot, false);
  assert.match(snapshot.note ?? "", /not a claim the screen is empty/);
  dom.stop();
});

test("hand-written verbs sit beside click verbs in one mount", async () => {
  // Climbing the ladder has to be possible one verb at a time. A verb that
  // calls a real function is strictly better than one that clicks a button,
  // and nothing here should make an app choose between having all of one kind
  // or all of the other.
  let accepted: string[] = [];
  const { driver, dom } = app({
    verbs: [
      {
        name: "accept-matching",
        describe: "accept every invoice in a state",
        kind: "commit",
        args: { state: { type: "string", describe: "state to accept" } },
        run: ({ state }: { state: string }) => {
          accepted.push(state);
        },
      },
    ],
  });

  const result = await driver.call("accept-matching", { state: "due" });

  assert.equal(result.ok, true);
  assert.deepEqual(accepted, ["due"]);
  assert.deepEqual(driver.manifest().verbs.map((v) => v.name), [
    "next-page",
    "accept",
    "accept-matching",
  ]);
  dom.stop();
});

test("an app that already has a counter passes it instead, and no observer is made", () => {
  // Tier 1 and tier 3 mixed: real rev, DOM rows. A real counter is better than
  // a mutation count, and taking one must not cost the rest of the package.
  const made = FakeMutationObserver.instances.length;
  let rev = 41;
  const root = html(MARKUP);
  const dom = fromDom({
    where: "invoices",
    table: "#invoices",
    rev: () => ++rev,
    document: new FakeDocument(root),
  });

  const driver = mount({ app: "Invoices", ...dom });

  assert.equal(driver.snapshot().rev, 42);
  assert.equal(driver.snapshot().rev, 43);
  assert.equal(FakeMutationObserver.instances.length, made, "no observer should be constructed");
  dom.stop(); // still safe to call
});

test("a fixed numeric rev is accepted, and means the app is opting out of staleness", () => {
  const root = html(MARKUP);
  const dom = fromDom({ where: "invoices", table: "#invoices", rev: 1, document: new FakeDocument(root) });

  assert.equal(mount({ app: "Invoices", ...dom }).snapshot().rev, 1);
});

test("selected reads ids the same way rows do, so 'this one' resolves", () => {
  // An id in `selected` spelled differently from the same row's id in `rows`
  // resolves "park that one" to nothing, so both have to come from the same
  // rule.
  const { dom } = app({ selected: "tr.selected" });

  const snapshot = dom.visible();

  assert.deepEqual(snapshot.selected, ["a1"]);
  assert.ok(snapshot.rows!.some((r) => r.id === "a1"));
  dom.stop();
});

test("fromDom with neither a rev nor a table refuses to be built", () => {
  // There is no safe default here. Inventing a constant rev would make every
  // stale call succeed, and this failing at setup is strictly better than it
  // failing silently for the life of the page.
  assert.throws(
    () => fromDom({ where: "nothing", clicks: { save: "save" } }),
    /fromDom needs a rev/,
  );
});

test("fromDom will not observe a table that is not in the page yet", () => {
  // A MutationObserver has to be handed a node, so this is resolved once at
  // setup. An app that mounts driverkit before it renders hits this, and the
  // message names the real fix rather than shrugging.
  const root = html(`<div id="app"></div>`);

  assert.throws(
    () =>
      fromDom({
        where: "invoices",
        table: "#invoices",
        document: new FakeDocument(root),
        MutationObserver: FakeMutationObserver,
      }),
    /pass rev: \{ target: "#a-container-that-always-exists" \}/,
  );
});

test("stop() disconnects the observer fromDom created", () => {
  const { dom, observer } = app();

  dom.stop();

  assert.equal(observer.disconnected, true);
});

test("a bare string click is a description, and declares no kind at all", () => {
  // Shorthand for the ten-button case. It deliberately does NOT default to
  // `read`: the core says an absent `kind` makes no safety claim in either
  // direction, and guessing `read` for a button whose handler might be
  // bulk-accept is the one guess that gets rows committed.
  const { driver, dom } = app({ clicks: { save: "save the open invoice" } });

  assert.deepEqual(driver.manifest().verbs.map((v) => [v.name, v.kind ?? null]), [
    ["save", null],
  ]);
  dom.stop();
});

test("a verb whose handle was never wired reports threw, with the handle named", async () => {
  // Through the core, so this is what whoever is driving actually receives.
  const { driver, dom } = app({ clicks: { archive: "archive the invoice" } });

  const result = await driver.call("archive");

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refused, "threw");
  assert.match(result.ok === false ? (result.hint ?? "") : "", /no handle `archive` for verb `archive`/);
  dom.stop();
});

test("a handle name can differ from the verb name", async () => {
  const { root, driver, dom } = app({
    clicks: { "show-more": { describe: "show more invoices", kind: "read", handle: "next-page" } },
  });

  await driver.call("show-more");

  assert.equal(root.querySelector(`[data-dk="next-page"]`)!.clicks, 1);
  dom.stop();
});

test("a table that declares no total reaches the agent as a window of unknown size", () => {
  // Through mount(), because this is the field the agent actually receives. An
  // app that adopts fromDom in one line and never reads this README gets the
  // truthful claim by default: "a window, size unknown", not "that is all of
  // them".
  const root = html(`
    <div id="app">
      <table id="t"><tbody><tr><td>INV-1</td></tr><tr><td>INV-2</td></tr></tbody></table>
    </div>`);
  const dom = fromDom({ where: "invoices", table: "#t", rev: 1, document: new FakeDocument(root) });

  const snapshot = mount({ app: "Invoices", ...dom }).snapshot();

  assert.deepEqual(snapshot.page, { index: 0, size: 2 });
  assert.equal("total" in snapshot.page!, false);
});

test("complete: true travels through the one literal, for an author who knows", () => {
  const root = html(`
    <div id="app">
      <table id="t"><tbody><tr><td>INV-1</td></tr></tbody></table>
    </div>`);
  const dom = fromDom({
    where: "invoices",
    table: { selector: "#t", complete: true },
    rev: 1,
    document: new FakeDocument(root),
  });

  const snapshot = mount({ app: "Invoices", ...dom }).snapshot();

  assert.equal("page" in snapshot, false);
  assert.equal(snapshot.rows!.length, 1);
});

test("table options pass through, so the one literal covers a div grid too", () => {
  const root = html(`
    <div id="app">
      <div id="grid">
        <div class="row" data-dk-id="a1"><span data-dk-col="invoice">INV-1</span></div>
      </div>
    </div>`);
  const dom = fromDom({
    where: "invoices",
    table: { selector: "#grid", rowSelector: ".row", cellSelector: "span", total: 900 },
    rev: 1,
    document: new FakeDocument(root),
  });

  const snapshot = dom.visible();

  assert.deepEqual(snapshot.rows, [{ id: "a1", invoice: "INV-1" }]);
  assert.deepEqual(snapshot.page, { index: 0, size: 1, total: 900 });
});
