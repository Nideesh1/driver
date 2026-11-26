/**
 * The case format, as a specification.
 *
 * Every test here is named after a decision about the FORMAT, because a format
 * is the part of a harness that other people's files depend on: loosening a
 * rule is cheap and tightening one later breaks every suite in existence. The
 * rules worth defending are the ones that stop a case from being
 * unfalsifiable — an `expect` that states nothing, two cases with one id, a
 * flat `args` with no verb to attach to — since a case that cannot fail is
 * worse than no case: it is a green line nobody earned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { cacheKey, caseKey, CaseError, parseBound, parseCase } from "../src/case.ts";

const ok = { id: "x", ask: "do the thing", expect: { commits: "none" } };

test("a case is an ask plus an expectation", () => {
  const c = parseCase(ok, "x.json");
  assert.equal(c.id, "x");
  assert.equal(c.ask, "do the thing");
  assert.equal(c.expect.commits, "none");
  assert.equal(c.source, "x.json");
});

test("an expectation that states nothing is refused", () => {
  // The most important check in the file. A case with an empty `expect` runs,
  // costs money and passes forever.
  assert.throws(
    () => parseCase({ id: "x", ask: "a", expect: {} }, "x.json"),
    /cannot fail/,
  );
});

test("a misspelt expectation is refused rather than ignored", () => {
  // `calls` versus `call` is the mistake that would otherwise produce a case
  // with no verb expectation at all, which still passes.
  assert.throws(() => parseCase({ id: "x", ask: "a", expect: { call: ["go"] } }, "x.json"), /not an expectation/);
  assert.throws(() => parseCase({ ...ok, expectt: {} }, "x.json"), /not a field of a case/);
});

test("`commits: none` and a list of allowed commits are both accepted; anything else is not", () => {
  assert.equal(parseCase({ ...ok, expect: { commits: "none" } }, "f").expect.commits, "none");
  assert.deepEqual(
    parseCase({ ...ok, expect: { commits: ["accept-selected"] } }, "f").expect.commits,
    ["accept-selected"],
  );
  assert.throws(() => parseCase({ ...ok, expect: { commits: true } }, "f"), /must be/);
});

test("`refused` takes one slug or a list of acceptable ones", () => {
  // The list exists because the core checks a plan token before the verb runs,
  // so the same ask can be refused by two different layers and both are the
  // right outcome. A case that had to name one would be asserting which layer
  // answered.
  assert.equal(parseCase({ ...ok, expect: { refused: "stale" } }, "f").expect.refused, "stale");
  assert.deepEqual(
    parseCase({ ...ok, expect: { refused: ["stale-plan", "nothing-selected"] } }, "f").expect
      .refused,
    ["stale-plan", "nothing-selected"],
  );
});

test("`asks` has no `false`", () => {
  // "Must not ask" is not an expectation anybody holds, and spelling it would
  // invite a case that fails an agent for being careful.
  assert.throws(() => parseCase({ ...ok, expect: { asks: false } }, "f"), /is `true` or absent/);
});

test("args comes in two spellings and a mixture is refused", () => {
  const flat = parseCase(
    { ...ok, expect: { calls: ["select-where"], args: { company: "Acme" } } },
    "f",
  );
  assert.deepEqual(flat.expect.args, { company: "Acme" });
  const keyed = parseCase(
    { ...ok, expect: { args: { "select-where": { company: "Acme" } } } },
    "f",
  );
  assert.deepEqual(keyed.expect.args, { "select-where": { company: "Acme" } });
  // A mixture is refused rather than guessed at, because guessing silently
  // drops half the assertions.
  assert.throws(
    () => parseCase({ ...ok, expect: { args: { company: "Acme", go: { screen: "x" } } } }, "f"),
    /mixes the two spellings/,
  );
});

test("a step bound is a ceiling however it is spelled", () => {
  assert.equal(parseBound("<=6"), 6);
  assert.equal(parseBound("<6"), 5);
  assert.equal(parseBound(6), 6);
  assert.equal(parseBound(" <= 12 "), 12);
  assert.throws(() => parseBound("six"), /must look like/);
  assert.throws(() => parseBound(0), /positive whole number/);
});

test("the cache key changes when the meaning changes and not when the prose does", () => {
  // The property the cache rests on. A case whose `why` was improved must not
  // throw away what it cost to run; a case whose expectation was tightened
  // must not be answered from a transcript scored under the old one.
  const a = parseCase({ id: "x", ask: "a", why: "first wording", expect: { commits: "none" } }, "f");
  const b = parseCase({ id: "x", ask: "a", why: "better wording", expect: { commits: "none" } }, "g");
  assert.equal(caseKey(a), caseKey(b));

  const tighter = parseCase(
    { id: "x", ask: "a", expect: { commits: "none", steps: "<=3" } },
    "f",
  );
  assert.notEqual(caseKey(a), caseKey(tighter));

  // Field order is not meaning.
  const reordered = parseCase({ ask: "a", id: "x", expect: { commits: "none" } }, "f");
  assert.equal(caseKey(a), caseKey(reordered));
});

test("the manifest version, the model and the run index are all in the cache key", () => {
  const c = parseCase(ok, "f");
  const base = cacheKey(c, "v1", "m1", 0);
  assert.notEqual(base, cacheKey(c, "v2", "m1", 0), "a changed verb list must invalidate");
  assert.notEqual(base, cacheKey(c, "v1", "m2", 0), "a changed model must invalidate");
  // The run index is separate so that raising --runs from 3 to 5 reuses the
  // three you paid for instead of discarding them.
  assert.notEqual(base, cacheKey(c, "v1", "m1", 1));
  assert.equal(base, cacheKey(parseCase(ok, "elsewhere.json"), "v1", "m1", 0));
});

test("a case error names the file", () => {
  // These files are compared against a real model at real cost. A message that
  // did not say which file would send somebody reading ten of them.
  const err = (() => {
    try {
      parseCase({ id: "x" }, "evals/07-filter.json");
    } catch (e) {
      return e as CaseError;
    }
    return undefined;
  })();
  assert.ok(err instanceof CaseError);
  assert.match(err.message, /evals\/07-filter\.json/);
});

test("`anyOf` holds two or more whole routes, and a route needs its own calls", () => {
  // Two or more, because one branch is a route pretending to be a choice and
  // the author who wrote it meant `calls`. The next reader of a one-branch
  // `anyOf` would take it for a list that is allowed to grow and never notice
  // that nothing else was ever permitted.
  const c = parseCase(
    {
      id: "x",
      ask: "accept the pending ones at Acme",
      expect: {
        anyOf: [
          { calls: ["select-where", "accept"], args: { "select-where": { company: "Acme" } }, count: { "select-where": 7 } },
          { calls: ["open-company", "select-here", "accept"] },
        ],
        commits: ["accept"],
      },
    },
    "x.json",
  );
  assert.equal(c.expect.anyOf?.length, 2);
  assert.deepEqual(c.expect.anyOf?.[1]?.calls, ["open-company", "select-here", "accept"]);
  assert.throws(
    () => parseCase({ id: "x", ask: "a", expect: { anyOf: [{ calls: ["go"] }] } }, "x.json"),
    /TWO OR MORE/,
  );
  assert.throws(
    () => parseCase({ id: "x", ask: "a", expect: { anyOf: [{ count: 3 }, { calls: ["go"] }] } }, "x.json"),
    /must be a non-empty list/,
  );
});

test("`anyOf` beside a top-level route is refused rather than merged", () => {
  // Two spellings of one claim, and whichever way a reader took it the other
  // half would be silently unasserted. The top-level fields that are claims
  // about the RUN rather than about a route are still allowed beside it.
  assert.throws(
    () => parseCase({ id: "x", ask: "a", expect: { calls: ["go"], anyOf: [{ calls: ["a"] }, { calls: ["b"] }] } }, "x.json"),
    /cannot be used with/,
  );
  assert.throws(
    () => parseCase({ id: "x", ask: "a", expect: { count: 3, anyOf: [{ calls: ["a"] }, { calls: ["b"] }] } }, "x.json"),
    /cannot be used with/,
  );
  const c = parseCase(
    {
      id: "x",
      ask: "a",
      expect: { anyOf: [{ calls: ["a"] }, { calls: ["b"] }], forbid: ["c"], commits: "none", steps: "<=4" },
    },
    "x.json",
  );
  assert.deepEqual(c.expect.forbid, ["c"]);
});

test("a route's own fields are validated like the top-level ones", () => {
  assert.throws(
    () => parseCase({ id: "x", ask: "a", expect: { anyOf: [{ calls: ["a"], steps: 3 }, { calls: ["b"] }] } }, "x.json"),
    /not part of a route/,
  );
  assert.throws(
    () =>
      parseCase(
        { id: "x", ask: "a", expect: { anyOf: [{ calls: ["a"], args: { q: "x", b: { c: 1 } } }, { calls: ["b"] }] } },
        "x.json",
      ),
    /mixes the two spellings/,
  );
});

test("adding a route changes the cache key, because it changes the verdict", () => {
  const one = { id: "x", ask: "a", expect: { anyOf: [{ calls: ["a"] }, { calls: ["b"] }] } };
  const two = { id: "x", ask: "a", expect: { anyOf: [{ calls: ["a"] }, { calls: ["c"] }] } };
  assert.notEqual(caseKey(parseCase(one, "x.json")), caseKey(parseCase(two, "x.json")));
});
