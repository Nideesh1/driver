/**
 * These tests are the specification for reading a rendered table. Each name
 * states the decision it pins, so a future change that looks harmless has to
 * break a named test and read why the rule is there before deleting it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsFromTable } from "../src/index.ts";
import { FakeDocument, html } from "./fake-dom.ts";

/** Collect warnings instead of printing them. Every test passes this: a
 *  warning is an assertion target here, not noise. */
function warnings(): { onWarn: (m: string) => void; said: string[] } {
  const said: string[] = [];
  return { onWarn: (m) => said.push(m), said };
}

test("column keys come from th text, lowercased and hyphenated", () => {
  const table = html(`
    <table>
      <thead><tr><th>Invoice</th><th>Due Date</th><th>Amount</th></tr></thead>
      <tbody>
        <tr><td>INV-1</td><td>2026-01-02</td><td>$40</td></tr>
      </tbody>
    </table>`);

  const { rows } = rowsFromTable(table, warnings());

  // Kebab-case, matching the convention the core uses for verb names. An
  // agent that has met `set-lane` has already met this spelling.
  assert.deepEqual(rows, [{ id: "INV-1", invoice: "INV-1", "due-date": "2026-01-02", amount: "$40" }]);
});

test("data-dk-col on a header overrides the header's visible text", () => {
  // The header is written for a person and a designer may change it next week.
  // A column key that changes is a breaking change to every stored prompt that
  // mentioned it, so the app author gets to pin it.
  const table = html(`
    <table>
      <tr><th data-dk-col="id">Inv. #</th><th data-dk-col="total">Amount (USD)</th></tr>
      <tbody><tr><td>INV-1</td><td>40</td></tr></tbody>
    </table>`);

  const { rows } = rowsFromTable(table, warnings());

  assert.deepEqual(rows, [{ id: "INV-1", total: "40" }]);
});

test("a cell's own data-dk-col wins over the header's key", () => {
  const table = html(`
    <table>
      <thead><tr><th>Invoice</th><th>Amount</th></tr></thead>
      <tbody><tr><td>INV-1</td><td data-dk-col="cents">4000</td></tr></tbody>
    </table>`);

  const { rows } = rowsFromTable(table, warnings());

  assert.equal(rows[0]!.cents, "4000");
  assert.equal(rows[0]!.amount, undefined);
});

test("columns with no header at all are positional: col0, col1", () => {
  // The fallback has to exist and has to be boring. A table of icons has no
  // header text to slug, and inventing a name from the first row's contents
  // would give a key that changes when the data does.
  const table = html(`<table><tbody><tr><td>INV-1</td><td>paid</td></tr></tbody></table>`);

  const { rows } = rowsFromTable(table, warnings());

  assert.deepEqual(rows, [{ id: "INV-1", col0: "INV-1", col1: "paid" }]);
});

test("two headers that slug alike do not silently merge into one column", () => {
  // "Amount" and "amount " and "AMOUNT" all slug to `amount`. Merging them
  // would drop a column from the agent's view with no sign that it happened.
  const w = warnings();
  const table = html(`
    <table>
      <thead><tr><th>Amount</th><th>AMOUNT</th></tr></thead>
      <tbody><tr><td>40</td><td>50</td></tr></tbody>
    </table>`);

  const { rows } = rowsFromTable(table, w);

  assert.equal(rows[0]!.amount, "40");
  assert.equal(rows[0]!.col1, "50");
  assert.match(w.said.join("\n"), /two headers both read `amount`/);
});

test("data-dk-id on the row wins over every other source of id", () => {
  const table = html(`
    <table>
      <thead><tr><th>Invoice</th></tr></thead>
      <tbody><tr data-dk-id="7f3a"><td>INV-1</td></tr></tbody>
    </table>`);

  const { rows } = rowsFromTable(table, { ...warnings(), idColumn: "invoice" });

  // The attribute is the app author's deliberate statement of what its verbs
  // take. A visible invoice number is what a person reads; they are not always
  // the same string, and the agent must hold the one the verbs accept.
  assert.equal(rows[0]!.id, "7f3a");
});

test("idColumn names the column the id comes from when there is no attribute", () => {
  const table = html(`
    <table>
      <thead><tr><th>Name</th><th>Invoice</th></tr></thead>
      <tbody><tr><td>Acme</td><td>INV-9</td></tr></tbody>
    </table>`);

  const { rows } = rowsFromTable(table, { ...warnings(), idColumn: "invoice" });

  assert.equal(rows[0]!.id, "INV-9");
});

test("the first cell's text is the id of last resort", () => {
  const table = html(`<table><tbody><tr><td>INV-3</td><td>paid</td></tr></tbody></table>`);

  const { rows } = rowsFromTable(table, warnings());

  assert.equal(rows[0]!.id, "INV-3");
});

