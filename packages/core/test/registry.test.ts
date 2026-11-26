/**
 * These tests are the specification. Each one pins a decision that was argued
 * for, so a future change that looks harmless has to break a named test and
 * read why the rule exists before deleting it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import uriTemplates from "uri-templates";
import {
  checkArg,
  mount,
  refusal,
  RESERVED_REFUSALS,
  selectionId,
  SIZE_LIMITS,
} from "../src/index.ts";
import type { Scalar, Snapshot } from "../src/index.ts";

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

// =========================================================================
// The approval gate.
//
// The decision these pin, before any of them: the gate belongs in `call()`
// and not in a consumer. It used to live in `@driverkit/agent`'s
// `onBeforeCommit`, which `mountWidget` defaults on — so a person watching
// the in-page panel was asked, and an agent arriving over the relay or MCP
// called `accept-selected` and it simply ran. The reserved slug
// `declined-by-user` existed and nothing on the outside path could ever emit
// it. A safety property that holds on one of two paths is a property of one
// consumer, so every one of these tests goes through `driver.call()`, which is
// the one thing the in-page loop, a relay frame and a test with no transport
// all have in common.
// =========================================================================

/** A one-commit app, so the gate is the only thing under test. `kind` and the
 *  absence of `reversible` are what put `accept` behind the gate. */
function gated(options: Partial<Parameters<typeof mount>[0]> = {}) {
  let rev = 1;
  let accepted = 0;
  let pageSize = 20;
  const driver = mount({
    app: "toy",
    visible: (): Snapshot => ({ where: "contacts", rev, selectedCount: 1000 }),
    verbs: [
      { name: "look", kind: "read", describe: "look at the rows", run: () => {} },
      {
        name: "accept",
        kind: "commit",
        describe: "accept the selection",
        run: () => {
          accepted += 1000;
          rev++;
        },
      },
      {
        name: "set-page-size",
        kind: "commit",
        reversible: true,
        describe: "change how many rows a page shows",
        args: { size: { type: "number", describe: "rows per page" } },
        run: ({ size }: { size: number }) => {
          pageSize = size;
          rev++;
        },
      },
    ],
    ...options,
  });
  return { driver, accepted: () => accepted, pageSize: () => pageSize };
}

test("a commit is refused declined-by-user when the approval hook says no", async () => {
  // The gap, closed. This call did not come through the widget or through
  // `drive`: it is a bare `driver.call()`, which is exactly what a relay frame
  // becomes. Before the gate moved here, this ran.
  const app = gated({ approve: () => false });
  const out = await app.driver.call("accept");

  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.refused, "declined-by-user");
  assert.equal(app.accepted(), 0);
  // A snapshot, because the app is still there and the agent is about to have
  // to say something to a person about it. Only a transport refusal has none.
  assert.ok(out.snapshot);
});

test("a reason from the hook becomes the hint, so the model learns more than no", async () => {
  // The whole reason the decision is not a boolean. "Declined" sends a model
  // looking for another way to do the same thing; "not until finance signs
  // off" is something it can say to a person.
  const app = gated({ approve: () => "not until finance signs off" });
  const out = await app.driver.call("accept");

  assert.equal(out.ok === false && out.refused, "declined-by-user");
  assert.match(out.ok === false ? out.hint! : "", /finance/);
});

test("an allowed commit runs, and the hook was shown the screen it is about", async () => {
  // Allow is the uninteresting half and it still has to be pinned: a gate that
  // refuses everything is not a gate, it is an outage. The request carries the
  // snapshot BEFORE the verb ran, which is the screen the question has to be
  // worded from — 1,000 rows selected, not 0 left after.
  const seen: Array<{ name: string; count?: number; reversible?: true }> = [];
  const app = gated({
    approve: (req) => {
      seen.push({
        name: req.name,
        ...(req.snapshot.selectedCount === undefined
          ? {}
          : { count: req.snapshot.selectedCount }),
        ...(req.verb.reversible ? { reversible: req.verb.reversible } : {}),
      });
      return true;
    },
  });

  const out = await app.driver.call("accept");
  assert.equal(out.ok, true);
  assert.equal(app.accepted(), 1000);
  assert.deepEqual(seen, [{ name: "accept", count: 1000 }]);
});

test("nothing returned is a yes, so a hook may fall through its own cases", async () => {
  // `void` allows, deliberately. A policy written as a series of `if` blocks
  // that denies the cases it cares about must not deny everything else by
  // forgetting a `return true` at the bottom — that is a gate that looks
  // installed and is an outage.
  const app = gated({ approve: () => {} });
  assert.equal((await app.driver.call("accept")).ok, true);
  assert.equal(app.accepted(), 1000);
});

test("a read and a describe are never put to a person", async () => {
  // `read` and `describe` promise no data moves, which is the promise this
  // gate exists to check. Asking about them is how people learn to click Yes
  // without reading, and the next thing they click through is the bulk accept.
  const asked: string[] = [];
  const app = gated({
    approve: (req) => {
      asked.push(req.name);
      return true;
    },
  });
  await app.driver.call("look");
  assert.deepEqual(asked, []);
});

test("a reversible commit is still put to the hook, which is the hook's call to make", async () => {
  // Deliberately NOT filtered here. The core does not know how large the
  // selection is or how good the app's undo really is at that size; the
  // widget's dialog does, and it answers that question inside its own
  // implementation of this hook. A core that skipped reversible commits would
  // take the decision away from the one layer that can make it.
  const asked: string[] = [];
  const app = gated({
    approve: (req) => {
      asked.push(req.name);
      return true;
    },
  });
  await app.driver.call("set-page-size", { size: 50 });
  assert.deepEqual(asked, ["set-page-size"]);
  assert.equal(app.pageSize(), 50);
});

test("a call that arrives while an approval is open is refused approval-pending", async () => {
  // THE WEBMCP #288 DEFENCE, and the strongest of the three layers because it
  // needs nobody to remember anything. In that issue a proposal-only tool
  // correctly declined to execute itself, so the agent clicked the page's own
  // Approve button and the receipt said "approved by you". `press` and
  // `commit-control` over `data-dk-control` are exactly that bypass. Here the
  // call does not reach a verb at all: while somebody is being asked, this
  // driver is not taking calls.
  let release: (() => void) | undefined;
  const app = gated({
    approve: () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
  });

  const commit = app.driver.call("accept");
  // The agent tries the safe-looking verb that would press the dialog's own
  // button. It is refused before the verb is even looked up.
  const sneak = await app.driver.call("look");
  assert.equal(sneak.ok === false && sneak.refused, "approval-pending");
  assert.match(sneak.ok === false ? sneak.hint! : "", /approve or confirm control/);

  release!();
  assert.equal((await commit).ok, true);
  // And the lock is released, so the app is not wedged behind one question.
  assert.equal((await app.driver.call("look")).ok, true);
});

