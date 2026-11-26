/**
 * The specification for the controls layer.
 *
 * Three claims this file exists to keep honest, because each one is a decision
 * somebody will be tempted to undo:
 *
 *  1. **A name the screen does not offer is a refusal, never a near miss.**
 *     Nothing here matches by label, by role, by position or by similarity. The
 *     moment it does, the library is selector automation and an agent that
 *     meant Dismiss presses Delete.
 *  2. **The snapshot does not grow with the row count.** Twenty rows with six
 *     controls each is six entries. A per-element listing would be correct and
 *     would cost the cost argument the whole library is built on.
 *  3. **An undeclared control is not a safe control.** It routes through the
 *     gated verb, because no inspection of a button distinguishes Next Page
 *     from Delete Account.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "driverkit";
import type { Result, Snapshot } from "driverkit";
import { controlsFromDom } from "../src/controls/index.ts";
import { FakeDocument, FakeElement, FakeEvent, html } from "./controls-fake-dom.ts";

function page(markup: string) {
  const root = html(markup);
  return { root, doc: new FakeDocument(root) };
}

/** Warnings are for the app author and must never reach an agent, so every
 *  binding in here captures them instead of writing to the console. */
function bind(doc: FakeDocument, extra: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  const dk = controlsFromDom({
    document: doc,
    Event: FakeEvent,
    onWarn: (m) => warnings.push(m),
    ...extra,
  });
  return { dk, warnings };
}

function at(root: FakeElement, name: string): FakeElement {
  const el = root.querySelector(`[data-dk-control="${name}"]`);
  if (!el) throw new Error(`test: no control \`${name}\` in this markup`);
  return el;
}

const SCREEN = `
  <div id="app">
    <input data-dk-control="search" data-dk-kind="describe" placeholder="Search contacts" />
    <button data-dk-control="next-page" data-dk-kind="read">Next</button>
    <button data-dk-control="prev-page" data-dk-kind="read" disabled>Previous</button>
    <button data-dk-control="accept-all" data-dk-kind="commit">Accept all</button>
    <button data-dk-control="export">Export</button>
    <button class="theme-toggle">Dark mode</button>
    <table id="contacts">
      <tr><th>Id</th><th>Name</th></tr>
      <tr data-dk-id="c-1"><td>c-1</td><td>Ada</td>
        <td><input type="checkbox" data-dk-control="pick" data-dk-kind="describe" />
            <button data-dk-control="open" data-dk-kind="read">Open</button>
            <button data-dk-control="delete" data-dk-kind="commit">Delete</button></td></tr>
      <tr data-dk-id="c-2"><td>c-2</td><td>Grace</td>
        <td><input type="checkbox" data-dk-control="pick" data-dk-kind="describe" />
            <button data-dk-control="open" data-dk-kind="read">Open</button>
            <button data-dk-control="delete" data-dk-kind="commit">Delete</button></td></tr>
    </table>
  </div>`;

function screen() {
  const { root, doc } = page(SCREEN);
  const { dk, warnings } = bind(doc, { rows: "#contacts" });
  return { root, doc, dk, warnings };
}

/** Run a verb through a real `mount`, because the refusal path, the argument
 *  check and the snapshot-after all belong to the core and a test that called
 *  `run` directly would be testing a different thing from the one that ships. */
function driverFor(dk: ReturnType<typeof controlsFromDom>, visible?: () => Snapshot) {
  return mount({
    app: "Test",
    verbs: dk.verbs,
    visible: visible ?? (() => dk.withControls({ where: "test", rev: 1 })),
  });
}

function refusal(result: Result): string {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  return result.ok ? "" : result.refused;
}

// ── enumeration ─────────────────────────────────────────────────────────────

test("enumeration lists the marked controls and omits everything unmarked", () => {
  const { dk } = screen();

  const names = dk.controls().map((c) => c.name);

  // `theme-toggle` has a class and a label and is not marked, so it does not
  // exist. That is the whole boundary of this layer: the author publishes a
  // control deliberately, and an unmarked button is not an oversight the
  // library gets to correct.
  assert.deepEqual(names, [
    "search",
    "next-page",
    "prev-page",
    "accept-all",
    "export",
    "pick",
    "open",
    "delete",
  ]);
});

test("a control carries its declared kind, its label, and nothing else it does not need", () => {
  const { dk } = screen();
  const byName = new Map(dk.controls().map((c) => [c.name, c]));

  assert.deepEqual(byName.get("next-page"), { name: "next-page", label: "Next", kind: "read" });
  // A field says so, and its label falls back to the placeholder — the only
  // text an empty input has.
  assert.deepEqual(byName.get("search"), {
    name: "search",
    label: "Search contacts",
    kind: "describe",
    field: true,
  });
  // Disabled is reported rather than hidden: the person can see the greyed-out
  // button, so an agent shown nothing would conclude paging backwards is
  // impossible instead of looking for the precondition.
  assert.deepEqual(byName.get("prev-page"), {
    name: "prev-page",
    label: "Previous",
    kind: "read",
    disabled: true,
  });
});

