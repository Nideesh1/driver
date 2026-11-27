/**
 * Making a call's duration visible to the model. These tests are the spec.
 *
 * The problem: asked "compare how long it takes to fetch X and Y", an agent
 * driving this library had nothing to go on. `AuditEvent.ms` is recorded on
 * every call and goes to the HOST's logger; no byte of a rendered turn carried
 * a duration, so a model asked about speed was guessing.
 *
 * The three tensions each have their own section below, because each of them is
 * a decision somebody could reasonably have made differently: what it costs in
 * tokens, whether a transcript stays reproducible, and whether the figure is
 * honest about who was doing the waiting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../src/core/registry.ts";
import type { Driver, Snapshot, VerbContext } from "../src/core/types.ts";
import { SLOW_MS, drive, renderDuration, systemPrompt } from "../src/agent/index.ts";
import type { Clock, DriveOptions, Think } from "../src/agent/types.ts";

/**
 * A clock whose `now` only moves when a verb says so.
 *
 * The whole determinism argument in one fixture: nothing here sleeps, and the
 * transcript below is a function of the script rather than of how busy the
 * machine was when the suite ran.
 */
class ScriptedClock implements Clock {
  ms = 0;
  set(fn: () => void): unknown {
    fn();
    return 0;
  }
  clear(): void {}
  now(): number {
    return this.ms;
  }
}

/** An app whose verbs take exactly as long as the test says. */
function app(costs: Record<string, number>, clock: ScriptedClock): Driver {
  let rev = 1;
  const visible = (): Snapshot => ({ where: "reports", rev, rows: [] });
  return mount({
    app: "Reports",
    visible,
    verbs: Object.keys(costs).map((name) => ({
      name,
      kind: "read" as const,
      describe: `fetch ${name}`,
      run: () => {
        // The verb's cost, charged to the injected clock. A real verb charges
        // it to the wall clock; the point of injecting one is that the two
        // produce the same transcript.
        clock.ms += costs[name]!;
        rev++;
      },
    })),
  });
}

function scripted(script: unknown[]): Think {
  let i = 0;
  return async () => (script[i++] ?? { text: "done" }) as never;
}

/** Every tool turn's text, in order. */
async function run(
  driver: Driver,
  script: unknown[],
  clock: ScriptedClock,
  options: Partial<DriveOptions> = {},
): Promise<string[]> {
  const out = await drive(driver, {
    think: scripted(script),
    task: "compare the two fetches",
    clock,
    ...options,
  });
  return out.messages.filter((m) => m.role === "tool").map((m) => m.text);
}

const TWO_FETCHES = [
  { calls: [{ id: "a", name: "fetch-x", args: {} }] },
  { calls: [{ id: "b", name: "fetch-y", args: {} }] },
  { text: "x took about two seconds and y about twelve." },
];

// -------------------------------------------------------------------------
// What a duration looks like in a turn.
// -------------------------------------------------------------------------

test("a duration is one short line in the outcome half, above the screen", async () => {
  // Above the screen seam on purpose, and not only for thrift. "How long did
  // my third call take" is a question whose answer stays true forever, like
  // `ok` and like the count, and unlike the table -- so it belongs in the half
  // `pruneScreens` keeps rather than the half it drops.
  const clock = new ScriptedClock();
  const turns = await run(app({ "fetch-x": 2_100 }, clock), [
    { calls: [{ id: "a", name: "fetch-x", args: {} }] },
    { text: "done" },
  ], clock, { timing: "slow" });

  assert.equal(turns[0]!.split("\n\nOn screen now:\n")[0], "ok\ntook: ~2s");
  // And it is still there after the pruning that drops the screen, because a
  // later turn made this one stale.
  const later = await run(app({ "fetch-x": 2_100, "fetch-y": 12_000 }, clock), TWO_FETCHES, clock, {
    timing: "slow",
  });
  assert.match(later[0]!, /took: ~2s/);
  assert.match(later[1]!, /took: ~10s/);
});

test("the model is told once, in the cached half, what a `took:` line means", async () => {
  // A sentence of guidance beside every duration would be the one piece of
  // boilerplate in a turn that is O(calls), for a number that needs explaining
  // once. So it goes in `system`, which is byte-identical across every turn of
  // a run and is the half a provider caches.
  const manifest = app({ "fetch-x": 1 }, new ScriptedClock()).manifest();
  const off = systemPrompt(manifest);
  assert.doesNotMatch(off, /took:/, "an untimed run pays for the note");
  assert.equal(off, systemPrompt(manifest, undefined, "off"), "absent and off must be one prompt");

  const slow = systemPrompt(manifest, undefined, "slow");
  assert.match(slow, /It is rounded/);
  assert.match(slow, /time somebody spent reading a confirmation is not in it/i);
  // The sentence about SILENCE, which is the half a model gets wrong: under
  // `slow` a call with no line was fast, and "it was fast" is then a true
  // answer rather than a refusal to answer.
  assert.match(slow, /NO `took:` line\s+took under a second/);

  const always = systemPrompt(manifest, undefined, "always");
  assert.match(always, /Every result carries a `took:` line/);
  assert.notEqual(slow, always, "the two modes mean different things by silence");
});