test("a second call for the verb being approved is refused rather than racing the dialog", async () => {
  // The other half of the same rule, and the one an agent is likelier to try
  // on its own: call it again while the question is open and hope the second
  // one goes through. Two pending approvals for one commit is a dialog whose
  // answer applies to something nobody can name, and a commit that runs twice.
  let asked = 0;
  let release: (() => void) | undefined;
  const app = gated({
    approve: () => {
      asked++;
      return new Promise<boolean>((resolve) => (release = () => resolve(true)));
    },
  });

  const first = app.driver.call("accept");
  const second = await app.driver.call("accept");
  assert.equal(second.ok === false && second.refused, "approval-pending");
  assert.equal(asked, 1, "the dialog was asked twice about one commit");

  release!();
  await first;
  assert.equal(app.accepted(), 1000, "the commit ran more than once");
});

test("an approval nobody answers is approval-timeout, which says the verb did not run", async () => {
  // Distinguishable from the relay's `timeout` by name, and that is the point
  // of spending a slug on it. The relay's means the call was accepted and no
  // answer came back, so a commit MAY ALREADY HAVE RUN and the only safe next
  // move is to read the screen. This one means the question was never
  // answered, so the verb was never reached — ask a person and call again.
  const app = gated({ approve: () => new Promise<boolean>(() => {}), approvalTimeout: 5 });
  const out = await app.driver.call("accept");

  assert.equal(out.ok === false && out.refused, "approval-timeout");
  assert.notEqual(out.ok === false && out.refused, "timeout");
  assert.match(out.ok === false ? out.hint! : "", /did not\s+run/);
  assert.equal(app.accepted(), 0);
  // Not wedged: the deadline released the lock as well as answering.
  assert.equal((await app.driver.call("look")).ok, true);
});

test("a hook may report its own timeout, for a gate that knows better than a deadline", async () => {
  // A webhook that got a 504, or a dialog an app closed itself. The app knows
  // it was not answered and can say so without the core holding a timer.
  const app = gated({ approve: () => ({ timedOut: true, hint: "the approver's phone is off" }) });
  const out = await app.driver.call("accept");
  assert.equal(out.ok === false && out.refused, "approval-timeout");
  assert.match(out.ok === false ? out.hint! : "", /phone is off/);
});

test("a hook that throws is a no, and the driver keeps taking calls", async () => {
  // A failed ask is not consent. The alternative — treat an exception in the
  // confirmation UI as "carry on" — makes a broken dialog the way round the
  // gate, which is the one bug a gate must not have. The lock is released in a
  // `finally`, so one broken ask does not leave an app that refuses forever.
  const app = gated({
    approve: () => {
      throw new Error("the modal could not be shown");
    },
  });
  const out = await app.driver.call("accept");
  assert.equal(out.ok === false && out.refused, "declined-by-user");
  assert.match(out.ok === false ? out.hint! : "", /could not be shown/);
  assert.equal(app.accepted(), 0);
  assert.equal((await app.driver.call("look")).ok, true);
});

test("an answer the core does not recognise is a refusal and never consent", async () => {
  // Reading an unknown shape as yes is how a refactor of a hook's return type
  // silently removes the gate. The cost of being wrong this way round is one
  // refused commit; the other way round it is 3,412 accepted rows.
  const app = gated({ approve: () => ({ approved: "yes" }) as never });
  const out = await app.driver.call("accept");
  assert.equal(out.ok === false && out.refused, "declined-by-user");
  assert.equal(app.accepted(), 0);
});

test("with no approve, a commit runs exactly as it did before the gate existed", async () => {
  // The compatibility claim as a test rather than a promise. An app mounted
  // yesterday has no `approve`, is driven by its own in-page UI, and must
  // behave identically: no question, no refusal, and nothing in the result
  // that was not there before. The declaration is required at the moment the
  // driver is PUBLISHED — see `connect()` — and not here, because `mount()`
  // cannot know whether anybody is watching.
  const app = gated();
  const out = await app.driver.call("accept");
  assert.equal(out.ok, true);
  assert.equal(app.accepted(), 1000);
  assert.equal(app.driver.approval?.policy, "none");
});

test("`unattended` is a declaration and not a gate", async () => {
  // It does not ask and it does not refuse: it is the app saying out loud that
  // commits here run with nobody in front of them. The word earns its place by
  // being what `connect()` reads — the unsafe configuration stays reachable
  // and stops being reachable by accident, which is the whole trade.
  const app = gated({ approve: "unattended" });
  assert.equal(app.driver.approval?.policy, "unattended");
  assert.equal((await app.driver.call("accept")).ok, true);
  assert.equal(app.accepted(), 1000);
});

test("a misspelt policy throws at mount rather than degrading to no policy", async () => {
  // `approve: "unnattended"` must not read as "nothing declared". That is the
  // one failure mode where an author believes they have a gate and have not
  // got one, which is worse than knowingly having none. At mount, where it
  // costs one stack trace at startup.
  assert.throws(() => gated({ approve: "unnattended" as never }), /must be a function/);
});

test("the gate's own lock is offered to an approval UI that is not the hook", async () => {
  // `hold` is how the widget's in-page dialog gets the same protection as the
  // core's hook: it is an approval UI on a driver that may well have declared
  // nothing, and the agent it is asking is not the only agent that can reach
  // this driver. Offered whatever the policy is, including `none`.
  const app = gated();
  let inside: Awaited<ReturnType<typeof app.driver.call>> | undefined;
  await app.driver.approval!.hold("accept", async () => {
    inside = await app.driver.call("look");
  });

  assert.equal(inside?.ok, false);
  assert.equal(inside?.ok === false && inside.refused, "approval-pending");
  // Released afterwards, so a dialog that has been answered does not leave the
  // app refusing.
  assert.equal((await app.driver.call("look")).ok, true);
});

test("the approval slugs are reserved, so an app cannot say them itself", async () => {
  // Same argument as `timeout`: an agent has to be able to tell "the app said
  // no, phrase it differently" from "a person said no, stop and ask them".
  assert.throws(
    () =>
      mount({
        app: "toy",
        visible: () => ({ where: "x", rev: 1 }),
        verbs: [{ name: "approval-pending", describe: "nope", run: () => {} }],
      }),
    /reserved refusal slug/,
  );
  assert.throws(
    () =>
      mount({
        app: "toy",
        visible: () => ({ where: "x", rev: 1 }),
        verbs: [
          { name: "accept", describe: "accept", refuses: ["approval-timeout"], run: () => {} },
        ],
      }),
    /reserved refusal/,
  );
});

test("declaring an approval policy does not move the manifest version", async () => {
  // `approve` is a property of the app's wiring and not of its verb surface.
  // Nothing an agent can observe about the tools changes, so every cached
  // manifest out there stays current — an upgrade that moved the version would
  // tell every agent its copy had gone stale when nothing it reads had
  // changed. This is the same argument the pinned fingerprint above makes.
  assert.equal(
    gated({ approve: () => true }).driver.manifest().version,
    gated().driver.manifest().version,
  );
});