test("a control with no declared kind reports no kind, and is not reported as read", () => {
  const { dk, warnings } = screen();
  const exported = dk.controls().find((c) => c.name === "export")!;

  assert.equal("kind" in exported, false);
  // The author hears about it once. The agent is told nothing in either
  // direction, which is the point: a `kind: "read"` here would be the library
  // inventing a safety claim about a button it has never looked inside.
  assert.match(warnings.join("\n"), /declare no data-dk-kind: export/);
});

test("per-row controls are listed once, and the snapshot does not grow with the row count", () => {
  const rows = Array.from(
    { length: 20 },
    (_, i) =>
      `<tr data-dk-id="r-${i}"><td>r-${i}</td><td>
         <input type="checkbox" data-dk-control="pick" data-dk-kind="describe" />
         <button data-dk-control="open" data-dk-kind="read">Open</button>
         <button data-dk-control="edit" data-dk-kind="read">Edit</button>
         <button data-dk-control="archive" data-dk-kind="commit">Archive</button>
         <button data-dk-control="delete" data-dk-kind="commit">Delete</button>
         <button data-dk-control="flag" data-dk-kind="describe">Flag</button></td></tr>`,
  ).join("");
  const { doc } = page(`<div id="app"><table id="t">${rows}</table></div>`);
  const { dk, warnings } = bind(doc, { rows: "#t" });

  const controls = dk.controls();

  // Twenty rows times six controls is a hundred and twenty elements and six
  // entries. The arithmetic is the whole design.
  assert.equal(controls.length, 6);
  assert.deepEqual(
    controls.map((c) => c.name),
    ["pick", "open", "edit", "archive", "delete", "flag"],
  );
  assert.ok(controls.every((c) => c.per === "row"));
  // And no duplicate-name warning: twenty copies of one template are one
  // control, not twenty authoring mistakes.
  assert.equal(
    warnings.filter((w) => w.includes("both named")).length,
    0,
  );
});

test("a row control that is disabled on some rows but not all is not reported disabled", () => {
  // The honest limit of collapsing, asserted so it cannot be quietly
  // "improved" into a per-row listing. The snapshot says the control exists;
  // the call-time check is what knows about this row.
  const { doc } = page(`
    <div id="app"><table id="t">
      <tr data-dk-id="a"><td>a</td><td><button data-dk-control="ship" data-dk-kind="commit" disabled>Ship</button></td></tr>
      <tr data-dk-id="b"><td>b</td><td><button data-dk-control="ship" data-dk-kind="commit">Ship</button></td></tr>
    </table></div>`);
  const { dk } = bind(doc, { rows: "#t" });

  assert.equal("disabled" in dk.controls()[0]!, false);

  const driver = driverFor(dk);
  return driver.call("commit-control", { control: "ship", row: "a" }).then(async (onA) => {
    assert.equal(refusal(onA), "disabled");
    assert.equal((await driver.call("commit-control", { control: "ship", row: "b" })).ok, true);
  });
});

test("a row control disabled on every row is reported disabled", () => {
  const { doc } = page(`
    <div id="app"><table id="t">
      <tr data-dk-id="a"><td>a</td><td><button data-dk-control="ship" data-dk-kind="commit" disabled>Ship</button></td></tr>
      <tr data-dk-id="b"><td>b</td><td><button data-dk-control="ship" data-dk-kind="commit" aria-disabled="true">Ship</button></td></tr>
    </table></div>`);
  const { dk } = bind(doc, { rows: "#t" });

  assert.equal(dk.controls()[0]!.disabled, true);
});

test("without a rows spec every control belongs to the screen", () => {
  // A screen with no table is the common case for a settings pane, and the
  // collapsing has nothing to collapse. Worth pinning, because the wrong
  // behaviour here is a `needs-row` refusal for a control that has no rows.
  const { doc, root } = page(
    `<div id="app"><button data-dk-control="save" data-dk-kind="commit">Save</button></div>`,
  );
  const { dk } = bind(doc);

  assert.deepEqual(dk.controls(), [{ name: "save", label: "Save", kind: "commit" }]);

  return driverFor(dk)
    .call("commit-control", { control: "save" })
    .then((r) => {
      assert.equal(r.ok, true);
      assert.equal(at(root, "save").clicks, 1);
    });
});

test("two screen controls sharing a name are reported once and warned about", () => {
  const { doc } = page(`
    <div id="app">
      <button data-dk-control="save" data-dk-kind="commit">Save</button>
      <button data-dk-control="save" data-dk-kind="commit">Save also</button>
    </div>`);
  const { dk, warnings } = bind(doc);

  assert.equal(dk.controls().length, 1);
  assert.match(warnings.join("\n"), /two controls are both named `save`/);
});

test("over the limit the list is cut and says how much it is hiding", () => {
  const buttons = Array.from(
    { length: 9 },
    (_, i) => `<button data-dk-control="b${i}" data-dk-kind="read">B${i}</button>`,
  ).join("");
  const { doc } = page(`<div id="app">${buttons}</div>`);
  const { dk, warnings } = bind(doc, { limit: 4 });

  assert.equal(dk.controls().length, 4);
  assert.match(dk.note()!, /5 more control\(s\) on this screen are not listed/);
  assert.match(warnings.join("\n"), /9 controls on screen, over the limit of 4/);
});

