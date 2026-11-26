/**
 * These tests are the specification. Each one pins a decision that was argued
 * for, so a future change that looks harmless has to break a named test and
 * read why the rule exists before deleting it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkArg, mount, refusal } from "../src/index.ts";
import type { Snapshot } from "../src/index.ts";

/** A toy app: a list of descents, a lane per descent, a cursor. Enough shape
 *  to exercise the rules without pretending to be a real application. */
function app() {
  const lanes = new Map<string, string>([
    ["01a2", "pruning"],
    ["01b7", "doing"],
  ]);
  let rev = 1;
  let where = "descents";
  let selected: string[] = [];
  let pageIndex = 0;
  const PAGE = 1;

  const visible = (): Snapshot => {
    const ids = [...lanes.keys()];
    const start = pageIndex * PAGE;
    return {
      where,
      rev,
      rows: ids.slice(start, start + PAGE).map((id) => ({ id, lane: lanes.get(id)! })),
      page: { index: pageIndex, size: PAGE, total: ids.length },
      ...(selected.length ? { selected } : {}),
    };
  };

  const driver = mount({
    app: "toy",
    visible,
    verbs: [
      {
        name: "goto",
        describe: "open a descent",
        args: { id: { type: "string", describe: "descent id" } },
        refuses: ["no-such-descent"],
        run: ({ id }, ctx) => {
          if (!lanes.has(id)) return ctx.refuse("no-such-descent", `no descent \`${id}\``);
          where = `descent ${id}`;
          selected = [id];
          rev++;
        },
      },
      {
        name: "set-lane",
        describe: "move a descent to a lane",
        args: {
          id: { type: "string", describe: "descent id" },
          lane: { type: "string", describe: "target lane", oneOf: ["doing", "pruning", "held"] },
        },
        refuses: ["no-such-descent", "machine-may-not-leave-pruning"],
        run: ({ id, lane }, ctx) => {
          if (!lanes.has(id)) return ctx.refuse("no-such-descent", `no descent \`${id}\``);
          if (lanes.get(id) === "pruning" && lane !== "pruning") {
            return ctx.refuse(
              "machine-may-not-leave-pruning",
              "pruning is the human gate; only a person moves a descent out of it",
            );
          }
          lanes.set(id, lane);
          rev++;
        },
      },
      {
        name: "scroll",
        describe: "show the next page of rows",
        run: () => {
          if ((pageIndex + 1) * PAGE < lanes.size) {
            pageIndex++;
            rev++;
          }
        },
      },
      { name: "boom", describe: "always throws", run: () => { throw new Error("kaboom"); } },
    ],
  });

  return { driver, lanes, visible };
}

test("the manifest carries no data, only the verb surface", () => {
  const { driver } = app();
  const m = driver.manifest();
  const json = JSON.stringify(m);

  // The whole cost argument rests on this: no id and no row ever reaches the
  // half that gets cached in the prompt prefix.
  assert.ok(!json.includes("01a2"), "a descent id leaked into the manifest");
  assert.ok(!json.includes("01b7"), "a descent id leaked into the manifest");
  assert.deepEqual(
    m.verbs.map((v) => v.name).sort(),
    ["boom", "goto", "scroll", "set-lane"],
  );

  // Note what is NOT banned here. `set-lane` declares oneOf ["doing",
  // "pruning", "held"], so the string "doing" is in the manifest and belongs
  // there: the set of lanes that EXIST is static vocabulary, identical for
  // every user forever. What must never appear is which lane a particular
  // descent is in -- that is the live half. Banning the word would confuse
  // the vocabulary of the app with the state of the app, and would push an
  // author toward dropping `oneOf`, which is the field that lets an agent
  // fix a bad call without another round trip.
  assert.ok(
    m.verbs.find((v) => v.name === "set-lane")!.args!.lane.oneOf!.includes("doing"),
    "static vocabulary was stripped out of the manifest",
  );
});

test("the manifest is identical no matter what the live data says", async () => {
  // The sharpest form of the rule: drive one app's data somewhere completely
  // different and its manifest must still byte-for-byte match a fresh one.
  // This is what makes the prefix cacheable ACROSS USERS, not merely across
  // one user's turns.
  const a = app();
  await a.driver.call("set-lane", { id: "01b7", lane: "held" });
  await a.driver.call("goto", { id: "01b7" });
  await a.driver.call("scroll");

  assert.equal(
    JSON.stringify(a.driver.manifest()),
    JSON.stringify(app().driver.manifest()),
  );
});

test("the manifest version is stable across calls and across live data changes", async () => {
  const { driver } = app();
  const first = driver.manifest().version;
  await driver.call("set-lane", { id: "01b7", lane: "held" });
  assert.equal(driver.manifest().version, first, "data changed the manifest version");
});