// -------------------------------------------------------------------------
// Tokens. `pruneScreens` cut a ten-step run from 5,775 to 1,397 characters and
// this must not quietly give that back.
// -------------------------------------------------------------------------

test("drive renders no duration by default, so an existing caller's transcript does not move", async () => {
  // The backward-compatibility decision, and the same judgement
  // `onBeforeCommit` gets: off in the primitive, on one level up in the panel.
  // Anything else would move every existing eval's cached prompts on upgrade.
  const clock = new ScriptedClock();
  const turns = await run(app({ "fetch-x": 90_000 }, clock), [
    { calls: [{ id: "a", name: "fetch-x", args: {} }] },
    { text: "done" },
  ], clock);
  assert.doesNotMatch(turns[0]!, /took:/);
});

test("a fast call costs nothing, which is what makes `slow` affordable as a default", async () => {
  // The whole token argument. A duration on every call is a line in every turn
  // forever, for a capability most runs never use -- so the bytes are spent
  // only where elapsed time is a fact about the app rather than noise.
  const clock = new ScriptedClock();
  const quick = await run(app({ "fetch-x": SLOW_MS - 1 }, clock), [
    { calls: [{ id: "a", name: "fetch-x", args: {} }] },
    { text: "done" },
  ], clock, { timing: "slow" });
  assert.doesNotMatch(quick[0]!, /took:/);
  assert.equal(quick[0]!.split("\n\nOn screen now:\n")[0], "ok");

  // And the boundary is at `SLOW_MS` and not one millisecond either side of it.
  const clock2 = new ScriptedClock();
  const slow = await run(app({ "fetch-x": SLOW_MS }, clock2), [
    { calls: [{ id: "a", name: "fetch-x", args: {} }] },
    { text: "done" },
  ], clock2, { timing: "slow" });
  assert.match(slow[0]!, /took: ~1s/);
});

test("`always` is for the run that was asked to compare two fast verbs", async () => {
  // "Both were under a second" is a true answer and often a useless one. The
  // mode exists because the question the user actually asked -- compare X and
  // Y -- is unanswerable from a threshold that hides both of them.
  const clock = new ScriptedClock();
  const turns = await run(app({ "fetch-x": 180, "fetch-y": 640 }, clock), TWO_FETCHES, clock, {
    timing: "always",
  });
  assert.match(turns[0]!, /took: ~0\.1s/);
  assert.match(turns[1]!, /took: ~0\.6s/);
});

// -------------------------------------------------------------------------
// Determinism. Every other byte of a rendered turn is a function of app state.
// -------------------------------------------------------------------------

test("two runs of the same script produce byte-identical transcripts", async () => {
  // What eval caching, snapshot tests and anything that diffs transcripts are
  // built on, and what a wall-clock millisecond count would have broken for
  // every reader at once. The injected clock is the mechanism; `DriveOptions
  // .clock` already existed for pacing and this is the second thing it buys.
  const script = TWO_FETCHES;
  const costs = { "fetch-x": 2_100, "fetch-y": 12_000 };
  const a = new ScriptedClock();
  const b = new ScriptedClock();
  assert.deepEqual(await run(app(costs, a), script, a, { timing: "always" }), await run(app(costs, b), script, b, { timing: "always" }));
});

test("bucketing makes the real clock stable too, where the app's own behaviour is", async () => {
  // The injected clock is for determinism and the buckets are for production,
  // and neither is asked to do the other's job. A verb that takes 2.1s one run
  // and 2.3s the next renders `~2s` both times, so a transcript diff shows the
  // app changing and not the scheduler.
  assert.equal(renderDuration(2_100), renderDuration(2_399));
  assert.equal(renderDuration(2_100), "took: ~2s");
  // Floored, never rounded: the label must not claim more time than elapsed.
  assert.equal(renderDuration(2_999), "took: ~2s");
  assert.equal(renderDuration(59_999), "took: ~55s");
  assert.equal(renderDuration(60_000), "took: ~1m");
  // Tenths only in the mode that asked for them, and said in words below where
  // a tenth would read as zero.
  assert.equal(renderDuration(40, 0), "took: under 0.1s");
  assert.equal(renderDuration(450, 0), "took: ~0.4s");
});

