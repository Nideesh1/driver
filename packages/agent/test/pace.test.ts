/**
 * Pacing, run controls, the events a step list is drawn from, and `Verb.at`.
 *
 * These tests are the specification for the half of the loop that exists for
 * the person watching rather than for the model. Each name states the decision
 * it pins, so a change that looks harmless has to break a named test and read
 * why the rule is there before deleting it.
 *
 * Nothing in here sleeps. The clock is injected, so a 600ms pace costs the
 * suite nothing and the waits can be counted exactly — a suite that actually
 * paced itself would take minutes and would therefore stop being run, which is
 * the real failure mode of testing timing by waiting for it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { drive, paceWait, runControls, WATCHABLE_PACE } from "../src/index.ts";
import type { Clock } from "../src/index.ts";
import { mount } from "../../core/src/registry.ts";
import type { Snapshot } from "../../core/src/types.ts";
import { call, contacts, scripted, TOTAL } from "./app.ts";

/**
 * A clock that records every wait and fires it on the next macrotask, with a
 * virtual `now` that jumps forward by whatever was scheduled.
 *
 * Wall-clock time is dropped on purpose: what the loop promises is *how many*
 * waits of *what length* it asks for, and asserting that from the ms it passed
 * is the same assertion as asserting it from a stopwatch, minus the stopwatch.
 * `now` has to move with the timers all the same, because a wait is re-armed
 * against `pace - elapsed` and an elapsed that never grew would re-arm forever.
 */
function instantClock(log?: string[]): Clock & { waits: number[] } {
  const waits: number[] = [];
  let t = 0;
  return {
    waits,
    now: () => t,
    set(fn, ms) {
      waits.push(ms);
      log?.push(`wait:${ms}`);
      // Charged at scheduling time. Every timer this clock hands out does fire,
      // so the two are the same moment as far as anything here can tell.
      t += ms;
      return setTimeout(fn, 0);
    },
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

/**
 * A clock that records waits, never fires them, and whose `now` moves only when
 * a test says so.
 *
 * The only ways out of a wait on this clock are an abort and a pace change,
 * which is exactly what the tests using it are about: if either path were
 * broken they would hang rather than fail, which is the honest shape for
 * "returned immediately".
 */
function frozenClock(): Clock & {
  waits: number[];
  readonly cleared: number;
  advance: (ms: number) => void;
} {
  const waits: number[] = [];
  let cleared = 0;
  let t = 0;
  return {
    waits,
    get cleared() {
      return cleared;
    },
    advance(ms: number) {
      t += ms;
    },
    now: () => t,
    set(_fn: () => void, ms: number) {
      waits.push(ms);
      return { ms };
    },
    clear() {
      cleared++;
    },
  };
}

/** Let the loop run as far as it can get on its own. Several turns of the
 *  macrotask queue, because a held run has to be given every chance to
 *  (wrongly) carry on before a test concludes that it is holding. */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

test("a paced run waits once before every call, and never for a model turn", async () => {
  // One wait per call, including the first — the first call is the one the
  // person has had the least chance to react to, so skipping it would skip the
  // case the feature is for. Model turns are not paced: they are already slow
  // and already visible, and padding them would double the latency of the only
  // part that costs money without making anything easier to follow.
  const app = contacts();
  const clock = instantClock();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" }), call("read_screen")] },
    { calls: [call("accept-selected")] },
    { text: "done" },
  ]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "go",
    pace: WATCHABLE_PACE,
    clock,
  });

  assert.equal(out.stop, "answered");
  assert.equal(s.seen.length, 3, "three model turns");
  assert.deepEqual(clock.waits, [600, 600, 600], "one wait per call, none per turn");
});

test("a pace of 0 schedules no timer at all, so a headless run is not slowed", async () => {
  // The default, and the reason it is the default: `drive` is driven by backend
  // jobs, tests and CLIs where nobody is watching. "Pacing off" has to mean the
  // pacing code is not in the path, not that it asks for a zero-delay timer —
  // otherwise a bug in there can still cost an unattended run its latency.
  const app = contacts();
  const clock = instantClock();
  const s = scripted([{ calls: [call("select-where", { where: "company=Acme" })] }, { text: "ok" }]);

  await drive(app.driver, { think: s.think, task: "go", clock });
  assert.deepEqual(clock.waits, [], "a default run asked for a timer");

  const app2 = contacts();
  const clock2 = instantClock();
  const s2 = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { text: "ok" },
  ]);
  await drive(app2.driver, { think: s2.think, task: "go", pace: 0, clock: clock2 });
  assert.deepEqual(clock2.waits, [], "an explicit pace of 0 asked for a timer");
});