test("the note line is short, groups by row, and marks only what is not the common case", () => {
  const { dk } = screen();

  assert.equal(
    dk.note(),
    'controls: search “Search contacts” (text, describe), next-page “Next”, ' +
      'prev-page “Previous” (disabled), accept-all “Accept all” (commit), ' +
      'export (undeclared); ' +
      'each row: pick (describe), open, delete (commit)',
  );
  // Short enough to pay for on every turn. The legend that makes it readable
  // is in the verb descriptions, which are cached.
  assert.ok(dk.note()!.length < 260, `note is ${dk.note()!.length} chars`);
});

test("inNote: false leaves the note alone, for a renderer that prints controls itself", () => {
  const { doc } = page(`<div id="app"><button data-dk-control="go" data-dk-kind="read">Go</button></div>`);
  const { dk } = bind(doc, { inNote: false });

  assert.equal(dk.note(), undefined);
  // The explicit type argument is what makes `controls` readable below:
  // `withControls` is `<S extends Snapshot>(s: S) => S`, so an inferred `S`
  // is the literal that was passed in and carries no `controls` at all.
  const snapshot = dk.withControls<Snapshot>({ where: "test", rev: 3, note: "mine" });
  assert.equal(snapshot.note, "mine");
  assert.equal(snapshot.controls!.length, 1);
});

test("withControls keeps a note the app already wrote", () => {
  const { doc } = page(`<div id="app"><button data-dk-control="go" data-dk-kind="read">Go</button></div>`);
  const { dk } = bind(doc);

  const snapshot = dk.withControls({ where: "test", rev: 3, note: "rows unavailable" });

  assert.match(snapshot.note!, /^rows unavailable\. controls: go/);
});

test("the attribute is configurable, so an app may publish its existing data-dk marks", () => {
  const { doc } = page(`<div id="app"><button data-dk="save" data-dk-kind="commit">Save</button></div>`);
  const { dk } = bind(doc, { attribute: "data-dk" });

  assert.deepEqual(dk.controls(), [{ name: "save", label: "Save", kind: "commit" }]);
});

test("kinds can be declared in code, for markup an author cannot annotate", () => {
  const { doc } = page(`<div id="app"><button data-dk-control="export">Export</button></div>`);
  const { dk } = bind(doc, { kind: (name: string) => (name === "export" ? "read" : undefined) });

  assert.equal(dk.controls()[0]!.kind, "read");
});

test("a kind the author misspelled is treated as undeclared and said so", () => {
  const { doc } = page(
    `<div id="app"><button data-dk-control="x" data-dk-kind="write">X</button></div>`,
  );
  const { dk, warnings } = bind(doc);

  assert.equal("kind" in dk.controls()[0]!, false);
  assert.match(warnings.join("\n"), /data-dk-kind="write", which is not read, describe or commit/);
});

// ── pressing ────────────────────────────────────────────────────────────────

test("press reaches the right control and nothing else", async () => {
  const { root, dk } = screen();
  let ran = 0;
  at(root, "next-page").onclick = () => (ran += 1);

  const result = await driverFor(dk).call("press", { control: "next-page" });

  assert.equal(result.ok, true);
  assert.equal(ran, 1);
  assert.equal(at(root, "next-page").clicks, 1);
  assert.equal(at(root, "accept-all").clicks, 0);
  assert.equal(at(root, "export").clicks, 0);
});

test("press reaches the control on the row it was given, and only that row", async () => {
  const { root, dk } = screen();
  const rows = root.querySelectorAll("tr[data-dk-id]");

  const result = await driverFor(dk).call("press", { control: "open", row: "c-2" });

  assert.equal(result.ok, true);
  assert.equal(rows[0]!.querySelector(`[data-dk-control="open"]`)!.clicks, 0);
  assert.equal(rows[1]!.querySelector(`[data-dk-control="open"]`)!.clicks, 1);
});

test("a per-row control named without a row refuses and lists the rows on screen", async () => {
  const { dk } = screen();

  const result = await driverFor(dk).call("press", { control: "open" });

  assert.equal(refusal(result), "needs-row");
  assert.match(result.ok ? "" : result.hint!, /Rows on screen: c-1, c-2/);
});

test("a screen control named with a row refuses rather than pressing the screen one", async () => {
  // The quiet wrong answer here would be to ignore the row and press the
  // page-level button. An agent that asked for "next page for row c-1" has
  // misunderstood the screen, and doing something plausible teaches it nothing.
  const { root, dk } = screen();

  const result = await driverFor(dk).call("press", { control: "next-page", row: "c-1" });

  assert.equal(refusal(result), "not-a-row-control");
  assert.equal(at(root, "next-page").clicks, 0);
});

