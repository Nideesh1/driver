/**
 * A spend ceiling that a page reload does not refill. These tests are the spec.
 *
 * `MountOptions.budget` bounded one mounted driver, and that was one word short
 * of bounding anything: navigation is one of the agent's own verbs, a `goto`
 * that is a full page load tears the driver down, and a fresh mount starts at
 * zero. So an agent that hit a ceiling could refresh past it — while being told,
 * in the `budget-spent` hint, that the ceiling "does not refill, and waiting or
 * retrying will not change it". A hint that lies is worse than no hint.
 *
 * A reload is simulated by mounting again against the same storage, which is
 * exactly what the browser does: the page's JavaScript is gone, `localStorage`
 * is not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../src/core/registry.ts";
import type { Budget, Driver, Result, Snapshot } from "../src/core/types.ts";
import { budgetKey, localBudgetStore } from "../src/browser/index.ts";
import { FakeStorage } from "./fake-dom.ts";

/** The refusal slug, or undefined. A helper because `Result` is a discriminated
 *  union and `out.ok === false && out.refused` inline in thirty assertions
 *  reads as noise rather than as the thing being asserted. */
function refusalOf(result: Result): string | undefined {
  return result.ok === false ? result.refused : undefined;
}

/** The refusal hint, as a string. The hints here are the whole user-facing
 *  half of a ceiling that cannot be kept, so they are asserted and not
 *  skipped. */
function hintOf(result: Result): string {
  return result.ok === false ? (result.hint ?? "") : "";
}

function app(budget: Budget): Driver {
  let rev = 1;
  const visible = (): Snapshot => ({ where: "contacts", rev, rows: [], selectedCount: 1 });
  return mount({
    app: "Contacts",
    visible,
    budget,
    verbs: [
      { name: "look", kind: "read", describe: "look at it", run: () => {} },
      {
        name: "accept",
        kind: "commit",
        describe: "accept the selection",
        run: () => {
          rev++;
        },
      },
    ],
  });
}

/** One page load: a driver over storage that outlives it. */
function load(storage: FakeStorage, budget: Omit<Budget, "store"> = { calls: 3 }): Driver {
  return app({ ...budget, store: localBudgetStore({ app: "Contacts", storage }) });
}

test("a reload does not refill the ceiling, because an agent can cause a reload", async () => {
  // THE TEST THIS EXISTS FOR. `goto` is a `read` verb an agent calls freely,
  // and one that is a full page load used to be a budget-doubling move. A
  // ceiling that resets is not a ceiling.
  const storage = new FakeStorage();
  const first = load(storage);
  assert.equal((await first.call("look")).ok, true);
  assert.equal((await first.call("look")).ok, true);
  assert.equal(first.budget!().calls.used, 2);

  // The reload.
  const second = load(storage);
  assert.equal(second.budget!().calls.used, 2, "the counter went back to zero");
  assert.equal((await second.call("look")).ok, true, "the third of three");
  const spent = await second.call("look");
  assert.equal(spent.ok, false);
  assert.equal(refusalOf(spent), "budget-spent");
  assert.match(hintOf(spent), /does not refill/);

  // And refreshing again does not help, which is the sentence the hint makes.
  const third = load(storage);
  assert.equal(refusalOf(await third.call("look")), "budget-spent");
});

test("the commit ceiling persists on its own, because the two bound different costs", async () => {
  // A thousand reads costs tokens and a thousand commits costs DATA, which is
  // why there are two counters and not one stricter one. Both have to survive a
  // reload or the cheaper bound is the only real one.
  const storage = new FakeStorage();
  const first = load(storage, { commits: 1 });
  assert.equal((await first.call("accept")).ok, true);

  const second = load(storage, { commits: 1 });
  const spent = await second.call("accept");
  assert.equal(refusalOf(spent), "budget-spent");
  assert.match(hintOf(spent), /all 1 have run/);
  // Reads still work: it is commits that are spent, and the hint says so.
  assert.equal((await second.call("look")).ok, true);
});

