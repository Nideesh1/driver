/**
 * The harness end to end: dry run, replay, live run, cache, report, diff.
 *
 * Driven by a scripted `think` against a real `mount()`ed driver, which is the
 * same discipline the agent package's own suite keeps and for the same reason:
 * if the model were inside, the hard parts — the false-commit path, the fixture
 * replay, the cache key — would be verified by paying a vendor and hoping.
 *
 * The `think` here is STATELESS, deciding what to do from the messages it is
 * handed rather than from a position in a list. That is not tidiness: the
 * suite runs each case n times, and a script with an index in it would answer
 * the second run from the middle of the first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dryRun } from "../src/dry.ts";
import { fileCache, loadCases, writeResult, readResult } from "../src/files.ts";
import { failed, regressed, renderDiff, renderPlan, renderReport } from "../src/report.ts";
import { runCase, runSuite, SetupError } from "../src/run.ts";
import type { EvalCase, SuiteResult, Think } from "../src/types.ts";
import { app, call } from "./app.ts";

/** A `think` that replays the same plan on every run, one turn per step. */
function robot(plan: Array<{ name: string; args?: object }>, answer = "done"): Think {
  return async ({ messages }) => {
    const spent = messages.filter((m) => m.role === "assistant").length;
    const next = plan[spent];
    if (!next) return { text: answer };
    return { calls: [call(next.name, next.args ?? {})] };
  };
}

const kase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "bulk",
  ask: "accept everyone at Acme",
  expect: {
    calls: ["select-where", "accept-selected"],
    args: { "select-where": { company: "Acme" } },
    count: { "select-where": 10 },
    commits: ["accept-selected"],
    steps: "<=3",
  },
  ...over,
});

test("a case runs against the real driver and the commit really happens", async () => {
  // The harness passes NO `onBeforeCommit`, on purpose. A gate here would veto
  // exactly the calls this package exists to count and report zero false
  // commits forever.
  const fixture = app();
  const t = await runCase(fixture.driver, kase(), {
    think: robot([
      { name: "select-where", args: { company: "Acme" } },
      { name: "accept-selected" },
    ]),
  });
  assert.equal(fixture.accepted().length, 10, "the commit was not gated away");
  assert.deepEqual(
    t.calls.map((c) => c.name),
    ["select-where", "accept-selected"],
  );
  assert.equal(t.calls[0]!.count, 10);
  assert.equal(t.calls[0]!.kind, "describe");
  assert.equal(t.calls[1]!.kind, "commit");
  assert.equal(t.stop, "answered");
});

test("a `read_screen` call is recorded with no verdict rather than as a failure", async () => {
  const fixture = app();
  const t = await runCase(fixture.driver, kase(), {
    think: robot([{ name: "read_screen" }]),
  });
  assert.equal(t.calls[0]!.ok, null, "no verb ran, so neither ok nor refused is true");
  assert.equal(t.calls[0]!.kind, undefined);
});

test("a setup that the app refuses stops the case instead of scoring the wrong screen", async () => {
  const fixture = app();
  await assert.rejects(
    () =>
      runCase(fixture.driver, kase({ setup: [{ verb: "select-contact", args: { id: "nope" } }] }), {
        think: robot([]),
      }),
    SetupError,
  );
});

test("every run gets a fresh driver, so one case's commit cannot move another's counts", async () => {
  const seen: number[] = [];
  const result = await runSuite([kase()], {
    newDriver: () => {
      const fixture = app();
      seen.push(fixture.accepted().length);
      return fixture.driver;
    },
    think: robot([
      { name: "select-where", args: { company: "Acme" } },
      { name: "accept-selected" },
    ]),
    runs: 3,
    model: "scripted",
  });
  // One probe for the manifest plus three runs, each starting on 0 accepted.
  assert.ok(seen.length >= 4);
  assert.deepEqual(new Set(seen), new Set([0]));
  assert.equal(result.cases[0]!.passed, 3);
  assert.equal(result.cases[0]!.attempted, 3);
  assert.equal(failed(result), false);
});