test("a row id that is no longer on screen refuses and points at rev", async () => {
  const { dk } = screen();

  const result = await driverFor(dk).call("press", { control: "open", row: "c-99" });

  assert.equal(refusal(result), "no-such-row");
  assert.match(result.ok ? "" : result.hint!, /no row `c-99` is on screen/);
  assert.match(result.ok ? "" : result.hint!, /Quoting `rev`/);
});

test("a row on screen that does not render the control refuses as no-such-control", async () => {
  const { doc } = page(`
    <div id="app"><table id="t">
      <tr data-dk-id="a"><td>a</td><td><button data-dk-control="undo" data-dk-kind="read">Undo</button></td></tr>
      <tr data-dk-id="b"><td>b</td><td></td></tr>
    </table></div>`);
  const { dk } = bind(doc, { rows: "#t" });

  const result = await driverFor(dk).call("press", { control: "undo", row: "b" });

  assert.equal(refusal(result), "no-such-control");
  assert.match(result.ok ? "" : result.hint!, /row `b` is on screen but offers no `undo`/);
});

test("a control that has vanished since the snapshot refuses, and lists what is there now", async () => {
  // The case this layer is most likely to meet in anger: the person at the
  // keyboard kept clicking while the model was thinking. A refusal costs a
  // round trip. Pressing whatever is nearest costs the user something they
  // cannot undo.
  const { root, dk } = screen();
  const driver = driverFor(dk);
  assert.equal((await driver.call("press", { control: "next-page" })).ok, true);

  at(root, "next-page").remove();
  const result = await driver.call("press", { control: "next-page" });

  assert.equal(refusal(result), "no-such-control");
  const hint = result.ok ? "" : result.hint!;
  assert.match(hint, /this screen offers no control named `next-page`/);
  assert.match(hint, /It offers: accept-all, delete, export, open, pick, prev-page, search/);
  // And the refusal carries the screen as it is NOW, so the agent's next turn
  // sees the shorter list without another read.
  assert.equal(
    result.snapshot.controls!.some((c) => c.name === "next-page"),
    false,
  );
});

test("a name the screen does not offer is never matched to a near miss", async () => {
  // No fuzzy match, no label match, no prefix match, no "did you mean". There
  // is one `delete` on this screen and `Delete all` is a label, not a handle.
  const { root, dk } = screen();
  const driver = driverFor(dk);

  for (const guess of ["Next", "next", "nextpage", "next-pag", "Accept all", "accept"]) {
    const result = await driver.call("press", { control: guess });
    assert.equal(refusal(result), "no-such-control", `\`${guess}\` should not resolve`);
  }
  assert.equal(at(root, "next-page").clicks, 0);
  assert.equal(at(root, "accept-all").clicks, 0);
});

test("a screen with no marked controls at all says so rather than listing nothing", async () => {
  const { doc } = page(`<div id="app"><button>Save</button></div>`);
  const { dk } = bind(doc);

  const result = await driverFor(dk).call("press", { control: "save" });

  assert.equal(refusal(result), "no-such-control");
  assert.match(result.ok ? "" : result.hint!, /offers no controls at all/);
});

test("a disabled control refuses instead of being pressed and reported ok", async () => {
  // The worst outcome in this library is a verb that silently does nothing.
  const { root, dk } = screen();

  const result = await driverFor(dk).call("press", { control: "prev-page" });

  assert.equal(refusal(result), "disabled");
  assert.equal(at(root, "prev-page").clicks, 0);
});

test("refuseWhen replaces the disabled rule for an app that disables its own way", async () => {
  const { doc, root } = page(
    `<div id="app"><button data-dk-control="go" data-dk-kind="read" class="is-off">Go</button></div>`,
  );
  const { dk } = bind(doc, {
    refuseWhen: (el: { getAttribute(n: string): string | null }) =>
      (el.getAttribute("class") ?? "").includes("is-off") ? "disabled" : null,
  });

  assert.equal(refusal(await driverFor(dk).call("press", { control: "go" })), "disabled");
  assert.equal(at(root, "go").clicks, 0);
});

// ── kind and the gate ───────────────────────────────────────────────────────

test("a control declared commit is refused by press and pointed at the gated verb", async () => {
  const { root, dk } = screen();

  const result = await driverFor(dk).call("press", { control: "accept-all" });

  assert.equal(refusal(result), "wrong-verb");
  assert.match(result.ok ? "" : result.hint!, /declared `commit`\. Use `commit-control`/);
  assert.equal(at(root, "accept-all").clicks, 0);
});

test("a control with no declared kind is refused by press and treated as committing", async () => {
  const { root, dk } = screen();
  const driver = driverFor(dk);

  const refused = await driver.call("press", { control: "export" });
  assert.equal(refusal(refused), "wrong-verb");
  assert.match(
    refused.ok ? "" : refused.hint!,
    /has not declared what `export` does, so it is treated as though it changes data/,
  );
  assert.equal(at(root, "export").clicks, 0);

  // Reachable, though. Coverage is the whole point of the layer; what the
  // missing declaration costs is a question to the human, not the action.
  assert.equal((await driver.call("commit-control", { control: "export" })).ok, true);
  assert.equal(at(root, "export").clicks, 1);
});

