/**
 * The cost ceiling.
 *
 * `maxSteps` bounds one run; this bounds the mount. The three things worth
 * pinning are the ones a cost control gets wrong: that it is OFF unless
 * declared, that a run under it is untouched, and that when it does stop it
 * SAYS SO — the approval gate waits forever by default because "a deadline
 * that denies while somebody is reading teaches them the dialog is a race",
 * and a ceiling has the same hazard in reverse.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount, RESERVED_REFUSALS } from "../src/core/registry.ts";
import type { Driver, Scalar, Snapshot } from "../src/core/types.ts";
import { drive } from "../src/agent/loop.ts";
import { scripted, call as toolCall } from "./app.ts";

/** A toy with a read, a describe and a commit, and a counter per verb so a
 *  test can tell "refused" from "refused after running". */
function toy(budget?: { calls?: number; commits?: number }): {
  driver: Driver;
  ran: () => Record<string, number>;
} {
  let rev = 1;
  const ran: Record<string, number> = { look: 0, "select-all": 0, "accept-selected": 0 };
  const driver = mount({
    app: "Toy",
    visible: (): Snapshot => ({ where: "contacts", rev, rows: [{ id: "c-1" }] }),
    ...(budget ? { budget } : {}),
    verbs: [
      { name: "look", kind: "read", describe: "look", run: () => void ran["look"]!++ },
      {
        name: "select-all",
        kind: "describe",
        describe: "select everything",
        run: () => {
          ran["select-all"]!++;
          rev++;
          return { count: 1 };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the selection",
        run: () => {
          ran["accept-selected"]!++;
          rev++;
          return { count: 1 };
        },
      },
    ],
  });
  return { driver, ran: () => ({ ...ran }) };
}

test("budget-spent is a reserved slug, so no app can mean something else by it", () => {
  // Reserved for the usual reason: it says where a call stopped and not what
  // an app's rules are. It is also the only slug on the list whose honest
  // repair is "do not try again", so an app that used it for a business rule
  // would be telling an agent to give up forever over something rephrasable.
  assert.ok(RESERVED_REFUSALS.includes("budget-spent"));
  assert.throws(
    () =>
      mount({
        app: "Rude",
        visible: () => ({ where: "x", rev: 1 }),
        verbs: [
          {
            name: "spend",
            describe: "spend",
            refuses: ["budget-spent"],
            run: () => {},
          },
        ],
      }),
    /reserved refusal `budget-spent`/,
  );
});

test("no budget means no ceiling, and an app mounted without one is untouched", async () => {
  // The rule the whole feature is subject to: additive and optional. Two
  // hundred calls, every one answered, and the driver still reports what it
  // spent -- because a counter with no limit is the number somebody debugging
  // a chatty agent actually wants.
  const { driver } = toy();
  for (let i = 0; i < 200; i++) {
    const out = await driver.call("look");
    assert.equal(out.ok, true);
  }
  assert.deepEqual(driver.budget!(), {
    calls: { used: 200 },
    commits: { used: 0 },
    // Reported although this app cannot ask at all, by the rule the two above
    // follow: a panel renders one shape whatever the app declared.
    asks: { used: 0 },
  });
});

test("a run under the limit is not affected by the limit existing", async () => {
  // A ceiling that changed the behaviour of calls below it would be a ceiling
  // nobody could set safely. Three calls under a budget of ten behave exactly
  // as three calls under no budget at all.
  const { driver, ran } = toy({ calls: 10, commits: 5 });
  assert.equal((await driver.call("look")).ok, true);
  assert.equal((await driver.call("select-all")).ok, true);
  assert.equal((await driver.call("accept-selected")).ok, true);
  assert.deepEqual(ran(), { look: 1, "select-all": 1, "accept-selected": 1 });
  assert.deepEqual(driver.budget!(), {
    calls: { used: 3, limit: 10 },
    commits: { used: 1, limit: 5 },
    asks: { used: 0 },
  });
});

test("the call ceiling refuses budget-spent and the verb does not run", async () => {
  const { driver, ran } = toy({ calls: 2 });
  assert.equal((await driver.call("look")).ok, true);
  assert.equal((await driver.call("look")).ok, true);
  const out = await driver.call("look");
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.refused, "budget-spent");
  assert.equal(ran()["look"], 2, "the third call must not have reached the verb");
  // The hint has to be honest about WHY it stopped, which means saying the one
  // thing an agent would otherwise get wrong: this is not a rate limit, so
  // waiting does not help. A hint that only said "limit reached" invites a
  // retry loop against the budget that has just run out.
  assert.match(String(out.ok === false && out.hint), /does not refill|not refill/);
  assert.match(String(out.ok === false && out.hint), /2/);
});

