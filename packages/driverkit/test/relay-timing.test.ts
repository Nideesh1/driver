/**
 * A call's duration over the relay: who measures it, and what it must not say.
 *
 * The in-page half of this is `timing.test.ts`, where the clock brackets
 * `driver.call()` and `DriveOptions.waited` subtracts the person, so a
 * 38-second confirmation around a 400ms verb renders nothing. This file is the
 * same fact for an agent on the far side of a relay, which could previously
 * measure only its own round trip — the network out, the tab's work, any
 * question the page put to a person, the network back — and so could not tell
 * a slow app from a slow network from somebody taking thirty seconds over an
 * Approve button.
 *
 * Two ends, in one file, because the decision spans them and a test for either
 * half alone passes on the other half being wrong:
 *
 *   THE TAB MEASURES. Its own bracket, around its own call into its own
 *   driver, with the person taken out by the only party that can see them.
 *   THE RELAY CARRIES. It has one number of its own and that number is the sum
 *   this field exists to take apart, so it copies, validates and has no
 *   opinion — exactly as with `rev` and `focus`.
 *
 * The relay half is driven by hand over real SSE rather than through
 * `driverkit/browser`, the rule the rest of the relay tests follow: a test that
 * drives both sides of a contract with one codebase passes happily when both
 * ends agree on the wrong thing. `python/tests/test_timing.py` is the twin,
 * assertion for assertion, because a field added to one relay and not the
 * other is the cheapest possible way to make two conforming relays disagree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../src/core/index.ts";
import { connect } from "../src/browser/index.ts";
import { serve } from "../src/relay/serve.ts";
import type { RelayAuditEvent } from "../src/relay/index.ts";
import type { Driver, Snapshot } from "../src/browser/frames.ts";
import { HttpEventSource, postJson } from "./sse-client.ts";
import { eventSources, posts, storage, waitFor } from "./fake.ts";

// -------------------------------------------------------------------------
// The tab's end. What it measures, and what it refuses to claim.
// -------------------------------------------------------------------------

/** A clock that moves only when a verb or an approver says so. */
class ScriptedClock {
  ms = 0;
  now = (): number => this.ms;
}

/**
 * A one-verb app whose work costs exactly what the test says.
 *
 * `kind` and `approve` are arguments because they are the two inputs to the
 * only judgement the tab makes here: whether a person could have been inside
 * the measurement.
 */
function app(
  clock: ScriptedClock,
  costMs: number,
  kind: "read" | "commit" | "ask" = "read",
  approve?: () => boolean,
): { driver: Driver; waited: () => number } {
  let waited = 0;
  const visible = (): Snapshot => ({ where: "reports", rev: 1, rows: [] });
  const driver = mount({
    app: "Reports",
    visible,
    verbs: [
      {
        name: "fetch",
        kind: kind === "ask" ? "read" : kind,
        describe: "fetch the report",
        // `reversible` on the commit so this toy is publishable without an
        // approver, exactly as `connect.test.ts`'s is; spread rather than set
        // to `undefined`, which `exactOptionalPropertyTypes` rightly refuses.
        ...(kind === "commit" ? { reversible: true as const } : {}),
        run: () => {
          clock.ms += costMs;
        },
      },
    ],
    ...(approve
      ? {
          approve: () => {
            // Somebody reads the dialog. The gate is INSIDE `driver.call()`,
            // which is the configuration `mountWidget` creates through
            // `DriverApproval.adopt`, so the page side can see only that the
            // call took a long time.
            clock.ms += 38_000;
            waited += 38_000;
            return approve();
          },
        }
      : {}),
  });
  return { driver, waited: () => waited };
}