test("a describe verb reports the count the commit decision turns on", async () => {
  // The motivating case, end to end: "find the Acme contacts and accept the
  // top thousand". The match is far larger than the window, so the number
  // cannot come from `rows` and cannot come from `page.total` either -- that
  // describes the table, not the selection.
  const all = Array.from({ length: 3412 }, (_, i) => `c-${i}`);
  let selected: string[] = [];
  let rev = 1;

  const driver = mount({
    app: "Contacts",
    visible: () => ({
      where: "contacts",
      rev,
      rows: all.slice(0, 20).map((id) => ({ id })),
      page: { index: 0, size: 20, total: all.length },
      ...(selected.length ? { selected: selected.slice(0, 3) } : {}),
    }),
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select every contact matching a filter",
        args: {
          where: { type: "string", describe: "e.g. company=Acme" },
          limit: { type: "number", describe: "cap", optional: true },
        },
        run: ({ where, limit }) => {
          const matched = where === "company=Acme" ? all : [];
          selected = matched.slice(0, (limit as number) ?? matched.length);
          rev++;
          return { count: selected.length, note: `${matched.length} matched` };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        refuses: ["nothing-selected"],
        run: (_args, ctx) => {
          if (!selected.length) return ctx.refuse("nothing-selected");
          const n = selected.length;
          selected = [];
          rev++;
          return { count: n };
        },
      },
    ],
  });

  // One call, not a thousand. The predicate crossed the wire; the ids never did.
  const picked = await driver.call("select-where", { where: "company=Acme", limit: 1000 });
  assert.equal(picked.ok, true);
  if (!picked.ok) return;
  assert.equal(picked.count, 1000);
  assert.equal(picked.note, "3412 matched");
  // Nothing irreversible has happened yet -- that is the point of `describe`.

  const done = await driver.call("accept-selected", {});
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.count, 1000);
});

test("a describe verb that matched nothing says 0, which is not the same as saying nothing", async () => {
  const driver = mount({
    app: "Contacts",
    visible: () => ({ where: "contacts", rev: 1 }),
    verbs: [
      { name: "counts", kind: "describe", describe: "matches none", run: () => ({ count: 0 }) },
      { name: "silent", kind: "describe", describe: "does not count", run: () => {} },
    ],
  });

  const zero = await driver.call("counts");
  const quiet = await driver.call("silent");
  assert.equal(zero.ok && zero.count, 0);
  // Absent, not 0. "I looked and found none" must not be confused with "I do
  // not report counts" -- the first says do not commit, the second says ask.
  assert.equal(quiet.ok && "count" in quiet, false);
});

test("a verb's kind reaches the manifest, which is the only hop that matters", async () => {
  const driver = mount({
    app: "bulk",
    visible: () => ({ where: "rows", rev: 1 }),
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select every row matching a predicate",
        args: { where: { type: "string", describe: "predicate" } },
        run: () => {},
      },
      { name: "accept-selected", kind: "commit", describe: "accept the selection", run: () => {} },
      { name: "peek", describe: "declares no kind", run: () => {} },
    ],
  });

  const byName = Object.fromEntries(driver.manifest().verbs.map((v) => [v.name, v]));
  assert.equal(byName["select-where"]!.kind, "describe");
  assert.equal(byName["accept-selected"]!.kind, "commit");
  // Absent, not defaulted. Guessing `read` would tell an agent an
  // irreversible verb is safe; guessing `commit` would warn on everything and
  // therefore warn on nothing.
  assert.equal("kind" in byName["peek"]!, false);
});

test("reclassifying a verb from describe to commit busts every cached manifest", () => {
  const verbs = (kind: "describe" | "commit") => [
    { name: "accept", kind, describe: "accept the selection", run: () => {} },
  ];
  const one = mount({ app: "a", visible: () => ({ where: "x", rev: 1 }), verbs: verbs("describe") });
  const two = mount({ app: "a", visible: () => ({ where: "x", rev: 1 }), verbs: verbs("commit") });

  // Same name, same args, same description. If `kind` were left out of the
  // fingerprint the version would not move, and an agent holding the old copy
  // would go on treating an irreversible verb as free to try.
  assert.notEqual(one.manifest().version, two.manifest().version);
});

test("two apps with the same verbs agree on the version; a changed verb does not", () => {
  assert.equal(app().driver.manifest().version, app().driver.manifest().version);

  const other = mount({
    app: "toy",
    visible: () => ({ where: "x", rev: 1 }),
    verbs: [{ name: "goto", describe: "open a descent — now with more words", run: () => {} }],
  });
  assert.notEqual(other.manifest().version, app().driver.manifest().version);
});

test("a successful call returns the snapshot AFTER it ran, so act and observe are one trip", async () => {
  const { driver } = app();
  const before = driver.snapshot().rev;
  const r = await driver.call("set-lane", { id: "01b7", lane: "held" });

  assert.equal(r.ok, true);
  assert.ok(r.snapshot.rev > before, "the returned snapshot predates the call");
  // No second read was needed to learn the outcome.
  assert.equal(r.snapshot.rows?.[0]?.id, "01a2");
});

test("a refusal is an ordinary result, not an exception", async () => {
  const { driver } = app();
  const r = await driver.call("set-lane", { id: "01a2", lane: "done" });

  assert.equal(r.ok, false);
  if (r.ok) return;
  // `done` is not in oneOf, so argument checking catches it before the body.
  assert.equal(r.refused, "bad-argument");
  assert.match(r.hint!, /must be one of/);
  // And the accepted set is named, so the agent can fix it without re-reading.
  assert.match(r.hint!, /"held"/);
});