// =========================================================================
// `screens`, `goto` and `flows`: the app's map, and multi-step work
// =========================================================================

/**
 * A two-screen app with a map, a navigate hook and a flow.
 *
 * `moved` records what the hook was handed, which is the only way to assert
 * that the core expanded the template rather than the app: the hook is the
 * whole of what an app supplies, so what arrives in it IS the contract.
 */
function mapped(over: Partial<Parameters<typeof mount>[0]> = {}) {
  const moved: Array<{ screen: string; args: Record<string, Scalar>; url?: string }> = [];
  let screen = "descents";
  const driver = mount({
    app: "toy",
    visible: (): Snapshot => ({ where: screen, screen, rev: 1 }),
    screens: [
      { id: "descents", describe: "every descent", url: "#/descents" },
      {
        id: "descent",
        describe: "one descent and its lanes",
        url: "#/descents/{id}",
        args: { id: { type: "string", describe: "descent id" } },
      },
      // No `url`, and that is not a defect: a modal, a wizard step and a
      // router-less app are all screens with no address.
      { id: "pruning-modal", describe: "the pruning dialog, over whatever you are on" },
    ],
    navigate: (target) => {
      moved.push(target);
      screen = target.screen;
    },
    flows: [
      {
        id: "prune-a-descent",
        describe: "open a descent and prune it",
        steps: [
          { section: "find it", verb: "goto", hint: "goto(screen: descents)" },
          { verb: "goto", hint: "goto(screen: descent, id: …) once you know which" },
          { verb: "accept", hint: "accept it; this is the commit" },
        ],
      },
    ],
    verbs: [{ name: "accept", kind: "commit", describe: "accept it", run: () => {} }],
    ...over,
  });
  return { driver, moved };
}

test("the screens are in the manifest and are never in a snapshot", () => {
  // The static/dynamic split, one level up from `Verb.screen`. The NAMES of an
  // app's screens are the same for every user forever, so they are cacheable;
  // which one is live is as per-turn as a row is. An agent could previously
  // learn where it was and where it was not, and could not learn that a screen
  // existed without standing on it -- which is why the worked example was
  // pasting a prose screen-map into `instructions`.
  const { driver } = mapped();
  const m = driver.manifest();
  assert.deepEqual(m.screens!.map((s) => s.id), ["descents", "descent", "pruning-modal"]);
  assert.equal(m.screens![1]!.url, "#/descents/{id}");
  assert.deepEqual(Object.keys(m.screens![1]!.args!), ["id"]);
  // And the dynamic half carries exactly one screen: the live one.
  const snap = driver.snapshot() as Snapshot & { screens?: unknown; flows?: unknown };
  assert.equal(snap.screen, "descents");
  assert.equal(snap.screens, undefined, "the map leaked into the uncached half");
  assert.equal(snap.flows, undefined, "the flows leaked into the uncached half");
});

test("the core's `goto` reaches a screen by id, and is a read", async () => {
  const { driver, moved } = mapped();
  const goto = driver.manifest().verbs.find((v) => v.name === "goto")!;
  // A `read` by the ladder's own definition: no data moves and no count is
  // left pending. It does move the person's screen, which is what `read` was
  // reworded to say out loud rather than growing a fourth kind for.
  assert.equal(goto.kind, "read");
  assert.deepEqual(goto.args!.screen!.oneOf, ["descents", "descent", "pruning-modal"]);
  // Every screen's own arguments become the verb's, all optional: whether one
  // is required depends on which screen was asked for, and a schema that said
  // otherwise would make a client reject `goto("descents")`.
  assert.equal(goto.args!.id!.optional, true);

  const out = await driver.call("goto", { screen: "descent", id: "01a2" });
  assert.equal(out.ok, true);
  assert.equal(out.snapshot.screen, "descent");
  assert.deepEqual(moved, [{ screen: "descent", args: { id: "01a2" }, url: "#/descents/01a2" }]);
});

test("a url template is expanded by the core, exactly as RFC 6570 says", async () => {
  // The template is handed to the app's hook already filled in, because
  // expanding it is the same in every app and getting it slightly wrong -- a
  // slug with a slash in it silently becoming another path segment -- is the
  // kind of bug that only shows up on somebody's real data. Checked against
  // `uri-templates` rather than against the code that wrote it: `ScreenSpec
  // .url` is documented as RFC 6570, so a real implementation is the oracle.
  const { driver, moved } = mapped();
  for (const id of ["01a2", "a b", "a/b", "ümlaut", "a%b", "a~b.c_d-e"]) {
    await driver.call("goto", { screen: "descent", id });
    assert.equal(
      moved[moved.length - 1]!.url,
      uriTemplates("#/descents/{id}").fill({ id }),
      `the core and uri-templates disagree about ${JSON.stringify(id)}`,
    );
  }
});

test("a screen with no url is reached by id all the same, and carries no url", async () => {
  // Absent is not a defect and must not be a special case: the ID is the
  // handle an agent uses, and the url is a convenience for whoever can use
  // one. A type that demanded a url would push the author of a modal into
  // inventing a fake one.
  const { driver, moved } = mapped();
  const out = await driver.call("goto", { screen: "pruning-modal" });
  assert.equal(out.ok, true);
  assert.deepEqual(moved, [{ screen: "pruning-modal", args: {} }]);
  assert.equal("url" in moved[0]!, false, "a screen with no template invented one");
});

test("`goto` is refused for a screen the app does not have, with every screen named", async () => {
  // The core's own argument check does this, because the screen ids are a
  // static `oneOf`: the refusal lists the accepted set rather than counting
  // it, so the model can fix the call on its next turn without another read.
  const { driver, moved } = mapped();
  const out = await driver.call("goto", { screen: "billing" });
  assert.equal(out.ok, false);
  assert.equal((out as { refused: string }).refused, "bad-argument");
  assert.match((out as { hint: string }).hint, /"descents", "descent", "pruning-modal"/);
  assert.deepEqual(moved, [], "a refused goto still navigated");
});

test("`goto` is refused when the screen's own argument is missing, naming the screen", async () => {
  // "missing argument `id`" on a verb that takes every screen's arguments does
  // not say which screen wanted it, and the agent's next guess is another
  // refused call. A separate slug from `bad-argument` because the core
  // originates it from inside a verb body, where a reserved slug would be
  // reported as `threw`.
  const { driver, moved } = mapped();
  const out = await driver.call("goto", { screen: "descent" });
  assert.equal((out as { refused: string }).refused, "bad-screen-argument");
  assert.match((out as { hint: string }).hint, /the `descent` screen needs its own arguments/);
  assert.match((out as { hint: string }).hint, /missing argument `id`/);
  // A WRONG TYPE is caught one check earlier, by the core's ordinary argument
  // check, because the hoisted argument carries the screen's own `ArgSpec`.
  // The two slugs divide cleanly: `bad-argument` is "that value is not what
  // this argument takes", which is true wherever you were going, and
  // `bad-screen-argument` is "this screen needed one and you did not send it",
  // which only the screen can say. Nothing is lost by the generic check going
  // first -- it names the argument and the type -- and an agent that meets
  // `bad-argument` on `goto` has the same fix as on any other verb.
  const typed = await driver.call("goto", { screen: "descent", id: 7 });
  assert.equal((typed as { refused: string }).refused, "bad-argument");
  assert.match((typed as { hint: string }).hint, /argument `id` wants a string, got number/);
  assert.deepEqual(moved, []);
});