/** `connect`, on fakes, driven one `call` frame at a time. */
function wire(driver: Driver, clock: ScriptedClock, options: Record<string, unknown> = {}) {
  const es = eventSources();
  const http = posts();
  const conn = connect(driver, {
    relay: "http://127.0.0.1:9999",
    app: "Reports",
    EventSource: es.ctor,
    fetch: http.fetch,
    storage: storage(),
    now: clock.now,
    ...options,
  } as never);
  return {
    conn,
    http,
    /** Deliver one `call` frame and give back the `result` frame it produced. */
    async call(name = "fetch", extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
      const before = http.of("result").length;
      es.last().deliver({ t: "call", id: `c-${before + 1}`, name, args: {}, ...extra });
      await waitFor(() => http.of("result").length > before);
      return http.of("result")[before]!.body;
    },
  };
}

test("the tab measures its own work and says so on the result frame", async () => {
  // The figure is taken where the bracket can be the same one the in-page loop
  // uses, and it rides on the frame rather than inside `result`: `result` is
  // what the APP returned, and a duration in there would be the app's claim
  // about its own speed instead of an observation nobody asked it for.
  const clock = new ScriptedClock();
  const { conn, call } = wire(app(clock, 2_100).driver, clock);
  const frame = await call();

  assert.equal(frame.tookMs, 2_100);
  assert.equal("tookMs" in frame.result, false, "the duration was put in the app's own answer");
  assert.equal("waitedMs" in frame, false, "a key for a person nobody waited on");
  conn.disconnect();
});

test("an in-page approval's wait is not counted as app time over the wire", async () => {
  // THE LIE THIS WHOLE FILE EXISTS TO PREVENT, now on the wire. 38.4 seconds
  // of wall clock for 400ms of app, and the frame says 400ms — because
  // `waited` is read either side of the call and the difference is subtracted
  // by the one party that can see the dialog. A model told "this took 38
  // seconds" goes looking for a faster route around a verb that is not slow.
  const clock = new ScriptedClock();
  const { driver, waited } = app(clock, 400, "commit", () => true);
  const { conn, call } = wire(driver, clock, { waited });
  const frame = await call();

  assert.equal(frame.tookMs, 400);
  // And the person is REPORTED, not merely removed. Without this the gap
  // between an agent's round trip and `tookMs` is unexplained, and a client
  // comparing the two would bill 38 seconds to the network.
  assert.equal(frame.waitedMs, 38_000);
  assert.equal(frame.result.ok, true);
  conn.disconnect();
});

test("a commit that may have been gated reports nothing rather than a figure with a person in it", async () => {
  // The honest refusal, and it is structural rather than a flag an adopter has
  // to know about. With no `waited` to subtract, a page whose core holds an
  // approval gate cannot tell how much of a commit was somebody reading — so
  // it says nothing, which PROTOCOL.md pins as UNKNOWN. Silence is true;
  // `tookMs: 38400` would be a false claim about the app.
  const clock = new ScriptedClock();
  const { driver } = app(clock, 400, "commit", () => true);
  const { conn, call } = wire(driver, clock);
  const frame = await call();

  assert.equal("tookMs" in frame, false);
  assert.equal(frame.result.ok, true, "the call itself must be unaffected");
  conn.disconnect();
});

test("a commit nobody is asked about is the app's own work and is reported", async () => {
  // The other side of the same rule, so it is a judgement about whether a
  // person could have been there and not a blanket refusal to time commits.
  // `policy` is a LIVE read for exactly this reason: the same driver answers
  // `none` before a panel mounts and `adopted` after.
  const clock = new ScriptedClock();
  const { driver } = app(clock, 2_100, "commit");
  const { conn, call } = wire(driver, clock);

  assert.equal((await call()).tookMs, 2_100);
  conn.disconnect();
});

