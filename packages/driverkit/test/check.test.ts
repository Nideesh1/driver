/**
 * The honesty checker, against apps that lie.
 *
 * Every test here is of the form "an app tells one specific lie and the
 * checker names it, with a message an author can act on". The control test —
 * an honest app producing nothing — is the one that keeps the rest meaningful:
 * a checker that fires on everything is a checker nobody leaves switched on.
 *
 * The messages are asserted loosely (a phrase, not the sentence) on purpose.
 * The slug is the contract and the sentence is prose that should be free to
 * improve; a test that pinned the wording would make every rewording a test
 * change, which is how a message stops being improved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkDriver, assertHonest, CHECKS } from "../src/check/index.ts";
import type { Finding } from "../src/check/index.ts";
import { mount } from "../src/core/registry.ts";
import type { Snapshot } from "../src/core/types.ts";
import {
  describeWithoutCount,
  forgetsRev,
  honest,
  impureVisible,
  selectsOffScreen,
  windowWithoutPage,
} from "./dishonest.ts";

/** Every finding of a given check, so a test asserts the one it is about
 *  rather than the order they came out in. */
const of = (findings: readonly Finding[], check: string): Finding[] =>
  findings.filter((f) => f.check === check);

test("an honest app produces no findings, which is what makes the rest worth having", async () => {
  // The control. This app pages, selects, counts, commits and bumps its rev --
  // everything the checks look at -- and the right answer is silence. A
  // checker that could not be quiet here would be a checker an author turns
  // off on the first run, and the lies below would never be seen.
  const report = await checkDriver(honest(), { commits: true });
  assert.deepEqual(report.findings, [], `expected silence, got ${JSON.stringify(report.findings)}`);
  assert.equal(report.ok, true);
});

test("a commit that forgets to bump rev is caught, and the message says what it defeats", async () => {
  // The big one. `rev` is what `stale` and the whole plan token rest on, so an
  // app that forgets to bump it keeps both mechanisms and loses both
  // guarantees -- silently, which is why a checker is the only thing that
  // finds it. Detected differentially: the snapshot changed and `rev` did not.
  const report = await checkDriver(forgetsRev(), { commits: true });
  const found = of(report.findings, "rev-did-not-move");
  assert.equal(found.length, 1, JSON.stringify(report.findings));
  assert.equal(found[0]!.verb, "accept-selected");
  assert.equal(found[0]!.severity, "lie");
  // An author has to be told WHERE to put the fix, and "in the setter, not in
  // each verb" is the fix -- this app bumps correctly in the verb written
  // first and not in the one added later.
  assert.match(found[0]!.message, /stale/);
  assert.match(found[0]!.message, /setter/);
  assert.equal(report.ok, false);
});

test("the rev check does not fire on a correct describe that matched nothing", async () => {
  // The false positive this check was shaped to avoid. "A describe must bump
  // rev" is the obvious rule and it is wrong: a describe that selects nothing
  // changes nothing, and an app that does not bump there is correct. What is
  // never correct is the snapshot moving while `rev` stands still, so that is
  // what is compared -- everything but `rev`, before against after.
  let rev = 7;
  const driver = mount({
    app: "Empty",
    visible: (): Snapshot => ({ where: "contacts", rev, rows: [] }),
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select matching contacts",
        args: { where: { type: "string", describe: "a filter", oneOf: ["company=Nobody"] } },
        run: () => ({ count: 0 }),
      },
    ],
  });
  const report = await checkDriver(driver);
  assert.deepEqual(of(report.findings, "rev-did-not-move"), []);
  assert.equal(rev, 7);
});

test("a window that publishes no page is caught the second time the rows change", async () => {
  // Absence is a claim: the renderer prints "rows 3 (all of them)" on the
  // strength of it. One screen showing two different row sets while claiming
  // completeness for both is the contradiction, and it is the only mechanical
  // handle there is -- see the caveat test below for the version that gets
  // away with it.
  const report = await checkDriver(windowWithoutPage());
  const found = of(report.findings, "window-without-page");
  assert.equal(found.length, 1, JSON.stringify(report.findings));
  assert.equal(found[0]!.severity, "lie");
  // The fix is the third state, and naming it is the point: the author's
  // objection to publishing `page` is that they do not know the total, and
  // `total` is optional exactly for them.
  assert.match(found[0]!.message, /total/);
  assert.match(found[0]!.message, /index, size/);
});

