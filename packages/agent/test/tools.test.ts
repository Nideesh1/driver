/**
 * The static half, pinned.
 *
 * These tests exist mostly to keep this package honest about one claim: that a
 * model driving an app through the MCP server and a model driving it through
 * the in-page loop read the same sentences about the same verbs. The strings
 * asserted here are quoted from `python/src/driverkit/mcp_server.py` and
 * `render.py`, so a change in one half that is not mirrored in the other
 * breaks a named test instead of silently splitting the library in two.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../../core/src/registry.ts";
import { argSchema, renderResult, renderSnapshot, systemPrompt, toolsFor, verbTool } from "../src/index.ts";

const bulk = () =>
  mount({
    app: "Bulk",
    visible: () => ({ where: "rows", rev: 3 }),
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select every row matching a predicate",
        args: {
          where: { type: "string", describe: "predicate" },
          limit: { type: "number", describe: "cap", optional: true },
          mode: { type: "string", describe: "how", oneOf: ["all", "page"] },
        },
        run: () => {},
      },
      { name: "accept-selected", kind: "commit", describe: "accept the selection", run: () => {} },
      { name: "peek", describe: "declares no kind", run: () => {} },
    ],
  });

test("oneOf becomes JSON Schema enum, never JSON Schema oneOf", () => {
  // The names look alike and the meanings diverge: the core's `oneOf` is a
  // list of permitted scalars, which is `enum`, while JSON Schema's `oneOf` is
  // a list of subschemas. Emitting the latter produces a schema that validates
  // anything.
  const schema = argSchema({ type: "string", describe: "how", oneOf: ["all", "page"] });
  assert.deepEqual(schema, { type: "string", description: "how", enum: ["all", "page"] });
  assert.equal("oneOf" in schema, false);
});

test("optional is expressed by omission from required, which is how JSON Schema says it", () => {
  // An `"optional": true` key would be ignored by every validator and the
  // argument would silently become mandatory.
  const tool = toolsFor(bulk().manifest()).find((t) => t.name === "select-where")!;
  assert.deepEqual(tool.inputSchema.required, ["where", "mode"]);
  assert.equal("optional" in tool.inputSchema.properties.limit!, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test("a verb that declares its own rev keeps it, because the app's meaning wins", () => {
  const tool = verbTool({
    name: "jump",
    describe: "jump to a revision",
    args: { rev: { type: "string", describe: "a git rev, not a driverkit one" } },
  });
  assert.equal(tool.inputSchema.properties.rev!.type, "string");
  assert.deepEqual(tool.inputSchema.required, ["rev"]);
});

test("an absent kind adds no safety claim in either direction", () => {
  const tool = toolsFor(bulk().manifest()).find((t) => t.name === "peek")!;
  assert.ok(!/READ-ONLY/.test(tool.description));
  assert.ok(!/COMMIT/.test(tool.description));
  // Defaulting to `read` would tell a model an irreversible verb is free to
  // try; defaulting to `commit` would warn on every verb of every app written
  // before the field existed, which is a warning on nothing.
  assert.match(tool.description, /^declares no kind\n\nReturns the screen/);
});

test("an unknown arg type is loud rather than becoming a schema nobody validates", () => {
  assert.throws(
    () => argSchema({ type: "date" as never, describe: "when" }),
    /unknown arg type "date"/,
  );
});

test("the system prompt contains the app's verbs' vocabulary but no screen and no data", () => {
  const prompt = systemPrompt(bulk().manifest());
  assert.match(prompt, /live Bulk session/);
  // The describe/commit pairing is spelled out here and not only per-verb,
  // because "select 1000 and accept" is the motivating case and the pairing is
  // a workflow rule rather than a property of either verb alone.
  assert.match(prompt, /Never commit on a selection whose count you have not read/);
  assert.match(prompt, /`describe` verb with the predicate, read the `count`/);
  assert.match(prompt, /takes no predicate and acts on the current selection/);
  assert.ok(!/rev 3/.test(prompt), "the screen leaked into the system prompt");
});

test("the system prompt is a pure function of the manifest and the static instructions", () => {
  // Two mounts of the same app must agree byte for byte, which is what makes
  // the prefix cacheable ACROSS USERS rather than merely across one person's
  // turns -- where most of the saving actually lives.
  assert.equal(systemPrompt(bulk().manifest()), systemPrompt(bulk().manifest()));
  assert.notEqual(systemPrompt(bulk().manifest()), systemPrompt(bulk().manifest(), "Be terse."));
});

test("a snapshot renders in a fixed field order so two reads diff only where the screen moved", () => {
  const text = renderSnapshot({
    where: "contacts, filtered to Acme",
    rev: 8,
    selected: ["c-8821"],
    note: "sorted by name",
    rows: [
      { id: "c-8820", company: "Acme", status: "new" },
      { id: "c-8821", company: "Acme", flagged: true },
    ],
    page: { index: 0, size: 2, total: 5 },
  });

  assert.equal(
    text,
    [
      "where: contacts, filtered to Acme (rev 8)",
      // Before the rows: "this one" is usually the subject of the next verb.
      "selected: c-8821",
      "note: sorted by name",
      "rows 1-2 of 5",
      "more rows exist off screen; use the app's own paging verb to reach them",
      // Columns are the union over all rows, `id` first. Dropping a column
      // only some rows carry would hide exactly the outlier a person asks
      // about. `-` for a missing cell; no trailing padding on the last column.
      "id      company  status  flagged",
      "c-8820  Acme     new     -",
      "c-8821  Acme     -       true",
    ].join("\n"),
  );
});

test("absent rows and zero rows are different claims", () => {
  // An app with no table on screen reports no rows; a filter that matched
  // nothing reports an empty list. An agent told "no rows" in the first case
  // would conclude the records do not exist.
  assert.match(renderSnapshot({ where: "settings", rev: 1 }), /\(this screen reports no rows\)/);
  const empty = renderSnapshot({ where: "contacts", rev: 1, rows: [], page: { index: 0, size: 20, total: 0 } });
  assert.match(empty, /rows 0 of 0/);
  assert.match(empty, /\(no rows on screen\)/);
});

test("no page field is rendered as a claim that this is everything", () => {
  // The alternative reading -- "the driver forgot to tell me" -- sends an
  // agent hunting for a paging verb that does not exist.
  assert.match(
    renderSnapshot({ where: "contacts", rev: 1, rows: [{ id: "c-1" }] }),
    /rows 1 \(all of them\)/,
  );
});

test("a count renders high up, on its own line, with separators that do not vary by locale", () => {
  // 1000 and 10000 look alike at a glance and this is the number the commit
  // decision turns on. `toLocaleString` would render it `1.000` for some
  // people, which is a per-user difference in the one number that matters.
  const text = renderResult({
    ok: true,
    count: 1000,
    snapshot: { where: "contacts", rev: 2, rows: [] },
  });
  assert.match(text, /^ok\ncount: 1,000 matched\n/);
  assert.match(text, /Check it is the number you expect before committing\./);
});

test("a refusal renders as an ordinary outcome, with the screen it left behind", () => {
  const text = renderResult({
    ok: false,
    refused: "nothing-selected",
    hint: "select something first",
    snapshot: { where: "contacts", rev: 2, rows: [] },
  });
  assert.match(text, /^refused: nothing-selected\nhint: select something first\n\nwhere: contacts/);
  // No alarm language. The slug is the one the manifest already declared under
  // `refuses`, so a model that read the tool description recognises the word;
  // dressing it up mostly teaches a model to retry the same call.
  assert.ok(!/error|failed/i.test(text));
});

test("a window with a known total renders the total, and says more exists in words", () => {
  // Pinned alongside the unknown-total case below so the two cannot drift
  // apart: these are different claims about the same screen and a model has to
  // be able to tell them apart by reading.
  const text = renderSnapshot({
    where: "contacts",
    rev: 1,
    rows: [{ id: "c-1" }],
    page: { index: 0, size: 1, total: 20 },
  });
  assert.match(text, /^where: contacts \(rev 1\)\nrows 1-1 of 20\n/);
  assert.match(text, /more rows exist off screen/);
  assert.doesNotMatch(text, /unknown/);
});

test("a window with no total says 'at least', never 'of undefined'", () => {
  // `page.total` is optional, and absent is the normal case for anything
  // reading a rendered DOM — an adapter cannot tell a virtualised grid from a
  // short list. Interpolating it unguarded put the literal string `of
  // undefined` into the prompt on every turn of every DOM-adapted app.
  //
  // What replaces it has to be a true claim. `of 1` would tell the model the
  // table ends where the window does, which is how an agent comes to report
  // that a record does not exist; a number for the total would be invented.
  const text = renderSnapshot({
    where: "contacts",
    rev: 1,
    rows: [{ id: "c-1" }],
    page: { index: 0, size: 1 },
  });
  assert.doesNotMatch(text, /undefined/);
  assert.match(text, /rows 1-1 of at least 1 \(total unknown\)/);
  assert.match(text, /more rows may exist off screen/);
  // And the instruction that the absence of a total is actually for: never
  // conclude something is missing from a window of unknown size.
  assert.match(text, /do not report that something is absent/);

  // A later page of an unknown-sized table still counts what it has seen.
  assert.match(
    renderSnapshot({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-41" }, { id: "c-42" }],
      page: { index: 2, size: 20 },
    }),
    /rows 41-42 of at least 42 \(total unknown\)/,
  );
});

test("selectedCount carries the size of a selection that selected cannot", () => {
  // The case the library exists for: `select-where` selects thousands of rows
  // in one call. Putting all of those ids in `selected` would push tens of
  // kilobytes into the uncached half of every later result, so `selected` is
  // the ids on screen and `selectedCount` is the truth about the size. A model
  // shown three ids and asked to commit must be told in words that the list is
  // a window, or it will believe three rows are about to change.
  const text = renderSnapshot({
    where: "contacts, filtered to Acme",
    rev: 9,
    selected: ["c-0", "c-1", "c-2"],
    selectedCount: 10000,
    rows: [{ id: "c-0" }],
    page: { index: 0, size: 1, total: 10000 },
  });
  assert.match(text, /selected: c-0, c-1, c-2\n/);
  // With separators, for the same reason a count has them: 10000 and 1000 look
  // alike at a glance and this is the number a commit decision turns on.
  assert.match(text, /selected 10,000 rows in all; the 3 ids above are only the ones on screen/);

  // A selection entirely off screen is still reported. Saying nothing would
  // read as "nothing is selected" to the one caller that most needs to know.
  assert.match(
    renderSnapshot({ where: "contacts", rev: 9, selectedCount: 1200, rows: [{ id: "c-0" }] }),
    /selected 1,200 rows in all; none of them are on screen/,
  );

  // Nothing extra is said when the ids ARE the whole selection: the list is
  // already the answer, and a second line restating its length is bytes in the
  // uncached half that carry nothing.
  assert.doesNotMatch(
    renderSnapshot({ where: "contacts", rev: 9, selected: ["c-0"], selectedCount: 1 }),
    /rows in all/,
  );
});

// ---- screens, the app's own briefing, and a commit that can be undone ----

/** An app with screens: two verbs scoped to one each, one that works anywhere,
 *  a commit the app can undo, and a briefing of its own. */