test("the `ask` verb is a person from end to end and is never timed as the app", async () => {
  // A question put to somebody has no app time in it at all, so there is no
  // honest figure to report and no `waited` to subtract one with. The core
  // declares `ask` with its own `kind`, which is what makes this knowable from
  // the page side without asking the app anything.
  const clock = new ScriptedClock();
  const driver = mount({
    app: "Reports",
    visible: (): Snapshot => ({ where: "reports", rev: 1, rows: [] }),
    verbs: [{ name: "fetch", kind: "read", describe: "fetch", run: () => {} }],
    ask: () => {
      clock.ms += 45_000;
      return "the blue one";
    },
  });
  const { conn, call } = wire(driver, clock);
  const frame = await call("ask", { args: { question: "which one?" } });

  assert.equal("tookMs" in frame, false, "45 seconds of a person were billed to the app");
  conn.disconnect();
});

test("a tab that opts out sends the bytes it always sent", async () => {
  // Additive, which is the rule for everything on this wire: a tab that opts
  // into nothing behaves identically, and no clock is read at all.
  const clock = new ScriptedClock();
  const { conn, call } = wire(app(clock, 2_100).driver, clock, { timing: false });
  const frame = await call();

  assert.deepEqual(Object.keys(frame).sort(), ["id", "result", "t", "tab"]);
  conn.disconnect();
});

// -------------------------------------------------------------------------
// The relay's end. It carries the number and originates none.
// -------------------------------------------------------------------------

async function up(t: { after: (fn: () => unknown) => void }, onAudit?: (e: RelayAuditEvent) => void) {
  const { server, relay, url } = await serve({
    port: 0,
    pingMs: 20_000,
    ...(onAudit ? { onAudit } : {}),
  });
  t.after(() => {
    relay.close();
    server.close();
  });
  return url;
}

const SNAP: Snapshot = { where: "reports", rev: 7, rows: [] };

/** A hand-driven tab that answers one call with whatever frame a test names. */
async function tab(url: string, id = "t1") {
  const es = new HttpEventSource(`${url}/dk/events?tab=${encodeURIComponent(id)}`);
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  await postJson(`${url}/dk/result?tab=${id}`, { t: "hello", tab: id, snapshot: SNAP });
  return {
    es,
    /** Answer the next call with these extra frame fields, and give back the
     *  body the agent's `/call` was answered with. */
    async answer(extra: Record<string, unknown>, result: unknown = { ok: true, snapshot: SNAP }) {
      const answered = postJson(`${url}/dk/tabs/${id}/call`, { name: "fetch" });
      const frame = (await es.next("call")) as { id: string };
      await postJson(`${url}/dk/result?tab=${id}`, {
        t: "result",
        tab: id,
        id: frame.id,
        result,
        ...extra,
      });
      return (await answered).body;
    },
  };
}

test("the relay carries the tab's figure to the agent untouched", async (t) => {
  const url = await up(t);
  const one = await tab(url);
  t.after(() => one.es.close());

  const body = await one.answer({ tookMs: 2_100, waitedMs: 38_000 });
  assert.equal(body.tookMs, 2_100);
  assert.equal(body.waitedMs, 38_000);
  // And the `result` itself is still forwarded byte for byte: the copy is
  // shallow and the two reserved keys are the only thing it touches.
  assert.deepEqual(body.snapshot, SNAP);
  assert.equal(body.ok, true);
});

test("a tab that reports nothing leaves the agent with no figure rather than a zero", async (t) => {
  // Absent is UNKNOWN. An older tab, a hand-written `fetch` loop and a tab
  // that could not say honestly all send nothing, and a relay that filled in a
  // zero would have every one of those apps rendering as instant.
  const url = await up(t);
  const one = await tab(url);
  t.after(() => one.es.close());

  const body = await one.answer({});
  assert.equal("tookMs" in body, false);
  assert.equal("waitedMs" in body, false);
});