test("an abort during a pace wait returns at once, rather than after the wait", async () => {
  // A stop button that takes the pace to notice is a stop button a person
  // presses twice, and on a page with a two-second pace it reads as a frozen
  // panel. The wait is raced against the signal; the timer it no longer needs
  // is cleared rather than left to fire into a finished run.
  const clock = frozenClock();
  const controller = new AbortController();
  const waited = paceWait({ ms: 10_000, clock, signal: controller.signal });

  let done = false;
  void waited.then(() => {
    done = true;
  });
  await settle(1);
  assert.equal(done, false, "the wait resolved without the timer and without an abort");

  controller.abort();
  await waited;
  assert.equal(clock.cleared, 1, "the abandoned timer was left scheduled");
});

test("a run aborted mid-pace commits nothing and does not wait for the pace to end", async () => {
  // The same property, through `drive`, where it matters: the verb must not run
  // and the loop must not be parked on a timer. The clock here never fires, so
  // if the abort did not resolve the wait this test would hang rather than
  // fail — which is the honest shape for "did not return immediately".
  const app = contacts();
  const clock = frozenClock();
  const controller = new AbortController();
  const s = scripted([{ calls: [call("accept-selected")] }]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "accept everything",
    pace: WATCHABLE_PACE,
    clock,
    signal: controller.signal,
    // Fired before the wait starts, so the abort lands while the loop is inside
    // it rather than before it — the listener path, not the early return.
    onBeforeCall: () => void setTimeout(() => controller.abort(), 0),
  });

  assert.equal(out.stop, "aborted");
  assert.deepEqual(app.accepted(), [], "a commit ran after the run was stopped mid-pace");
  assert.deepEqual(clock.waits, [600], "the loop did not pace the call it abandoned");
});

test("a pace changed mid-run takes effect on the next wait", async () => {
  // The reason the setter exists. The moment a person wants the agent slowed
  // down is while it is going, so a pace that only applied to the next run
  // would be a slider they move, see nothing happen, and conclude is broken.
  const app = contacts();
  const clock = instantClock();
  const controls = runControls();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" }), call("read_screen")] },
    { calls: [call("accept-selected")] },
    { text: "done" },
  ]);

  await drive(app.driver, {
    think: s.think,
    task: "go",
    pace: WATCHABLE_PACE,
    clock,
    controls,
    // Changed after the first call's own wait is over, so what is being asserted
    // is the NEXT wait and not a re-arm of the one in progress — that case has
    // its own test below.
    onResult: (e) => {
      if (e.call.name === "select-where") controls.pace(120);
    },
  });

  assert.deepEqual(clock.waits, [600, 120, 120]);
  assert.equal(controls.paceMs, 120, "the controls did not report the pace they are using");
});

test("the run's pace option is the initial value, and the setter overrides it from then on", async () => {
  // Two owners of one number, and an order between them. The option seeds the
  // run because the run is the thing being paced; after that the controls hold
  // it, which is what lets anything change it mid-flight.
  const controls = runControls({ pace: 50 });
  assert.equal(controls.paceMs, 50);

  const app = contacts();
  const clock = instantClock();
  const s = scripted([{ calls: [call("read_screen")] }, { text: "ok" }]);
  await drive(app.driver, { think: s.think, task: "go", pace: 300, clock, controls });

  assert.deepEqual(clock.waits, [300], "the run's option did not seed the controls");

  // And a run that does not mention `pace` leaves the controls' own value
  // alone, rather than resetting it to the default.
  const app2 = contacts();
  const clock2 = instantClock();
  const s2 = scripted([{ calls: [call("read_screen")] }, { text: "ok" }]);
  controls.pace(80);
  await drive(app2.driver, { think: s2.think, task: "go", clock: clock2, controls });
  assert.deepEqual(clock2.waits, [80]);
});