test("selected ids that are not on screen are caught, and the hint is the token budget", async () => {
  // `Snapshot.selected` is documented as on-screen ids only. The author who
  // fills it honestly with all of them has not been sloppy, they have been
  // literal -- so the message has to say why the literal reading is the
  // expensive one, and name `selectedCount` as the place the size goes.
  const report = await checkDriver(selectsOffScreen());
  const found = of(report.findings, "selected-not-on-screen");
  assert.equal(found.length, 1, JSON.stringify(report.findings));
  assert.equal(found[0]!.verb, "select-all");
  assert.match(found[0]!.message, /selectedCount/);
  assert.match(found[0]!.message, /uncached/);
});

test("selected ids with no selectedCount is a warning and not a lie", async () => {
  // The severity split earns its place here. `selected` with no count is a
  // weaker claim than it reads as -- absent means "I do not count" and a model
  // reads three ids as three rows -- but an app whose selection really is only
  // what is on screen is not lying. So: said, and `ok` stays true.
  const driver = mount({
    app: "Uncounted",
    visible: (): Snapshot => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-1" }, { id: "c-2" }],
      selected: ["c-1"],
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await checkDriver(driver);
  const found = of(report.findings, "selected-count-missing");
  assert.equal(found.length > 0, true, JSON.stringify(report.findings));
  assert.equal(found[0]!.severity, "warn");
  assert.equal(report.ok, true, "a warning must not fail a build");
});

test("a selectedCount smaller than selected is a flat contradiction", async () => {
  // `selected` is the on-screen part of the selection, so the total can never
  // be smaller than it. Checked separately from the missing-count warning
  // because this one has no honest reading at all.
  const driver = mount({
    app: "Contradiction",
    visible: (): Snapshot => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-1" }, { id: "c-2" }],
      selected: ["c-1", "c-2"],
      selectedCount: 1,
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await checkDriver(driver);
  assert.equal(of(report.findings, "selected-count-below-selected").length, 1);
  assert.equal(report.ok, false);
});

test("a selectedCount larger than selected is correct and says nothing", async () => {
  // The check the brief asked for in both directions, and the reverse
  // direction is NOT a check: `render.ts` renders a count larger than the id
  // list as "selected 3,412 rows in all; the 3 ids above are only the ones on
  // screen", which is the mechanism working. Pinned so nobody adds it.
  const driver = mount({
    app: "Bulk",
    visible: (): Snapshot => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-1" }, { id: "c-2" }],
      selected: ["c-1"],
      selectedCount: 3412,
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await checkDriver(driver);
  assert.deepEqual(report.findings, []);
});

test("more rows than the page size claims is caught", async () => {
  const driver = mount({
    app: "Overflowing",
    visible: (): Snapshot => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-1" }, { id: "c-2" }, { id: "c-3" }],
      page: { index: 0, size: 2, total: 9 },
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await checkDriver(driver);
  assert.equal(of(report.findings, "rows-exceed-page-size").length, 1);
});

test("a page total smaller than the window already shown is caught", async () => {
  // The renderer computes "rows 1-3 of 2" from these, which tells a model the
  // table ends before the rows it can already see.
  const driver = mount({
    app: "Shrinking",
    visible: (): Snapshot => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-1" }, { id: "c-2" }, { id: "c-3" }],
      page: { index: 0, size: 3, total: 2 },
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await checkDriver(driver);
  assert.equal(of(report.findings, "page-total-below-window").length, 1);
});

test("two rows sharing an id is caught, because an id is what a verb takes", async () => {
  const driver = mount({
    app: "Twins",
    visible: (): Snapshot => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-1", name: "Ada" }, { id: "c-1", name: "Grace" }],
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await checkDriver(driver);
  assert.equal(of(report.findings, "duplicate-row-id").length, 1);
});

test("a visible() that mutates is caught by two reads with nothing in between", async () => {
  // The core reads `visible()` twice per call -- once before the verb and once
  // after -- so whatever changes between them is attributed to the verb, and
  // every differential check in the checker is comparing against a snapshot
  // the act of reading already moved. Which is why this one runs first.
  const report = await checkDriver(impureVisible());
  const found = of(report.findings, "visible-mutates");
  assert.equal(found.length, 1, JSON.stringify(report.findings));
  assert.equal(found[0]!.severity, "lie");
  // The two causes an author actually has, both named, because the fix differs:
  // a timestamp comes out of the snapshot, a counter comes out of `visible()`.
  assert.match(found[0]!.message, /timestamp/);
  assert.match(found[0]!.message, /twice/);
});

test("a visible() over its time budget is a warning, with the number measured", async () => {
  // Documented as "must be cheap: it runs on each verb call", and warned about
  // rather than failed: it is a judgement about an app's own performance
  // budget, and a suite that failed on a slow machine is a suite somebody
  // turns off. The budget is a parameter for the same reason.
  const driver = mount({
    app: "Slow",
    visible: (): Snapshot => {
      // A busy wait rather than a sleep: `visible()` is synchronous, which is
      // itself part of why an expensive one is so costly.
      const until = Date.now() + 2;
      while (Date.now() < until) {
        /* spin */
      }
      return { where: "contacts", rev: 1, rows: [{ id: "c-1" }] };
    },
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await checkDriver(driver, { visibleSamples: 3, visibleBudgetMs: 1 });
  const found = of(report.findings, "visible-expensive");
  assert.equal(found.length, 1, JSON.stringify(report.findings));
  assert.equal(found[0]!.severity, "warn");
  assert.ok(report.visibleUs > 1000, `measured ${report.visibleUs}µs`);
});

test("a describe verb that reports no count is caught, because the pairing turns on it", async () => {
  const report = await checkDriver(describeWithoutCount());
  const found = of(report.findings, "describe-without-count");
  assert.equal(found.length, 1, JSON.stringify(report.findings));
  assert.equal(found[0]!.verb, "select-all");
  // Both ways out are offered. An author who does not want to count has a
  // legitimate answer -- declare it a `read` -- and a message that only said
  // "return a count" would push them into returning a wrong one.
  assert.match(found[0]!.message, /declare this `read`/);
});

test("rev going backwards is caught separately from rev not moving", async () => {
  // Two findings and not one, because the causes differ: a non-bump is a
  // forgotten line and a decrease is usually a hash or a version string where
  // a counter belongs. Both let an old rev pass the `stale` check.
  let rev = 9;
  const driver = mount({
    app: "Backwards",
    visible: (): Snapshot => ({ where: "contacts", rev, rows: [{ id: "c-1" }] }),
    verbs: [
      {
        name: "refresh",
        kind: "read",
        describe: "reload the list",
        run: () => {
          rev = 2;
        },
      },
    ],
  });
  const report = await checkDriver(driver);
  assert.equal(of(report.findings, "rev-went-backwards").length, 1);
  assert.deepEqual(of(report.findings, "rev-did-not-move"), []);
});

test("verbs scoped to a screen in an app with no Snapshot.screen is a finding, not just a console warning", async () => {
  // The core already warns once about this at call time. Repeated here because
  // a `console.warn` in a browser tab is not a thing a test suite fails on,
  // and this one is the `next-page` landing on another company's list that
  // `Verb.screen` exists to stop.
  const driver = mount({
    app: "Unscoped",
    visible: (): Snapshot => ({ where: "contacts", rev: 1, rows: [{ id: "c-1" }] }),
    verbs: [
      { name: "next-page", kind: "read", describe: "page", screen: "contacts", run: () => {} },
    ],
  });
  const report = await checkDriver(driver);
  const found = of(report.findings, "screen-scoped-verbs-without-screen");
  assert.equal(found.length, 1, JSON.stringify(report.findings));
  assert.match(found[0]!.message, /next-page/);
});

test("commits are not called by default, and the report says what that cost", async () => {
  // The default that decides whether anybody runs this twice. An author points
  // it at an app wired to a real backend, and a checker that accepts a
  // thousand contacts on the first run is a checker they delete. So the commit
  // is skipped -- and the skip names the check it cost them, because a silent
  // skip is the checker telling a half-truth about its own coverage.
  const app = forgetsRev();
  const report = await checkDriver(app);
  assert.deepEqual(of(report.findings, "rev-did-not-move"), []);
  const skip = report.skipped.find((s) => s.verb === "accept-selected");
  assert.ok(skip, JSON.stringify(report.skipped));
  assert.match(skip.why, /rev-did-not-move/);
});

test("a verb with a required argument is skipped rather than guessed at", async () => {
  // A guess produces a `bad-argument` refusal that looks like a finding and is
  // not. `select-where` takes `company=Acme` and there is no deriving that
  // from an `ArgSpec`, so the honest move is to say so and let the author pass
  // it -- which the skip reason tells them how to do.
  const driver = mount({
    app: "Predicate",
    visible: (): Snapshot => ({ where: "contacts", rev: 1, rows: [{ id: "c-1" }] }),
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select matching contacts",
        args: { where: { type: "string", describe: "e.g. company=Acme" } },
        run: () => ({ count: 1 }),
      },
    ],
  });
  const report = await checkDriver(driver);
  assert.equal(report.calls, 0);
  assert.match(report.skipped[0]!.why, /options\.args/);

  // And with the argument supplied it is driven.
  const again = await checkDriver(driver, { args: { "select-where": { where: "company=Acme" } } });
  assert.equal(again.calls, 1);
});

test("assertHonest throws on a lie and names the coverage in the same message", async () => {
  // The one-liner an author puts in their own test file, which is the whole
  // reason the checker is a wrapper and not a `mount({ strict: true })`. The
  // coverage rides in the failure because the next thing a person does after
  // reading it is decide whether to trust the rest of the app.
  await assert.rejects(() => assertHonest(forgetsRev(), { commits: true }), (err: Error) => {
    assert.match(err.message, /not telling the truth/);
    assert.match(err.message, /rev-did-not-move/);
    return true;
  });
  // The coverage line, on a run that actually skipped something. It is in the
  // failure rather than only in the report because the next thing a person
  // does after reading a finding is decide whether to trust the rest.
  await assert.rejects(
    () => assertHonest(forgetsRev(), { commits: true, verbs: ["select-all", "accept-selected"] }),
    (err: Error) => {
      assert.match(err.message, /not checked: clear-selection/);
      return true;
    },
  );
  // And it resolves, handing back the report, when the app is honest.
  const report = await assertHonest(honest(), { commits: true });
  assert.equal(report.ok, true);
});

test("a warning alone does not throw, so a performance judgement cannot fail a build", async () => {
  const driver = mount({
    app: "Uncounted",
    visible: (): Snapshot => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-1" }],
      selected: ["c-1"],
    }),
    verbs: [{ name: "noop", kind: "read", describe: "do nothing", run: () => {} }],
  });
  const report = await assertHonest(driver);
  assert.equal(report.ok, true);
  assert.equal(report.findings.length, 1);
});

test("CHECKS names every check the checker can emit, so the list cannot drift", async () => {
  // The exported list is what an author greps and what documentation is
  // written from, so it has to be the same set the code can produce. Asserted
  // by running the lot and confirming nothing came out that is not named.
  const reports = await Promise.all(
    [honest(), forgetsRev(), windowWithoutPage(), selectsOffScreen(), impureVisible(),
      describeWithoutCount()].map((d) => checkDriver(d, { commits: true, visibleSamples: 5 })),
  );
  const emitted = new Set(reports.flatMap((r) => r.findings.map((f) => f.check)));
  for (const check of emitted) {
    assert.ok(CHECKS.includes(check), `\`${check}\` is emitted and not in CHECKS`);
  }
  assert.equal(new Set(CHECKS).size, CHECKS.length, "CHECKS has a duplicate");
});