test("the human gate is expressible: the machine cannot move a descent out of pruning", async () => {
  const { driver, lanes } = app();
  const r = await driver.call("set-lane", { id: "01a2", lane: "held" });

  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refused, "machine-may-not-leave-pruning");
  assert.equal(lanes.get("01a2"), "pruning", "the refusal did not actually hold");
  // The refusal was declared up front, in the cached half, so a well-briefed
  // agent never had to make this call to learn the answer.
  assert.ok(driver.manifest().verbs.find((v) => v.name === "set-lane")!.refuses!
    .includes("machine-may-not-leave-pruning"));
});

test("a stale call is refused rather than applied to a row the agent never saw", async () => {
  const { driver } = app();
  const seen = driver.snapshot().rev;
  await driver.call("set-lane", { id: "01b7", lane: "held" }); // someone else moved on

  const r = await driver.call("set-lane", { id: "01b7", lane: "doing" }, { rev: seen });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refused, "stale");
  assert.match(r.hint!, /read again/);
});

test("staleness is checked before arguments, because the fix is the same either way", async () => {
  const { driver } = app();
  const seen = driver.snapshot().rev;
  await driver.call("scroll");

  // Both wrong: the rev is old AND the lane is not in oneOf. The stale answer
  // is the useful one; the argument complaint would describe a row the agent
  // was never looking at.
  const r = await driver.call("set-lane", { id: "01a2", lane: "nonsense" }, { rev: seen });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refused, "stale");
});

test("omitting rev opts out of the staleness check", async () => {
  const { driver } = app();
  await driver.call("scroll");
  const r = await driver.call("set-lane", { id: "01b7", lane: "held" });
  assert.equal(r.ok, true);
});

test("an unknown verb names the ones that exist, for an agent holding an old manifest", async () => {
  const { driver } = app();
  const r = await driver.call("park");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refused, "unknown-verb");
  assert.match(r.hint!, /set-lane/);
});

test("a verb that throws is reported as a failed call and does not take the driver down", async () => {
  const { driver } = app();
  const r = await driver.call("boom");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refused, "threw");
  assert.match(r.hint!, /kaboom/);

  // Still alive. In the relay this is the difference between one bad verb and
  // a dead websocket pump.
  assert.equal((await driver.call("scroll")).ok, true);
});

test("the agent sees only what is on screen, and is told that more exists", async () => {
  const { driver } = app();
  const s = driver.snapshot();
  assert.equal(s.rows!.length, 1, "the agent was handed more than the screen shows");
  assert.deepEqual(s.page, { index: 0, size: 1, total: 2 });

  // `scroll` is how it reaches the rest — the same way a person would.
  const r = await driver.call("scroll");
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.rows![0]!.id, "01b7");
});

test("selection resolves 'this one' without a query", async () => {
  const { driver } = app();
  await driver.call("goto", { id: "01b7" });
  assert.deepEqual(driver.snapshot().selected, ["01b7"]);
  assert.equal(driver.snapshot().where, "descent 01b7");
});

test("two verbs with one name fail at mount, not on the first call", () => {
  assert.throws(
    () =>
      mount({
        app: "x",
        visible: () => ({ where: "x", rev: 1 }),
        verbs: [
          { name: "go", describe: "a", run: () => {} },
          { name: "go", describe: "b", run: () => {} },
        ],
      }),
    /both named `go`/,
  );
});

test("an unmounted driver refuses instead of pretending to work", async () => {
  const { driver } = app();
  driver.unmount();
  driver.unmount(); // idempotent
  const r = await driver.call("scroll");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refused, "unmounted");
});

test("checkArg: required, typed, enumerated", () => {
  const spec = { type: "string", describe: "d" } as const;
  assert.match(checkArg("id", spec, undefined)!, /missing argument/);
  assert.equal(checkArg("id", { ...spec, optional: true }, undefined), null);
  assert.match(checkArg("id", spec, 7)!, /wants a string, got number/);
  assert.equal(checkArg("id", spec, "ok"), null);
  assert.match(checkArg("l", { ...spec, oneOf: ["a", "b"] }, "c")!, /one of "a", "b"/);
});

test("refusal() builds the shape a verb returns", () => {
  assert.deepEqual(refusal("nope"), { __driverkit: "refusal", reason: "nope" });
  assert.equal(refusal("nope", "why").hint, "why");
});

test("async verbs are awaited before the snapshot is read", async () => {
  let done = false;
  const driver = mount({
    app: "async",
    visible: () => ({ where: "x", rev: done ? 2 : 1 }),
    verbs: [{
      name: "slow",
      describe: "resolves later",
      run: async () => { await new Promise((r) => setTimeout(r, 5)); done = true; },
    }],
  });
  const r = await driver.call("slow");
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.rev, 2, "the snapshot was read before the verb finished");
});