test("the navigate hook may refuse, which is how a screen nobody may open says so", async () => {
  // The other half of `ScreenSpec`'s rule against filtering the declared list.
  // "You may not open that" is a fact about this person at this moment, so it
  // is said at the moment of the call with a reason an agent can relay -- and
  // never as a screen quietly missing from everybody's map, which is
  // unfalsifiable and makes an agent conclude the feature does not exist.
  const { driver } = mapped({
    navigate: (target, ctx) =>
      target.screen === "descent" ? ctx.refuse("not-your-descent", "ask the owner") : undefined,
  });
  const out = await driver.call("goto", { screen: "descent", id: "01a2" });
  assert.equal((out as { refused: string }).refused, "not-your-descent");
  assert.equal((out as { hint: string }).hint, "ask the owner");
});

test("declaring screens without a navigate hook publishes the map and no `goto`", async () => {
  // A map with no way to walk it is a legitimate thing to publish -- an agent
  // that knows the screens exist knows more than one that does not -- but it
  // is the less likely of the two readings, so it is said once. A `goto` the
  // core could not carry out would be a dead verb in everybody's cached
  // prefix.
  const capture = warnings(() => {
    const driver = mount({
      app: "toy",
      visible: (): Snapshot => ({ where: "x", screen: "a", rev: 1 }),
      screens: [{ id: "a", describe: "the only screen" }],
      verbs: [{ name: "accept", kind: "commit", describe: "accept", run: () => {} }],
    });
    assert.deepEqual(driver.manifest().screens!.map((s) => s.id), ["a"]);
    assert.equal(driver.manifest().verbs.some((v) => v.name === "goto"), false);
  });
  await capture.done;
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0]!, /`screens` was declared without `navigate`/);
});

test("an app that declares its own `goto` keeps it, and the hook is never called", async () => {
  // `goto` is reserved in the weak sense: the core offers the name, it does not
  // seize it. The same rule as the `rev` and `screen` arguments the agent
  // package hoists into every tool schema -- an app that claimed the name wins,
  // because the app's meaning wins over ours. This also keeps every app that
  // already had a verb called `goto` mounting exactly as it did.
  const capture = warnings(async () => {
    let called = 0;
    const { driver, moved } = mapped({
      verbs: [
        { name: "accept", kind: "commit", describe: "accept it", run: () => {} },
        {
          name: "goto",
          kind: "read",
          describe: "the app's own",
          args: { id: { type: "string", describe: "anything" } },
          run: () => void called++,
        },
      ],
      flows: [],
    });
    const out = await driver.call("goto", { id: "whatever" });
    assert.equal(out.ok, true);
    assert.equal(called, 1);
    assert.deepEqual(moved, [], "the core's hook ran for the app's own verb");
    assert.equal(driver.manifest().verbs.find((v) => v.name === "goto")!.describe, "the app's own");
  });
  await capture.done;
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0]!, /this app also declares its own verb\s+named `goto`/);
});

test("two screens with one id, or one argument declared twice differently, fail at mount", () => {
  // Thrown at mount, the way a duplicate verb name is: both make the app's own
  // map ambiguous to every agent that caches it, and mount runs at startup
  // rather than on a refusal path.
  const base = {
    app: "toy",
    visible: (): Snapshot => ({ where: "x", screen: "a", rev: 1 }),
    navigate: () => {},
    verbs: [],
  };
  assert.throws(
    () => mount({ ...base, screens: [{ id: "a", describe: "one" }, { id: "a", describe: "two" }] }),
    /two screens are both named `a`/,
  );
  assert.throws(
    () => mount({ ...base, screens: [{ id: "", describe: "nameless" }] }),
    /has no `id`/,
  );
  assert.throws(
    () =>
      mount({
        ...base,
        screens: [
          { id: "a", describe: "a", args: { id: { type: "string", describe: "an id" } } },
          { id: "b", describe: "b", args: { id: { type: "number", describe: "a number" } } },
        ],
      }),
    /two screens declare the argument `id` differently/,
  );
  // And a screen may not claim `goto`'s own argument name, because the two
  // would be one property of one schema.
  assert.throws(
    () =>
      mount({
        ...base,
        screens: [{ id: "a", describe: "a", args: { screen: { type: "string", describe: "x" } } }],
      }),
    /which is the name `goto` uses for the screen itself/,
  );
});

test("a flow is in the manifest, and a flow naming a verb that does not exist throws at mount", () => {
  // The validation that makes a recipe worth reading. A flow citing a verb
  // nobody implemented is a dead end whose only symptom is an agent halfway
  // through a job meeting `unknown-verb` -- after the navigation and before the
  // commit, which is the worst place to find out. So it fails at startup, the
  // way a duplicate verb name does.
  const { driver } = mapped();
  const flows = driver.manifest().flows!;
  assert.equal(flows.length, 1);
  assert.equal(flows[0]!.id, "prune-a-descent");
  assert.deepEqual(flows[0]!.steps.map((s) => s.verb), ["goto", "goto", "accept"]);
  // The reserved verb may be named like any other: the check runs after the
  // core has added it.
  assert.throws(
    () =>
      mapped({
        flows: [
          { id: "f", describe: "do it", steps: [{ verb: "accept-all", hint: "accept the lot" }] },
        ],
      }),
    /names the verb `accept-all`, which this app does not have[\s\S]*known: accept, goto/,
  );
  // And the shape is checked too, because an unreadable recipe is a recipe
  // nobody follows.
  assert.throws(() => mapped({ flows: [{ id: "f", describe: "do it", steps: [] }] }), /has no `steps`/);
  assert.throws(
    () => mapped({ flows: [{ id: "f", describe: "", steps: [{ verb: "accept", hint: "go" }] }] }),
    /has no `describe`/,
  );
  assert.throws(
    () => mapped({ flows: [{ id: "f", describe: "do it", steps: [{ verb: "accept", hint: "" }] }] }),
    /has no `hint`/,
  );
  assert.throws(
    () =>
      mapped({
        flows: [
          { id: "f", describe: "a", steps: [{ verb: "accept", hint: "x" }] },
          { id: "f", describe: "b", steps: [{ verb: "accept", hint: "y" }] },
        ],
      }),
    /two flows are both named `f`/,
  );
});