test("the relay never substitutes its own round trip for a missing figure", async (t) => {
  // The one number the relay has is the network out, plus the tab's work, plus
  // any question the page put to a person, plus the network back — which is
  // the sum `tookMs` exists to take apart. A relay that offered it here would
  // be the second place that decides, beside the only process that can see.
  const url = await up(t);
  const one = await tab(url);
  t.after(() => one.es.close());

  const answered = postJson(`${url}/dk/tabs/t1/call`, { name: "fetch" });
  const frame = (await one.es.next("call")) as { id: string };
  // A real delay, so a relay that timed the round trip would have something
  // non-zero to put in the body.
  await new Promise((r) => setTimeout(r, 60));
  await postJson(`${url}/dk/result?tab=t1`, {
    t: "result",
    tab: "t1",
    id: frame.id,
    result: { ok: true, snapshot: SNAP },
  });
  const { body } = await answered;
  assert.equal("tookMs" in body, false);
});

test("a figure the app put in its own result is not passed off as a measurement", async (t) => {
  // `tookMs` is reserved on this body. The `result` is what the APP returned,
  // and an app reporting its own speed is a claim where the agent is entitled
  // to an observation — so a value found in there is dropped, and only the
  // frame's own field, written by the page-side harness, is forwarded.
  const url = await up(t);
  const one = await tab(url);
  t.after(() => one.es.close());

  const body = await one.answer({}, { ok: true, snapshot: SNAP, tookMs: 5, waitedMs: 5 });
  assert.equal("tookMs" in body, false);
  assert.equal("waitedMs" in body, false);

  // And the frame's own field wins over one the app wrote, rather than the two
  // being merged in whichever order the spread happened to run.
  const second = await one.answer({ tookMs: 2_100 }, { ok: true, snapshot: SNAP, tookMs: 5 });
  assert.equal(second.tookMs, 2_100);
});

test("anything that is not a finite millisecond count is dropped on the way through", async (t) => {
  // The rule `focus` already has for a value that is not a string: a relay
  // carries what it was given or nothing, and never a figure a reader would
  // have to guess the meaning of. A negative or non-finite number is a broken
  // clock rather than a fast call.
  const url = await up(t);
  const one = await tab(url);
  t.after(() => one.es.close());

  for (const junk of ["2100", true, null, -1, {}]) {
    const body = await one.answer({ tookMs: junk });
    assert.equal("tookMs" in body, false, `a relay forwarded \`${JSON.stringify(junk)}\``);
  }
  // A float is a number and survives JSON; it is floored rather than dropped,
  // because nothing downstream wants tenths of a millisecond and every reader
  // flooring for itself is how two clients come to disagree.
  assert.equal((await one.answer({ tookMs: 2_100.7 })).tookMs, 2_100);
});

test("`waitedMs` never travels without the figure it was subtracted from", async (t) => {
  // It is defined as the amount already taken out of `tookMs`, so on its own
  // it is a quantity relative to nothing — and a reader might well subtract it
  // a second time from something.
  const url = await up(t);
  const one = await tab(url);
  t.after(() => one.es.close());

  const body = await one.answer({ waitedMs: 38_000 });
  assert.equal("waitedMs" in body, false);
});

test("the relay's audit record does not gain the tab's figure", async (t) => {
  // Deliberate, and the same argument as `outcome` saying `delivered` rather
  // than `ok`: a relay must not assert what it did not observe. `tookMs` was
  // measured in another process and the relay cannot check it. Logging it
  // beside `ms` would also invite the subtraction nobody should make — the
  // difference is not "the network", it is the network plus however long the
  // frame sat in the tab's event loop plus whatever a proxy buffered.
  const records: RelayAuditEvent[] = [];
  const url = await up(t, (e) => records.push(e));
  const one = await tab(url);
  t.after(() => one.es.close());

  await one.answer({ tookMs: 2_100, waitedMs: 38_000 });
  await waitFor(() => records.length > 0);
  assert.deepEqual(Object.keys(records[0]!).sort(), [
    "at",
    "ms",
    "outcome",
    "principal",
    "tab",
    "verb",
  ]);
  assert.equal(records[0]!.outcome, "delivered");
});