/** Run `body` with `console.warn` captured. The checks below are the only ones
 *  that are allowed to print, and a test that asserts a warning must not also
 *  dirty the suite's output. */
function warnings(body: () => void | Promise<void>): { lines: string[]; done: Promise<void> } {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  let done: Promise<void>;
  try {
    done = Promise.resolve(body()).finally(() => {
      console.warn = real;
    });
  } catch (err) {
    console.warn = real;
    throw err;
  }
  return { lines, done };
}

test("a verb may not be named after a reserved refusal slug, and that fails at mount", () => {
  // `mount()` used to accept a verb named `stale`, and an agent then had no way
  // to tell a refusal FROM that verb apart from a refusal ABOUT staleness. It
  // is a static fact about the verb surface, exactly like two verbs sharing a
  // name, so it fails at startup where it costs a developer one stack trace
  // rather than at a call where it would cost a working app.
  assert.throws(
    () =>
      mount({
        app: "toy",
        visible: () => ({ where: "x", rev: 1 }),
        verbs: [{ name: "stale", describe: "nope", run: () => {} }],
      }),
    /may not be named `stale`/,
  );
});

test("a verb may not declare a reserved refusal slug, and that fails at mount too", () => {
  // Declaring `timeout` is a promise, in the cached half, to tell an agent
  // "your call never landed" when what happened is that the app said no. The
  // declaration is visible at mount, so it is caught there.
  assert.throws(
    () =>
      mount({
        app: "toy",
        visible: () => ({ where: "x", rev: 1 }),
        verbs: [{ name: "fetch-it", describe: "nope", refuses: ["timeout"], run: () => {} }],
      }),
    /declares the reserved refusal `timeout`/,
  );
});

test("refusing with a reserved slug at call time is reported as threw, not passed through", async () => {
  // `refuses` is checked at mount, but a `run` body can still reach for
  // `ctx.refuse("timeout")` at any moment — and this is the hard case, because
  // it is only reachable while a working app is in the act of saying no.
  //
  // Three choices and only one survives: passing it through leaves an agent
  // reading `timeout` from a call that landed and answered, which empties the
  // reserved list of meaning; throwing kills a live run over a slug, turning a
  // declined commit into a dead panel. `threw` is already the core's word for
  // "the app's own code is broken", which is what this is, and it keeps the
  // reserved slugs saying only what they are for.
  const driver = mount({
    app: "toy",
    visible: () => ({ where: "x", rev: 1 }),
    verbs: [
      { name: "ask", describe: "refuses wrongly", run: (_a, ctx) => ctx.refuse("timeout") },
    ],
  });

  const capture = warnings(async () => {
    const out = await driver.call("ask");
    assert.equal(out.ok, false);
    assert.equal((out as { refused: string }).refused, "threw");
    assert.match((out as { hint: string }).hint, /reserved slug/);
    assert.match((out as { hint: string }).hint, /not something to retry differently/);
  });
  await capture.done;
  assert.equal(capture.lines.length, 1, "the app author was not told about their own bug");
  assert.match(capture.lines[0]!, /refused with the reserved slug `timeout`/);
});

test("a refusal outside a verb's declared refuses is warned about, and still returned", async () => {
  // `refuses` is documented as the list a `refuse()` is checked against, and
  // nothing checked it: the manifest is the only description of a verb an agent
  // gets, so an undeclared refusal is one it cannot plan around.
  //
  // A warning rather than a refusal or a throw. This fires on the path an app
  // takes when it is working correctly and merely saying no, and the app's own
  // answer is the truthful thing to return — turning a business rule into
  // `threw` would tell the agent the app is broken when it is not.
  const driver = mount({
    app: "toy",
    visible: () => ({ where: "x", rev: 1 }),
    verbs: [
      {
        name: "park",
        describe: "park a row",
        refuses: ["already-parked"],
        run: (_a, ctx) => ctx.refuse("not-on-this-plan", "upgrade first"),
      },
    ],
  });

  const capture = warnings(async () => {
    const out = await driver.call("park");
    assert.equal((out as { refused: string }).refused, "not-on-this-plan");
    assert.equal((out as { hint: string }).hint, "upgrade first");
  });
  await capture.done;
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0]!, /not in its declared refuses \[already-parked\]/);
});

test("a verb that declared no refuses is not warned about, because it claimed nothing", async () => {
  // The field is optional and absence makes no claim, the same way an absent
  // `kind` makes no safety claim. Warning on every app that never filled it in
  // would be a warning on everything and therefore a warning on nothing — and
  // the suite's own fixtures include such verbs on purpose.
  const driver = mount({
    app: "toy",
    visible: () => ({ where: "x", rev: 1 }),
    verbs: [{ name: "park", describe: "park a row", run: (_a, ctx) => ctx.refuse("busy") }],
  });

  const capture = warnings(async () => {
    const out = await driver.call("park");
    assert.equal((out as { refused: string }).refused, "busy");
  });
  await capture.done;
  assert.deepEqual(capture.lines, []);
});