test("the documented size budgets are enforced, and `instructions` is only warned about", async () => {
  // Apple's app skills ship with exactly this pair -- a description of at most
  // 1024 characters on one line, and a body of at most 10,000 -- and the
  // numbers are worth copying because of what the absence of one did:
  // `instructions` had no documented bound, so the honest answer to "how much
  // may I write?" was "nobody has said". Everything here is in the cached
  // prefix of every session, which is why it is cheap and why it is tempting;
  // the cost that a number actually guards is that text in the prefix competes
  // with the verb list for the model's attention.
  assert.equal(SIZE_LIMITS.describe, 1024);
  assert.equal(SIZE_LIMITS.body, 10_000);
  assert.equal(SIZE_LIMITS.instructions, 10_000);

  const long = "x".repeat(SIZE_LIMITS.describe + 1);
  assert.throws(
    () => mapped({ flows: [{ id: "f", describe: long, steps: [{ verb: "accept", hint: "x" }] }] }),
    /one-line `describe` of at most 1024 characters/,
  );
  // One LINE, which is the half of the budget that is about reading rather
  // than about size: it is a label a model chooses on, not a paragraph it
  // reasons from.
  assert.throws(
    () =>
      mapped({
        flows: [{ id: "f", describe: "do\nit", steps: [{ verb: "accept", hint: "x" }] }],
      }),
    /with a line break/,
  );
  assert.throws(
    () =>
      mapped({
        flows: [
          {
            id: "f",
            describe: "do it",
            steps: [{ verb: "accept", hint: "x".repeat(SIZE_LIMITS.body + 1) }],
          },
        ],
      }),
    /characters of steps; the budget is 10000/,
  );
  assert.throws(
    () => mapped({ screens: [{ id: "a", describe: long }] }),
    /has a `describe` of 1025 characters; the budget is 1024/,
  );

  // `instructions` WARNS and does not throw, and that inconsistency is
  // deliberate: the field existed before it had a budget, so an app that
  // mounted yesterday with a very long briefing must still mount today. A new
  // throw on an old field is the kind of change the additive rule forbids.
  // `screens` and `flows` are new, nothing can already be over their budget,
  // and so they throw.
  const capture = warnings(() => {
    const driver = mount({
      app: "toy",
      visible: (): Snapshot => ({ where: "x", rev: 1 }),
      instructions: "i".repeat(SIZE_LIMITS.instructions + 1),
      verbs: [{ name: "accept", kind: "commit", describe: "accept", run: () => {} }],
    });
    assert.equal(driver.manifest().instructions!.length, SIZE_LIMITS.instructions + 1);
  });
  await capture.done;
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0]!, /`instructions` is 10001 characters; the documented budget/);
});

test("screens and flows are in the fingerprint, and an app with neither keeps its version", () => {
  // The reason `kind` and `screen` are in it. A screen that gained a url
  // template, or whose sentence was rewritten, is a screen a model was briefed
  // about in the app's old words; a flow is rendered straight into the cached
  // prompt and NAMES VERBS, so an app that renames one leaves every cached
  // copy holding a recipe that cites a verb which no longer exists.
  const base = {
    app: "v",
    visible: (): Snapshot => ({ where: "x", screen: "a", rev: 1 }),
    navigate: () => {},
    verbs: [{ name: "accept", kind: "commit" as const, describe: "accept", run: () => {} }],
  };
  const plain = mount(base).manifest().version;
  const mapOnly = mount({ ...base, screens: [{ id: "a", describe: "the screen" }] });
  const reworded = mount({ ...base, screens: [{ id: "a", describe: "the only screen" }] });
  const addressed = mount({ ...base, screens: [{ id: "a", describe: "the screen", url: "#/a" }] });
  const flowed = mount({
    ...base,
    flows: [{ id: "f", describe: "do it", steps: [{ verb: "accept", hint: "accept it" }] }],
  });
  const rehinted = mount({
    ...base,
    flows: [{ id: "f", describe: "do it", steps: [{ verb: "accept", hint: "accept them all" }] }],
  });
  const versions = [
    plain,
    mapOnly.manifest().version,
    reworded.manifest().version,
    addressed.manifest().version,
    flowed.manifest().version,
    rehinted.manifest().version,
  ];
  assert.equal(new Set(versions).size, 6, "two different cached surfaces hash the same");

  // And the backward-compatibility claim, as a number: the pinned literal
  // above is for an app that declares neither field, and it is unchanged.
  // These two are appended to the hashed shape, and only when the app used
  // them, so no stored `Manifest.version` out there moved for a feature its
  // app does not use.
  assert.equal(mount(base).manifest().version, plain);
});

// =========================================================================
// The plan token: what makes the describe/commit count a guarantee
// =========================================================================

/**
 * A toy app with a describe/commit pair behind a plan token.
 *
 * Separate from `app()` above rather than bolted onto it, and deliberately so:
 * `app()` is what the pinned fingerprint and a dozen other tests are written
 * against, and a verb added to it would move that literal — which is the one
 * thing the backward-compatibility claim says must not happen.
 *
 * `identity` is the switch for the honest weak case: an app that declares
 * `consumes` and publishes no `selectionId`. `quietly` is the other half of
 * what makes the identity worth having — a mutation that changes the selection
 * and does NOT move `rev`, which is what an app with a bug, a debounce or a
 * websocket actually does, and the only thing `rev` alone cannot catch.
 */
function planned(
  o: { consumes?: "plan"; identity?: boolean } = { consumes: "plan", identity: true },
) {
  const ids = ["r1", "r2", "r3", "r4", "r5"];
  let rev = 1;
  let selected = new Set<string>();
  let accepted = 0;

  const visible = (): Snapshot => ({
    where: "rows",
    screen: "rows",
    rev,
    rows: ids.map((id) => ({ id })),
    selected: [...selected],
    ...(selected.size ? { selectedCount: selected.size } : {}),
    ...(o.identity === false ? {} : { selectionId: selectionId(selected) }),
  });

  const driver = mount({
    app: "planner",
    visible,
    verbs: [
      {
        name: "select-first",
        kind: "describe",
        describe: "select the first n rows",
        args: { n: { type: "number", describe: "how many" } },
        run: ({ n }: { n: number }) => {
          selected = new Set(ids.slice(0, n));
          rev += 1;
          return { count: selected.size };
        },
      },
      {
        name: "look",
        kind: "read",
        describe: "look, and count nothing",
        run: () => {},
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the selection",
        ...(o.consumes ? { consumes: o.consumes } : {}),
        run: () => {
          accepted += selected.size;
          rev += 1;
          return { count: selected.size };
        },
      },
      {
        name: "decline-selected",
        kind: "commit",
        describe: "decline the selection, and ask for no receipt",
        // An argument, so that `mount()`'s all-or-none warning does not fire on
        // this toy. The warning's signal is a commit with NO arguments, because
        // that is a verb which can only be acting on ambient state; a commit
        // that names something is the shape it deliberately leaves alone, and
        // this toy needs an un-gated commit to prove the field is opt-in.
        args: { because: { type: "string", describe: "why", optional: true } },
        // Changes nothing and does not bump `rev`, which is not laziness: it is
        // what lets the test below show that a plan handed to a verb that does
        // not consume one is IGNORED rather than spent. A verb that moved `rev`
        // would invalidate the token on its way past and the test could not
        // tell the two apart.
        run: () => {},
      },
    ],
  });

  return {
    driver,
    /** Tick a row the way a person does: the selection moves and so does `rev`. */
    tick(id: string) {
      selected.add(id);
      rev += 1;
    },
    /** The case `rev` cannot see: the selection moves and `rev` does not. */
    tickQuietly(id: string) {
      selected.add(id);
    },
    accepted: () => accepted,
    rev: () => rev,
    size: () => selected.size,
  };
}