test("a refused call is charged for, because a model round trip was spent on it", async () => {
  // The decision this test exists to pin. An agent looping on `bad-argument`
  // is precisely the runaway a ceiling is for -- it costs tokens on every
  // turn and reaches no verb -- so a counter that only counted successful
  // calls would watch it spin forever. `unknown-verb` counts for the same
  // reason.
  const { driver } = toy({ calls: 3 });
  assert.equal((await driver.call("nonesuch")).ok, false);
  assert.equal((await driver.call("nonesuch")).ok, false);
  assert.equal((await driver.call("nonesuch")).ok, false);
  const out = await driver.call("look");
  assert.equal(out.ok === false && out.refused, "budget-spent");
});

test("the budget is checked before the verb lookup, because it is the wider fact", async () => {
  // Ordering, and it is the same argument `wrong-screen` sits above `stale`
  // for, taken one step further out. Every other check says "this call is
  // wrong, here is the repair"; this one says "nothing will work again".
  // Answering `unknown-verb` past the ceiling would send an agent hunting for
  // a verb name that was never the problem.
  const { driver } = toy({ calls: 1 });
  assert.equal((await driver.call("look")).ok, true);
  const out = await driver.call("nonesuch");
  assert.equal(out.ok === false && out.refused, "budget-spent");
});

test("the commit ceiling stops commits and leaves reads and describes working", async () => {
  // Two counters rather than one stricter counter, because they bound
  // different costs: a thousand reads costs tokens and a thousand commits
  // costs DATA. An app may allow the first and not the second, and one number
  // cannot say that -- so the hint says which one is spent and that the others
  // still work.
  const { driver, ran } = toy({ commits: 1 });
  assert.equal((await driver.call("accept-selected")).ok, true);
  const out = await driver.call("accept-selected");
  assert.equal(out.ok === false && out.refused, "budget-spent");
  assert.match(String(out.ok === false && out.hint), /no data\s+moved/);
  assert.match(String(out.ok === false && out.hint), /Reads and describes may still work/);
  assert.equal(ran()["accept-selected"], 1);
  // And the cheap kinds are untouched.
  assert.equal((await driver.call("look")).ok, true);
  assert.equal((await driver.call("select-all")).ok, true);
});

test("nobody is asked to approve a commit the ceiling was already going to refuse", async () => {
  // The approval gate's own rule, reused: asking a person about a call that
  // was never going to happen is how they learn to click Yes without reading.
  // So the commit ceiling is checked one line ABOVE the gate.
  const asked: string[] = [];
  let rev = 1;
  const driver = mount({
    app: "Gated",
    visible: (): Snapshot => ({ where: "x", rev }),
    budget: { commits: 1 },
    approve: (req) => {
      asked.push(req.name);
      return true;
    },
    verbs: [
      {
        name: "wipe",
        kind: "commit",
        describe: "wipe it",
        run: () => {
          rev++;
        },
      },
    ],
  });
  assert.equal((await driver.call("wipe")).ok, true);
  const out = await driver.call("wipe");
  assert.equal(out.ok === false && out.refused, "budget-spent");
  assert.deepEqual(asked, ["wipe"], "the second commit must not have reached the gate");
});

