/**
 * Two tabs of one app over one backend.
 *
 * THE DEFECT THIS FILE IS THE RECORD OF. `Snapshot.rev` is the app's claim
 * that its data has not moved, and it is bumped by the app's own mutation
 * path. So: two tabs, same person, same backend. An agent commits in tab A.
 * Tab B is now showing data that has changed and **B's `rev` has not moved**,
 * because B's store never heard — B's app did nothing. Three guarantees fail
 * at once and all three fail SILENTLY:
 *
 *   - B's snapshot reports stale rows as current;
 *   - a `stale` check against B's `rev` passes, because the number is
 *     unchanged;
 *   - a plan token minted in B still verifies — same `rev`, and `selectionId`
 *     is computed from B's own stale selection.
 *
 * That is the staleness machinery passing in exactly the situation it exists
 * to catch, which is worse than having none.
 *
 * The fixture below is the honest shape of the problem and not a convenience:
 * each tab has its OWN store with its OWN `rev`, and a commit writes to the
 * shared backend and bumps only the committing tab's `rev`. Nothing in tab B
 * can see the change — not `rev`, not `selectionId`, not a hash of B's rows,
 * because all three are computed from the copy that is wrong. That is the
 * argument for why the fact has to arrive from outside, and the first test in
 * here pins the defect itself so that nobody mistakes the fix for something
 * the core could have worked out on its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount, selectionId } from "../src/core/registry.ts";
import { broadcastElsewhere } from "../src/browser/elsewhere.ts";
import type {
  Driver,
  ElsewhereChannel,
  ElsewhereNotice,
  Snapshot,
  VerbContext,
} from "../src/core/types.ts";
import type { BroadcastChannelLike } from "../src/browser/elsewhere.ts";

/** The shared truth both tabs read from and write to: the app's backend. */
interface Backend {
  accepted: Set<string>;
}

interface Tab {
  driver: Driver;
  /** The tab's own `rev`, which only this tab's own actions move. */
  rev: () => number;
  /** Something a person did in this tab that is not a data change — a filter.
   *  Moves this tab's `rev` without refetching anything, which is the case
   *  `MountOptions.elsewhere` documents as the known weakness of its clear. */
  filter: () => void;
  /** This tab refetching from the backend, which is what an app that listens
   *  on the channel itself would do. Moves the rev AND fixes the data. */
  refresh: () => void;
}

/**
 * One tab: its own cached copy of the backend, its own `rev`.
 *
 * `visible()` reads the CACHE and never the backend, which is the whole point.
 * A fixture whose `visible()` read the shared backend would have no stale tab
 * in it and would pass every assertion in this file for the wrong reason.
 */