test("a commit that consumes a plan is refused with no token, and nothing runs", async () => {
  // The bare call is the one every agent written before this field makes, so
  // the refusal has to teach rather than merely decline: it names the pairing,
  // and it says nothing ran, because an agent that cannot tell "refused" from
  // "may have half-run" reads the screen and guesses.
  const a = planned();
  const picked = await a.driver.call("select-first", { n: 3 });
  assert.equal(picked.ok && picked.count, 3);

  const bare = await a.driver.call("accept-selected");
  assert.equal(bare.ok, false);
  assert.equal(bare.ok === false && bare.refused, "stale-plan");
  assert.match(bare.ok === false ? bare.hint! : "", /may only be called with the `plan` token/);
  assert.match(bare.ok === false ? bare.hint! : "", /nothing ran/);
  // The whole point, as a number: no data moved.
  assert.equal(a.accepted(), 0);
});

test("a fresh plan from the describe that counted the selection is accepted", async () => {
  const a = planned();
  const picked = await a.driver.call("select-first", { n: 3 });
  assert.equal(picked.ok && typeof picked.plan, "string");

  const done = await a.driver.call("accept-selected", {}, { plan: picked.ok ? picked.plan : "" });
  assert.equal(done.ok, true);
  assert.equal(a.accepted(), 3);
});

test("a plan is good for ONE commit; the second call on it is refused", async () => {
  // Pinned because it is a decision and not a consequence. Terraform's saved
  // plan is a record of one reviewed change and applying it twice is the
  // double-apply; here it is the double-accept, which is the most expensive
  // thing an agent can do with a bulk verb. The count was shown once and
  // approved once, so it buys one commit — and the refusal says so in those
  // words rather than saying "stale", because an agent told "stale" re-reads
  // and sends the same token again.
  const a = planned();
  const picked = await a.driver.call("select-first", { n: 2 });
  const token = picked.ok ? picked.plan! : "";

  assert.equal((await a.driver.call("accept-selected", {}, { plan: token })).ok, true);
  assert.equal(a.accepted(), 2);

  const again = await a.driver.call("accept-selected", {}, { plan: token });
  assert.equal(again.ok === false && again.refused, "stale-plan");
  assert.match(again.ok === false ? again.hint! : "", /already been used by a commit/);
  assert.match(again.ok === false ? again.hint! : "", /one commit/);
  assert.equal(a.accepted(), 2, "the second commit ran");
});

test("a plan is refused once the selection changed underneath it, naming BOTH counts", async () => {
  // THE BUG THIS WHOLE MECHANISM EXISTS FOR, and the case no amount of `rev`
  // discipline catches on its own: the selection moves without `rev` moving.
  // That is not a hypothetical — it is a debounced push, a websocket, or an app
  // that bumps its rev on data and not on selection. Django shipped the same
  // shape of bug for fifteen years.
  //
  // Both numbers are in the hint for the reason `wrong-screen` names both
  // screens: "the selection changed" is a dead end, and "you were shown 3; it
  // is now 4" is something a model can say to a person.
  const a = planned();
  const picked = await a.driver.call("select-first", { n: 3 });
  const token = picked.ok ? picked.plan! : "";

  a.tickQuietly("r5");
  assert.equal(a.rev(), picked.ok ? picked.snapshot.rev : -1, "rev moved; wrong test");

  const out = await a.driver.call("accept-selected", {}, { plan: token });
  assert.equal(out.ok === false && out.refused, "stale-plan");
  assert.match(out.ok === false ? out.hint! : "", /named a different selection/);
  assert.match(out.ok === false ? out.hint! : "", /You were shown 3; the selection is now 4\./);
  assert.equal(a.accepted(), 0, "a selection nobody counted was accepted");
});

test("a plan taken at an older rev is refused, naming both revs", async () => {
  const a = planned();
  const picked = await a.driver.call("select-first", { n: 3 });
  const token = picked.ok ? picked.plan! : "";
  const was = picked.ok ? picked.snapshot.rev : -1;

  a.tick("r4");

  const out = await a.driver.call("accept-selected", {}, { plan: token });
  assert.equal(out.ok === false && out.refused, "stale-plan");
  assert.match(out.ok === false ? out.hint! : "", new RegExp(`taken at rev ${was}`));
  assert.match(out.ok === false ? out.hint! : "", new RegExp(`now at rev ${a.rev()}`));
  assert.equal(a.accepted(), 0);
});

test("a plan minted by another driver, or edited, is not a plan this app has", async () => {
  // Tokens are per-driver and the hash binds every field, so one cannot be
  // carried between two mounted apps and cannot be edited into a claim about
  // another verb, another rev or another selection. A token that could be is a
  // token an agent can mint for itself, which is the same as no token at all —
  // and a forgery that is accepted is worse than a refusal, because it reads
  // as a guarantee in the transcript.
  const mine = planned();
  const theirs = planned();

  const picked = await theirs.driver.call("select-first", { n: 3 });
  const foreign = picked.ok ? picked.plan! : "";
  await mine.driver.call("select-first", { n: 3 });

  const crossed = await mine.driver.call("accept-selected", {}, { plan: foreign });
  assert.equal(crossed.ok === false && crossed.refused, "stale-plan");
  assert.equal(mine.accepted(), 0);

  // Edited: the same four fields, the trailing hash left alone.
  const own = await mine.driver.call("select-first", { n: 2 });
  const edited = (own.ok ? own.plan! : "").replace(/\.\d+\.(\d+)\./, ".999.$1.");
  const forged = await mine.driver.call("accept-selected", {}, { plan: edited });
  assert.equal(forged.ok === false && forged.refused, "stale-plan");
  assert.equal(mine.accepted(), 0);

  // And a string that was never a token at all.
  const junk = await mine.driver.call("accept-selected", {}, { plan: "plan-1" });
  assert.equal(junk.ok === false && junk.refused, "stale-plan");
  assert.match(junk.ok === false ? junk.hint! : "", /not a plan this app has outstanding/);
  assert.equal(mine.accepted(), 0);
});