const scoped = () =>
  mount({
    app: "Scoped",
    instructions: "this app has screens: contacts and settings. `go` reaches both.",
    visible: () => ({ where: "contacts list", screen: "contacts", rev: 3 }),
    verbs: [
      { name: "next-page", kind: "read", describe: "show the next page", screen: "contacts", run: () => {} },
      {
        name: "set-setting",
        kind: "commit",
        reversible: true,
        describe: "turn dense rows on",
        screen: "settings",
        run: () => {},
      },
      { name: "accept-selected", kind: "commit", describe: "accept the selection", run: () => {} },
      { name: "clear", kind: "describe", describe: "deselect everything", run: () => {} },
    ],
  });

test("a verb's screen is in its tool description, so the call is never made", () => {
  // Same argument as `refuses` being in the description: the point of declaring
  // where a verb lives is that a well-briefed model does not call it from
  // somewhere else and then have to recover.
  const byName = Object.fromEntries(toolsFor(scoped().manifest()).map((t) => [t.name, t]));
  assert.match(byName["next-page"]!.description, /ONLY ON THE `contacts` SCREEN/);
  assert.match(byName["next-page"]!.description, /refused as `wrong-screen`/);
  // The screen line is where a model is told to look for where it is, which is
  // the one piece of the answer the static half can carry.
  assert.match(byName["next-page"]!.description, /the `screen` line of every screen you read/);
  // A verb that works anywhere says nothing about screens at all. Saying "works
  // everywhere" on twelve of eighteen verbs is prose nobody reads.
  assert.ok(!/SCREEN/.test(byName["clear"]!.description));
});