test("one misdeclared refusal warns once, however many times a model repeats it", async () => {
  // A model that has not learned anything will call the same refused verb until
  // the loop detector stops it. The check must not turn that into a console
  // flood, or into a per-call cost in an app that ships with the bug.
  const driver = mount({
    app: "toy",
    visible: () => ({ where: "x", rev: 1 }),
    verbs: [
      {
        name: "repeat",
        describe: "always refuses",
        refuses: ["expected"],
        run: (_a, ctx) => ctx.refuse("surprising"),
      },
    ],
  });

  const capture = warnings(async () => {
    for (let i = 0; i < 5; i++) await driver.call("repeat");
  });
  await capture.done;
  assert.equal(capture.lines.length, 1);
});

test("selectedCount reports the size of a selection larger than the window", async () => {
  // The cost argument for the case the library exists for. A `describe` verb
  // selects 10,000 rows in one call; `selected` carries only the ids a person
  // can see, because 10,000 ids in the uncached half of every later result is
  // the token budget gone and, over the relay, a body nobody can send. The true
  // size is a number, so it goes in a number field rather than into `note` as
  // prose a model has to parse.
  const ALL = 10000;
  const WINDOW = 3;
  let selected: string[] = [];
  const driver = mount({
    app: "contacts",
    visible: () => ({
      where: "contacts",
      rev: 1,
      rows: Array.from({ length: WINDOW }, (_, i) => ({ id: `c-${i}` })),
      page: { index: 0, size: WINDOW, total: ALL },
      ...(selected.length ? { selected: selected.slice(0, WINDOW) } : {}),
      ...(selected.length ? { selectedCount: selected.length } : {}),
    }),
    verbs: [
      {
        name: "select-all",
        kind: "describe",
        describe: "select every contact",
        run: () => {
          selected = Array.from({ length: ALL }, (_, i) => `c-${i}`);
          return { count: selected.length };
        },
      },
    ],
  });

  const out = await driver.call("select-all");
  assert.equal(out.ok, true);
  assert.equal(out.snapshot.selectedCount, ALL);
  assert.equal(out.snapshot.selected!.length, WINDOW, "the whole selection leaked onto the screen");
  // The two fields are different facts and neither substitutes for the other:
  // the ids resolve "this one", the count decides whether a commit is safe.
  assert.deepEqual(out.snapshot.selected, ["c-0", "c-1", "c-2"]);
});

// ---- screens -------------------------------------------------------------

/**
 * A two-screen app: a list that pages, and a form that does not.
 *
 * `screen` is on the verbs that only make sense somewhere — `next-page` on the
 * list, `set-setting` on the form — and absent from the ones that work from
 * anywhere, which is the common case and must stay the default.
 */
function screens() {
  let screen = "contacts";
  let page = 0;
  let dense = false;

  const driver = mount({
    app: "two-screen",
    instructions: "this app has two screens: contacts and settings. `go` reaches both.",
    visible: () => ({
      where: screen === "contacts" ? `contacts list, page ${page + 1}` : "settings",
      screen,
      rev: page + (dense ? 100 : 0) + 1,
      rows: screen === "contacts" ? [{ id: "c-1" }] : [{ id: "dense-rows", value: String(dense) }],
    }),
    verbs: [
      {
        name: "go",
        kind: "read",
        describe: "go to one of the app's screens",
        // The app's own `screen` ARGUMENT, which is not `Verb.screen`: this
        // verb works from anywhere and takes the destination as an argument.
        // Both spellings in one verb on purpose — the hoisted `screen` must not
        // steal the name, exactly like `rev`.
        args: { screen: { type: "string", describe: "which screen", oneOf: ["contacts", "settings"] } },
        run: ({ screen: to }: { screen: string }) => {
          screen = to;
          page = 0;
        },
      },
      {
        name: "next-page",
        kind: "read",
        describe: "show the next page of contacts",
        screen: "contacts",
        run: () => {
          page++;
        },
      },
      {
        name: "set-setting",
        kind: "commit",
        // One click to undo, so it is a commit that says so. See `reversible`.
        reversible: true,
        describe: "turn dense rows on or off",
        screen: "settings",
        args: { value: { type: "boolean", describe: "on or off" } },
        run: ({ value }: { value: boolean }) => {
          dense = value;
        },
      },
      {
        name: "clear-selection",
        kind: "describe",
        describe: "deselect everything, from any screen",
        run: () => ({ count: 0 }),
      },
    ],
  });

  return { driver, at: () => screen };
}

test("a screen-scoped verb is refused off its screen, and the hint names both screens", async () => {
  // The whole point of declaring the mapping rather than guarding by hand. A
  // bare `wrong-screen` is a dead end: an agent that is told no and not told
  // where to go guesses, and the guess is another refused call. So the refusal
  // carries the screen the caller is ON and the screen the verb WANTS, which is
  // everything needed to fix it in one turn.
  const { driver } = screens();
  await driver.call("go", { screen: "settings" });

  const out = await driver.call("next-page");
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "wrong-screen");
  assert.match(out.hint!, /you are on the `settings` screen/);
  assert.match(out.hint!, /`next-page` works on the `contacts` screen/);
  // And the refused call did nothing: the screen under it has not moved.
  assert.equal(out.snapshot.screen, "settings");
});