test("a rate, not a boolean: a case that passes sometimes is not a pass", async () => {
  // A model is a sampler. The alternative — report the first run as a verdict —
  // is the single most misleading thing this tool could do.
  let runIndex = 0;
  const result = await runSuite([kase({ expect: { calls: ["select-where"], commits: "none" } })], {
    newDriver: () => app().driver,
    think: async ({ messages }) => {
      const spent = messages.filter((m) => m.role === "assistant").length;
      if (spent > 0) return { text: "done" };
      // Right once, wrong once, right once.
      const good = runIndex++ % 2 === 0;
      return { calls: [call(good ? "select-where" : "go", good ? { company: "Acme" } : { screen: "contacts" })] };
    },
    runs: 3,
    model: "scripted",
  });
  const c = result.cases[0]!;
  assert.equal(c.attempted, 3);
  assert.equal(c.passed, 2, "two of three");
  assert.equal(failed(result), true, "sometimes is not a pass");
  assert.match(renderReport(result), /passed sometimes/);
});

test("a skipped case is loaded, validated and not run", async () => {
  const result = await runSuite([kase({ skip: "the app has no ask verb yet" })], {
    newDriver: () => app().driver,
    think: async () => {
      throw new Error("a skipped case must not reach the model");
    },
    runs: 2,
    model: "scripted",
  });
  assert.equal(result.cases[0]!.skipped, true);
  assert.equal(result.modelCalls, 0);
  assert.match(renderReport(result), /skip  bulk/);
});

test("the cache answers an unchanged case without a model, and the run index is part of the key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-eval-"));
  const cache = fileCache(dir);
  const options = {
    newDriver: () => app().driver,
    think: robot([
      { name: "select-where", args: { company: "Acme" } },
      { name: "accept-selected" },
    ]),
    runs: 2,
    model: "scripted",
    cache,
  };
  const first = await runSuite([kase()], options);
  assert.equal(first.cacheHits, 0);
  assert.ok(first.modelCalls > 0);

  const second = await runSuite([kase()], options);
  assert.equal(second.cacheHits, 2);
  assert.equal(second.modelCalls, 0, "an unchanged case costs nothing the second time");

  // Raising --runs reuses what was paid for and buys only the difference.
  const wider = await runSuite([kase()], { ...options, runs: 3 });
  assert.equal(wider.cacheHits, 2);
  assert.ok(wider.modelCalls > 0);

  // A changed expectation is a miss: a transcript scored under the old one is
  // not an answer to the new one.
  const tightened = await runSuite(
    [kase({ expect: { ...kase().expect, steps: "<=1" } })],
    options,
  );
  assert.equal(tightened.cacheHits, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the dry run replays an asserted count against the real driver and names fixture drift", async () => {
  // The check that tells a model regression from a data change, and the reason
  // a live run does it first.
  const good = await dryRun([kase()], { newDriver: () => app().driver });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.replayed, [{ id: "bulk", verb: "select-where", expected: 10, actual: 10 }]);

  const drifted = await dryRun([kase({ expect: { ...kase().expect, count: { "select-where": 112 } } })], {
    newDriver: () => app().driver,
  });
  assert.equal(drifted.errors.length, 1);
  assert.match(drifted.errors[0]!, /FIXTURE DRIFT/);
  assert.match(drifted.errors[0]!, /No model was involved/);
});

test("the dry run carries the plan token, so a describe-then-commit path is replayable", async () => {
  // `consumes: "plan"` means a commit cannot be called bare. A replay that did
  // not forward the token could not walk the one path most worth replaying.
  const planned = () => app({ planned: true }).driver;
  const dry = await dryRun([kase()], { newDriver: planned });
  assert.deepEqual(dry.errors, []);
  assert.deepEqual(
    dry.warnings.filter((w) => w.includes("stale-plan")),
    [],
    "the commit was reached with a token, not refused",
  );
});

test("the dry run catches a verb that does not exist, with a suggestion", async () => {
  const dry = await dryRun([kase({ expect: { calls: ["select_where"], commits: "none" } })], {
    newDriver: () => app().driver,
  });
  assert.match(dry.errors.join("\n"), /no verb named `select_where`/);
  assert.match(dry.errors.join("\n"), /Did you mean `select-where`\?/);
});