test("a safe control is refused by the gated verb, so the gate keeps meaning something", async () => {
  // Without this an agent could route every press through `commit-control` and
  // the person would be asked about paging. A gate that asks about everything
  // is a gate nobody reads.
  const { root, dk } = screen();

  const result = await driverFor(dk).call("commit-control", { control: "next-page" });

  assert.equal(refusal(result), "wrong-verb");
  assert.match(result.ok ? "" : result.hint!, /declared `read`\. Use `press` for it/);
  assert.equal(at(root, "next-page").clicks, 0);
});

test("the three verbs carry the kinds the gate reads, and the commit one is the only commit", () => {
  const { dk } = screen();
  const manifest = driverFor(dk).manifest();

  assert.deepEqual(
    manifest.verbs.map((v) => [v.name, v.kind]),
    [
      ["press", "describe"],
      ["type-into", "describe"],
      ["commit-control", "commit"],
    ],
  );
  // `press` is `describe` and not `read`, because it also presses controls the
  // author declared `describe` -- a select-all checkbox, a filter chip. The
  // weaker claim is the true one for the verb as a whole.
  for (const verb of manifest.verbs) {
    assert.deepEqual(verb.refuses, [
      "no-such-control",
      "no-such-row",
      "needs-row",
      "not-a-row-control",
      "wrong-verb",
      "disabled",
    ]);
  }
});

test("the manifest holds no control names, so one screen's buttons cannot bust the prefix", () => {
  const { dk, doc } = screen();
  const first = driverFor(dk).manifest();

  // Navigate: different buttons entirely.
  const other = page(`<div id="app"><button data-dk-control="pay" data-dk-kind="commit">Pay</button></div>`);
  const second = driverFor(bind(other.doc).dk).manifest();

  // No argument enumerates anything. `oneOf` is the shape this invariant dies
  // of: listing the control names there reads as helpful typing and drops a
  // per-screen list into the prompt prefix.
  for (const verb of first.verbs) {
    for (const [arg, spec] of Object.entries(verb.args ?? {})) {
      assert.equal("oneOf" in spec, false, `${verb.name}.${arg} must not enumerate`);
    }
  }
  const cached = JSON.stringify(first.verbs);
  for (const control of ["next-page", "accept-all", "export", "pick", "prev-page"]) {
    assert.equal(cached.includes(control), false, `\`${control}\` must not be in the cached half`);
  }
  // Same verbs, same fingerprint, across two completely different screens.
  assert.equal(first.version, second.version);
  assert.equal(doc instanceof FakeDocument, true);
});

// ── typing ──────────────────────────────────────────────────────────────────

test("type-into puts the text in the field and tells the app about it", async () => {
  const { root, dk } = screen();
  const field = at(root, "search");
  const seen: string[] = [];
  field.oninput = (value) => seen.push(value);

  const result = await driverFor(dk).call("type-into", { control: "search", text: "Ada" });

  assert.equal(result.ok, true);
  assert.equal(field.value, "Ada");
  // Assigning `value` and firing nothing looks typed and tells a framework
  // nothing, and the next render wipes it while the verb reports success.
  assert.deepEqual(field.events, ["input", "change"]);
  assert.deepEqual(seen, ["Ada"]);
  assert.equal(field.focused, 1);
});

test("an empty string clears the field, rather than being read as no text", async () => {
  const { root, dk } = screen();
  at(root, "search").value = "Ada";

  const result = await driverFor(dk).call("type-into", { control: "search", text: "" });

  assert.equal(result.ok, true);
  assert.equal(at(root, "search").value, "");
});

test("type-into on a button refuses rather than putting text nowhere", async () => {
  const { dk } = screen();

  const result = await driverFor(dk).call("type-into", { control: "next-page", text: "Ada" });

  assert.equal(refusal(result), "wrong-verb");
  assert.match(result.ok ? "" : result.hint!, /is a button, not a field/);
});

test("press on a field refuses and names the verb that types", async () => {
  const { root, dk } = screen();

  const result = await driverFor(dk).call("press", { control: "search" });

  assert.equal(refusal(result), "wrong-verb");
  assert.match(result.ok ? "" : result.hint!, /is a field, not a button\. Use `type-into`/);
  assert.equal(at(root, "search").clicks, 0);
});

test("a checkbox is a control you press, not a field you type into", async () => {
  // The distinction the tag alone cannot make: a checkbox is an `<input>` and
  // typing into one is nonsense, while ticking one is the commonest per-row
  // action there is.
  const { root, dk } = screen();

  const result = await driverFor(dk).call("press", { control: "pick", row: "c-1" });

  assert.equal(result.ok, true);
  assert.equal(dk.controls().find((c) => c.name === "pick")!.field, undefined);
  assert.equal(
    root.querySelectorAll("tr[data-dk-id]")[0]!.querySelector(`[data-dk-control="pick"]`)!.clicks,
    1,
  );
});