test("the same verb works on its own screen", async () => {
  // The other half of the check, which is the half a wrong guard breaks.
  const { driver } = screens();
  const out = await driver.call("next-page");
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.snapshot.screen, "contacts");
  assert.match(out.snapshot.where, /page 2/);
});

/**
 * Three screens, and a verb that works on two of them.
 *
 * The shape `Verb.screen` grew a list for, and it was found honestly: the
 * library's own demo pages both a contacts list and a company's contact list,
 * and one string meant declaring either screen would refuse a call on a screen
 * that is still publishing a `page` block. The demo wrote a refusal slug of its
 * own instead, which is the pattern `wrong-screen` was reserved to end.
 */
function threeScreens() {
  let screen = "contacts";
  let paged = 0;

  const driver = mount({
    app: "three-screen",
    visible: (): Snapshot => ({ where: screen, screen, rev: paged + 1 }),
    verbs: [
      {
        name: "go",
        kind: "read",
        describe: "go to a screen",
        args: { to: { type: "string", describe: "which screen" } },
        run: ({ to }: { to: string }) => {
          screen = to;
        },
      },
      {
        name: "next-page",
        kind: "read",
        describe: "page whichever list you are on",
        screen: ["contacts", "company"],
        run: () => {
          paged++;
        },
      },
    ],
  });

  return { driver, paged: () => paged };
}

test("a verb on two screens works on both of them", async () => {
  // The half a single string could not express. Declaring one of the two would
  // have refused a call on a screen that is still publishing a `page` block --
  // a lie in the cached half, which is worse than no claim at all.
  const { driver, paged } = threeScreens();
  for (const to of ["contacts", "company"]) {
    await driver.call("go", { to });
    const out = await driver.call("next-page");
    assert.equal(out.ok, true, `next-page was refused on ${to}`);
  }
  assert.equal(paged(), 2);
});

test("a verb on two screens is refused on a third with ALL of its screens named", async () => {
  // Naming one of two is a subtler dead end than naming none: an agent told
  // `next-page` lives on the contacts list navigates there from the company
  // list it was already standing on, to do something it could have done where
  // it was. So every screen the verb works on is in the hint, and the sentence
  // reads for a list -- "Go to one of those" rather than "Go there".
  const { driver, paged } = threeScreens();
  await driver.call("go", { to: "dashboard" });

  const out = await driver.call("next-page");
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "wrong-screen");
  assert.match(out.hint!, /you are on the `dashboard` screen/);
  assert.match(out.hint!, /`next-page` works on the `contacts` and `company` screens/);
  assert.match(out.hint!, /Go to one of those first, then call it again/);
  assert.equal(paged(), 0, "the refused call paged anyway");
});

test("a one-element array behaves as the string it is, phrasing and all", async () => {
  // The list must not acquire a comma, an "and", or a plural for a verb that
  // names one screen -- a model and a person both read this hint, and the
  // single-screen wording is the one every existing app's agent has seen.
  const driver = mount({
    app: "one",
    visible: (): Snapshot => ({ where: "settings", screen: "settings", rev: 1 }),
    verbs: [
      { name: "page", kind: "read", describe: "page", screen: ["contacts"], run: () => {} },
    ],
  });

  const out = await driver.call("page");
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.hint, "you are on the `settings` screen; `page` works on the `contacts` screen. Go there first, then call it again.");
});

test("`screen: []` is refused at mount, the way a duplicate name is", () => {
  // It says the verb works on no screen at all, which no author means: it is
  // what an empty `.filter()` over a list of screens produces, or what a config
  // file hands over when a key is missing. Guessing either way is wrong --
  // "anywhere" silently makes a scoped verb global, "nowhere" leaves a verb in
  // everybody's cached prefix that can only ever be refused -- so it is said at
  // startup, where it costs one stack trace and a running app nothing.
  assert.throws(
    () =>
      mount({
        app: "nowhere",
        visible: (): Snapshot => ({ where: "x", screen: "x", rev: 1 }),
        verbs: [{ name: "page", kind: "read", describe: "page", screen: [], run: () => {} }],
      }),
    /works on \s*no screen at all[\s\S]*Omit `screen`/,
  );
});

test("a second screen on a verb moves the manifest version, and the manifest says both", () => {
  // The same argument `screen` is in the fingerprint for at all: a verb that
  // now ALSO works on a company's contact list is a verb whose cached
  // description was wrong about where it can be called, and an agent holding
  // the old copy would go on refusing to try it there.
  const base = {
    app: "v",
    visible: (): Snapshot => ({ where: "x", screen: "contacts", rev: 1 }),
  };
  const verb = { name: "page", kind: "read" as const, describe: "page", run: () => {} };

  const one = mount({ ...base, verbs: [{ ...verb, screen: "contacts" }] }).manifest();
  const two = mount({ ...base, verbs: [{ ...verb, screen: ["contacts", "company"] }] }).manifest();
  const listed = mount({ ...base, verbs: [{ ...verb, screen: ["contacts"] }] }).manifest();

  assert.notEqual(one.version, two.version);
  // The DECLARED shape is what is hashed, so `"contacts"` and `["contacts"]`
  // are different versions. They are different bytes in the manifest and a
  // client caching it would hold a different document, so a fingerprint that
  // hid the difference would be claiming two copies read the same when they do
  // not.
  assert.notEqual(one.version, listed.version);

  // And the manifest carries the shape through untouched, because every client
  // reading `verbs[].screen` today reads it as a string.
  assert.equal(one.verbs[0]!.screen, "contacts");
  assert.deepEqual(two.verbs[0]!.screen, ["contacts", "company"]);
});