test("a call refused while an approval is open is not charged for", async () => {
  // The other end of the same argument. A call refused `approval-pending`
  // reached nothing, so charging for it would let an agent polling at a
  // dialog eat a whole ceiling without a verb running -- and the ceiling is
  // for spend, not for impatience.
  let release: (() => void) | undefined;
  let rev = 1;
  const driver = mount({
    app: "Holding",
    visible: (): Snapshot => ({ where: "x", rev }),
    budget: { calls: 2 },
    verbs: [{ name: "look", kind: "read", describe: "look", run: () => {} }],
  });
  const held = driver.approval!.hold(
    "something",
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const blocked = await driver.call("look");
  assert.equal(blocked.ok === false && blocked.refused, "approval-pending");
  assert.deepEqual(driver.budget!().calls, { used: 0, limit: 2 });
  release!();
  await held;
  // And the ceiling is still whole afterwards.
  assert.equal((await driver.call("look")).ok, true);
  assert.equal((await driver.call("look")).ok, true);
  assert.equal((await driver.call("look")).ok === false, true);
});

test("a budget of zero is refused at mount, not discovered as a refusal", async () => {
  // Validated where a typo costs one stack trace at startup. A budget of 0
  // means the app is never drivable, which nobody means, and discovering it as
  // `budget-spent` on the very first call reads as a runaway rather than as
  // the typo it is.
  assert.throws(
    () =>
      mount({
        app: "Walled",
        visible: () => ({ where: "x", rev: 1 }),
        budget: { calls: 0 },
        verbs: [{ name: "look", describe: "look", run: () => {} }],
      }),
    /`budget.calls` is 0/,
  );
  assert.throws(
    () =>
      mount({
        app: "Walled",
        visible: () => ({ where: "x", rev: 1 }),
        budget: { commits: 1.5 },
        verbs: [{ name: "look", describe: "look", run: () => {} }],
      }),
    /`budget.commits` is 1.5/,
  );
});

test("the manifest and its fingerprint do not move for a budget", () => {
  // The rule everything in this file is subject to. A spend limit is a runtime
  // arrangement, not part of the surface an agent caches, so two drivers that
  // differ only in their ceiling must publish the identical manifest -- or
  // every adopter's cached prompt prefix would bust when somebody tightened a
  // budget.
  const verbs = [{ name: "look", kind: "read" as const, describe: "look", run: () => {} }];
  const visible = (): Snapshot => ({ where: "x", rev: 1 });
  const bare = mount({ app: "Same", visible, verbs });
  const capped = mount({ app: "Same", visible, verbs, budget: { calls: 5, commits: 1 } });
  assert.deepEqual(capped.manifest(), bare.manifest());
  assert.equal(capped.manifest().version, bare.manifest().version);
});

test("drive stops with over-budget on the first budget-spent instead of grinding to stuck", async () => {
  // The hazard the brief names, in reverse: a limit that silently stops
  // mid-job is worse than one that says so. Through `refusalLimit` this would
  // have reported `stuck` -- "the same call kept being refused" -- which reads
  // as a confused model and sends somebody to rewrite a prompt for an app that
  // has simply run out of allowance. And it would have spent two more model
  // round trips proving it, against the budget that just ran out.
  const { driver } = toy({ calls: 1 });
  const { think, seen } = scripted([
    { calls: [toolCall("look")] },
    { calls: [toolCall("look")] },
  ]);
  const out = await drive(driver, { think, task: "look twice" });
  assert.equal(out.stop, "over-budget");
  // Two model turns and not four: the second call was refused and the loop
  // stopped there rather than retrying to the refusal limit.
  assert.equal(seen.length, 2);
  assert.equal(out.steps, 2);
  // The transcript says why, for a caller who resumes this conversation later.
  const last = out.messages[out.messages.length - 1]!;
  assert.match(String(last.text), /spend ceiling/);
  assert.match(String(last.text), /does not refill/);
});

test("drive is unaffected when the budget is not reached", async () => {
  const { driver } = toy({ calls: 10 });
  const { think } = scripted([{ calls: [toolCall("look")] }, { text: "done" }]);
  const out = await drive(driver, { think, task: "look once" });
  assert.equal(out.stop, "answered");
  assert.equal(out.text, "done");
});

test("Driver.budget is read-only: a UI cannot raise its own ceiling through it", async () => {
  // The reason this is a getter returning a fresh object rather than the
  // driver's own state. A viewer's comfort belongs in the widget's settings;
  // a spend limit belongs to whoever mounted the app, and a settings view that
  // could write here would be a viewer raising their own ceiling.
  const { driver } = toy({ calls: 3 });
  const first = driver.budget!();
  first.calls.used = 0;
  (first.calls as { limit?: number }).limit = 9999;
  await driver.call("look");
  assert.deepEqual(driver.budget!().calls, { used: 1, limit: 3 });
});

test("an unmounted driver answers unmounted and is not charged", async () => {
  // `unmounted` is checked first and stays first. A driver that is gone has no
  // budget question to answer, and charging a call against a dead driver would
  // make the counters depend on how long after unmount somebody kept calling.
  const { driver } = toy({ calls: 5 });
  driver.unmount();
  const out = await driver.call("look" as string, {} as Record<string, Scalar>);
  assert.equal(out.ok === false && out.refused, "unmounted");
  assert.deepEqual(driver.budget!().calls, { used: 0, limit: 5 });
});
