/**
 * driverkit/agent — pacing and run controls.
 *
 * `drive()` on its own goes as fast as the model answers, which is right for a
 * headless caller and wrong for the case this package was built for: the agent
 * is moving the screen a person is looking at. A run nobody can follow is a run
 * nobody can stop, and "it already accepted them" is not a thing a person
 * should learn after the fact. So there are two mechanisms in here, and they
 * are deliberately separate.
 *
 * **Pacing** is a wait before each verb call. Its only job is to make the run
 * legible — a row appears, glows, then the verb fires — and the one property it
 * must have is that it is *cancellable*. A stop button that takes 600ms to
 * notice is a stop button a person presses twice; worse, a stop pressed during
 * a wait that is not cancellable gets the abort processed only after the wait,
 * which on a page with a 2s pace reads as a frozen panel.
 *
 * **Run controls** are pause, resume and step. These are not an abort: an abort
 * ends the run and abandons the model's calls, whereas a pause holds the run
 * open with its conversation intact so it can go on. Both exist because they
 * answer different questions — "stop, I have seen enough" and "wait, let me
 * read that before you do the next one".
 *
 * Three decisions worth stating, because they are what the tests pin:
 *
 * **1. A pause holds BETWEEN calls, never inside one.** The call in flight runs
 * to completion and its result is fed back. Anything else would need the app's
 * verb to be interruptible halfway, which no app promises and which would leave
 * the screen in a state neither the person nor the model can describe.
 *
 * **2. An abort outranks a pause.** A paused run that could not be stopped
 * would be the worst outcome of the whole feature: the person presses stop, the
 * loop is parked on a promise nobody will resolve, and the panel is wedged.
 * Every wait in here — the pace wait and the control gate both — takes the
 * run's signal and returns immediately when it fires.
 *
 * **3. None of this reaches the model.** Pacing and control state are runtime
 * state. `system` and `tools` are computed once from the manifest and must stay
 * byte-identical across turns, and a model told "the run is paused" would
 * start reasoning about the pause.
 */

import type { Clock, ControlState, RunControls } from "./types.ts";

/**
 * A pace a person can actually watch, in milliseconds.
 *
 * Exported rather than left as a literal in two places, because the choice of
 * default belongs to the *caller* and the two callers want different ones.
 * `drive()` defaults to 0: it is a library primitive driven by backend jobs,
 * tests and CLIs, where nobody is watching and an invented 600ms per call is
 * pure latency added to work that has no eyes on it. A widget mounted in a page
 * defaults to this, because there is a person in front of it by definition.
 * Same shape as `onBeforeCommit`, which is off in `drive` and on in
 * `mountWidget`, and for the same reason.
 *
 * 600ms is a judgement, not a measurement: long enough that a row appearing and
 * then firing reads as two events rather than one flicker, short enough that a
 * five-step run still finishes in about the time a person will sit through.
 */
export const WATCHABLE_PACE = 600;

/**
 * The real timer, and the only place in this package that touches one.
 *
 * Injectable for one reason: a suite that actually slept its paces would take
 * seconds to assert something that is pure logic, and a slow suite is a suite
 * that gets run less. The tests hand `drive` a fake clock and count the waits.
 */
export const realClock: Clock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** What `paceWait` needs. An object rather than four positional arguments,
 *  because three of them are optional and two of those are functions. */
export interface PaceWaitOptions {
  /** The pace in milliseconds. A function is re-read on every re-arm, which is
   *  what lets a live `controls.pace()` reach a wait already running. */
  ms: number | (() => number);
  clock: Clock;
  signal?: AbortSignal;
  /** Subscribe to "the pace may have changed"; returns an unsubscribe. Usually
   *  `RunControls.subscribe`. Without it the wait is armed once. */
  watch?: (listener: () => void) => () => void;
}