test("a commit that does not declare `consumes` is unaffected, with a plan or without", async () => {
  // The backward-compatibility claim, as behaviour rather than a promise. A
  // commit written before this field runs bare, and a plan sent to one is
  // ignored rather than refused — an agent that got into the habit of
  // forwarding tokens must not start failing on the verbs that never asked.
  const a = planned();
  const picked = await a.driver.call("select-first", { n: 2 });

  assert.equal((await a.driver.call("decline-selected")).ok, true);
  assert.equal(
    (await a.driver.call("decline-selected", {}, { plan: picked.ok ? picked.plan! : "" })).ok,
    true,
  );
  // And the token it ignored is still good for the verb that wants one, since
  // only a verb that consumes a plan can spend one.
  const done = await a.driver.call("accept-selected", {}, { plan: picked.ok ? picked.plan! : "" });
  assert.equal(done.ok, true);
});

test("a plan is minted only on a describe that counted, and only in an app that consumes one", async () => {
  // Three conditions, and the third is what keeps this additive. An app with no
  // `consumes` verb gets no tokens at all, so every `describe` in every app
  // written before this returns the exact `Result` it returned before — which
  // matters because that result is rendered into a transcript and asserted on.
  const uses = planned();
  const plain = planned({ consumes: undefined, identity: true });

  const counted = await uses.driver.call("select-first", { n: 1 });
  assert.equal(counted.ok && typeof counted.plan, "string");

  const looked = await uses.driver.call("look");
  assert.equal(looked.ok && looked.plan, undefined, "a read minted a plan");

  const committed = await uses.driver.call("accept-selected", {}, { plan: counted.ok ? counted.plan! : "" });
  assert.equal(committed.ok && committed.plan, undefined, "a commit minted a plan");

  const elsewhere = await plain.driver.call("select-first", { n: 1 });
  assert.equal(elsewhere.ok && elsewhere.plan, undefined, "an app with no consuming verb minted one");
});

test("the plan check runs before the rev check, because its repair is the larger one", async () => {
  // The ordering decision, pinned. Every stale `rev` is also a stale plan — the
  // token binds the rev it was taken at — so the two fire together and only one
  // answer comes back. `stale` says "read again", and an agent that reads again
  // and carries on is the agent that accepts the set nobody counted; `stale-plan`
  // says "run the describe again and read the new count". Answering the narrower
  // one first would hand back the cheaper instruction for the more expensive
  // mistake.
  const a = planned();
  const picked = await a.driver.call("select-first", { n: 3 });
  const token = picked.ok ? picked.plan! : "";
  const was = picked.ok ? picked.snapshot.rev : -1;

  a.tick("r4");

  const out = await a.driver.call("accept-selected", {}, { plan: token, rev: was });
  assert.equal(out.ok === false && out.refused, "stale-plan", "answered `stale` instead");

  // And the wider mistake still wins over this one: a wrong screen says the
  // plan is about a selection the agent was never looking at.
  const after = await a.driver.call("select-first", { n: 2 });
  const fresh = after.ok ? after.plan! : "";
  const wrong = await a.driver.call("accept-selected", {}, { plan: fresh, screen: "somewhere" });
  assert.equal(wrong.ok === false && wrong.refused, "wrong-screen");
});

test("a declined commit leaves its plan usable, because nothing moved", async () => {
  // Burned on entering `run` and not before the gate, which is a decision about
  // people rather than about tokens. A person who hesitates, or is asked twice,
  // has not changed the selection — and making them re-run the describe because
  // they thought about it is how a gate teaches people to stop reading it.
  let say: boolean = false;
  const ids = ["a", "b"];
  let rev = 1;
  const selected = new Set(ids);
  let accepted = 0;
  const driver = mount({
    app: "gated",
    approve: () => say,
    visible: (): Snapshot => ({
      where: "rows",
      rev,
      selected: [...selected],
      selectedCount: selected.size,
      selectionId: selectionId(selected),
    }),
    verbs: [
      {
        name: "pick",
        kind: "describe",
        describe: "pick both",
        run: () => ({ count: selected.size }),
      },
      {
        name: "go",
        kind: "commit",
        consumes: "plan",
        describe: "accept them",
        run: () => {
          accepted += selected.size;
        },
      },
    ],
  });

  const picked = await driver.call("pick");
  const token = picked.ok ? picked.plan! : "";

  const no1 = await driver.call("go", {}, { plan: token });
  assert.equal(no1.ok === false && no1.refused, "declined-by-user");
  assert.equal(accepted, 0);

  say = true;
  const yes = await driver.call("go", {}, { plan: token });
  assert.equal(yes.ok, true, "the plan was burned by a refusal that never ran the verb");
  assert.equal(accepted, 2);
});

test("`consumes` is refused at mount on anything but a commit, and on an unknown value", () => {
  // At mount, where a typo costs one stack trace at startup, for the reason a
  // duplicate verb name is. The misspelt value is the dangerous one: `"plans"`
  // is truthy to the fingerprint and matches no check, so the app would believe
  // it had the guarantee, every cached manifest would have moved, and every
  // commit would run bare.
  const base = { app: "v", visible: (): Snapshot => ({ where: "x", rev: 1 }) };
  assert.throws(
    () =>
      mount({
        ...base,
        verbs: [{ name: "peek", kind: "describe", describe: "peek", consumes: "plan", run: () => {} }],
      }),
    /only a `commit` can consume one/,
  );
  assert.throws(
    () =>
      mount({
        ...base,
        verbs: [
          // @ts-expect-error the point of the test is the value the type forbids
          { name: "go", kind: "commit", describe: "go", consumes: "plans", run: () => {} },
        ],
      }),
    /the only value is "plan"/,
  );
});