test("a verb on two screens names both in its description, not one of them", () => {
  // Naming one of two is worse than naming none: a model told `next-page` is
  // ONLY ON THE `contacts` SCREEN navigates away from the company list it was
  // already standing on, to do something it could have done where it was.
  const driver = mount({
    app: "two-list",
    visible: () => ({ where: "contacts list", screen: "contacts", rev: 1 }),
    verbs: [
      {
        name: "next-page",
        kind: "read",
        describe: "page whichever list you are on",
        screen: ["contacts", "company"],
        run: () => {},
      },
      {
        name: "sort",
        kind: "read",
        describe: "reorder three lists",
        screen: ["contacts", "company", "companies"],
        run: () => {},
      },
      // The single-string wording must not acquire a comma or a plural because
      // the field can now hold a list: this is the sentence every existing
      // app's cached prefix already contains, byte for byte.
      { name: "search", kind: "read", describe: "search", screen: "contacts", run: () => {} },
    ],
  });
  const byName = Object.fromEntries(toolsFor(driver.manifest()).map((t) => [t.name, t]));

  assert.match(byName["next-page"]!.description, /ONLY ON THE `contacts` AND `company` SCREENS\./);
  assert.match(
    byName["sort"]!.description,
    /ONLY ON THE `contacts`, `company` AND `companies` SCREENS\./,
  );
  assert.match(byName["search"]!.description, /ONLY ON THE `contacts` SCREEN\./);
  // And the rest of the sentence is the same one in every case, because what
  // follows it is mechanics and not a claim about this verb.
  for (const name of ["next-page", "sort", "search"]) {
    assert.match(byName[name]!.description, /refused as `wrong-screen`/);
  }
});