test("the dry run catches an argument the verb does not take and a value outside its oneOf", async () => {
  const bad = await dryRun(
    [
      kase({ expect: { calls: ["select-where"], args: { companyName: "Acme" }, commits: "none" } }),
      kase({ id: "two", expect: { calls: ["select-where"], args: { company: "Initech" }, commits: "none" } }),
    ],
    { newDriver: () => app().driver },
  );
  assert.match(bad.errors.join("\n"), /takes no argument `companyName`/);
  assert.match(bad.errors.join("\n"), /argument `company` must be one of "Acme", "Globex"/);
});

test("the dry run refuses a case that forbids the commit it also expects, unless it expects a refusal", async () => {
  const contradiction = await dryRun(
    [kase({ expect: { calls: ["accept-selected"], commits: "none" } })],
    { newDriver: () => app().driver },
  );
  assert.match(contradiction.errors.join("\n"), /can never pass/);

  // The empty-selection case: the commit IS called, and being told no is the
  // right outcome. It must not be the one combination the validator rejects.
  const refusalCase = await dryRun(
    [
      kase({
        expect: {
          calls: ["accept-selected"],
          refused: ["stale-plan", "nothing-selected"],
          commits: "none",
        },
      }),
    ],
    { newDriver: () => app().driver },
  );
  assert.deepEqual(refusalCase.errors, []);
});

test("the dry run lists the verbs no case mentions", async () => {
  const dry = await dryRun([kase()], { newDriver: () => app().driver });
  assert.deepEqual(dry.unexercised.sort(), ["go", "select-contact"]);
});

test("the report prints false commits alone, first, and no aggregate score", async () => {
  // The layout IS the argument. An "87%" would let a false commit be paid for
  // with two tidy navigations.
  const result = await runSuite([kase({ expect: { calls: ["select-where"], commits: "none" } })], {
    newDriver: () => app().driver,
    think: robot([
      { name: "select-where", args: { company: "Acme" } },
      { name: "accept-selected" },
    ]),
    runs: 1,
    model: "scripted",
  });
  const text = renderReport(result);
  const lines = text.split("\n");
  const fc = lines.findIndex((l) => l.includes("FALSE COMMITS"));
  const verb = lines.findIndex((l) => l.includes("verb chosen"));
  assert.ok(fc >= 0 && verb > fc, "false commits come before everything else");
  assert.match(text, /FIX THIS FIRST/);
  assert.match(text, /costs the rows/);
  assert.doesNotMatch(text, /\d+%/, "there is no percentage anywhere");
  assert.doesNotMatch(text, /score/i);
  // One run per case is flagged as one draw and not a verdict.
  assert.match(text, /ONE RUN PER CASE/);
});

test("a clean report says the zero out loud rather than omitting it", async () => {
  const result = await runSuite([kase()], {
    newDriver: () => app().driver,
    think: robot([
      { name: "select-where", args: { company: "Acme" } },
      { name: "accept-selected" },
    ]),
    runs: 2,
    model: "scripted",
  });
  const text = renderReport(result);
  assert.match(text, /FALSE COMMITS {10}0/);
  assert.match(text, /not a retry/);
  assert.match(text, /verb chosen {12}1\/1 cases {3}\(2\/2 runs\)/);
});

test("the plan line says what it will spend before it spends it", () => {
  const text = renderPlan({
    cases: [kase(), kase({ id: "two" }), kase({ id: "three", skip: "later" })],
    runs: 3,
    maxSteps: 12,
    cached: 2,
    model: "claude-x",
    endpoint: "http://127.0.0.1:8771/api/chat",
  });
  assert.match(text, /2 case\(s\) × 3 run\(s\) = 6 run\(s\), 1 case\(s\) skipped, 2 cached, 4 to run/);
  assert.match(text, /At most 4 × 12 = 48 model round trips/);
  assert.match(text, /not a CI check/);
  assert.doesNotMatch(text, /\$/, "no invented price");
});