test("a verb with no screen applies anywhere, which is the default and must stay it", async () => {
  // Absent means absent. An app that never heard of `screen` keeps every verb
  // it had, on every screen it had them on, and a verb that genuinely works
  // from anywhere -- `clear-selection`, `select-contact` -- does not have to
  // enumerate the screens it is allowed on.
  const { driver } = screens();
  for (const to of ["contacts", "settings"]) {
    await driver.call("go", { screen: to });
    const out = await driver.call("clear-selection");
    assert.equal(out.ok, true, `clear-selection was refused on ${to}`);
  }
});

test("a verb that names a screen in an app whose snapshot has none is not refused", async () => {
  // The honest reading of a half-adopted field. The core has nothing to compare
  // against, and treating absent as "not that screen" would refuse every
  // screen-scoped verb in an app that has declared the mapping and not yet
  // filled in `Snapshot.screen` -- turning an additive field into a breaking
  // one. It warns instead; see `warn`.
  const driver = mount({
    app: "half",
    visible: () => ({ where: "somewhere", rev: 1 }),
    verbs: [{ name: "page", describe: "page", screen: "list", run: () => {} }],
  });

  const out = await driver.call("page");
  assert.equal(out.ok, true);
});

test("CallOptions.screen is checked before a stale rev, because they are different mistakes", async () => {
  // The live bug, pinned. A paging call sent with no `rev` landed on a screen
  // the agent had never seen, paged a different list and answered `ok`. With
  // both claims wrong, the useful answer is the wider one: "you are somewhere
  // else" sends an agent to navigate, "the number moved" sends it to re-read a
  // screen it is not even on.
  const { driver } = screens();
  const read = driver.snapshot();
  assert.equal(read.screen, "contacts");

  // The person clicks away while the agent is thinking, and the rev moves too.
  await driver.call("go", { screen: "settings" });
  await driver.call("set-setting", { value: true });
  assert.notEqual(driver.snapshot().rev, read.rev);

  const out = await driver.call("clear-selection", {}, { screen: read.screen, rev: read.rev });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "wrong-screen", "a stale rev answered a question about the screen");
  assert.match(out.hint!, /you believed you were on the `contacts` screen/);
  assert.match(out.hint!, /the app is on `settings`/);
});

test("CallOptions.screen that matches lets the rev check do its own job", async () => {
  // Checked first does not mean instead. With the screen right and the rev
  // stale, the answer is `stale` -- the two checks are about two different
  // claims and each one still has to be able to fail on its own.
  const { driver } = screens();
  const read = driver.snapshot();
  await driver.call("next-page");

  const out = await driver.call("clear-selection", {}, { screen: "contacts", rev: read.rev });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.refused, "stale");
});

test("omitting screen opts out of the check, exactly as omitting rev does", async () => {
  const { driver } = screens();
  await driver.call("go", { screen: "settings" });
  // No claim made, so no claim checked: the verb works from anywhere and the
  // call lands.
  const out = await driver.call("clear-selection", {}, { rev: driver.snapshot().rev });
  assert.equal(out.ok, true);
});

test("a screen claim against an app that declares no screen makes no claim", async () => {
  // Same restraint as the verb case, from the other direction: an agent may be
  // quoting a `screen` it read from another app, and the app in front of it
  // does not describe its screens. There is nothing to compare, so the call
  // runs rather than being refused over a field this app never filled in.
  const driver = mount({
    app: "screenless",
    visible: () => ({ where: "somewhere", rev: 1 }),
    verbs: [{ name: "poke", describe: "poke", run: () => {} }],
  });
  const out = await driver.call("poke", {}, { screen: "whatever" });
  assert.equal(out.ok, true);
});