test("a clock that goes backwards renders nothing rather than a negative duration", async () => {
  // A monotonic clock cannot go backwards; an injected one can, and a test
  // clock that does should not put `took: ~-1s` in front of a model. The
  // honest rendering of a measurement that did not happen is silence.
  assert.equal(renderDuration(-1, 0), "");
  assert.equal(renderDuration(Number.NaN, 0), "");
  assert.equal(renderDuration(Number.POSITIVE_INFINITY, 0), "");
});

// -------------------------------------------------------------------------
// Honesty. `ms` in an audit record includes the approval wait by design; what
// a MODEL is shown must not.
// -------------------------------------------------------------------------

test("time a person spent deciding is not reported to the model as the app being slow", async () => {
  // THE LIE THIS SECTION EXISTS TO PREVENT. "This call took 40 seconds" when
  // 38 of them were somebody reading a confirmation is a false claim about the
  // app's speed, and a model that believes it will go looking for a faster
  // route around a verb that is not slow.
  const clock = new ScriptedClock();
  let waited = 0;
  const driver = mount({
    app: "Reports",
    visible: () => ({ where: "reports", rev: 1, rows: [] }),
    verbs: [
      {
        name: "accept",
        kind: "commit",
        describe: "accept the selection",
        // The gate is INSIDE `driver.call()`, which is the configuration
        // `mountWidget` creates through `DriverApproval.adopt` -- so the loop
        // can see only that the call took a long time.
        run: () => {
          clock.ms += 400;
        },
      },
    ],
    approve: () => {
      // Somebody reads the dialog for 38 seconds.
      clock.ms += 38_000;
      waited += 38_000;
      return true;
    },
  });

  const turns = await run(driver, [
    { calls: [{ id: "a", name: "accept", args: {} }] },
    { text: "done" },
  ], clock, { timing: "slow", waited: () => waited });
  // 38.4 seconds of wall clock, and nothing rendered: the app's own work was
  // 400ms, which is under the threshold.
  assert.doesNotMatch(turns[0]!, /took:/, "a person's deciding time was billed to the app");

  // Without `waited`, the same run reports the person as the app. Asserted so
  // that the option is visibly load-bearing rather than decorative -- a host
  // that gates inside `call()` and does not report its wait gets this.
  const clock2 = new ScriptedClock();
  let waited2 = 0;
  const driver2 = mount({
    app: "Reports",
    visible: () => ({ where: "reports", rev: 1, rows: [] }),
    verbs: [
      { name: "accept", kind: "commit", describe: "a", run: () => {
        clock2.ms += 400;
      } },
    ],
    approve: () => {
      clock2.ms += 38_000;
      waited2 += 38_000;
      return true;
    },
  });
  const unfixed = await run(driver2, [
    { calls: [{ id: "a", name: "accept", args: {} }] },
    { text: "done" },
  ], clock2, { timing: "slow" });
  assert.match(unfixed[0]!, /took: ~35s/);
  assert.equal(waited2, 38_000);
});

test("the loop's own commit gate is outside the measurement by construction", async () => {
  // `onBeforeCommit` is awaited before `driver.call()`, so there is nothing to
  // subtract: the honest figure falls out of WHERE the clock is read rather
  // than out of arithmetic afterwards. That is why `waited` exists only for
  // the gate the loop cannot see.
  const clock = new ScriptedClock();
  const turns = await run(app({ accept: 300 }, clock), [
    { calls: [{ id: "a", name: "accept", args: {} }] },
    { text: "done" },
  ], clock, {
    timing: "always",
    onBeforeCommit: () => {
      clock.ms += 50_000;
      return true;
    },
  });
  // `accept` is declared `read` by the fixture, so the gate is not consulted;
  // what is asserted is the 300ms, unpolluted by the clock moving elsewhere.
  assert.match(turns[0]!, /took: ~0\.3s/);
});

test("a refusal carries its duration too, because a slow refusal is worth knowing about", async () => {
  // A call that took twelve seconds to say no is the same fact about the app as
  // one that took twelve seconds to say yes, and a model deciding whether to
  // try a different route needs it either way.
  const clock = new ScriptedClock();
  const driver = mount({
    app: "Reports",
    visible: () => ({ where: "reports", rev: 1, rows: [] }),
    verbs: [
      {
        name: "fetch-x",
        kind: "read",
        describe: "fetch x",
        refuses: ["upstream-down"],
        run: (_args: never, ctx: VerbContext) => {
          clock.ms += 12_000;
          return ctx.refuse("upstream-down", "the reporting service is not answering");
        },
      },
    ],
  });
  const turns = await run(driver, [
    { calls: [{ id: "a", name: "fetch-x", args: {} }] },
    { text: "done" },
  ], clock, { timing: "slow" });
  assert.match(turns[0]!, /refused: upstream-down/);
  assert.match(turns[0]!, /took: ~10s/);
});