test("a field that commits is typed into through the gated verb", async () => {
  const { doc, root } = page(`
    <div id="app">
      <input data-dk-control="rename" data-dk-kind="commit" data-dk-label="Contact name" />
    </div>`);
  const { dk } = bind(doc);
  const driver = driverFor(dk);

  assert.equal(refusal(await driver.call("type-into", { control: "rename", text: "Ada" })), "wrong-verb");
  const ok = await driver.call("commit-control", { control: "rename", text: "Ada" });

  assert.equal(ok.ok, true);
  assert.equal(at(root, "rename").value, "Ada");
});

test("the gated verb refuses a field with no text rather than clicking it", async () => {
  const { doc, root } = page(
    `<div id="app"><input data-dk-control="rename" data-dk-kind="commit" /></div>`,
  );
  const { dk } = bind(doc);

  const result = await driverFor(dk).call("commit-control", { control: "rename" });

  assert.equal(refusal(result), "wrong-verb");
  assert.match(result.ok ? "" : result.hint!, /is a field: it takes text\. Pass `text`/);
  assert.equal(at(root, "rename").clicks, 0);
});

test("setValue is the hook for a framework the default assignment cannot reach", async () => {
  const { doc, root } = page(
    `<div id="app"><input data-dk-control="q" data-dk-kind="describe" /></div>`,
  );
  const mine: string[] = [];
  const { dk } = bind(doc, { setValue: (_el: unknown, text: string) => mine.push(text) });

  assert.equal((await driverFor(dk).call("type-into", { control: "q", text: "x" })).ok, true);
  assert.deepEqual(mine, ["x"]);
  // The default path did not also run.
  assert.deepEqual(at(root, "q").events, []);
});

test("with no way to fire an event, typing fails loudly instead of half-working", async () => {
  const { doc, root } = page(
    `<div id="app"><input data-dk-control="q" data-dk-kind="describe" /></div>`,
  );
  const field = at(root, "q");
  // An element that cannot be told about a keystroke -- a web component with a
  // `value` and no events, which is a real thing people ship. Assigning
  // `value` here would look typed on screen, tell the app nothing, and report
  // `ok`: the half of the job that looks like all of it.
  (field as unknown as { dispatchEvent: undefined }).dispatchEvent = undefined;
  const { dk } = bind(doc);

  const result = await driverFor(dk).call("type-into", { control: "q", text: "x" });

  assert.equal(refusal(result), "threw");
  assert.match(result.ok ? "" : result.hint!, /the element has no dispatchEvent/);
  assert.match(result.ok ? "" : result.hint!, /options.setValue/);
  assert.equal(field.value, "");
});

// ── composition ─────────────────────────────────────────────────────────────

test("both layers live in one mount, and an agent cannot tell them apart", async () => {
  // The requirement that decides whether this design is usable at all: a
  // hand-written shortcut and the generic controls in the same `mount()`, the
  // same `call`, the same snapshot.
  const { root, doc } = page(SCREEN);
  const { dk } = bind(doc, { rows: "#contacts" });

  const store = { selected: new Set<string>(), rev: 4 };
  const driver = mount({
    app: "Contacts",
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select every contact at one company",
        args: { company: { type: "string", describe: "the company" } },
        run: ({ company }: { company: string }) => {
          store.selected = new Set(["c-1", "c-2"]);
          store.rev += 1;
          return { count: 410, note: `selected 410 at ${company}` };
        },
      },
      ...dk.verbs,
    ],
    visible: () =>
      dk.withControls({
        where: "contacts",
        rev: store.rev,
        rows: [
          { id: "c-1", name: "Ada" },
          { id: "c-2", name: "Grace" },
        ],
        ...(store.selected.size ? { selectedCount: store.selected.size } : {}),
      }),
  });

  // The shortcut: four hundred and ten rows in one call, with a count.
  const bulk = await driver.call("select-where", { company: "Acme" });
  assert.equal(bulk.ok, true);
  assert.equal(bulk.ok && bulk.count, 410);

  // The control: the one thing the shortcut cannot express — this one row.
  const one = await driver.call("press", { control: "pick", row: "c-2" });
  assert.equal(one.ok, true);
  assert.equal(
    root.querySelectorAll("tr[data-dk-id]")[1]!.querySelector(`[data-dk-control="pick"]`)!.clicks,
    1,
  );

  // Four verbs, one manifest, nothing saying which layer anything came from.
  assert.deepEqual(driver.manifest().verbs.map((v) => v.name), [
    "select-where",
    "press",
    "type-into",
    "commit-control",
  ]);
  // And one snapshot carrying both halves of the screen.
  const snapshot = driver.snapshot();
  assert.equal(snapshot.rows!.length, 2);
  assert.equal(snapshot.controls!.length, 8);
  assert.equal(snapshot.selectedCount, 2);
});

