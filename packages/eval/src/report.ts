/**
 * Printing the result, and refusing to print a score.
 *
 * **There is no aggregate number anywhere in this file.** Four things are
 * measured — verb chosen, arguments correct, steps taken, commits that should
 * not have happened — and they are not comparable. Three of them cost a retry.
 * The fourth costs the rows, is not undone by running again, and is the only
 * one of the four that can be zero and must stay zero. An "87%" would let a
 * false commit be paid for with two tidy navigations, so the layout makes that
 * impossible: false commits are printed first, alone, in their own block, with
 * the sentence that says what they are, and the other three follow under a
 * rule.
 *
 * The second thing the layout is for is the rate. A case's headline is `2/3`
 * and not a tick, because a model is a sampler and a verb list that works two
 * times in three is a finding. See `RunOptions.runs`.
 */

import type { CaseResult, DryResult, EvalCase, Judgement, Mark, SuiteResult } from "./types.ts";
import { parseBound } from "./case.ts";

/**
 * The line printed BEFORE anything runs.
 *
 * Required by the design: this costs real model calls, so the person at the
 * terminal is told how many and what will be reused before the first one is
 * spent. The upper bound is honest rather than flattering — `maxSteps` per
 * run is what a confused agent will actually use — and no price is quoted,
 * because this package cannot know what the caller's model costs and a made-up
 * dollar figure would be believed.
 */
export function renderPlan(options: {
  cases: EvalCase[];
  runs: number;
  maxSteps: number;
  cached: number;
  model: string;
  endpoint?: string;
}): string {
  const live = options.cases.filter((c) => !c.skip);
  const skipped = options.cases.length - live.length;
  const total = live.length * options.runs;
  const toRun = Math.max(0, total - options.cached);
  const lines = [
    `${live.length} case(s) × ${options.runs} run(s) = ${total} run(s)` +
      (skipped ? `, ${skipped} case(s) skipped` : "") +
      (options.cached ? `, ${options.cached} cached` : "") +
      `, ${toRun} to run.`,
    `At most ${toRun} × ${options.maxSteps} = ${toRun * options.maxSteps} model round trips ` +
      `against ${options.model}${options.endpoint ? ` via ${options.endpoint}` : ""}.`,
  ];
  if (toRun > 0) {
    lines.push(
      `This spends real model calls. It is not a CI check: run it when you change a verb's ` +
        `\`describe\`, and use \`--dry-run\` for everything else.`,
    );
  } else {
    lines.push(`Nothing to spend: every run is cached.`);
  }
  if (options.runs === 1) {
    lines.push(
      `⚠ --runs 1. One sample from a sampler is not a verdict; the report will say so.`,
    );
  }
  return lines.join("\n");
}

/** The whole report. */
export function renderReport(result: SuiteResult): string {
  const out: string[] = [];
  const live = result.cases.filter((c) => !c.skipped);

  out.push(
    `${result.app} — manifest ${result.manifestVersion}  ·  model ${result.model}  ` +
      `·  ${result.runs} run(s) per case`,
  );
  out.push("");

  // ---- the expensive number, alone -------------------------------------
  const falseCommits = live.flatMap((c) => c.falseCommits.map((call) => ({ case: c, call })));
  if (falseCommits.length === 0) {
    out.push(`  FALSE COMMITS          0`);
    out.push(
      `    No run changed data a case did not allow. This is the only number here that is ` +
        `not a retry.`,
    );
  } else {
    out.push(`  FALSE COMMITS          ${falseCommits.length}   ← FIX THIS FIRST`);
    out.push(
      `    Data moved that a case forbade. A wrong verb costs a retry; this costs the rows, ` +
        `and running again does not undo it.`,
    );
    for (const { case: c, call } of falseCommits) {
      out.push(
        `    ${c.id}: \`${call.name}\`${argText(call.args)}` +
          (call.count === undefined ? "" : ` on ${call.count} row(s)`),
      );
    }
  }
  out.push(`  ${"─".repeat(60)}`);

  // ---- the three that are retries --------------------------------------
  out.push(`  verb chosen            ${dimension(live, "verb")}`);
  out.push(`  arguments correct      ${dimension(live, "args")}`);
  out.push(`  counts as asserted     ${dimension(live, "counts")}`);
  const refusal = dimension(live, "refusal");
  if (!refusal.startsWith("—")) out.push(`  refusal reached        ${refusal}`);
  out.push(`  steps                  ${steps(live)}`);
  const asks = live.filter((c) => c.runs.some((r) => r.judgement.asked !== "n/a"));
  if (asks.length > 0) out.push(`  asked, not guessed     ${dimension(asks, "asked")}`);
  out.push("");

  // ---- case by case -----------------------------------------------------
  for (const c of result.cases) {
    if (c.skipped) {
      out.push(`  skip  ${pad(c.id, 26)} ${c.skipReason ?? ""}`);
      continue;
    }
    const rate = `${c.passed}/${c.attempted}`;
    const verdict = c.falseCommits.length > 0 ? "FALSE COMMIT" : c.passed === c.attempted ? "" : "FAILED";
    out.push(`  ${pad(rate, 5)} ${pad(c.id, 26)} ${verdict}`);
    if (c.passed === c.attempted && c.falseCommits.length === 0) {
      // Green: one line about the drift, and nothing else. A report that
      // printed as much for a pass as for a failure is a report people stop
      // reading at the top.
      const worst = Math.max(...c.runs.map((r) => r.judgement.steps.taken));
      const bound = c.runs[0]?.judgement.steps.bound;
      if (bound !== undefined && worst > bound) {
        out.push(`        ${worst} steps against a bound of ${bound} — drift, not a failure`);
      }
      continue;
    }
    if (c.why) out.push(`        why: ${c.why}`);
    out.push(`        ask: ${c.ask}`);
    // Notes from the runs, deduplicated: n runs of one broken verb list say
    // the same sentence n times, and the useful information is how often.
    const seen = new Map<string, number>();
    for (const run of c.runs) for (const note of run.judgement.notes) {
      seen.set(note, (seen.get(note) ?? 0) + 1);
    }
    for (const [note, times] of seen) {
      out.push(`        - ${note}${times > 1 ? ` (${times} of ${c.attempted} runs)` : ""}`);
    }
  }

  out.push("");
  out.push(
    `  ${result.modelCalls} model round trip(s) spent, ${result.cacheHits} run(s) from cache.`,
  );
  if (result.runs === 1) {
    out.push(
      `  ⚠ ONE RUN PER CASE. Every rate above is one draw from a sampler and must not be ` +
        `read as a verdict; a case that passed here may fail the next time with no change to ` +
        `your app. Use --runs 3 or more before you believe a green line.`,
    );
  }
  const flaky = live.filter((c) => c.passed > 0 && c.passed < c.attempted);
  if (flaky.length > 0) {
    out.push(
      `  ${flaky.length} case(s) passed sometimes: ${flaky.map((c) => c.id).join(", ")}. ` +
        `Sometimes is not a pass — it is the shape of a \`describe\` the model has to ` +
        `guess at.`,
    );
  }
  return out.join("\n");
}