/**
 * Wait out the pace, or return at once if the run is aborted — whichever first.
 *
 * A pace of 0 (or a negative, or a NaN from a parsed input) schedules no timer
 * at all rather than a zero-delay one. Not a micro-optimisation: a headless run
 * is the default, and "pacing off" should mean the pacing code is not in the
 * path, so that a `drive()` with no human watching cannot be made slower by a
 * bug in here.
 *
 * **The wait is re-armed against the pace rather than fixed at the value it
 * started with.** Cutting 5s to 200ms with 4s still to run is exactly the
 * moment somebody is jabbing at the slider, and a wait that rode out its old
 * value would be the thing they are already annoyed about, happening again. So
 * every wake — the timer firing, or the pace changing — recomputes
 * `pace - elapsed`, and a wait already longer than the new pace ends at once.
 * Lengthening works the same way round. Elapsed is measured from when the wait
 * started, so moving the slider never restarts the wait and cannot be used to
 * hold a run open.
 *
 * The abort path resolves rather than rejects, and is checked on every wake.
 * Every caller in the loop checks `signal.aborted` on the next line anyway, and
 * a rejection would turn an ordinary stop into an exception that the loop's one
 * `try` was not written to catch.
 */
export function paceWait({ ms, clock, signal, watch }: PaceWaitOptions): Promise<void> {
  const pace = typeof ms === "function" ? ms : () => ms;
  const now = clock.now ? () => clock.now!() : Date.now;

  if (!(pace() > 0) || signal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const started = now();
    let handle: unknown;
    let settled = false;
    let unwatch: (() => void) | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) clock.clear(handle);
      unwatch?.();
      signal?.removeEventListener?.("abort", finish);
      resolve();
    };

    /** Re-read the pace and schedule what is left of it, or end the wait.
     *
     *  Also the timer's own callback: a timer that fires lands here, finds
     *  nothing left and finishes, so "the timer fired" and "the pace moved" are
     *  one piece of arithmetic rather than two that can come to disagree. */
    const arm = (): void => {
      if (settled) return;
      if (signal?.aborted) return finish();
      if (handle !== undefined) {
        clock.clear(handle);
        handle = undefined;
      }
      const remaining = pace() - (now() - started);
      // `!(remaining > 0)` rather than `<= 0`, so a NaN that got past the check
      // above ends the wait instead of scheduling a timer for NaN.
      if (!(remaining > 0)) return finish();
      // Assigned after the call, and checked, because a fake clock in a test may
      // fire synchronously — in which case `arm` has already run again and this
      // handle is the stale one.
      const scheduled = clock.set(arm, remaining);
      if (!settled && handle === undefined) handle = scheduled;
    };

    unwatch = watch?.(arm);
    signal?.addEventListener?.("abort", finish, { once: true });
    arm();
  });
}

/**
 * A pace value, or `fallback` if it is not one.
 *
 * Three rules, and the asymmetry between them is the point. A negative becomes
 * 0, because "less than no wait" has exactly one sensible reading. Anything
 * non-finite — `NaN` from a parsed input, `Infinity` from a divide, `undefined`
 * from an unset option — is **refused**, keeping what was there before: reading
 * it as 0 would make the agent run faster than the person asked, and reading
 * `Infinity` as a delay would park the run on a timer nobody meant to set.
 * Neither is a thing to guess at, and the current pace is the one value that is
 * certainly not a surprise.
 */
function clean(ms: number | undefined, fallback: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return fallback;
  return ms < 0 ? 0 : ms;
}

/** Options for `runControls`. */
export interface RunControlsOptions {
  /** The pace to start with, in milliseconds. `drive`'s own `pace` option
   *  overrides it at the start of a run — the run is the thing being paced —
   *  and `pace()` then wins over both. */
  pace?: number;
  /**
   * Start paused, so every call needs its own `step()`. This is "step mode",
   * and it is not a second mode: there is no flag for it beyond this, because a
   * `stepMode` that lived alongside `state` would be a second source of truth
   * able to disagree with the first. Step mode IS "paused, and stepped one call
   * at a time".
   */
  stepMode?: boolean;
}

/**
 * Pause, resume and step for a run.
 *
 * ```ts
 * const controls = runControls();
 * drive(driver, { think, task, controls, pace: WATCHABLE_PACE, signal });
 * controls.pause();  // finishes the call in flight, then holds
 * controls.step();   // exactly one more call, then holds again
 * controls.resume(); // carry on
 * ```
 *
 * **Why an object passed in and not a handle returned from `drive`.** `drive`
 * returns a promise that settles when the run is *over*, so anything returned
 * from it is unreachable during the only window in which pausing means
 * anything. The alternatives were to change `drive` to return
 * `{ controls, done }` — which breaks every existing caller and every test that
 * awaits the outcome directly — or to hand the controls out through a callback,
 * which is a handle with extra steps. Passing one in keeps `drive`'s signature,
 * matches `AbortController`/`AbortSignal` (which this sits beside and must not
 * contradict), and lets a caller build the control surface before the run
 * starts and reuse it across runs.
 *
 * It is a plain object with methods: no DOM, no events, no framework. A CLI can
 * call `pause()` from a keypress handler, a test can call it from inside a
 * scripted `think`, and the widget can wire it to buttons without this package
 * knowing a button exists.
 */