test("the tool list does not vary with the live screen, which is the cost argument", () => {
  // The decision this pins, and the reason the mapping is static rather than a
  // filtered list: a verb list that changed on every navigation would bust the
  // prompt prefix every time the person moved — paid for on every turn, for
  // every user. So `set-setting` is offered while the app is on the contacts
  // list, and the core refuses it there with both screens named.
  const tools = toolsFor(scoped().manifest());
  assert.deepEqual(
    tools.map((t) => t.name),
    ["next-page", "set-setting", "accept-selected", "clear", "read_screen"],
  );
});

test("screen is hoisted onto every verb, the way rev is", () => {
  // A model has nowhere else to put it, and the claim is worth making: a paging
  // call that quotes neither `rev` nor `screen` lands on whatever screen is
  // there when it arrives.
  const byName = Object.fromEntries(toolsFor(scoped().manifest()).map((t) => [t.name, t]));
  assert.equal(byName["clear"]!.inputSchema.properties.screen!.type, "string");
  assert.match(byName["clear"]!.inputSchema.properties.screen!.description!, /refused as `wrong-screen`/);
  // Hoisted, so not required: a claim nobody makes is a check nobody asked for.
  assert.deepEqual(byName["clear"]!.inputSchema.required, []);
});

test("a verb that declares its own screen argument keeps it, because the app's meaning wins", () => {
  // `go(screen)` is a real verb in a real app, and it is the navigation verb —
  // the one place where stealing the name would break the app's own vocabulary.
  // Exactly the rule `rev` follows.
  const tool = verbTool({
    name: "go",
    describe: "go to one of the app's screens",
    args: { screen: { type: "string", describe: "which screen", oneOf: ["contacts", "settings"] } },
  });
  assert.deepEqual(tool.inputSchema.properties.screen!.enum, ["contacts", "settings"]);
  assert.deepEqual(tool.inputSchema.required, ["screen"]);
});

test("a reversible commit reads differently from one that cannot be undone", () => {
  // The failure this exists for: a page-size change and accepting 3,412
  // contacts were both getting *** THIS CHANGES DATA AND MAY BE IRREVERSIBLE
  // ***, and a banner that shows up on a page-size change is a banner a model
  // learns to read past — the same way a person learns to click Yes without
  // reading. So the shouting is reserved for the calls that deserve it.
  const byName = Object.fromEntries(toolsFor(scoped().manifest()).map((t) => [t.name, t]));
  assert.match(byName["set-setting"]!.description, /COMMIT \(reversible\): this changes data/);
  assert.match(byName["set-setting"]!.description, /can be undone/);
  assert.ok(!/MAY BE IRREVERSIBLE/.test(byName["set-setting"]!.description));
  // It still says the data changes and the person still sees it: reversible is
  // a claim that there is a way back, not that nobody minds.
  assert.match(byName["set-setting"]!.description, /a change the person will see/);
  // And the irreversible one keeps every asterisk.
  assert.match(byName["accept-selected"]!.description, /\*\*\* COMMIT: THIS CHANGES DATA AND MAY BE IRREVERSIBLE\. \*\*\*/);
});