test("wrong-screen is reserved, and an app that was refusing it by hand is told what to do", () => {
  // The slug was an app's invention before it was the core's: an app with six
  // screens wrote the check by hand and had to name it, the next one would have
  // picked `not-on-this-screen`, and an agent that learned one would not
  // recognise the other. It says where a call stopped, so it is reserved -- and
  // this is the one reserved slug an app may already be declaring, so the error
  // names the replacement rather than only the rule.
  assert.throws(
    () =>
      mount({
        app: "toy",
        visible: () => ({ where: "x", rev: 1 }),
        verbs: [{ name: "page", describe: "page", refuses: ["wrong-screen"], run: () => {} }],
      }),
    /declares the reserved refusal `wrong-screen`[\s\S]*put `screen:/,
  );
});

test("screen, reversible and instructions are in the fingerprint, where they belong", () => {
  // The same argument `kind` is in it for. Moving a verb to another screen
  // changes where a cached manifest says it works; dropping `reversible`
  // changes whether an agent was told there is a way back; `instructions` is
  // rendered straight into the system prompt, so an old copy briefs a model in
  // the app's old words. None of the three changes a name or an argument, so
  // without this the version would not move and nobody would re-fetch.
  const base = {
    app: "v",
    visible: (): Snapshot => ({ where: "x", screen: "a", rev: 1 }),
  };
  const verb = { name: "act", kind: "commit" as const, describe: "act", run: () => {} };

  const plain = mount({ ...base, verbs: [verb] }).manifest().version;
  const scoped = mount({ ...base, verbs: [{ ...verb, screen: "a" }] }).manifest().version;
  const elsewhere = mount({ ...base, verbs: [{ ...verb, screen: "b" }] }).manifest().version;
  const undoable = mount({ ...base, verbs: [{ ...verb, reversible: true as const }] }).manifest().version;
  const briefed = mount({ ...base, verbs: [verb], instructions: "two screens" }).manifest().version;

  assert.equal(new Set([plain, scoped, elsewhere, undoable, briefed]).size, 5);
});

test("the manifest version of an app that uses none of the new fields has not moved", () => {
  // The backward-compatibility claim, as a number rather than a promise. Every
  // stored `Manifest.version` out there was computed before `screen`,
  // `reversible` and `instructions` existed, and an upgrade of this library that
  // moved them all would tell every agent its cached manifest had gone stale
  // when nothing about the app had changed. So the three are appended to the
  // hashed shape, and only when the app actually used them.
  const driver = mount({
    app: "toy",
    visible: () => ({ where: "x", rev: 1 }),
    verbs: [
      {
        name: "goto",
        describe: "open a descent",
        args: { id: { type: "string", describe: "descent id" } },
        refuses: ["no-such-descent"],
        run: () => {},
      },
      { name: "scroll", kind: "read", describe: "show the next page of rows", at: ".table", run: () => {} },
      { name: "accept", kind: "commit", describe: "accept the selection", run: () => {} },
    ],
  });
  assert.equal(driver.manifest().version, "7d165f135f77");
});

test("the app's own briefing is in the manifest, and the data still is not", async () => {
  // `instructions` is static by definition -- it is the sentence an app says
  // about itself, identical for every user forever -- so it belongs in the half
  // that is cached once. Before it, an app that needed both the widget and an
  // MCP client to hear it had to repeat it in `Snapshot.note`, in the uncached
  // half, paid for on every single turn.
  const { driver } = screens();
  const m = driver.manifest();
  assert.match(m.instructions!, /two screens/);

  // And the rule that field had to survive: nothing per-user, per-screen or
  // per-minute got in with it.
  const json = JSON.stringify(m);
  assert.ok(!json.includes("c-1"), "a row id leaked into the manifest");
  assert.ok(!json.includes("page 1"), "the live screen leaked into the manifest");
  assert.equal("screen" in m, false, "which screen is live is not a static fact");

  // The verb→screen mapping IS static and is in there, which is the whole
  // point: an agent reads it in the cached half instead of discovering it by
  // being refused once.
  const byName = Object.fromEntries(m.verbs.map((v) => [v.name, v]));
  assert.equal(byName["next-page"]!.screen, "contacts");
  assert.equal(byName["set-setting"]!.screen, "settings");
  assert.equal(byName["set-setting"]!.reversible, true);
  assert.equal("screen" in byName["clear-selection"]!, false, "anywhere was spelled as a screen");
  assert.equal("reversible" in byName["next-page"]!, false, "a read claimed to be reversible");
});

test("the manifest of a screen app is byte-identical across two mounts of it", async () => {
  // The rule all of this had to be additive to. Drive one copy somewhere else
  // entirely and its manifest must still match a fresh one, because that is
  // what makes the prefix cacheable ACROSS USERS -- and `screen` is exactly the
  // field that would have broken it if it had gone in the manifest as "where
  // the person is now" rather than as "where this verb lives".
  const a = screens();
  await a.driver.call("next-page");
  await a.driver.call("go", { screen: "settings" });
  await a.driver.call("set-setting", { value: true });

  assert.equal(
    JSON.stringify(a.driver.manifest()),
    JSON.stringify(screens().driver.manifest()),
  );
  assert.notEqual(a.driver.snapshot().screen, screens().driver.snapshot().screen);
});

test("the snapshot says which screen is live, beside the prose that says what else is on it", async () => {
  // The split, in one assertion. `where` carries the filter and the page and
  // moves for reasons that are not navigation; `screen` is the word that
  // changes if and only if the person went somewhere.
  const { driver } = screens();
  const first = driver.snapshot();
  await driver.call("next-page");
  const paged = driver.snapshot();
  assert.notEqual(paged.where, first.where, "paging did not change the prose");
  assert.equal(paged.screen, first.screen, "paging was reported as a navigation");

  await driver.call("go", { screen: "settings" });
  assert.notEqual(driver.snapshot().screen, first.screen);
});