test("a stale rev refuses before a control is ever resolved", async () => {
  // The controls layer does not weaken staleness: `rev` is checked by the core
  // first, so a model acting on a screen that has moved is told to read again
  // rather than told its control has vanished.
  const { root, doc } = page(SCREEN);
  const { dk } = bind(doc, { rows: "#contacts" });
  let rev = 7;
  const driver = mount({
    app: "Contacts",
    verbs: dk.verbs,
    visible: () => dk.withControls({ where: "contacts", rev }),
  });

  rev = 8;
  const result = await driver.call("press", { control: "next-page" }, { rev: 7 });

  assert.equal(refusal(result), "stale");
  assert.equal(at(root, "next-page").clicks, 0);
});

test("names can be changed, so a control verb cannot collide with an app's own", () => {
  const { doc } = screen();
  const dk = controlsFromDom({
    document: doc,
    Event: FakeEvent,
    rows: "#contacts",
    names: { press: "dk-press", type: "dk-type", commit: "dk-commit" },
    onWarn: () => {},
  });

  const driver = mount({
    app: "App",
    verbs: [
      { name: "press", kind: "read", describe: "the app's own press", run: () => {} },
      ...dk.verbs,
    ],
    visible: () => ({ where: "x", rev: 1 }),
  });

  assert.deepEqual(driver.manifest().verbs.map((v) => v.name), [
    "press",
    "dk-press",
    "dk-type",
    "dk-commit",
  ]);
  // The renamed verbs refer to each other by their real names, so a refusal
  // never points a model at a verb that does not exist.
  const commit = driver.manifest().verbs.find((v) => v.name === "dk-press")!;
  assert.match(commit.describe, /`dk-commit`/);
  assert.match(commit.describe, /`dk-type`/);
});

// ── the gate's own controls ─────────────────────────────────────────────────
//
// webmachinelearning/webmcp#288: ChatGPT's in-app browser called a
// proposal-only tool, the proposal correctly declined to execute itself, so
// the agent clicked the page's own Approve button and the receipt recorded
// "approved by you". `press` and `commit-control` are one action with total
// coverage, and total coverage includes the button that exists to stop the
// action. These pin the layer that takes a control back out.

const CONFIRM = `
  <div id="app">
    <button data-dk-control="accept-all" data-dk-kind="commit">Accept all</button>
    <div role="dialog">
      <button data-dk-control="approve" data-dk-kind="commit" data-dk-human-only>Yes, do it</button>
      <input data-dk-control="signature" data-dk-human-only data-dk-kind="commit" />
      <button data-dk-control="cancel" data-dk-kind="read" data-dk-human-only="false">No</button>
    </div>
  </div>`;

test("a human-only control is not enumerated, so an agent never learns it is there", () => {
  // Not listed and not refusable-by-name: the two have to go together. A
  // control an agent can see in the snapshot and cannot press is an invitation
  // to keep trying, and a control it cannot see does not come up.
  const { doc } = page(CONFIRM);
  const { dk } = bind(doc);
  const names = dk.controls().map((c) => c.name);

  assert.deepEqual(names.sort(), ["accept-all", "cancel"]);
  assert.equal(dk.note()!.includes("approve"), false, "the note leaked the gate's own button");
});

test("pressing the gate's own approve button is refused as no-such-control", async () => {
  // `no-such-control` and NOT a refusal of its own, deliberately. A distinct
  // slug would make this an oracle over which buttons are the interesting
  // ones — ask for every name and the ones that come back differently are the
  // approvals. So a marked-human-only control answers exactly as a button
  // nobody marked at all.
  const live = page(CONFIRM);
  const driver = driverFor(bind(live.doc).dk);

  for (const verb of ["press", "commit-control"]) {
    const result = await driver.call(verb, { control: "approve" });
    assert.equal(refusal(result), "no-such-control");
    assert.equal(live.root.querySelector('[data-dk-control="approve"]')!.clicks, 0);
  }

  // The field form too: a signature box is a control that takes text, and
  // typing into it is the same bypass wearing different clothes.
  assert.equal(refusal(await driver.call("type-into", { control: "signature", text: "A. Lovelace" })), "no-such-control");
  // And the unmarked button beside it still works, so this is an opt-out and
  // not a quarantine of everything near a dialog.
  assert.equal((await driver.call("press", { control: "cancel" })).ok, true);
});

test("`data-dk-human-only=\"false\"` is a real no, for markup that always emits the attribute", () => {
  // Presence is the signal, because `data-dk-human-only` with no value is how
  // an author writes it by hand. A templating language that cannot omit an
  // attribute needs a way to say no, and `false` is it — the `cancel` button in
  // the fixture above is enumerated for exactly that reason.
  const { doc } = page(CONFIRM);
  const { dk } = bind(doc);
  assert.ok(dk.controls().some((c) => c.name === "cancel"));
});

// ── the mark is inherited ───────────────────────────────────────────────────
//
// `data-dk-human-only` used to read the element and nothing else, so the
// natural way to write it — one attribute on the gate itself — marked nothing,
// and the only spelling that worked was to repeat it on every Yes, every
// signature field and every 2FA box inside the dialog. An opt-out whose
// correct use is the laborious one is an opt-out that gets got wrong. The walk
// needs an upward link, which `ElementLike.parentElement` now declares as an
// OPTIONAL field: a real `Element` has it, and anything that does not reads as
// "no parent", which is the behaviour this package had before.

