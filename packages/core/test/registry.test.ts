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