function tab(backend: Backend, elsewhere?: ElsewhereChannel): Tab {
  const ids = ["c-1", "c-2", "c-3"];
  let cache = new Set(backend.accepted);
  let rev = 1;
  let where = "contacts";
  let selected: string[] = [];

  const visible = (): Snapshot => ({
    where,
    screen: "contacts",
    rev,
    rows: ids.map((id) => ({ id, status: cache.has(id) ? "accepted" : "new" })),
    selected: [...selected],
    selectedCount: selected.length,
    selectionId: selectionId(selected),
  });

  const driver = mount({
    app: "Contacts",
    visible,
    ...(elsewhere === undefined ? {} : { elsewhere }),
    verbs: [
      {
        name: "select-new",
        kind: "describe",
        describe: "select every contact that is not accepted yet",
        run: () => {
          selected = ids.filter((id) => !cache.has(id));
          rev++;
          return { count: selected.length };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        consumes: "plan",
        describe: "accept every selected contact",
        run: () => {
          for (const id of selected) {
            backend.accepted.add(id);
            cache.add(id);
          }
          rev++;
        },
      },
      {
        // Takes an argument so that `mount()`'s "a bare commit beside a
        // plan-consuming one makes the check advisory" warning does not fire
        // across this whole file. The warning is right; this verb is not the
        // place to argue with it.
        name: "decline-selected",
        kind: "commit",
        describe: "decline every selected contact",
        args: { reason: { type: "string", describe: "why" } },
        refuses: ["nothing-selected"],
        run: (_args: { reason: string }, ctx: VerbContext) => {
          // Always refuses, so the "an app saying no announces nothing" case
          // has a verb to be refused by.
          return ctx.refuse("nothing-selected", "nothing is selected");
        },
      },
      {
        name: "read-rows",
        kind: "read",
        describe: "read the contacts on screen",
        run: () => {},
      },
      {
        // `filter()` as a verb. A read that moves this tab's `rev` without
        // refetching anything is what clears the notice, and it is also what
        // a plan is now carried across -- so this file needs it as a CALL and
        // not only as a helper, to pin that the two do not combine.
        name: "goto",
        kind: "read",
        describe: "go to another screen of this app",
        run: () => {
          where = where === "contacts" ? "settings" : "contacts";
          rev++;
        },
      },
    ],
  });

  return {
    driver,
    rev: () => rev,
    filter: () => {
      where = "contacts, filtered";
      rev++;
    },
    refresh: () => {
      cache = new Set(backend.accepted);
      rev++;
    },
  };
}

/**
 * An in-process `ElsewhereChannel`, shared by every driver that takes it.
 *
 * Deliberately NOT `broadcastElsewhere` for most of this file: the core's
 * behaviour is what is being pinned, and a test that went through a
 * `BroadcastChannel` fake as well would be testing two things and failing at
 * one. `broadcastElsewhere` gets its own test at the bottom.
 *
 * It echoes to the sender, which the real `BroadcastChannel` does not. That is
 * on purpose — a channel written over a websocket DOES echo, and the core must
 * ignore its own notices rather than rely on the transport to.
 */
function wire(): ElsewhereChannel & { sent: ElsewhereNotice[] } {
  const listeners: Array<(n: ElsewhereNotice) => void> = [];
  const sent: ElsewhereNotice[] = [];
  return {
    sent,
    post(notice) {
      sent.push(notice);
      for (const heard of [...listeners]) heard(notice);
    },
    listen(heard) {
      listeners.push(heard);
      return () => {
        const at = listeners.indexOf(heard);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
}

/** Count, then accept, which is the only legal order for a `consumes: "plan"`
 *  commit. Returns the plan token so a test can hold it across an event. */
async function counted(t: Tab): Promise<string> {
  const described = await t.driver.call("select-new");
  assert.equal(described.ok, true);
  assert.ok(described.ok && described.plan, "the describe should have minted a plan");
  return described.ok ? described.plan! : "";
}

test("with no channel, a commit in one tab leaves the other's stale rows passing every check", async () => {
  // THE DEFECT, PINNED. This is not a test of a feature, it is the record of
  // what the library does when an app opts into nothing — which it must go on
  // doing byte for byte, because an app that shares no backend across tabs, or
  // that already invalidates so that `rev` moves on its own, must pay nothing
  // for a hazard it has not got.
  //
  // Every assertion below is the machinery saying yes in the one situation it
  // exists to say no in. If a later change makes any of them fail, the change
  // is not additive and this file is where to argue about it.
  const backend: Backend = { accepted: new Set() };
  const a = tab(backend);
  const b = tab(backend);

  const plan = await counted(b);
  const bRev = b.rev();

  await counted(a);
  const landed = await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  assert.equal(landed.ok, true);
  assert.deepEqual([...backend.accepted].sort(), ["c-1", "c-2", "c-3"]);

  // 1. B reports stale rows as current.
  const seen = b.driver.snapshot();
  assert.deepEqual(
    seen.rows?.map((r) => r.status),
    ["new", "new", "new"],
    "B is still showing `new` for three rows the backend has accepted",
  );
  assert.equal(seen.rev, bRev, "and B's rev has not moved, because B's app did nothing");
  assert.equal(seen.note, undefined, "and nothing says so");

  // 2. The `stale` check passes, because the number is unchanged.
  const read = await b.driver.call("read-rows", {}, { rev: bRev, screen: "contacts" });
  assert.equal(read.ok, true, "`stale` passes against a rev that is unchanged and wrong");

  // 3. The plan token still verifies, and the commit runs a second time.
  const again = await b.driver.call("accept-selected", {}, { plan, rev: bRev });
  assert.equal(again.ok, true, "the plan token minted before the other tab committed still buys a commit");
});

test("a commit in another tab refuses this tab's commit as `changed-elsewhere`", async () => {
  // THE FIX, and the whole of what it claims. B's data is still wrong — only
  // the app refetching fixes that — but B has stopped saying otherwise, and the
  // one call whose cost is not paid back by reading again is refused.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  const plan = await counted(b);
  const bRev = b.rev();

  await a.driver.call("accept-selected", {}, { plan: await counted(a) });

  const refused = await b.driver.call("accept-selected", {}, { plan, rev: bRev });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.refused, "changed-elsewhere");
  assert.match(
    (refused.ok === false && refused.hint) || "",
    /another tab of this app committed `accept-selected`/,
    "the refusal names the verb, because `something changed somewhere` is not actionable",
  );
  assert.match(
    (refused.ok === false && refused.hint) || "",
    /Reading this screen again will NOT fix that/,
    "and it says the one thing an agent told `stale` would get wrong",
  );
  assert.deepEqual(
    [...backend.accepted].sort(),
    ["c-1", "c-2", "c-3"],
    "and nothing moved a second time",
  );
});

test("`changed-elsewhere` is answered before `stale` and before `stale-plan`", async () => {
  // The ladder is widest first, and this is the widest staleness there is: the
  // repair for `stale` and for `stale-plan` is to read this tab again, which is
  // exactly the repair that does not work here. An agent handed the narrower
  // slug reads again, gets the same rev, believes itself current and commits —
  // the silent failure, re-created by answering the cheaper refusal first.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  await counted(b);
  await a.driver.call("accept-selected", {}, { plan: await counted(a) });

  // A call that is wrong in all three ways at once: no plan at all (which is
  // `stale-plan`), and a rev from the future (which is `stale`).
  const refused = await b.driver.call("accept-selected", {}, { rev: 999 });
  assert.equal(refused.ok === false && refused.refused, "changed-elsewhere");
});

test("a read and a describe still answer in a tab another tab changed, and say so in words", async () => {
  // NOT refused, and this is the one real judgement in the check. A read in a
  // tab that is behind still returns the rows the person is actually looking
  // at. Refusing it would make a tab whose app does not refetch undrivable —
  // and it would do it by sending an agent round a loop: refused, read again,
  // same rev, refused. So the read answers and the snapshot tells the truth
  // about itself instead.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  await a.driver.call("accept-selected", {}, { plan: await counted(a) });

  const read = await b.driver.call("read-rows", {}, { rev: b.rev() });
  assert.equal(read.ok, true);
  assert.match(
    read.snapshot.note ?? "",
    /another tab of this app committed `accept-selected`/,
    "the snapshot a read returns carries the warning",
  );
  assert.match(read.snapshot.note ?? "", /may be out of date even though the rev has not moved/);

  const described = await b.driver.call("select-new");
  assert.equal(described.ok, true, "a describe answers too — a count is not a change");
});

test("every snapshot this driver hands back carries the warning, not only a Result's", async () => {
  // `driver.snapshot()` is what `connect()` pushes to the relay and what an
  // approval dialog is handed. A warning that reached the `Result` and not
  // those would be a guarantee that holds on one path, which is the defect
  // `MountOptions.approve` was moved into the core to fix.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  assert.equal(b.driver.snapshot().note, undefined);
  await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  assert.match(b.driver.snapshot().note ?? "", /another tab of this app committed/);
});

test("the tab that committed is not refused by its own notice", async () => {
  // A channel over a websocket fans a notice back out to the sender, so the
  // core checks `from` rather than trusting the transport not to echo. `wire`
  // echoes on purpose. Without this a two-step job would refuse its own second
  // half.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);

  await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  assert.equal(bus.sent.length, 1, "the commit was announced");

  const second = await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  assert.equal(second.ok, true, "and the tab that announced it is not refused by it");
});

test("the notice clears when this app's own rev moves", async () => {
  // `rev` is the only statement the core is entitled to believe about this
  // app's data, and a second staleness rule beside it would be a second set of
  // rules. The cost is stated rather than hidden: a `rev` that moves for an
  // unrelated reason clears the notice without the data having been refetched,
  // which is the SAME weakness `rev` already has. See `MountOptions.elsewhere`.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  assert.match(b.driver.snapshot().note ?? "", /another tab/);

  b.filter();
  assert.equal(
    b.driver.snapshot().note,
    undefined,
    "a filter the person typed clears it, which is the documented weakness and not a bug",
  );
  const allowed = await b.driver.call("accept-selected", {}, { plan: await counted(b) });
  assert.equal(allowed.ok, true);
});

test("a navigation carries no plan in a tab another tab has changed", async () => {
  // The hole the carry would have opened on top of the notice's documented
  // weakness. A read-only move does not spend a plan -- see `plansGoodAt` --
  // and a read-only move also clears the `changed-elsewhere` notice, because
  // `rev` is the only statement the core is entitled to believe. Carrying the
  // plan across the same call would have made those two compose: the notice
  // gone, the receipt still good, and a bulk commit going through in a tab the
  // core had just been told was behind, with no fresh count anywhere.
  //
  // So the carry declines while a notice stands. The tab is not stuck -- it
  // describes again and gets a new token, which is the documented weakness and
  // no worse -- but the count gets read a second time, which is the one thing
  // worth insisting on here.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  const held = await counted(b);
  await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  assert.match(b.driver.snapshot().note ?? "", /another tab/);

  assert.equal((await b.driver.call("goto")).ok, true);
  assert.equal(b.driver.snapshot().note, undefined, "the notice outlived a rev move");

  const out = await b.driver.call("accept-selected", {}, { plan: held });
  assert.equal(out.ok === false && out.refused, "stale-plan");
});

test("a tab that listens and refetches never sees any of this fire", async () => {
  // The destination. An app that reacts to the notice itself is correct rather
  // than merely honest, and in that app the core's check is dead code — which
  // is the right shape for a safety net.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);
  bus.listen(() => b.refresh());

  await a.driver.call("accept-selected", {}, { plan: await counted(a) });

  assert.equal(b.driver.snapshot().note, undefined, "B refetched, so B's rev moved and nothing is pending");
  assert.deepEqual(
    b.driver.snapshot().rows?.map((r) => r.status),
    ["accepted", "accepted", "accepted"],
    "and B is showing the truth rather than a warning about not showing it",
  );
});

test("a commit the app itself refused announces nothing", async () => {
  // The app saying no means nothing moved, so there is nothing for the other
  // tabs to be behind on. Announcing it would refuse a commit in every other
  // tab for a call that changed not one row.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  const refused = await a.driver.call("decline-selected", { reason: "no" });
  assert.equal(refused.ok === false && refused.refused, "nothing-selected");
  assert.equal(bus.sent.length, 0);
  assert.equal(b.driver.snapshot().note, undefined);
});

test("a describe announces nothing, however many rows it counted", async () => {
  // `read` and `describe` promise no data moves, which is the promise the whole
  // ladder is built on. Announcing them would refuse every commit in every
  // other tab for every read anybody did — a warning on everything and
  // therefore a warning on nothing.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  await counted(a);
  await a.driver.call("read-rows");
  assert.equal(bus.sent.length, 0);
  assert.equal(b.driver.snapshot().note, undefined);
});

test("unmount stops listening, so a reloaded driver does not leak a subscription", async () => {
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  const b = tab(backend, bus);

  b.driver.unmount();
  await a.driver.call("accept-selected", {}, { plan: await counted(a) });

  // Unmounted, so every call is `unmounted` anyway; what is being pinned is
  // that the listener is gone rather than that the driver is closed.
  const after = await b.driver.call("read-rows");
  assert.equal(after.ok === false && after.refused, "unmounted");
});

test("the app's own note is kept and the warning is added to it", async () => {
  // The app may be saying something the person needs, and this is not more
  // important than that.
  const backend: Backend = { accepted: new Set() };
  const bus = wire();
  const a = tab(backend, bus);
  let rev = 1;
  const b = mount({
    app: "Contacts",
    elsewhere: bus,
    visible: () => ({ where: "contacts", rev, note: "trial expires on Friday" }),
    verbs: [{ name: "touch", kind: "commit", describe: "touch", run: () => { rev++; } }],
  });

  await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  const note = b.snapshot().note ?? "";
  assert.match(note, /^trial expires on Friday /);
  assert.match(note, /another tab of this app committed/);
});

test("`broadcastElsewhere` carries a notice between two drivers over one BroadcastChannel", async () => {
  // The shipped implementation, over the narrow structural type its own
  // interface exists for. Two real tabs in one browser is the only honest test
  // of the WIRE and e2e/smoke.spec.mjs does that; this is the honest test of
  // the shape, and it is the one that runs on every commit.
  const backend: Backend = { accepted: new Set() };
  const channels: FakeBus[] = [];
  const Ctor = function (this: unknown, name: string) {
    const bus = new FakeBus(name, channels);
    channels.push(bus);
    return bus;
  } as unknown as new (name: string) => BroadcastChannelLike;

  const a = tab(backend, broadcastElsewhere({ BroadcastChannel: Ctor }));
  const b = tab(backend, broadcastElsewhere({ BroadcastChannel: Ctor }));

  await a.driver.call("accept-selected", {}, { plan: await counted(a) });
  assert.match(b.driver.snapshot().note ?? "", /another tab of this app committed/);
});

test("`broadcastElsewhere` throws rather than hand back a channel that does nothing", () => {
  // The same rule as `driverkit/relay` having no browser shim. A no-op is worse
  // here than a build error, because the app would believe it had a cross-tab
  // check and the whole point of the check is that the failure it guards is
  // silent.
  //
  // The global is removed for the length of this test rather than `undefined`
  // being passed, because Node HAS a `BroadcastChannel` -- so passing
  // `undefined` falls through to a real one and the assertion would be
  // vacuous. It also keeps the event loop alive, which is how this was found.
  const global = globalThis as { BroadcastChannel?: unknown };
  const was = global.BroadcastChannel;
  delete global.BroadcastChannel;
  try {
    assert.throws(() => broadcastElsewhere(), /no BroadcastChannel/);
  } finally {
    global.BroadcastChannel = was;
  }
});

test("anything else on the channel is dropped rather than read as a notice", async () => {
  // A channel name shared with another library, or with a newer driverkit.
  // Taking a driver out of service over a frame it does not understand is how a
  // forward-compatible addition becomes an outage; a notice with no `verb`
  // would put the word `undefined` into a refusal a model reads.
  const backend: Backend = { accepted: new Set() };
  const channels: FakeBus[] = [];
  const Ctor = function (this: unknown, name: string) {
    const bus = new FakeBus(name, channels);
    channels.push(bus);
    return bus;
  } as unknown as new (name: string) => BroadcastChannelLike;

  const b = tab(backend, broadcastElsewhere({ BroadcastChannel: Ctor }));
  const noise = new FakeBus("driverkit:elsewhere", channels);
  channels.push(noise);
  noise.postMessage({ hello: "world" });
  noise.postMessage("a string");
  noise.postMessage({ verb: 7, from: "x" });

  assert.equal(b.driver.snapshot().note, undefined);
  const allowed = await b.driver.call("accept-selected", {}, { plan: await counted(b) });
  assert.equal(allowed.ok, true);
});

/** A `BroadcastChannel` that delivers to every OTHER channel of the same name,
 *  which is the one behaviour of the real thing that matters here — including
 *  that it does not echo to the sender. */
class FakeBus implements BroadcastChannelLike {
  private listeners: Array<(event: { data?: unknown }) => void> = [];
  private closed = false;
  readonly name: string;
  private readonly all: FakeBus[];
  // Written out rather than declared as parameter properties: the suite runs
  // under `--experimental-strip-types`, which erases types and refuses syntax
  // that would have to emit code.
  constructor(name: string, all: FakeBus[]) {
    this.name = name;
    this.all = all;
  }
  postMessage(data: unknown): void {
    for (const other of this.all) {
      if (other === this || other.name !== this.name || other.closed) continue;
      for (const listener of [...other.listeners]) listener({ data });
    }
  }
  addEventListener(_type: "message", listener: (event: { data?: unknown }) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "message", listener: (event: { data?: unknown }) => void): void {
    const at = this.listeners.indexOf(listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }
  close(): void {
    this.closed = true;
    this.listeners = [];
  }
}