test("`consumes` is in the manifest and in the fingerprint; an app without it has not moved", () => {
  // In the manifest because it is HOW a verb may be called, which is a fact an
  // agent should read in the cached half rather than discover by being refused
  // on every attempt. In the fingerprint for the same reason `kind` is: a verb
  // that has started requiring a receipt cannot be called the old way, and an
  // agent holding the old copy would go on calling it the old way forever.
  const base = { app: "v", visible: (): Snapshot => ({ where: "x", rev: 1 }) };
  const verb = { name: "act", kind: "commit" as const, describe: "act", run: () => {} };

  const plain = mount({ ...base, verbs: [verb] });
  const strict = mount({ ...base, verbs: [{ ...verb, consumes: "plan" as const }] });

  assert.equal(plain.manifest().verbs[0]!.consumes, undefined);
  assert.equal(strict.manifest().verbs[0]!.consumes, "plan");
  assert.notEqual(plain.manifest().version, strict.manifest().version);

  // The pinned literal from the backward-compatibility test above, asserted a
  // second time from here on purpose: this is the field most likely to be
  // folded into the hashed shape unconditionally by somebody tidying up, and
  // that would move the stored `Manifest.version` of every app in the world.
  const untouched = mount({
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
  assert.equal(untouched.manifest().version, "7d165f135f77");
});

test("an app that consumes plans and publishes no selectionId gets the weaker check, not silence", async () => {
  // The honest disclosure. Without a `selectionId` the token binds the `rev`
  // and the count and nothing else, which catches every change the app bumps
  // its `rev` for and no change it makes quietly. Refusing instead would break
  // an app that adopted `consumes` before `selectionId`; saying nothing would
  // let the weaker check be mistaken for the stronger one, which is the failure
  // mode this whole mechanism was built to remove.
  const a = planned({ consumes: "plan", identity: false });
  const picked = await a.driver.call("select-first", { n: 2 });
  const token = picked.ok ? picked.plan! : "";

  a.tickQuietly("r5");

  const out = await a.driver.call("accept-selected", {}, { plan: token });
  assert.equal(out.ok, true, "a quiet change was caught with no selectionId to catch it with");
  // And the rev-bound half still holds, which is the part that is not weaker.
  const next = await a.driver.call("select-first", { n: 1 });
  a.tick("r4");
  const late = await a.driver.call("accept-selected", {}, { plan: next.ok ? next.plan! : "" });
  assert.equal(late.ok === false && late.refused, "stale-plan");
});

test("selectionId answers membership, not order and not size alone", () => {
  // The three properties the plan token rests on, pinned where they are cheap
  // to check. Order-independence is the one an app hand-rolling this gets
  // wrong — `[...set].join(",")` is order-dependent, so ticking the same two
  // rows in the other order would read as a different selection and refuse
  // every commit — and the swap is the one a count cannot see.
  assert.equal(selectionId(["a", "b", "c"]), selectionId(["c", "a", "b"]));
  assert.notEqual(selectionId(["a", "b"]), selectionId(["a", "c"]));
  assert.notEqual(selectionId(["a", "b"]), selectionId(["a", "b", "c"]));
  assert.notEqual(selectionId([]), selectionId(["a"]));
  assert.equal(selectionId([]), selectionId([]));
});

test("`stale-plan` is reserved, so an app cannot name one of its own refusals that", () => {
  // The reserved-list rule, for the newest slug. An app that refused
  // `stale-plan` itself would take away an agent's only way to tell "the core
  // would not let that commit run on a count nobody checked" from "this app
  // declined for a reason of its own".
  assert.ok(RESERVED_REFUSALS.includes("stale-plan"));
  assert.throws(
    () =>
      mount({
        app: "v",
        visible: (): Snapshot => ({ where: "x", rev: 1 }),
        verbs: [
          { name: "go", kind: "commit", describe: "go", refuses: ["stale-plan"], run: () => {} },
        ],
      }),
    /declares the reserved refusal `stale-plan`/,
  );
});

test("mount warns when one commit on the selection consumes a plan and its sibling does not", () => {
  // ALL OR NONE, and the reason it is a warning rather than a rule nobody
  // enforces. An eval asked the worked example for a job it could not do and
  // the agent improvised its way to the one bulk commit that asked for no
  // receipt: 403 rows changed with no count read and nothing gated. The verb an
  // agent reaches for when it is off its intended path is the least-declared
  // one, so a guarantee is only as strong as its weakest sibling.
  //
  // The signal is a commit with NO ARGUMENTS, because a verb that takes nothing
  // can only be acting on ambient state. Narrow on purpose: see the comment at
  // the check for what it deliberately does not catch.
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void said.push(m);
  try {
    mount({
      app: `v${Math.random()}`,
      visible: (): Snapshot => ({ where: "x", rev: 1 }),
      verbs: [
        { name: "accept-selected", kind: "commit", consumes: "plan", describe: "a", run: () => {} },
        { name: "decline-selected", kind: "commit", describe: "d", run: () => {} },
        // Named arguments, so it is not acting on ambient state and must not be
        // nagged about: a warning on every commit would be a warning on none.
        {
          name: "set-setting",
          kind: "commit",
          describe: "s",
          args: { name: { type: "string", describe: "which" } },
          run: () => {},
        },
      ],
    });
  } finally {
    console.warn = warn;
  }
  const about = said.find((m) => m.includes("consumes a plan"));
  assert.ok(about, "the bare sibling was never mentioned");
  assert.match(about!, /`decline-selected`/);
  assert.match(about!, /or on none of them/);
  assert.ok(!about!.includes("set-setting"));
});

test("an app where no commit consumes a plan is not warned about anything", () => {
  // The additive rule. An app written before this field must mount in silence,
  // or the first thing every existing author sees from this release is a
  // console warning about a feature they have not adopted.
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void said.push(m);
  try {
    mount({
      app: `q${Math.random()}`,
      visible: (): Snapshot => ({ where: "x", rev: 1 }),
      verbs: [
        { name: "accept-selected", kind: "commit", describe: "a", run: () => {} },
        { name: "decline-selected", kind: "commit", describe: "d", run: () => {} },
      ],
    });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(said, []);
});

test("a commit called with no plan at all is told to count what the person asked for, not to re-run anything", async () => {
  // Two different mistakes, two different sentences, and the separation is the
  // decision being pinned. An eval hit "accept the selected contacts" with
  // nothing selected: the plan check is before the verb body, so the answer was
  // `stale-plan` — correct, nothing moved — with a hint that said run the
  // describe again. With an empty selection the only describe that mints a
  // non-empty plan is one that INVENTS a selection, so the hint pointed at
  // improvising in the one situation where improvising is most expensive. The
  // same eval watched an agent improvise a bulk decline of 403 rows.
  let rev = 1;
  const selected = new Set<string>();
  const driver = mount({
    app: "empty",
    visible: (): Snapshot => ({
      where: "rows",
      rev,
      selectedCount: selected.size,
      selectionId: selectionId(selected),
    }),
    verbs: [
      { name: "pick", kind: "describe", describe: "pick", run: () => ({ count: selected.size }) },
      {
        name: "accept-selected",
        kind: "commit",
        consumes: "plan",
        describe: "accept",
        run: () => void (rev += 1),
      },
    ],
  });

  const bare = await driver.call("accept-selected");
  const hint = bare.ok === false ? bare.hint! : "";
  assert.equal(bare.ok === false && bare.refused, "stale-plan");
  // The no-plan sentence, which names the rows the PERSON asked about and says
  // out loud not to pick a selection to give the call something to run on.
  assert.match(hint, /the rows the person actually asked about/);
  assert.match(hint, /do NOT select something near enough/);
  // And the empty case says so, because that is the fact that makes the
  // generic advice wrong here.
  assert.match(hint, /Nothing is selected right now/);
  // The stale sentence is NOT this sentence: only a plan that went out of date
  // is told to run the describe again.
  assert.ok(!hint.includes("Do not re-send this one"));

  // Whereas a plan that was good and went stale gets exactly that.
  selected.add("r1");
  rev += 1;
  const picked = await driver.call("pick");
  selected.add("r2");
  const stale = await driver.call("accept-selected", {}, { plan: picked.ok ? picked.plan! : "" });
  const other = stale.ok === false ? stale.hint! : "";
  assert.match(other, /Do not re-send this one/);
  assert.ok(!other.includes("do NOT select something near enough"));
});