test("a pace set to 0 mid-run skips the wait entirely rather than asking for a 0ms timer", async () => {
  // "As fast as possible" has to mean the pacing code is not in the path. A
  // zero-delay timer would still be a macrotask per call, and a person who has
  // just dragged the slider to 0 is asking for the opposite of one more hop.
  const app = contacts();
  const clock = instantClock();
  const controls = runControls({ pace: 400 });
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" }), call("read_screen")] },
    { text: "done" },
  ]);

  await drive(app.driver, {
    think: s.think,
    task: "go",
    clock,
    controls,
    onResult: () => controls.pace(0),
  });

  assert.deepEqual(clock.waits, [400], "a timer was scheduled after the pace went to 0");
});

test("a wait in progress is re-armed against the new pace, and ends at once if it is already over", async () => {
  // Cutting 5s to 200ms with 4s left to run is exactly when somebody is jabbing
  // at the slider, and a wait that rode out its old value would be the thing
  // they are already annoyed about, happening again. This clock never fires, so
  // the only way this test passes is the pace change resolving the wait.
  const clock = frozenClock();
  const controls = runControls({ pace: 5000 });
  const waited = paceWait({ ms: () => controls.paceMs, clock, watch: controls.subscribe });

  let done = false;
  void waited.then(() => {
    done = true;
  });
  await settle(1);
  assert.equal(done, false);
  assert.deepEqual(clock.waits, [5000]);

  // Four seconds in, shortened to less than that: already over.
  clock.advance(4000);
  controls.pace(200);
  await waited;
  assert.deepEqual(clock.waits, [5000], "a new timer was scheduled for a wait already elapsed");
});

test("a wait in progress is shortened to what is left, not restarted at the new pace", async () => {
  // The other half of the same arithmetic. Elapsed is measured from when the
  // wait began, so moving the slider can never restart a wait — otherwise a
  // person fiddling with it would hold the run open by accident, and a person
  // doing it on purpose would have a way to stall a run that pause already
  // covers honestly.
  const clock = frozenClock();
  const controls = runControls({ pace: 5000 });
  const waited = paceWait({ ms: () => controls.paceMs, clock, watch: controls.subscribe });
  void waited;

  clock.advance(1000);
  controls.pace(1500);
  // 1500 asked for, 1000 already spent: 500 left, not 1500.
  assert.deepEqual(clock.waits, [5000, 500]);

  clock.advance(400);
  controls.pace(3000);
  assert.deepEqual(clock.waits, [5000, 500, 1600]);
});

test("an abort during a re-armed wait still returns immediately", async () => {
  // The stop button must not be made worse by the slider. Every wake in the
  // wait — the timer, the pace change — re-checks the signal, and the abort
  // resolves the wait whichever arming it is currently on.
  const clock = frozenClock();
  const controls = runControls({ pace: 5000 });
  const controller = new AbortController();
  const waited = paceWait({
    ms: () => controls.paceMs,
    clock,
    signal: controller.signal,
    watch: controls.subscribe,
  });

  let done = false;
  void waited.then(() => {
    done = true;
  });
  clock.advance(100);
  controls.pace(9000);
  await settle(1);
  assert.equal(done, false, "the re-armed wait resolved on its own");

  controller.abort();
  await waited;
});

test("a pace that is not a number is refused, and the run keeps the one it had", async () => {
  // NaN from a parsed input and Infinity from a divide are not claims about a
  // speed, and both plausible readings of them are harmful: 0 runs the agent
  // faster than the person asked, and Infinity parks the run on a timer nobody
  // meant to set. The current pace is the one value that is certainly not a
  // surprise. A negative is different — "less than no wait" has exactly one
  // meaning — so it clamps.
  const controls = runControls({ pace: 300 });

  controls.pace(Number.NaN);
  assert.equal(controls.paceMs, 300);
  controls.pace(Number.POSITIVE_INFINITY);
  assert.equal(controls.paceMs, 300);
  controls.pace(undefined as unknown as number);
  assert.equal(controls.paceMs, 300);

  controls.pace(-5);
  assert.equal(controls.paceMs, 0, "a negative pace was not clamped");

  // And a run fed junk still finishes rather than wedging on a timer for NaN.
  const app = contacts();
  const clock = instantClock();
  const s = scripted([{ calls: [call("read_screen")] }, { text: "ok" }]);
  const out = await drive(app.driver, {
    think: s.think,
    task: "go",
    pace: Number.NaN,
    clock,
    controls,
  });
  assert.equal(out.stop, "answered");
  assert.deepEqual(clock.waits, [], "a wait was scheduled for a pace nobody could state");
  assert.equal(controls.paceMs, 0, "a refused pace overwrote the live one anyway");
});