test("the allowance is per app per origin, so two tabs share one ceiling", async () => {
  // Scoped deliberately UNLIKE the widget's transcript, which is per tab. If
  // the ceiling were per tab then "open a second tab" would be a
  // budget-doubling move -- the reload bypass in a different hat. Two tabs
  // sharing one allowance means one can exhaust the other's, and that is one
  // ceiling behaving like one ceiling, exactly as a server-side counter would.
  const storage = new FakeStorage();
  //
  // Both tabs are mounted BEFORE either spends anything, which is the shape
  // that caught this: a mount-time read alone gave each of them the whole
  // allowance, so two concurrent tabs were two ceilings. The store is re-read
  // before every charge for exactly this case.
  const tabA = load(storage, { calls: 2 });
  const tabB = load(storage, { calls: 2 });
  assert.equal((await tabA.call("look")).ok, true);
  assert.equal((await tabA.call("look")).ok, true);
  // B has not spent anything itself. It is still out, because the allowance was
  // never B's -- a point worth pinning rather than discovering.
  const refused = await tabB.call("look");
  assert.equal(refusalOf(refused), "budget-spent");
  // And B's own view of the counter is the shared one, not its own history.
  assert.equal(tabB.budget!().calls.used, 2);
});

test("two apps on one origin do not share an allowance", async () => {
  // One app's runaway must not be another app's outage, which is what a single
  // unnamespaced key would have made it.
  const storage = new FakeStorage();
  const contacts = app({ calls: 1, store: localBudgetStore({ app: "Contacts", storage }) });
  const admin = mount({
    app: "Admin",
    visible: () => ({ where: "admin", rev: 1, rows: [] }),
    budget: { calls: 1, store: localBudgetStore({ app: "Admin", storage }) },
    verbs: [{ name: "look", kind: "read", describe: "d", run: () => {} }],
  });
  assert.equal((await contacts.call("look")).ok, true);
  assert.equal(refusalOf(await contacts.call("look")), "budget-spent");
  assert.equal((await admin.call("look")).ok, true, "Contacts spent Admin's allowance");
});

// -------------------------------------------------------------------------
// Failing closed, which is the opposite of every other piece of persistence in
// the library.
// -------------------------------------------------------------------------

test("a storage that cannot be read refuses every call rather than assuming a fresh allowance", async () => {
  // The asymmetry, stated as a test. The widget's transcript swallows every
  // storage failure because the worst case is a lost conversation. Here the
  // worst case is an uncapped agent -- a private window would have been a free
  // budget -- so the safe direction is the default one.
  const storage = new FakeStorage();
  storage.throwOnRead = true;
  const driver = load(storage);
  const refused = await driver.call("look");
  assert.equal(refusalOf(refused), "budget-spent");
  assert.match(hintOf(refused), /could not be read/);
  // And it says the app itself is fine, because it is: only the agent stops.
  assert.match(hintOf(refused), /still works normally for the person at the keyboard/);
});

test("a storage that cannot be written stops the agent from that point on", async () => {
  // A swallowed write failure is an allowance that quietly stops being kept,
  // which is the uncapped agent again with one extra reload in front of it.
  // The first call is NOT failed -- the verb ran and the data moved, and
  // failing the `Result` now would tell an agent nothing happened when
  // something did. What a failed write changes is the future.
  const storage = new FakeStorage();
  const driver = load(storage, { calls: 10 });
  storage.throwOnWrite = true;
  const first = await driver.call("look");
  assert.equal(first.ok, true, "the call that already happened was failed retroactively");
  const second = await driver.call("look");
  assert.equal(refusalOf(second), "budget-spent");
  assert.match(hintOf(second), /could not be written down/);
});

test("a corrupt stored record fails closed, because it cannot be told from tampering", async () => {
  // Of the two ways to guess at a garbled record, exactly one has a bill
  // attached. Tampering is explicitly out of scope -- the person owns the
  // machine -- but guessing in the agent's favour is not the way to say so.
  const storage = new FakeStorage();
  storage.items.set(budgetKey("Contacts"), "{not json");
  assert.equal(refusalOf(await load(storage).call("look")), "budget-spent");

  storage.items.set(budgetKey("Contacts"), JSON.stringify({ calls: "lots", commits: 0, since: 1 }));
  assert.equal(refusalOf(await load(storage).call("look")), "budget-spent");
});

test("a store with no ceiling declared enforces nothing, broken storage or not", async () => {
  // An app that passes a `store` and no `calls` or `commits` has asked for
  // nothing to be enforced, and refusing its calls because its storage is
  // blocked would be a ceiling invented out of a field that set none.
  const storage = new FakeStorage();
  storage.throwOnRead = true;
  const driver = app({ store: localBudgetStore({ app: "Contacts", storage }) });
  assert.equal((await driver.call("look")).ok, true);
  assert.equal((await driver.call("look")).ok, true);
  // The counter is still reported, which is what `Driver.budget` is for.
  assert.equal(driver.budget!().calls.used, 2);
  assert.equal(driver.budget!().calls.limit, undefined);
});