test("reversible changes the description and nothing else about the tool", () => {
  // Scoped deliberately narrowly: the flag is a sentence in the cached half and
  // an input to a host's confirmation gate. It is not an argument, not a
  // refusal, and it does not touch the schema — a commit is still a commit.
  const plain = verbTool({ name: "act", kind: "commit", describe: "act" });
  const undoable = verbTool({ name: "act", kind: "commit", describe: "act", reversible: true });
  assert.deepEqual(undoable.inputSchema, plain.inputSchema);
  assert.equal(undoable.name, plain.name);
  assert.notEqual(undoable.description, plain.description);

  // And on a verb that changes no data it says nothing at all, because there it
  // is a claim about nothing.
  const read = verbTool({ name: "look", kind: "read", describe: "look", reversible: true });
  assert.ok(!/reversible/.test(read.description));
  assert.match(read.description, /READ-ONLY/);
});

test("the app's own briefing reaches the cached system prompt, after the safety rules", () => {
  // `Manifest.instructions` is the field that closes the one gap where the two
  // halves of this library disagreed: a widget could be handed `instructions`
  // through `drive()` and an agent arriving over MCP could not, so an app with
  // something to say to both had to repeat it in every snapshot's `note` — in
  // the uncached half, paid for on every turn.
  const prompt = systemPrompt(scoped().manifest());
  assert.match(prompt, /this app has screens: contacts and settings/);
  // Last, not first: an app's note is an addition to the safety rules and not a
  // replacement for them, and a model reading in order should meet them first.
  assert.ok(
    prompt.indexOf("Never commit on a selection") < prompt.indexOf("this app has screens"),
    "the app's briefing was put ahead of the safety rules",
  );
});

test("the app's briefing and the host's both land, with the host's last", () => {
  // Two static voices, and they can disagree. The host embedding the app is the
  // more specific one, so it goes last — whichever is last is the one a model
  // follows.
  const prompt = systemPrompt(scoped().manifest(), "Be terse.");
  assert.ok(prompt.indexOf("this app has screens") < prompt.indexOf("Be terse."));
});

test("the briefing stays out of the snapshot and out of the uncached half", () => {
  // The whole reason it was moved. A sentence that never changes must be paid
  // for once.
  const driver = scoped();
  assert.equal("instructions" in driver.snapshot(), false);
  assert.ok(!renderSnapshot(driver.snapshot()).includes("this app has screens"));
});

test("the system prompt still names the three kinds, with the read promise corrected", () => {
  // `read` no longer claims to change nothing, because `go`, `open-contact` and
  // `back` are reads and they move the person's screen out from under them —
  // the most visible thing an agent can do to somebody watching. The two
  // promises that decide whether the next call is safe are the two it makes.
  const prompt = systemPrompt(scoped().manifest());
  assert.match(prompt, /READ-ONLY changes no data and reports no count/);
  assert.match(prompt, /moving to another screen is a read/);
  assert.match(prompt, /DESCRIBE changes what is selected and reports a `count`/);
  assert.match(prompt, /a COMMIT that says it is reversible can be undone/);
});

test("the screen id renders above the prose, and only when the app declares one", () => {
  // `where` carries the filter, the sort and a drill-down's record description,
  // so it moves constantly for reasons that are not navigation. `screen` is the
  // one line on this block that can be compared with `===`, which is what makes
  // "did I navigate?" answerable at all. First, because it is the stable fact
  // and the prose is about it.
  const text = renderSnapshot({
    where: "Acme Industrial — 410 contacts, pending",
    screen: "company",
    rev: 12,
    rows: [{ id: "c-1" }],
  });
  assert.match(text, /^screen: company\nwhere: Acme Industrial/);

  // An app that does not describe its screens renders exactly what it rendered
  // before the field existed. Not a cosmetic point: this is the uncached half,
  // and a line that says nothing is paid for on every turn.
  assert.match(
    renderSnapshot({ where: "contacts", rev: 12, rows: [{ id: "c-1" }] }),
    /^where: contacts \(rev 12\)/,
  );
  assert.ok(!renderSnapshot({ where: "contacts", rev: 12 }).includes("screen:"));
});