test("subscribe fires on a state change and on a pace change, including between runs", async () => {
  // What `onControl` cannot cover: there is no loop running between runs, so a
  // step or a pace change made then would be invisible to a panel that only
  // listened to the run. The listener is handed nothing and reads the getters,
  // so this cannot grow a snapshot shape that drifts from the object.
  const controls = runControls();
  const seen: string[] = [];
  const stop = controls.subscribe(() => {
    seen.push(`${controls.state}/${controls.permits}/${controls.paceMs}`);
  });

  controls.pause();
  controls.step();
  controls.pace(250);
  controls.resume();

  assert.deepEqual(seen, [
    "paused/0/0",
    "paused/1/0",
    "paused/1/250",
    "running/0/250",
  ]);

  // Nothing actually changed, so nobody is told. A listener woken for a
  // no-op would have a UI redrawing on every tick of a slider that has not
  // moved.
  const before = seen.length;
  controls.resume();
  controls.pace(250);
  assert.equal(seen.length, before);

  stop();
  controls.pause();
  assert.equal(seen.length, before, "unsubscribe did not take");
});

test("one broken listener does not stop the others, or the loop's own re-arm", async () => {
  // `drive` subscribes to the controls to re-arm its wait, so a panel listener
  // that throws must not be able to take the live pace down with it. Everybody
  // is told, then the failure is raised at whoever moved the control — their
  // listener, their stack — rather than swallowed.
  const clock = frozenClock();
  const controls = runControls({ pace: 5000 });
  const stop = controls.subscribe(() => {
    throw new Error("a panel listener blew up");
  });

  const waited = paceWait({ ms: () => controls.paceMs, clock, watch: controls.subscribe });
  clock.advance(6000);
  assert.throws(() => controls.pace(100), /a panel listener blew up/);

  // Told anyway: the wait saw the new pace and ended.
  await waited;
  // And the change stands — a listener does not get to veto it.
  assert.equal(controls.paceMs, 100);
  stop();
});

test("pause holds before the next call, and the call in flight finishes first", async () => {
  // A pause is a gate BETWEEN calls. Interrupting one halfway would need the
  // app's verb to be interruptible, which no app promises, and would leave the
  // screen in a state neither the person nor the model can describe. So the
  // test pauses from inside the first call's own event and then checks that the
  // first call completed in full and the second never started.
  const app = contacts();
  const controls = runControls();
  const s = scripted([
    {
      calls: [
        call("select-where", { where: "company=Acme" }),
        // The expensive one. It must not run while the run is held.
        call("accept-selected"),
      ],
    },
    { text: "done" },
  ]);

  const log: string[] = [];
  const run = drive(app.driver, {
    think: s.think,
    task: "accept the Acme contacts",
    controls,
    onBeforeCall: (e) => log.push(`before:${e.call.name}`),
    onCall: (e) => {
      log.push(`call:${e.call.name}`);
      if (e.index === 0) controls.pause();
    },
    onResult: (e) => log.push(`result:${e.call.name}`),
  });

  await settle();

  assert.equal(controls.state, "paused");
  assert.deepEqual(
    log,
    [
      "before:select-where",
      "call:select-where",
      "result:select-where",
      // The row for the held call is on screen, pending: that is the point of
      // `onBeforeCall` firing ahead of the gate.
      "before:accept-selected",
    ],
    "the pause did not land between the two calls",
  );
  assert.deepEqual(app.accepted(), [], "a commit ran while the run was paused");
  // And the call in flight was not cut short: the describe verb's whole effect
  // is there to be seen.
  assert.equal(app.driver.snapshot().where, "contacts, filtered to Acme");

  controls.resume();
  const out = await run;
  assert.equal(out.stop, "answered");
  assert.equal(app.accepted().length, TOTAL, "resume did not carry on from the hold");
  assert.equal(controls.state, "running");
});