test("a tool call that never reached the app carries no duration", async () => {
  // `read_screen` and an unknown tool name both answer without calling a verb,
  // so there is no app work to report and inventing a figure would be the
  // renderer making a claim about something that did not happen.
  const clock = new ScriptedClock();
  const turns = await run(app({ "fetch-x": 5_000 }, clock), [
    { calls: [{ id: "a", name: "read_screen", args: {} }] },
    { calls: [{ id: "b", name: "no-such-verb", args: {} }] },
    { text: "done" },
  ], clock, { timing: "always" });
  assert.doesNotMatch(turns[0]!, /took:/);
  assert.doesNotMatch(turns[1]!, /took:/);
});

// -------------------------------------------------------------------------
// The audit record, which separates the same two numbers for a different
// reader. `onAudit` goes to the HOST's logger; the lines above go to a model.
// -------------------------------------------------------------------------

test("the audit record keeps the human wait beside `ms` rather than inside it alone", async () => {
  // `ms` stays approval-inclusive on purpose: "this bulk accept took 41
  // seconds from the agent's point of view" is the fact an auditor wants, and
  // a record that silently excluded the human would make a slow decision look
  // like a fast app. But the sum alone answers neither question, so both are
  // written and subtracting is left to whoever is reading.
  const events: Array<{ verb: string; ms: number; waitedMs: number | undefined }> = [];
  const driver = mount({
    app: "Reports",
    visible: () => ({ where: "reports", rev: 1, rows: [] }),
    onAudit: (e) => void events.push({ verb: e.verb, ms: e.ms, waitedMs: e.waitedMs }),
    verbs: [
      { name: "look", kind: "read", describe: "look", run: () => {} },
      { name: "accept", kind: "commit", describe: "accept", run: () => {} },
    ],
    approve: async () => {
      await new Promise((r) => setTimeout(r, 25));
      return true;
    },
  });

  await driver.call("accept");
  const commit = events.find((e) => e.verb === "accept")!;
  assert.ok(commit.waitedMs !== undefined, "the human wait was not recorded");
  assert.ok(commit.waitedMs >= 20, `waited ${commit.waitedMs}ms, expected about 25`);
  assert.ok(commit.ms >= commit.waitedMs, "the wait cannot exceed the call");

  // And its ABSENCE is a claim: nobody was asked, so `ms` is the app's own
  // work start to finish. A read is never gated.
  await driver.call("look");
  assert.equal(events.find((e) => e.verb === "look")!.waitedMs, undefined);
});

test("a gate that chose not to ask records no wait, because nobody was asked", async () => {
  // `{ asked: false }` is the one answer that allows without claiming consent,
  // and it returns in no time at all -- which the clock cannot tell from an
  // instant yes. So `asked: false` is what the field is cleared on, and the
  // promise that "absent means no question was open" holds.
  const events: Array<{ waitedMs: number | undefined; approval: string }> = [];
  const driver = mount({
    app: "Reports",
    visible: () => ({ where: "reports", rev: 1, rows: [] }),
    onAudit: (e) => void events.push({ waitedMs: e.waitedMs, approval: e.approval }),
    verbs: [{ name: "accept", kind: "commit", describe: "accept", run: () => {} }],
    approve: () => ({ asked: false }),
  });
  await driver.call("accept");
  assert.equal(events[0]!.approval, "not-asked");
  assert.equal(events[0]!.waitedMs, undefined);
});

test("a declined commit records the wait too, because a slow no is as interesting as a slow yes", async () => {
  // Timed in a `finally`, so every exit is covered. A figure recorded only on
  // the happy path is one that vanishes from the records somebody is most
  // likely to be reading.
  const events: Array<{ waitedMs: number | undefined; approval: string }> = [];
  const driver = mount({
    app: "Reports",
    visible: () => ({ where: "reports", rev: 1, rows: [] }),
    onAudit: (e) => void events.push({ waitedMs: e.waitedMs, approval: e.approval }),
    verbs: [{ name: "accept", kind: "commit", describe: "accept", run: () => {} }],
    approve: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return false;
    },
  });
  await driver.call("accept");
  assert.equal(events[0]!.approval, "declined");
  assert.ok((events[0]!.waitedMs ?? 0) >= 15, "a declined commit's wait was not recorded");
});