test("a row with no id at all is reported positionally and warned about loudly", () => {
  // A positional id is stable until somebody sorts the table, at which point a
  // call naming `row0` acts on a row the agent never saw -- the exact failure
  // `rev` exists to prevent, reintroduced one layer below where `rev` can see
  // it. Hence the warning: this is a fallback, not a feature.
  const w = warnings();
  const table = html(`<table><tbody><tr><td>  </td><td>paid</td></tr></tbody></table>`);

  const { rows } = rowsFromTable(table, w);

  assert.equal(rows[0]!.id, "row0");
  assert.match(w.said.join("\n"), /Positional ids move when the table is sorted/);
});

test("whitespace in rendered markup is collapsed, not preserved", () => {
  // Indented HTML puts newlines inside every cell. They are invisible to the
  // person at the keyboard, and a row whose id is "\n INV-1\n " matches
  // nothing an agent echoes back.
  const table = html(`
    <table>
      <thead><tr><th>  Invoice
        Number </th></tr></thead>
      <tbody><tr><td>
        INV-1
      </td></tr></tbody>
    </table>`);

  const { rows } = rowsFromTable(table, warnings());

  assert.deepEqual(rows, [{ id: "INV-1", "invoice-number": "INV-1" }]);
});

test("a header row in a tbody-less table is not reported as data", () => {
  // Plenty of hand-written markup has no <tbody>. Reporting the header as a
  // row gives the agent a record whose id is "Invoice", and verbs called with
  // it fail in a way that looks like the app is broken.
  const table = html(`
    <table>
      <tr><th>Invoice</th><th>State</th></tr>
      <tr><td>INV-1</td><td>paid</td></tr>
    </table>`);

  const { rows } = rowsFromTable(table, warnings());

  assert.deepEqual(rows, [{ id: "INV-1", invoice: "INV-1", state: "paid" }]);
});

test("a windowed table with data-dk-total reports page, so the agent knows it is a window", () => {
  const table = html(`
    <table data-dk-total="3412" data-dk-page="2">
      <thead><tr><th>Invoice</th></tr></thead>
      <tbody><tr><td>INV-1</td></tr><tr><td>INV-2</td></tr></tbody>
    </table>`);

  const { rows, page } = rowsFromTable(table, warnings());

  assert.equal(rows.length, 2);
  // `size` is the rendered count rather than a configured page size: for a
  // virtualised grid the rendered count IS the window, and there is no other
  // honest number available from the DOM.
  assert.deepEqual(page, { index: 2, size: 2, total: 3412 });
});

test("a table with no declared total reports a window of UNKNOWN size rather than omitting page", () => {
  // The decision this test exists to pin. A virtualised grid's DOM looks
  // exactly like a short table's DOM, so this function cannot detect a window.
  // Omitting `page` would assert completeness it cannot know, and an agent
  // asked whether INV-9000 exists would answer no. So `page` is present with
  // `total` absent: "a window, and I do not know how big the whole is". The
  // agent can page or filter; what it cannot do is conclude.
  const w = warnings();
  const rowsHtml = Array.from({ length: 40 }, (_, i) => `<tr><td>INV-${i}</td></tr>`).join("");
  const table = html(`<table><thead><tr><th>Invoice</th></tr></thead><tbody>${rowsHtml}</tbody></table>`);

  const read = rowsFromTable(table, w);

  assert.deepEqual(read.page, { index: 0, size: 40 });
  assert.equal("total" in read.page!, false, "an invented total is worse than no total");
  // The warning survives as advice -- supply a total so the agent can tell how
  // much it has not seen -- and is no longer the last line of defence.
  assert.match(w.said.join("\n"), /window of unknown size/);
});

test("an index of 0 on an undeclared paginator is not a claim to be on the first page", () => {
  // `index` is required, so something has to go there. 0 means "nothing
  // declared a position", and an undeclared paginator sitting on page 4 will
  // report 0. That misleads an agent about WHERE it is, not about WHETHER it
  // is seeing everything -- `page` being present already settles the second
  // question, which is the one that produces wrong answers.
  const w = warnings();
  const table = html(`<table><tbody><tr><td>INV-1</td></tr></tbody></table>`);

  assert.deepEqual(rowsFromTable(table, w).page, { index: 0, size: 1 });

  const declared = html(`<table data-dk-page="4"><tbody><tr><td>INV-1</td></tr></tbody></table>`);
  assert.deepEqual(rowsFromTable(declared, w).page, { index: 4, size: 1 });
});