/**
 * Diff mode: what moved.
 *
 * The actual workflow this package was built for. You change a `describe`,
 * re-run, and this says whether selection got better. A harness that printed
 * only today's score would leave you comparing two screenfuls by eye, which is
 * how a regression in case nine gets missed while case two improves.
 *
 * Rates rather than booleans, so a 1/3 → 3/3 shows up: that is the commonest
 * shape of a `describe` that got better, and it is invisible if a case is only
 * ever red or green.
 */
export function renderDiff(before: SuiteResult, after: SuiteResult): string {
  const out: string[] = [];
  const byId = new Map(before.cases.map((c) => [c.id, c]));
  out.push(
    `${before.at} → ${after.at}   manifest ${before.manifestVersion} → ` +
      `${after.manifestVersion}   model ${before.model} → ${after.model}`,
  );
  if (before.manifestVersion === after.manifestVersion) {
    out.push(
      `  note: the manifest version did not change, so the verb list is the same in both runs. ` +
        `Anything that moved below is the model, not your edit.`,
    );
  }
  if (before.model !== after.model) {
    out.push(`  note: the model changed too, so an improvement here is not attributable.`);
  }
  out.push("");

  const fcBefore = before.cases.reduce((n, c) => n + c.falseCommits.length, 0);
  const fcAfter = after.cases.reduce((n, c) => n + c.falseCommits.length, 0);
  out.push(
    `  FALSE COMMITS          ${fcBefore} → ${fcAfter}` +
      (fcAfter > fcBefore ? `   ← WORSE. Nothing else here matters until this is back down.` : ""),
  );
  out.push(`  ${"─".repeat(60)}`);

  let moved = 0;
  for (const now of after.cases) {
    const then = byId.get(now.id);
    if (!then) {
      out.push(`  ${pad("new", 11)} ${pad(now.id, 26)} ${now.passed}/${now.attempted}`);
      continue;
    }
    const rateThen = `${then.passed}/${then.attempted}`;
    const rateNow = `${now.passed}/${now.attempted}`;
    const stepsThen = median(then.runs.map((r) => r.judgement.steps.taken));
    const stepsNow = median(now.runs.map((r) => r.judgement.steps.taken));
    const better = share(now) > share(then);
    const worse = share(now) < share(then);
    const stepDelta = stepsNow - stepsThen;
    if (!better && !worse && stepDelta === 0 && then.falseCommits.length === now.falseCommits.length) {
      continue;
    }
    moved += 1;
    const tag = worse
      ? "REGRESSED"
      : better
        ? "better"
        : stepDelta < 0
          ? "fewer steps"
          : stepDelta > 0
            ? "more steps"
            : "changed";
    out.push(
      `  ${pad(tag, 11)} ${pad(now.id, 26)} ${rateThen} → ${rateNow}` +
        (stepDelta === 0
          ? ""
          : `   steps ${stepsThen} → ${stepsNow} (${stepDelta > 0 ? "+" : ""}${stepDelta})`),
    );
    if (worse) {
      const notes = new Set(now.runs.flatMap((r) => r.judgement.notes));
      for (const note of notes) out.push(`              - ${note}`);
    }
  }
  for (const then of before.cases) {
    if (!after.cases.some((c) => c.id === then.id)) {
      out.push(`  ${pad("gone", 11)} ${pad(then.id, 26)} was ${then.passed}/${then.attempted}`);
    }
  }

  if (moved === 0) out.push(`  nothing moved.`);
  return out.join("\n");
}

