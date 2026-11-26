/**
 * Replaying a case against a real driver and a real model.
 *
 * Four decisions, all of them about honesty rather than about plumbing.
 *
 * **A fresh driver per run.** `newDriver()` is called for every single run, so
 * a false commit in case three cannot change the counts case seven asserts.
 * Sharing one driver would make the suite order-dependent and the failure
 * would surface as a count that drifted — the exact symptom this harness
 * reserves for "the fixture moved", which it would then be lying about.
 *
 * **No approval gate. On purpose, and it is the most important line in this
 * file.** `drive` takes an `onBeforeCommit` and `mountWidget` turns it on;
 * this harness does not pass one, and must not. The number this package exists
 * to report is *commits that should not have happened*, and a gate that
 * vetoed them would report zero forever while the verb list that invites them
 * stays broken. The eval is the one place in the library where you WANT the
 * dangerous call to go through, because it is a throwaway fixture in memory
 * and the alternative is finding out in production.
 *
 * **`pace: 0`, headless, no browser.** There is nobody watching an eval, so
 * the pacing that exists for a person is pure latency here. The demo's store
 * is DOM-free for exactly this reason.
 *
 * **The model is a `Think`.** This file never constructs an HTTP client, never
 * reads an environment variable and never sees an API key; the CLI's default
 * is the demo's own `/api/chat`, which keeps the key on the server. See
 * `backendThink` in `@driverkit/agent`.
 */

import { drive } from "@driverkit/agent";
import type { Driver, Manifest, Scalar } from "driverkit";

import { cacheKey } from "./case.ts";
import { askMechanism, judge } from "./score.ts";
import type {
  CallRecord,
  CaseResult,
  EvalCase,
  Judgement,
  RunOptions,
  SuiteResult,
  Transcript,
} from "./types.ts";

/** Thrown when a case's `setup` does not apply. Not a finding about the verb
 *  list: the case asked for an arrangement the app refused, so the ask was
 *  never put to the model and anything scored from here would be about the
 *  wrong screen. */
export class SetupError extends Error {}

export interface RunCaseOptions
  extends Pick<RunOptions, "think" | "maxSteps" | "instructions" | "signal"> {}

/**
 * One run of one case. Returns what happened, judges nothing.
 *
 * Separated from `judge` so that a transcript can be cached, saved, diffed and
 * re-scored against an edited expectation without paying for the model again —
 * which is also what makes `--diff` able to say "the agent did the same thing;
 * you changed the case".
 */
export async function runCase(
  driver: Driver,
  c: EvalCase,
  options: RunCaseOptions,
): Promise<Transcript> {
  for (const step of c.setup ?? []) {
    const result = await driver.call(step.verb, step.args ?? {});
    if (!result.ok) {
      throw new SetupError(
        `${c.id}: setup \`${step.verb}\` was refused \`${result.refused}\`` +
          (result.hint ? ` — ${result.hint}` : ""),
      );
    }
  }

  const calls: CallRecord[] = [];
  const started = Date.now();

  const outcome = await drive(driver, {
    think: options.think,
    task: c.ask,
    // A person's pace is latency to a harness. See the file comment.
    pace: 0,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // Deliberately no `onBeforeCommit`. See the file comment.
    onResult: (e) => {
      const record: CallRecord = {
        step: e.step,
        name: e.call.name,
        args: e.call.args as Record<string, Scalar>,
        ...(e.kind === undefined ? {} : { kind: e.kind }),
        // `null` for `read_screen` and for a name the manifest does not have:
        // no verb ran, so neither "it worked" nor "it was refused" is true.
        ok: e.result === null ? null : e.result.ok,
      };
      if (e.result && e.result.ok === false) record.refused = e.result.refused;
      if (e.result && e.result.ok === true && e.result.count !== undefined) {
        record.count = e.result.count;
      }
      calls.push(record);
    },
  });

  return {
    calls,
    steps: outcome.steps,
    stop: outcome.stop,
    ...(outcome.text === undefined ? {} : { text: outcome.text }),
    ms: Date.now() - started,
  };
}

/**
 * Every case, n times each, scored.
 *
 * The rate is the headline and a case is green only if every run passed. The
 * argument is in `RunOptions.runs` and it is short: a model is a sampler, so
 * one draw is not a verdict, and a case that passes two times in three is a
 * finding rather than a pass. Reporting the rate rather than a boolean is also
 * what makes `--diff` useful — 1/3 → 3/3 is the shape of a `describe` that got
 * better, and with booleans it is invisible.
 */
export async function runSuite(cases: EvalCase[], options: RunOptions): Promise<SuiteResult> {
  const runs = options.runs ?? 3;
  const probe = await options.newDriver();
  const manifest: Manifest = probe.manifest();
  probe.unmount();
  const model = options.model ?? "unknown";
  const askVerb = askMechanism(manifest, options.askVerb);
  const judgeOptions = { manifest, askVerb };

  const results: CaseResult[] = [];
  let modelCalls = 0;
  let cacheHits = 0;

  for (const c of cases) {
    if (c.skip) {
      results.push({
        id: c.id,
        ask: c.ask,
        ...(c.why === undefined ? {} : { why: c.why }),
        skipped: true,
        skipReason: c.skip,
        runs: [],
        passed: 0,
        attempted: 0,
        falseCommits: [],
      });
      continue;
    }

    const scored: Array<{ transcript: Transcript; judgement: Judgement }> = [];
    for (let run = 0; run < runs; run += 1) {
      const key = cacheKey(c, manifest.version, model, run);
      const hit = options.cache?.get(key);
      options.onRun?.({
        case: c,
        run: run + 1,
        of: runs,
        phase: "start",
        ...(hit ? { cached: true } : {}),
      });

      let transcript: Transcript;
      if (hit) {
        transcript = { ...hit, cached: true };
        cacheHits += 1;
      } else {
        const driver = await options.newDriver();
        try {
          transcript = await runCase(driver, c, options);
        } finally {
          driver.unmount();
        }
        modelCalls += transcript.steps;
        options.cache?.set(key, transcript);
      }

      const judgement = judge(c, transcript, judgeOptions);
      scored.push({ transcript, judgement });
      options.onRun?.({
        case: c,
        run: run + 1,
        of: runs,
        phase: "done",
        ...(transcript.cached ? { cached: true } : {}),
        judgement,
      });
      if (options.signal?.aborted) break;
    }

    results.push({
      id: c.id,
      ask: c.ask,
      ...(c.why === undefined ? {} : { why: c.why }),
      runs: scored,
      passed: scored.filter((r) => r.judgement.pass).length,
      attempted: scored.length,
      falseCommits: scored.flatMap((r) => r.judgement.falseCommits),
    });

    if (options.signal?.aborted) break;
  }

  return {
    at: new Date().toISOString(),
    manifestVersion: manifest.version,
    app: manifest.app,
    model,
    runs,
    cases: results,
    modelCalls,
    cacheHits,
  };
}