test("step runs exactly one more call and then holds again", async () => {
  // "One more" means one CALL, not one turn and not one step of the loop. A
  // model turn rides along on the permit unspent, because a call cannot happen
  // without the turn that asks for it — charging the permit to the model turn
  // would make every step need two presses, the second one doing what the first
  // one asked for.
  const app = contacts();
  const controls = runControls({ stepMode: true });
  const s = scripted([
    {
      calls: [
        call("select-where", { where: "company=Acme", limit: 1000 }),
        call("accept-selected"),
      ],
    },
    { text: "done" },
  ]);

  const ran: string[] = [];
  const run = drive(app.driver, {
    think: s.think,
    task: "accept the top thousand",
    controls,
    onCall: (e) => ran.push(e.call.name),
  });

  await settle();
  assert.deepEqual(ran, [], "step mode ran a call nobody asked for");

  controls.step();
  await settle();
  assert.deepEqual(ran, ["select-where"], "one step was not exactly one call");
  assert.equal(controls.state, "paused", "the run did not hold again after its step");
  assert.equal(controls.permits, 0, "the permit was not spent");
  assert.deepEqual(app.accepted(), []);

  controls.step();
  await settle();
  assert.deepEqual(ran, ["select-where", "accept-selected"]);
  assert.equal(app.accepted().length, 1000);

  // Still held, now in front of the model turn that will answer.
  assert.equal(controls.state, "paused");
  controls.resume();
  const out = await run;
  assert.equal(out.stop, "answered");
});

test("step mode starts paused, so nothing is spent until a step is asked for", async () => {
  // Including the model turn. A run that burned a round trip before its first
  // hold would have charged the person for a step they had not agreed to, which
  // is the one thing a step mode is for not doing.
  const app = contacts();
  const controls = runControls({ stepMode: true });
  const s = scripted([{ calls: [call("select-where", { where: "company=Acme" })] }, { text: "ok" }]);

  const states: string[] = [];
  const run = drive(app.driver, {
    think: s.think,
    task: "go",
    controls,
    onControl: (e) => states.push(`${e.state}@${e.step}`),
  });

  await settle();
  assert.equal(s.seen.length, 0, "step mode spent a model turn before its first step");
  assert.deepEqual(states, ["paused@0"], "a UI was not told the run starts held");
  assert.equal(controls.state, "paused");

  controls.resume();
  const out = await run;
  assert.equal(out.stop, "answered");
  assert.equal(states[1], "running@0", "the resume was not reported");
});

test("an abort wins over a pause, so a held run is stoppable and never wedged", async () => {
  // The worst possible outcome of this whole feature would be a paused run that
  // cannot be stopped: the person presses stop, the loop is parked on a promise
  // nobody will ever resolve, and the panel is dead. Every wait in the control
  // path takes the run's signal.
  const app = contacts();
  const controls = runControls({ stepMode: true });
  const controller = new AbortController();
  const s = scripted([{ calls: [call("accept-selected")] }, { text: "ok" }]);

  const run = drive(app.driver, {
    think: s.think,
    task: "go",
    controls,
    signal: controller.signal,
  });

  await settle();
  assert.equal(controls.state, "paused");

  controller.abort();
  const out = await run;

  assert.equal(out.stop, "aborted");
  assert.equal(out.steps, 0, "a model turn was spent after the stop");
  assert.deepEqual(app.accepted(), []);
  // Still paused: the run was stopped while held, and reporting that it resumed
  // on its way out would be a lie a panel would render.
  assert.equal(controls.state, "paused");
});