export function runControls(options: RunControlsOptions = {}): RunControls {
  let state: ControlState = options.stepMode ? "paused" : "running";

  /**
   * Outstanding `step()` permits — in practice 0 or 1.
   *
   * A permit rather than a "run one more call" boolean because it has to be
   * spendable: `step()` has to mean exactly one call, and the only way to be
   * sure of that is for the thing granting it to be consumed by the call that
   * uses it.
   */
  let permits = 0;

  /** The live pace. Owned here rather than in `drive`, because it has to
   *  outlive any single wait and be settable from outside the loop. */
  let paceMs = clean(options.pace, 0);

  /** Parked gates, each of which re-checks the state when woken. A Set and not
   *  an array that gets emptied: one `step()` wakes everybody and only one of
   *  them may consume the permit, so the losers have to stay parked. */
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of [...waiters]) waiter();
  };

  /** Subscribers to "something here changed". Kept apart from `waiters`: one
   *  set is the loop being let through, the other is a UI being told, and
   *  conflating them would mean a UI listener could hold up the run. */
  const listeners = new Set<() => void>();
  const notify = (): void => {
    // One broken listener must not stop the others being told, and above all
    // must not stop `drive`'s own re-arm being told, since the live pace rides
    // on it — a panel whose redraw throws would otherwise silently take pacing
    // down with it. So everybody is told first and the failure is raised after.
    let failure: unknown;
    let failed = false;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
      }
    }
    // Raised rather than swallowed, and raised synchronously at whoever called
    // `pause`/`step`/`resume`/`pace`: it is their listener and their stack, and
    // a silently eaten exception in a UI callback is a bug that gets found
    // weeks later. The control change itself has already happened and stands —
    // a listener cannot veto it.
    if (failed) throw failure;
  };

  return {
    get state() {
      return state;
    },
    get permits() {
      return permits;
    },
    get paceMs() {
      return paceMs;
    },

    pause() {
      const was = `${state}:${permits}`;
      state = "paused";
      // A pending step is dropped. "Pause" from a person who just pressed step
      // means "no, not even that one" — honouring the permit would run a call
      // after they asked for the run to hold.
      permits = 0;
      if (was !== `${state}:${permits}`) notify();
    },

    resume() {
      const was = `${state}:${permits}`;
      state = "running";
      permits = 0;
      wake();
      if (was !== `${state}:${permits}`) notify();
    },

    step() {
      // Paused with one permit, whichever state we were in. Stepping from a
      // running run is a legitimate thing to ask for — "do the next one and
      // then wait" — and it must not need two calls to express.
      const was = `${state}:${permits}`;
      state = "paused";
      permits = 1;
      wake();
      if (was !== `${state}:${permits}`) notify();
    },

    pace(ms) {
      const next = clean(ms, paceMs);
      if (next === paceMs) return;
      paceMs = next;
      // Last, so a listener that reads `paceMs` — `drive`'s re-arm included —
      // sees the new value rather than the one it is replacing.
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    gate(what, signal) {
      // Aborted runs are never held. The loop checks `signal.aborted` straight
      // after this returns and will end the run there; parking here would wedge
      // it instead.
      if (signal?.aborted) return Promise.resolve();
      if (state === "running") return Promise.resolve();

      if (permits > 0) {
        // Only a verb call spends the permit. A model round trip rides along on
        // it unspent, because `step()` promises one more CALL and a call cannot
        // happen without the turn that asks for it — charging the permit to the
        // `think` would make every step need two presses, with the second one
        // doing the thing the first one asked for.
        if (what === "call") permits--;
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        let settled = false;

        const finish = (): void => {
          if (settled) return;
          settled = true;
          waiters.delete(attempt);
          signal?.removeEventListener?.("abort", finish);
          resolve();
        };

        const attempt = (): void => {
          if (settled) return;
          if (state === "running") return finish();
          if (permits > 0) {
            if (what === "call") permits--;
            finish();
          }
          // Still paused with nothing granted: stay parked.
        };

        waiters.add(attempt);
        signal?.addEventListener?.("abort", finish, { once: true });
      });
    },
  };
}