test("a short table also reports a window, and quietly: the default is wrong in the cheap direction", () => {
  // Three rows with no total is probably all the data, and claiming a window
  // costs an agent one redundant check. The reverse costs a wrong answer about
  // whether a record exists. So the default leans this way for every table,
  // and the warning stays off until there are enough rows that the missing
  // total is worth a developer's attention.
  const w = warnings();
  const table = html(`<table><tbody><tr><td>INV-1</td></tr></tbody></table>`);

  const read = rowsFromTable(table, w);

  assert.deepEqual(read.page, { index: 0, size: 1 });
  assert.deepEqual(w.said, []);
});

test("complete: true is the only way to assert there is nothing out of view", () => {
  // Absence of `page` is now something an author opts into rather than
  // something this function falls into by failing to detect a grid. Nothing
  // readable from the DOM distinguishes a complete table from a window onto a
  // million rows, so the claim has to come from the person who rendered it.
  const w = warnings();
  const rowsHtml = Array.from({ length: 40 }, (_, i) => `<tr><td>INV-${i}</td></tr>`).join("");
  const table = html(`<table><tbody>${rowsHtml}</tbody></table>`);

  const read = rowsFromTable(table, { ...w, complete: true });

  assert.equal("page" in read, false);
  assert.deepEqual(w.said, [], "an author who has declared completeness does not need the advice");
});

test("an explicit total fills page even when the markup says nothing", () => {
  const table = html(`<table><tbody><tr><td>INV-1</td></tr></tbody></table>`);

  const { page } = rowsFromTable(table, { ...warnings(), total: () => 900, pageIndex: 3, pageSize: 50 });

  assert.deepEqual(page, { index: 3, size: 50, total: 900 });
});

test("a missing table throws rather than reporting zero rows", () => {
  // `{ rows: [] }` is not "I could not look", it is "there are no records",
  // and an agent cannot tell those apart. Asked whether an invoice exists, it
  // would answer no.
  const doc = new FakeDocument(html(`<div id="app"></div>`));

  assert.throws(
    () => rowsFromTable("#invoices", { document: doc, ...warnings() }),
    /Reporting zero rows would tell an agent the records do not exist/,
  );
});

test("ifMissing empty is available for an app that really renders no table", () => {
  const doc = new FakeDocument(html(`<div id="app"></div>`));

  const read = rowsFromTable("#invoices", { document: doc, ifMissing: "empty", ...warnings() });

  assert.deepEqual(read, { rows: [] });
});

test("duplicate ids are reported, not renamed", () => {
  // Renaming the second one to `INV-1#2` would hand the agent an id that no
  // verb in the app accepts. Left as-is and reported, because two rows sharing
  // an id means every "park that one" acts on whichever the app finds first,
  // and only the app author can fix that.
  const w = warnings();
  const table = html(`
    <table><tbody>
      <tr><td>INV-1</td></tr>
      <tr><td>INV-1</td></tr>
    </tbody></table>`);

  const { rows } = rowsFromTable(table, w);

  assert.deepEqual(rows.map((r) => r.id), ["INV-1", "INV-1"]);
  assert.match(w.said.join("\n"), /rows 0 and 1 both have id `INV-1`/);
});

test("rowSelector and cellSelector read a repeating structure that is not a table", () => {
  // Half the apps worth adapting do not use <table> at all. The same rules
  // have to work on a div grid, or tier 3 only covers the apps that happened
  // to pick the semantic markup.
  const grid = html(`
    <div class="grid">
      <div class="row" data-dk-id="a1"><span data-dk-col="invoice">INV-1</span><span data-dk-col="state">paid</span></div>
      <div class="row" data-dk-id="b2"><span data-dk-col="invoice">INV-2</span><span data-dk-col="state">due</span></div>
    </div>`);

  const { rows } = rowsFromTable(grid, {
    ...warnings(),
    rowSelector: ".row",
    cellSelector: "span",
  });

  assert.deepEqual(rows, [
    { id: "a1", invoice: "INV-1", state: "paid" },
    { id: "b2", invoice: "INV-2", state: "due" },
  ]);
});

test("cellValue is where an app turns rendered text into a value an agent can compare", () => {
  // Nothing is coerced by default: "$1,200" stays "$1,200" and "0012" stays
  // "0012", because guessing would silently reformat ids and currency. An app
  // that wants numbers asks for them.
  const table = html(`
    <table>
      <thead><tr><th>Invoice</th><th>Amount</th></tr></thead>
      <tbody><tr><td>0012</td><td>$1,200</td></tr></tbody>
    </table>`);

  const { rows } = rowsFromTable(table, {
    ...warnings(),
    cellValue: (text, column) => (column === "amount" ? Number(text.replace(/[^0-9.]/g, "")) : text),
  });

  assert.deepEqual(rows, [{ id: "0012", invoice: "0012", amount: 1200 }]);
});
