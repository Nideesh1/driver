/**
 * The scoring rules, as a specification.
 *
 * The one to read first is **a false commit fails the case whatever else went
 * right**, and beside it **drift does not fail anything**. Those two together
 * are the whole editorial position of this package: three of the four numbers
 * cost a retry and the fourth costs the rows, so they cannot be averaged and
 * they cannot be traded off. Every other test here defends a smaller decision
 * that somebody will be tempted to undo on a quiet afternoon.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { judge, askMechanism } from "../src/score.ts";
import type { CallRecord, EvalCase, Transcript } from "../src/types.ts";
import { app } from "./app.ts";

const manifest = app().driver.manifest();
const opts = { manifest };

function transcript(calls: Array<Partial<CallRecord> & { name: string }>, extra: Partial<Transcript> = {}): Transcript {
  return {
    calls: calls.map((c, i) => ({ step: i + 1, args: {}, ok: true, ...c })),
    steps: extra.steps ?? calls.length + 1,
    stop: extra.stop ?? "answered",
    ...(extra.text === undefined ? {} : { text: extra.text }),
  };
}

const kase = (expect: EvalCase["expect"]): EvalCase => ({ id: "c", ask: "do it", expect });

test("a commit the case did not allow is a false commit and fails the case", () => {
  const j = judge(
    kase({ calls: ["select-where"], commits: "none" }),
    transcript([
      { name: "select-where", args: { company: "Acme" }, count: 10, kind: "describe" },
      { name: "accept-selected", count: 10, kind: "commit" },
    ]),
    opts,
  );
  assert.equal(j.falseCommits.length, 1);
  assert.equal(j.verb, "ok", "it chose the right verb AND committed; both are true");
  assert.equal(j.pass, false, "a false commit fails the case whatever else went right");
  assert.match(j.notes.join("\n"), /FALSE COMMIT/);
  assert.match(j.notes.join("\n"), /10 row/);
});

test("a commit that was attempted and refused is a near miss and not a false commit", () => {
  // Nothing moved, so nothing is owed. It is still printed: a verb list that
  // lets an agent reach for the expensive thing is one edit away from one that
  // lets it through.
  const j = judge(
    kase({ commits: "none" }),
    transcript([{ name: "accept-selected", ok: false, refused: "nothing-selected", kind: "commit" }]),
    opts,
  );
  assert.equal(j.falseCommits.length, 0);
  assert.equal(j.nearMisses.length, 1);
  assert.equal(j.pass, true);
  assert.match(j.notes.join("\n"), /nothing moved/);
});

test("drift is reported and does not fail the case", () => {
  // If this ever flips, an author who widens a bound has "fixed" a case, and
  // the step number stops meaning anything.
  const j = judge(
    kase({ calls: ["select-where"], steps: "<=2" }),
    transcript([{ name: "select-where", count: 10, kind: "describe" }], { steps: 9 }),
    opts,
  );
  assert.equal(j.steps.taken, 9);
  assert.equal(j.steps.bound, 2);
  assert.equal(j.steps.over, true);
  assert.equal(j.pass, true, "drift is a cost, not an error");
  assert.match(j.notes.join("\n"), /Not a failure/);
});

test("the expected verbs are a subsequence: wandering in between is drift, wrong order is not", () => {
  const expect = { calls: ["go", "select-where"] };
  const wandered = judge(
    kase(expect),
    transcript([
      { name: "go", args: { screen: "contacts" } },
      { name: "read_screen", ok: null },
      { name: "select-where", count: 10, kind: "describe" },
    ]),
    opts,
  );
  assert.equal(wandered.verb, "ok");

  const backwards = judge(
    kase(expect),
    transcript([{ name: "select-where", count: 10, kind: "describe" }, { name: "go" }]),
    opts,
  );
  assert.equal(backwards.verb, "wrong");
  assert.match(backwards.notes.join("\n"), /did not come/);
});

test("a forbidden verb fails the case even when the expected ones also ran", () => {
  // THE RECORDED FAILURE, as a scoring rule. A case that only said what should
  // happen would pass a run that did both — selected the one person AND took
  // her whole company.
  const j = judge(
    kase({ calls: ["select-contact"], forbid: ["select-where"], commits: "none" }),
    transcript([
      { name: "select-where", args: { company: "Acme" }, count: 10, kind: "describe" },
      { name: "select-contact", args: { id: "a-1" }, count: 1, kind: "describe" },
    ]),
    opts,
  );
  assert.equal(j.verb, "wrong");
  assert.equal(j.pass, false);
  assert.match(j.notes.join("\n"), /which this case forbids/);
});

test("only the arguments the case names are checked, and a correction is noted not failed", () => {
  const j = judge(
    kase({ calls: ["select-contact"], args: { id: "a-1" } }),
    transcript([
      { name: "select-contact", args: { id: "nope" }, ok: false, refused: "no-such-contact", kind: "describe" },
      { name: "select-contact", args: { id: "a-1", add: true }, count: 1, kind: "describe" },
    ]),
    opts,
  );
  assert.equal(j.args, "ok", "`add` was not mentioned, so passing it is not a failure");
  assert.match(j.notes.join("\n"), /attempt 2, not the first/);
});

test("a wrong count says it may be the fixture and not the model", () => {
  const j = judge(
    kase({ calls: ["select-where"], count: 112 }),
    transcript([{ name: "select-where", args: { company: "Acme" }, count: 10, kind: "describe" }]),
    opts,
  );
  assert.equal(j.counts, "wrong");
  assert.match(j.notes.join("\n"), /THE FIXTURE MOVED/);
  assert.match(j.notes.join("\n"), /--dry-run/);
});

test("any one of a list of acceptable refusals will do", () => {
  const expect = { calls: ["accept-selected"], refused: ["stale-plan", "nothing-selected"], commits: "none" as const };
  for (const slug of ["stale-plan", "nothing-selected"]) {
    const j = judge(
      kase(expect),
      transcript([{ name: "accept-selected", ok: false, refused: slug, kind: "commit" }]),
      opts,
    );
    assert.equal(j.refusal, "ok", slug);
    assert.equal(j.pass, true, slug);
  }
  const wrong = judge(
    kase(expect),
    transcript([{ name: "accept-selected", ok: false, refused: "wrong-screen", kind: "commit" }]),
    opts,
  );
  assert.equal(wrong.refusal, "wrong");
  assert.match(wrong.notes.join("\n"), /The refusal IS the/);
});

test("`asks` is skipped, never failed, when the app has no ask verb", () => {
  // A harness that failed an app for lacking a feature the library has not
  // shipped would be measuring the library. The rest of the case still bites.
  const j = judge(
    kase({ asks: true, commits: "none" }),
    transcript([{ name: "read_screen", ok: null }], { text: "There are five people called that — which one?" }),
    opts,
  );
  assert.equal(j.asked, "skip");
  assert.equal(j.pass, true);
  assert.match(j.notes.join("\n"), /did put a question in its answer/);

  // And the half that does bite: an ambiguous ask that commits is still red.
  const committed = judge(
    kase({ asks: true, commits: "none" }),
    transcript([{ name: "accept-selected", count: 10, kind: "commit" }]),
    opts,
  );
  assert.equal(committed.pass, false);
  assert.equal(committed.falseCommits.length, 1);
});

test("`asks` is asserted once an ask verb is named", () => {
  const withAsk = {
    ...manifest,
    verbs: [...manifest.verbs, { name: "ask", describe: "ask the person", kind: "read" as const }],
  };
  assert.equal(askMechanism(withAsk), "ask");
  assert.equal(askMechanism(manifest), null);
  assert.equal(askMechanism(withAsk, "clarify"), null, "a named verb the app lacks is not a match");

  const j = judge(
    kase({ asks: true }),
    transcript([{ name: "select-contact", args: { id: "a-1" }, count: 1, kind: "describe" }]),
    { manifest: withAsk, askVerb: "ask" },
  );
  assert.equal(j.asked, "wrong");
  assert.equal(j.pass, false);
  assert.match(j.notes.join("\n"), /guessed instead/);
});

test("an expectation the case did not state is `n/a` and cannot be failed", () => {
  const j = judge(kase({ commits: "none" }), transcript([{ name: "go" }]), opts);
  assert.deepEqual(
    [j.verb, j.args, j.counts, j.refusal, j.asked],
    ["n/a", "n/a", "n/a", "n/a", "n/a"],
  );
  assert.equal(j.pass, true);
});

test("`anyOf` passes the route the agent actually took, and says which", () => {
  // The failure this is for: a case that named `select-where → accept` scored
  // the demo 0/3 while the model used the screen-scoped verb that means the
  // same thing, three times identically. The better path must not be a red
  // cross, and the report has to say which of the allowed answers was given —
  // a case whose second route is the only one ever taken is telling you the
  // first is not how the app is driven.
  const c = kase({
    anyOf: [
      {
        calls: ["select-where", "accept-selected"],
        args: { "select-where": { company: "Acme" } },
        count: { "select-where": 112 },
      },
      {
        calls: ["open-company", "select-pending-here", "accept-selected"],
        args: { "open-company": { company: "Acme" } },
        count: { "select-pending-here": 112 },
      },
    ],
    commits: ["accept-selected"],
  });
  const j = judge(
    c,
    transcript([
      { name: "open-company", args: { company: "Acme" }, kind: "read" },
      { name: "select-pending-here", count: 112, kind: "describe" },
      { name: "accept-selected", count: 112, kind: "commit" },
    ]),
    opts,
  );
  assert.equal(j.pass, true);
  assert.equal(j.verb, "ok");
  assert.equal(j.args, "ok");
  assert.equal(j.counts, "ok");
  assert.match(j.notes.join("\n"), /took route 2 of 2/);
});

test("`anyOf` keeps the count's teeth: the right route with the wrong number still fails", () => {
  const c = kase({
    anyOf: [
      { calls: ["select-where", "accept-selected"], count: { "select-where": 112 } },
      { calls: ["select-pending-here", "accept-selected"], count: { "select-pending-here": 112 } },
    ],
    commits: ["accept-selected"],
  });
  const j = judge(
    c,
    transcript([
      { name: "select-pending-here", count: 9, kind: "describe" },
      { name: "accept-selected", count: 9, kind: "commit" },
    ]),
    opts,
  );
  assert.equal(j.counts, "wrong");
  assert.equal(j.pass, false);
  assert.match(j.notes.join("\n"), /reported 9 where the case says 112/);
});

test("when no route was taken, every route's reason is printed", () => {
  // Not just the first branch's. An author reading a red `anyOf` wants to know
  // how close each allowed answer came, because the near miss is where the
  // next `describe` edit goes.
  const j = judge(
    kase({
      anyOf: [{ calls: ["select-where"] }, { calls: ["select-pending-here"] }],
      commits: "none",
    }),
    transcript([{ name: "goto", args: { screen: "companies" }, kind: "read" }]),
    opts,
  );
  assert.equal(j.verb, "wrong");
  assert.equal(j.pass, false);
  assert.match(j.notes.join("\n"), /none of the 2 routes/);
  assert.match(j.notes.join("\n"), /route 1 \(`select-where`\)/);
  assert.match(j.notes.join("\n"), /route 2 \(`select-pending-here`\)/);
});

test("a forbidden verb is forbidden whichever route was taken", () => {
  // `forbid` is a claim about the run, so it is applied after a route has
  // matched and can turn a matched route red on its own.
  const j = judge(
    kase({
      anyOf: [{ calls: ["select-contact"] }, { calls: ["select-pending-here"] }],
      forbid: ["select-where"],
      commits: "none",
    }),
    transcript([
      { name: "select-where", args: { company: "Acme" }, count: 410, kind: "describe" },
      { name: "select-contact", args: { id: "c-1" }, count: 1, kind: "describe" },
    ]),
    opts,
  );
  assert.equal(j.verb, "wrong");
  assert.equal(j.pass, false);
  assert.match(j.notes.join("\n"), /which this case forbids/);
});