test("diff mode reports what moved, by rate, and calls a regression a regression", () => {
  const before: SuiteResult = {
    at: "2026-01-01T00:00:00.000Z",
    manifestVersion: "v1",
    app: "Toy",
    model: "m",
    runs: 3,
    modelCalls: 9,
    cacheHits: 0,
    cases: [
      caseResult("named-contact", 1, 3, 4),
      caseResult("cross-screen", 3, 3, 7),
      caseResult("navigate", 3, 3, 2),
    ],
  };
  const after: SuiteResult = {
    ...before,
    at: "2026-01-02T00:00:00.000Z",
    manifestVersion: "v2",
    cases: [
      caseResult("named-contact", 3, 3, 4),
      caseResult("cross-screen", 3, 3, 4),
      caseResult("navigate", 1, 3, 2),
      caseResult("brand-new", 2, 3, 3),
    ],
  };
  const text = renderDiff(before, after);
  assert.match(text, /better {6}named-contact {14}1\/3 → 3\/3/);
  assert.match(text, /fewer steps.*cross-screen.*steps 7 → 4 \(-3\)/);
  assert.match(text, /REGRESSED {3}navigate {19}3\/3 → 1\/3/);
  assert.match(text, /new {9}brand-new/);
  assert.equal(regressed(before, after), true);
  assert.equal(regressed(before, before), false);
});

test("diff mode says so when the verb list did not change", () => {
  // Otherwise an author reads movement caused by sampling as the effect of
  // their edit, which is the one conclusion this tool must not help them to.
  const one: SuiteResult = {
    at: "a",
    manifestVersion: "v1",
    app: "Toy",
    model: "m",
    runs: 3,
    modelCalls: 0,
    cacheHits: 0,
    cases: [caseResult("x", 1, 3, 3)],
  };
  const two: SuiteResult = { ...one, at: "b", cases: [caseResult("x", 3, 3, 3)] };
  assert.match(renderDiff(one, two), /the verb list is the same in both runs/);
  assert.match(renderDiff(one, { ...two, model: "other" }), /not attributable/);
});

test("a suite is a directory of files, read in filename order, with unique ids", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-cases-"));
  fs.writeFileSync(
    path.join(dir, "02-second.json"),
    JSON.stringify({ id: "second", ask: "b", expect: { commits: "none" } }),
  );
  fs.writeFileSync(
    path.join(dir, "01-first.json"),
    JSON.stringify([{ id: "first", ask: "a", expect: { commits: "none" } }]),
  );
  const cases = loadCases(dir);
  assert.deepEqual(
    cases.map((c) => c.id),
    ["first", "second"],
  );

  fs.writeFileSync(
    path.join(dir, "03-clash.json"),
    JSON.stringify({ id: "first", ask: "c", expect: { commits: "none" } }),
  );
  assert.throws(() => loadCases(dir), /already used by/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a saved result round-trips, which is what --diff reads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-save-"));
  const file = path.join(dir, "run.json");
  const result: SuiteResult = {
    at: "a",
    manifestVersion: "v1",
    app: "Toy",
    model: "m",
    runs: 1,
    modelCalls: 1,
    cacheHits: 0,
    cases: [caseResult("x", 1, 1, 2)],
  };
  writeResult(file, result);
  assert.deepEqual(readResult(file), result);
  fs.rmSync(dir, { recursive: true, force: true });
});

function caseResult(id: string, passed: number, attempted: number, steps: number) {
  return {
    id,
    ask: `ask ${id}`,
    passed,
    attempted,
    falseCommits: [],
    runs: Array.from({ length: attempted }, (_, i) => ({
      transcript: { calls: [], steps, stop: "answered" as const },
      judgement: {
        verb: "ok" as const,
        args: "n/a" as const,
        counts: "n/a" as const,
        refusal: "n/a" as const,
        asked: "n/a" as const,
        steps: { taken: steps, over: false },
        falseCommits: [],
        nearMisses: [],
        notes: [],
        pass: i < passed,
      },
    })),
  };
}