test("a pause mid-fan-out can be stopped instead of resumed, and leaves no call unanswered", async () => {
  // The two mechanisms crossing. A `tool_use` block with no result makes the
  // whole conversation unusable for every later run — see `abandoned` — so the
  // calls dropped by a stop pressed during a hold still owe the model an
  // answer, exactly as they do for a stop pressed anywhere else.
  const app = contacts();
  const controls = runControls();
  const controller = new AbortController();
  const s = scripted([
    {
      calls: [call("select-where", { where: "company=Acme" }), call("accept-selected")],
    },
  ]);

  const run = drive(app.driver, {
    think: s.think,
    task: "go",
    controls,
    signal: controller.signal,
    onCall: (e) => {
      if (e.index === 0) controls.pause();
    },
  });

  await settle();
  controller.abort();
  const out = await run;

  assert.equal(out.stop, "aborted");
  assert.deepEqual(app.accepted(), []);

  const assistant = out.messages.find((m) => m.role === "assistant" && m.calls)!;
  const ids = (assistant as { calls: Array<{ id: string }> }).calls.map((c) => c.id);
  const answered = out.messages.filter((m) => m.role === "tool").map((m) => m.callId);
  assert.deepEqual(answered.sort(), ids.sort(), "a call was left without a tool result");
});

test("resume drops an unspent step, and pause drops it too", async () => {
  // Both are the stronger statement about what happens next. A `step()` left
  // banked across a `pause()` would run a call after the person asked the run
  // to hold — which is the one thing pause means.
  const controls = runControls({ stepMode: true });
  controls.step();
  assert.equal(controls.permits, 1);
  controls.pause();
  assert.equal(controls.permits, 0, "a pause honoured a step the person had just overridden");

  controls.step();
  controls.resume();
  assert.equal(controls.permits, 0);
  assert.equal(controls.state, "running");
});

test("the events let a step list show a row before the call it describes has run", async () => {
  // The ordering a pending → running → done list is built from. `onBeforeCall`
  // is ahead of the pace wait, which is what gives the row time to appear and
  // glow before the app is touched; `onCall` is the last event before it is.
  const app = contacts();
  const log: string[] = [];
  const clock = instantClock(log);
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { text: "selected them" },
  ]);

  await drive(app.driver, {
    think: s.think,
    task: "go",
    pace: WATCHABLE_PACE,
    clock,
    onControl: (e) => log.push(`control:${e.state}@${e.step}`),
    onStep: (e) => log.push(`step:${e.step}`),
    onBeforeCall: (e) => log.push(`before:${e.call.name}:${e.index}/${e.of}`),
    onCall: (e) => log.push(`call:${e.call.name}`),
    onResult: (e) => log.push(`result:${e.call.name}:${e.result?.ok}`),
    onSay: (e) => log.push(`say:${e.text}`),
    onStop: (e) => log.push(`stop:${e.stop}`),
  });

  assert.deepEqual(log, [
    "control:running@0",
    "step:1",
    "before:select-where:0/1",
    "wait:600",
    "call:select-where",
    "result:select-where:true",
    "step:2",
    "say:selected them",
    "stop:answered",
  ]);
});

test("the commit gate is reported as its own state, not as a running run", async () => {
  // A panel that said "running" while the loop sat in front of a confirmation
  // would be telling the person to wait for the thing that is waiting for them.
  const app = contacts();
  const states: string[] = [];
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { calls: [call("accept-selected")] },
    { text: "done" },
  ]);

  await drive(app.driver, {
    think: s.think,
    task: "accept them",
    onControl: (e) => states.push(e.state),
    onBeforeCommit: () => true,
  });

  // Once, around the one commit. The describe verb is not gated, so it does not
  // appear — the gate is in front of commits only, which is what keeps it from
  // being a prompt storm.
  assert.deepEqual(states, ["running", "awaiting-approval", "running"]);
});

test("a confirmation UI that throws still leaves the reported state honest", async () => {
  // A failed ask is a no, and the run carries on. What must not survive it is a
  // panel stuck saying it is waiting for an answer nobody is being asked for.
  const app = contacts();
  const states: string[] = [];
  const s = scripted([{ calls: [call("accept-selected")] }, { text: "ok" }]);

  await drive(app.driver, {
    think: s.think,
    task: "accept them",
    onControl: (e) => states.push(e.state),
    onBeforeCommit: () => {
      throw new Error("the dialog host is gone");
    },
  });

  assert.deepEqual(states, ["running", "awaiting-approval", "running"]);
});