const WRAPPED = `
  <div id="app">
    <button data-dk-control="accept-all" data-dk-kind="commit">Accept all</button>
    <div role="dialog" data-dk-human-only>
      <p>Accept 3,412 descents?</p>
      <button data-dk-control="approve" data-dk-kind="commit">Yes, do it</button>
      <input data-dk-control="signature" data-dk-kind="commit" />
      <div class="options">
        <input type="checkbox" data-dk-control="also-notify" data-dk-kind="describe" />
      </div>
      <button data-dk-control="read-terms" data-dk-kind="read" data-dk-human-only="false">Terms</button>
    </div>
  </div>`;

test("a control inside an element marked human-only is withheld too, at any depth", () => {
  const { doc } = page(WRAPPED);
  const { dk } = bind(doc);

  // `also-notify` is two levels down inside the dialog, which is the case the
  // element-only read got wrong: an author marks the dialog, not its grid.
  assert.deepEqual(
    dk.controls().map((c) => c.name).sort(),
    ["accept-all", "read-terms"],
  );
  assert.equal(dk.note()!.includes("approve"), false, "the note leaked the gate's own button");
  assert.equal(dk.note()!.includes("also-notify"), false);
});

test("a control inside a human-only ancestor is refused as no-such-control, like an unmarked one", async () => {
  // Same slug as a name nobody ever marked, deliberately: a distinct refusal
  // would be an oracle over which buttons are the approvals.
  const live = page(WRAPPED);
  const driver = driverFor(bind(live.doc).dk);

  for (const control of ["approve", "also-notify"]) {
    for (const verb of ["press", "commit-control"]) {
      assert.equal(refusal(await driver.call(verb, { control })), "no-such-control");
    }
    assert.equal(at(live.root, control).clicks, 0);
  }
  assert.equal(
    refusal(await driver.call("type-into", { control: "signature", text: "A. Lovelace" })),
    "no-such-control",
  );
  assert.equal(at(live.root, "signature").value, "");
});

test("a descendant may say `false`, so one control inside a marked region is opened again", async () => {
  // The nearest mark wins, which is the only reading that lets an author close
  // a dialog and still publish the one thing in it that is safe to read.
  const live = page(WRAPPED);
  const driver = driverFor(bind(live.doc).dk);

  assert.equal((await driver.call("press", { control: "read-terms" })).ok, true);
  assert.equal(at(live.root, "read-terms").clicks, 1);
});

test("the author is told which mark withheld a control, and the agent is told nothing", () => {
  // The one case of this attribute that looks like a bug in the library: a
  // control that is marked, is on screen, and does not appear. So the library
  // says which it was — to the author, on the channel an agent never reads.
  // Once per enumeration, like every other diagnostic here; the collapsing to
  // one line per distinct message belongs to the default console warner, and
  // an `onWarn` that wants it does its own.
  const { doc } = page(WRAPPED);
  const { dk, warnings } = bind(doc);
  dk.controls();

  const said = warnings.filter((w) => w.includes("data-dk-human-only"));
  assert.equal(said.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
  assert.match(said[0]!, /approve/);
  assert.match(said[0]!, /signature/);
  assert.match(said[0]!, /also-notify/);
  // And it names the way back, because an author who marked a wrapper by
  // accident needs the escape hatch and not just the diagnosis.
  assert.match(said[0]!, /data-dk-human-only="false"/);
});

test("an element with no parentElement reads as having no ancestors, so an older fake still works", () => {
  // `parentElement` is optional on `ElementLike` for this exact reason. A
  // hand-rolled element — a test double, a non-DOM renderer's adapter — that
  // predates the walk must not crash and must not have its controls withheld;
  // it gets the element-only behaviour, which is what it always had.
  const button = {
    textContent: "Accept all",
    getAttribute: (name: string) =>
      ({ "data-dk-control": "accept-all", "data-dk-kind": "commit" })[name] ?? null,
    click: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const root = {
    querySelector: () => null,
    querySelectorAll: (selectors: string) => (selectors === "[data-dk-control]" ? [button] : []),
  };

  const dk = controlsFromDom({ root, onWarn: () => {} });
  assert.deepEqual(dk.controls(), [{ name: "accept-all", label: "Accept all", kind: "commit" }]);
});

test("the undeclared warning asks for a decision and does not offer `read` as a way to silence it", () => {
  // The line this replaces ended "and the question goes away", which is true
  // and is also an instruction to type the cheapest value: `read` on
  // everything silences every question in one pass, and `read` on a button
  // that changes data removes the only thing in front of an agent pressing it.
  // The library cannot catch that, so the warning must not invite it.
  const { dk, warnings } = bind(page(SCREEN).doc, { rows: "#contacts" });
  dk.controls();

  const said = warnings.find((w) => w.includes("declare no data-dk-kind"))!;
  assert.match(said, /export/, "the warning has to name the control");
  assert.match(said, /CLAIM about what the control does/);
  assert.match(said, /nothing here can check it/);
  assert.doesNotMatch(said, /question goes away/);
});