/** `--dry-run`'s own report. */
export function renderDry(dry: DryResult): string {
  const out: string[] = [];
  for (const line of dry.errors) out.push(`  ERROR    ${line}`);
  for (const line of dry.warnings) out.push(`  warn     ${line}`);
  if (dry.replayed.length > 0) {
    out.push("");
    out.push(`  replayed against the real driver, with no model:`);
    for (const r of dry.replayed) {
      const ok = r.actual === r.expected;
      out.push(
        `    ${ok ? "ok  " : "DRIFT"} ${pad(r.id, 26)} \`${r.verb}\` reported ` +
          `${r.actual ?? "no count"}, case says ${r.expected}`,
      );
    }
  }
  if (dry.unexercised.length > 0) {
    out.push("");
    out.push(`  verbs no case mentions (${dry.unexercised.length}): ${dry.unexercised.join(", ")}`);
    out.push(
      `  Not an error — most apps have verbs nobody evaluates. It is the list of things ` +
        `nothing is watching, which is where the next surprise comes from.`,
    );
  }
  out.push("");
  out.push(
    dry.errors.length === 0
      ? `  ${dry.errors.length} error(s), ${dry.warnings.length} warning(s). The case files ` +
          `agree with the verb list and with the fixture.`
      : `  ${dry.errors.length} error(s), ${dry.warnings.length} warning(s). No model was called.`,
  );
  return out.join("\n");
}

// ---- small helpers -------------------------------------------------------

/**
 * One dimension as "cases that never got it wrong / cases that asserted it".
 *
 * Never-got-it-wrong rather than majority: a dimension that was right twice
 * and wrong once is not a case this dimension passes, for the same reason a
 * case is green only if every run passed. The run count is printed beside it
 * so "8/10 cases (26/30 runs)" distinguishes two broken cases from six flaky
 * ones, which want different fixes.
 */
function dimension(cases: CaseResult[], key: "verb" | "args" | "counts" | "refusal" | "asked"): string {
  const asserting = cases.filter((c) =>
    c.runs.some((r) => r.judgement[key] !== "n/a" && r.judgement[key] !== "skip"),
  );
  if (asserting.length === 0) return `— no case asserts it`;
  const clean = asserting.filter((c) => c.runs.every((r) => r.judgement[key] !== "wrong"));
  const runs = asserting.flatMap((c) => c.runs.map((r) => r.judgement[key]));
  const okRuns = runs.filter((m: Mark) => m === "ok").length;
  return `${clean.length}/${asserting.length} cases   (${okRuns}/${runs.length} runs)`;
}

function steps(cases: CaseResult[]): string {
  const all = cases.flatMap((c) => c.runs.map((r) => r.judgement.steps.taken));
  if (all.length === 0) return "—";
  const bounded = cases.filter((c) => c.runs.some((r) => r.judgement.steps.bound !== undefined));
  const over = bounded.filter((c) => c.runs.some((r) => r.judgement.steps.over));
  return (
    `median ${median(all)}, worst ${Math.max(...all)}` +
    (bounded.length === 0
      ? `   (no case sets a bound)`
      : `   over bound in ${over.length}/${bounded.length} bounded case(s)` +
        (over.length ? ` — drift, counted apart from correctness` : ""))
  );
}

function share(c: CaseResult): number {
  return c.attempted === 0 ? 0 : c.passed / c.attempted;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function argText(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  return entries.length === 0
    ? "()"
    : `(${entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`;
}

/** Exported so the CLI's exit code and the report agree about what red means:
 *  a false commit anywhere, or any case that did not pass every run. */
export function failed(result: SuiteResult): boolean {
  return result.cases.some((c) => !c.skipped && (c.falseCommits.length > 0 || c.passed < c.attempted));
}

/** Diff mode's exit code: a regression, or a new false commit. An improvement
 *  is never a failure, and a case that stayed red is not a *new* failure —
 *  `failed` is the check for "is it good", this is "did my edit make it
 *  worse". */
export function regressed(before: SuiteResult, after: SuiteResult): boolean {
  const byId = new Map(before.cases.map((c) => [c.id, c]));
  const fcBefore = before.cases.reduce((n, c) => n + c.falseCommits.length, 0);
  const fcAfter = after.cases.reduce((n, c) => n + c.falseCommits.length, 0);
  if (fcAfter > fcBefore) return true;
  return after.cases.some((now) => {
    const then = byId.get(now.id);
    return then !== undefined && share(now) < share(then);
  });
}

/** Re-exported for the CLI, which needs a bound to print a plan. */
export { parseBound };

/** The judgement marks, for a caller rendering its own table. */
export type { Judgement };