/** An app whose verbs name the elements they affect. */
function outlined(): ReturnType<typeof mount> {
  const visible = (): Snapshot => ({ where: "contacts", rev: 1, rows: [{ id: "c-1" }] });
  return mount({
    app: "Outlined",
    visible,
    verbs: [
      {
        name: "accept-selected",
        kind: "commit",
        at: "#contacts-table",
        describe: "accept the current selection",
        run: () => {},
      },
      {
        // No `at`. An app is not required to name one, and nothing may
        // manufacture one on its behalf.
        name: "open",
        kind: "read",
        describe: "open one contact",
        run: () => {},
      },
    ],
  });
}

test("at reaches the manifest and the step events, so a UI can outline what is about to happen", async () => {
  const driver = outlined();

  const byName = Object.fromEntries(driver.manifest().verbs.map((v) => [v.name, v]));
  assert.equal(byName["accept-selected"]!.at, "#contacts-table");
  assert.ok(!("at" in byName["open"]!), "an at was invented for a verb that declared none");

  const seen: Array<{ name: string; at?: string }> = [];
  const s = scripted([
    { calls: [call("accept-selected"), call("open")] },
    { text: "done" },
  ]);
  await drive(driver, {
    think: s.think,
    task: "go",
    onBeforeCall: (e) => seen.push({ name: e.call.name, ...(e.at === undefined ? {} : { at: e.at }) }),
  });

  // On `onBeforeCall` above all: the outline wants to be drawn before the verb
  // runs, which is the event that fires before the pace wait.
  assert.deepEqual(seen, [{ name: "accept-selected", at: "#contacts-table" }, { name: "open" }]);
});

test("at moves the manifest version, because it changes what the cached surface claims", async () => {
  // A UI holding a cached manifest would otherwise go on outlining the element
  // the verb no longer touches, with nothing to tell it the copy went stale.
  const plain = mount({
    app: "Outlined",
    visible: () => ({ where: "contacts", rev: 1 }),
    verbs: [{ name: "accept-selected", kind: "commit", describe: "accept the current selection", run: () => {} }],
  });
  const pointed = mount({
    app: "Outlined",
    visible: () => ({ where: "contacts", rev: 1 }),
    verbs: [
      {
        name: "accept-selected",
        kind: "commit",
        at: "#contacts-table",
        describe: "accept the current selection",
        run: () => {},
      },
    ],
  });

  assert.notEqual(plain.manifest().version, pointed.manifest().version);
});

test("at is never used to find anything, and never shown to the model", async () => {
  // The distinction the field lives or dies on. driverkit's claim is that an app
  // is driven through its own verbs and not by poking at its DOM; an `at` the
  // library resolved would be a back door straight back to selector automation,
  // and an `at` in the prompt would invite the model to ask for one.
  //
  // There is no DOM in this process at all, so a library that tried to resolve
  // a selector here would throw rather than quietly do the wrong thing — which
  // makes the passing call the assertion.
  assert.equal(
    (globalThis as { document?: unknown }).document,
    undefined,
    "this test only means something without a DOM",
  );

  const driver = mount({
    app: "Outlined",
    visible: () => ({ where: "contacts", rev: 1 }),
    verbs: [
      {
        name: "accept-selected",
        kind: "commit",
        // Deliberate nonsense, and deliberately nonsense that is also not a
        // valid selector. A wrong `at` must cost nothing but an outline drawn
        // in the wrong place.
        at: "#no-such-element >>> ::",
        describe: "accept the current selection",
        run: () => {},
      },
    ],
  });

  const s = scripted([{ calls: [call("accept-selected")] }, { text: "done" }]);
  const out = await drive(driver, { think: s.think, task: "go" });

  assert.equal(out.stop, "answered", "a selector that cannot resolve stopped a verb from running");

  const input = s.seen[0]!;
  assert.ok(!input.system.includes("no-such-element"), "at leaked into the system prompt");
  assert.ok(
    !JSON.stringify(input.tools).includes("no-such-element"),
    "at leaked into the tool list the model reads",
  );
  assert.ok(!JSON.stringify(input.tools).includes('"at"'), "the tool list grew an at field");
});