test("an app with no store behaves exactly as it did before persistence existed", async () => {
  // The backward-compatibility assertion. Absent means in-memory counters and a
  // reload that starts over, which is still right for an app with no storage to
  // reach for.
  const first = app({ calls: 1 });
  assert.equal((await first.call("look")).ok, true);
  assert.equal(refusalOf(await first.call("look")), "budget-spent");
  const second = app({ calls: 1 });
  assert.equal((await second.call("look")).ok, true, "an in-memory ceiling should reset");
});

// -------------------------------------------------------------------------
// What resets it. A budget that is permanently spent makes the app permanently
// undrivable, which nobody reads as a working cost control.
// -------------------------------------------------------------------------

test("changing the epoch starts a fresh allowance, and the agent has no verb for it", async () => {
  // The deliberate host-held reset: a string the app chooses, which lives in
  // the page's own source. A deploy bumps it, a billing period can be its name,
  // a support tool writes a new one into the page it serves.
  const storage = new FakeStorage();
  assert.equal((await load(storage, { calls: 1, epoch: "2026-11" }).call("look")).ok, true);
  assert.equal(
    refusalOf(await load(storage, { calls: 1, epoch: "2026-11" }).call("look")),
    "budget-spent",
  );
  assert.equal(
    (await load(storage, { calls: 1, epoch: "2026-12" }).call("look")).ok,
    true,
    "a new epoch did not start a new allowance",
  );
  // And the old epoch does not come back from the record the new one wrote.
  assert.equal(refusalOf(await load(storage, { calls: 1, epoch: "2026-12" }).call("look")), "budget-spent");
});

test("a window renews the allowance, and a record inside it does not", async () => {
  // Not the rolling RATE limit this type rejects: a runaway still stops dead at
  // `calls` and stays stopped for the rest of the window. What the window buys
  // is that tomorrow the app works again without anybody deploying anything.
  const storage = new FakeStorage();
  assert.equal((await load(storage, { calls: 1, window: 60_000 }).call("look")).ok, true);
  assert.equal(
    refusalOf(await load(storage, { calls: 1, window: 60_000 }).call("look")),
    "budget-spent",
    "a window must not forgive a spend inside it",
  );

  // The allowance is dated, so backdating the record is the same thing as the
  // clock advancing past the window.
  const record = JSON.parse(storage.items.get(budgetKey("Contacts"))!);
  storage.items.set(
    budgetKey("Contacts"),
    JSON.stringify({ ...record, since: record.since - 61_000 }),
  );
  assert.equal((await load(storage, { calls: 1, window: 60_000 }).call("look")).ok, true);
});

test("forget() is the host-side reset, and it is a method on an object the host holds", async () => {
  // An agent drives through verbs and has no verb for this, which is the test
  // every reset mechanism here has to pass.
  const storage = new FakeStorage();
  const store = localBudgetStore({ app: "Contacts", storage });
  const budget: Budget = { calls: 1, store };
  assert.equal((await app(budget).call("look")).ok, true);
  assert.equal(refusalOf(await app(budget).call("look")), "budget-spent");
  store.forget();
  assert.equal((await app(budget).call("look")).ok, true);
});

test("the stored record carries counts and dates and nothing about what was done", async () => {
  // A spend record that carried a verb name, an argument or a count would be a
  // transcript in `localStorage` under a field nobody reads as one. "This app
  // has made 41 calls" is a different privacy class from what those calls were
  // about.
  const storage = new FakeStorage();
  const driver = load(storage, { calls: 5 });
  await driver.call("look", { q: "the person's own words" });
  await driver.call("accept");
  const record = JSON.parse(storage.items.get(budgetKey("Contacts"))!);
  // `asks` joined the three when questions became countable, and it is the same
  // privacy class as the two counters beside it: how MANY questions, never what
  // any of them was, and never a word of what was answered.
  assert.deepEqual(Object.keys(record).sort(), ["asks", "calls", "commits", "since"]);
  assert.equal(record.asks, 0);
  assert.equal(record.calls, 2);
  assert.equal(record.commits, 1);
  assert.doesNotMatch(storage.items.get(budgetKey("Contacts"))!, /own words|accept|look/);
});

test("a refused call is charged and persisted, because a loop on bad-argument is the runaway", async () => {
  // `Budget` counts refused calls on purpose: an agent spinning on
  // `bad-argument` is precisely what this exists for, and a counter that only
  // counted successes would watch it spin. Across a reload too, or the spin
  // just needs a refresh in the middle of it.
  const storage = new FakeStorage();
  const first = load(storage, { calls: 2 });
  assert.equal((await first.call("no-such-verb")).ok, false);
  const second = load(storage, { calls: 2 });
  assert.equal(second.budget!().calls.used, 1, "a refusal was not charged across the reload");
});
