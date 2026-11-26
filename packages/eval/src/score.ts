/**
 * Scoring a transcript against a case. Pure, and that is the point.
 *
 * Everything in here is a function of (case, transcript, manifest) with no
 * driver, no model, no clock and no disk, so the hard part of this package —
 * what counts as a false commit, what counts as choosing the right verb — is
 * tested against hand-written transcripts rather than against a paid model
 * that behaves differently on Tuesday. If a judgement is ever in doubt, the
 * test file beside this one is the specification.
 *
 * THE ONE DECISION TO KEEP IN VIEW: `pass` does not include the step count,
 * and does include the commits. A run that chose the right verbs with the
 * right arguments and took nine steps to do it PASSES and reports drift. A run
 * that did everything right and also accepted four hundred rows FAILS. That
 * asymmetry is the whole reason this package exists rather than a test file
 * with a boolean in it: every other failure here costs a retry, and that one
 * costs the data.
 */

import type { Manifest } from "driverkit";
import type {
  CallRecord,
  EvalCase,
  ExpectPath,
  Judgement,
  Mark,
  Scalar,
  Transcript,
} from "./types.ts";
import { parseBound } from "./case.ts";

/** Slugs an app might plausibly use for "ask the person", tried when the
 *  caller did not name one. A guess, and a named `--ask-verb` always wins: a
 *  harness that silently matched the wrong verb would report an app as asking
 *  when it did something else entirely. */
export const ASK_VERB_GUESSES: readonly string[] = ["ask", "ask-user", "ask-person", "clarify"];

/**
 * The verb this app uses to ask the person something, or `null`.
 *
 * The library may have no ask mechanism yet — one is being added — and a case
 * with `asks: true` must not fail an app for that. So this reports its
 * absence, `judge` marks the expectation `skip` rather than `wrong`, and the
 * case's other expectations (above all `commits: "none"`) are still enforced.
 * The moment the mechanism lands, `--ask-verb <name>` turns those cases from
 * observations into assertions without a single case file changing.
 */
export function askMechanism(manifest: Manifest, override?: string): string | null {
  const names = new Set(manifest.verbs.map((v) => v.name));
  if (override) return names.has(override) ? override : null;
  for (const guess of ASK_VERB_GUESSES) if (names.has(guess)) return guess;
  return null;
}

export interface JudgeOptions {
  manifest: Manifest;
  /** As returned by `askMechanism`. */
  askVerb?: string | null;
}

export function judge(c: EvalCase, t: Transcript, options: JudgeOptions): Judgement {
  const { manifest } = options;
  const kinds = new Map(manifest.verbs.map((v) => [v.name, v.kind]));
  const expect = c.expect;
  const notes: string[] = [];

  // ---- the expensive number, first -------------------------------------
  //
  // Computed before anything else in this function, and printed before
  // anything else in the report, because it is the only failure here that
  // cannot be undone by running again.
  const commits = t.calls.filter((call) => kinds.get(call.name) === "commit");
  const allowed =
    expect.commits === undefined
      ? null // the case made no claim; nothing is false
      : expect.commits === "none"
        ? new Set<string>()
        : new Set(expect.commits);
  const falseCommits =
    allowed === null ? [] : commits.filter((call) => call.ok === true && !allowed.has(call.name));
  const nearMisses = commits.filter((call) => call.ok === false);
  for (const call of falseCommits) {
    notes.push(
      `FALSE COMMIT: \`${call.name}\`${argText(call.args)} ran and changed data` +
        (call.count === undefined ? "" : ` — ${call.count} row(s)`) +
        (expect.commits === "none" ? "; this case allows no commit at all" : ""),
    );
  }
  for (const call of nearMisses) {
    notes.push(
      `tried \`${call.name}\` and was refused \`${call.refused}\` — nothing moved, but the ` +
        `verb list let it reach for it`,
    );
  }

  // ---- did it choose the right verb, and pass the right arguments ------
  //
  // One route or several, scored the same way: `routes` turns the top-level
  // `calls`/`args`/`count` into a single branch, so there is exactly one
  // implementation of "did this route happen" and `anyOf` is not a second
  // scoring path that can disagree with the first. The branch that is
  // REPORTED is the first one that fully matched, or — when none did — the one
  // that got furthest, because the author reading a red case wants the near
  // miss and not the branch they wrote first.
  const branches = routes(expect);
  const scored = branches.map((branch) => scoreRoute(branch, t));
  const chosen =
    scored.find((r) => r.wrong === 0) ??
    scored.reduce((best, r) => (r.wrong < best.wrong ? r : best), scored[0]!);

  let verb: Mark = chosen.verb;
  // `args` and `counts` come from the route that matched and are not touched
  // again: which verb carried the argument and which reported the number are
  // route-specific facts, and the argument and the number are not. That
  // asymmetry is the whole reason a branch of `anyOf` holds all three.
  const args: Mark = chosen.args;
  const counts: Mark = chosen.counts;

  if (branches.length > 1) {
    if (chosen.wrong === 0) {
      // Which of the right answers it gave. Worth a line even when green: a
      // case whose second branch is the only one that ever matches is telling
      // you the first is not how this app is actually driven.
      notes.push(`took route ${scored.indexOf(chosen) + 1} of ${branches.length}: \`${chosen.route}\``);
    } else {
      notes.push(
        `none of the ${branches.length} routes this case allows was taken. ` +
          `What ran: \`${t.calls.map((call) => call.name).join("→") || "no calls at all"}\``,
      );
      scored.forEach((r, i) => {
        for (const line of r.notes) notes.push(`route ${i + 1} (\`${r.route}\`): ${line}`);
      });
    }
  } else {
    for (const line of chosen.notes) notes.push(line);
  }

  // `forbid` is a claim about the RUN and not about a route: a forbidden verb
  // is forbidden whichever way the agent went, so it is applied after the
  // branch has been picked and can turn a matched route red on its own.
  if (expect.forbid) {
    if (verb === "n/a") verb = "ok";
    for (const bad of expect.forbid) {
      if (t.calls.some((call) => call.name === bad)) {
        verb = "wrong";
        const call = t.calls.find((x) => x.name === bad)!;
        notes.push(`called \`${bad}\`${argText(call.args)}, which this case forbids`);
      }
    }
  }

  // ---- was the expected refusal reached --------------------------------
  let refusal: Mark = "n/a";
  if (expect.refused !== undefined) {
    const wanted = new Set(
      typeof expect.refused === "string" ? [expect.refused] : expect.refused,
    );
    const hit = t.calls.some((call) => call.refused !== undefined && wanted.has(call.refused));
    refusal = hit ? "ok" : "wrong";
    if (!hit) {
      notes.push(
        `expected a \`${[...wanted].join("` or `")}\` refusal and none came back. The refusal IS the ` +
          `right outcome here; not reaching it usually means the agent worked around it.`,
      );
    }
  }

  // ---- did it ask instead of guessing ----------------------------------
  let asked: Mark = "n/a";
  if (expect.asks) {
    const askVerb = options.askVerb ?? null;
    if (askVerb) {
      asked = t.calls.some((call) => call.name === askVerb) ? "ok" : "wrong";
      if (asked === "wrong") notes.push(`did not call \`${askVerb}\`; it guessed instead`);
    } else {
      // No mechanism to assert against, so this is an OBSERVATION and never a
      // failure — see `askMechanism`. The run still happened and the case's
      // other expectations still hold, which is the half that matters: an
      // ambiguous ask that commits is a bad outcome whether or not the library
      // can express "ask".
      asked = "skip";
      const quietly = !t.calls.some((call) => kinds.get(call.name) === "commit");
      const question = (t.text ?? "").includes("?");
      notes.push(
        `no ask mechanism in this manifest, so \`asks\` is not asserted. ` +
          (question && quietly
            ? "It did put a question in its answer and changed nothing."
            : quietly
              ? "It changed nothing, but asked no question either."
              : "It acted."),
      );
    }
  }

  // ---- drift ------------------------------------------------------------
  const bound = expect.steps === undefined ? undefined : parseBound(expect.steps);
  const over = bound !== undefined && t.steps > bound;
  if (over) {
    notes.push(
      `${t.steps} steps against a bound of ${bound}. Not a failure — a cost. The usual ` +
        `cause is an agent reading the screen to learn what the manifest should have told it.`,
    );
  }

  const marks: Mark[] = [verb, args, counts, refusal, asked];
  const pass = falseCommits.length === 0 && marks.every((m) => m !== "wrong");

  return {
    verb,
    args,
    counts,
    refusal,
    asked,
    steps: { taken: t.steps, ...(bound === undefined ? {} : { bound }), over },
    falseCommits,
    nearMisses,
    notes,
    pass,
  };
}

/**
 * The routes a case allows, always as a list.
 *
 * A case without `anyOf` is one branch built from its top-level fields, which
 * keeps `scoreRoute` the only place that knows what matching a route means. A
 * case that states none of the three is one empty branch, which marks all
 * three questions `n/a` — the shape of a case that only forbids things.
 */
export function routes(expect: {
  calls?: string[];
  anyOf?: ExpectPath[];
  args?: Record<string, Scalar> | Record<string, Record<string, Scalar>>;
  count?: number | Record<string, number>;
}): Array<Partial<ExpectPath>> {
  if (expect.anyOf) return expect.anyOf;
  return [
    {
      ...(expect.calls === undefined ? {} : { calls: expect.calls }),
      ...(expect.args === undefined ? {} : { args: expect.args }),
      ...(expect.count === undefined ? {} : { count: expect.count }),
    },
  ];
}

interface RouteScore {
  route: string;
  verb: Mark;
  args: Mark;
  counts: Mark;
  notes: string[];
  /** How many of the three questions this route got wrong. The tie-break for
   *  which branch a red case reports. */
  wrong: number;
}

/** Did this one route happen, with these arguments and these counts. Pure, and
 *  deliberately ignorant of `forbid`, `commits` and `steps`: those are claims
 *  about the run. */
function scoreRoute(branch: Partial<ExpectPath>, t: Transcript): RouteScore {
  const notes: string[] = [];
  const names = t.calls.map((call) => call.name);

  let verb: Mark = "n/a";
  if (branch.calls) {
    verb = "ok";
    const missing = missingFromSubsequence(names, branch.calls);
    if (missing) {
      verb = "wrong";
      notes.push(
        `expected \`${branch.calls.join("→")}\`, and \`${missing}\` did not come ` +
          `(in order) in \`${names.join("→") || "no calls at all"}\``,
      );
    }
  }

  let args: Mark = "n/a";
  if (branch.args) {
    args = "ok";
    for (const [verbName, wanted] of Object.entries(expectedArgs(branch))) {
      const made = t.calls.filter((call) => call.name === verbName);
      if (made.length === 0) {
        args = "wrong";
        notes.push(`\`${verbName}\` was never called, so its arguments cannot be right`);
        continue;
      }
      const index = made.findIndex((call) => matches(call.args, wanted));
      if (index === -1) {
        args = "wrong";
        notes.push(
          `\`${verbName}\` wanted ${argText(wanted).trim()} and got ` +
            made.map((call) => argText(call.args).trim()).join(" then "),
        );
      } else if (index > 0) {
        // Not a failure: the model corrected itself, which is what `refuses`
        // and `bad-argument` are for. Worth a line, because the correction
        // cost a model turn that a better `describe` or a tighter `oneOf`
        // would not have.
        notes.push(`\`${verbName}\` got there on attempt ${index + 1}, not the first`);
      }
    }
  }

  let counts: Mark = "n/a";
  if (branch.count !== undefined) {
    counts = "ok";
    for (const [verbName, wanted] of Object.entries(expectedCounts(branch, t))) {
      const reported = lastCount(t, verbName);
      if (reported !== wanted) {
        counts = "wrong";
        notes.push(
          `\`${verbName}\` reported ${reported === undefined ? "no count" : reported}` +
            ` where the case says ${wanted}. Either the arguments were wrong, or THE FIXTURE ` +
            `MOVED — \`--dry-run\` replays this call without a model and will say which.`,
        );
      }
    }
  }

  return {
    route: branch.calls?.join("→") ?? "(no calls named)",
    verb,
    args,
    counts,
    notes,
    wrong: [verb, args, counts].filter((m) => m === "wrong").length,
  };
}

/** The first expected verb that does not appear, in order, in what ran. Null
 *  when the whole expected list is a subsequence of it. */
function missingFromSubsequence(actual: string[], expected: string[]): string | null {
  let i = 0;
  for (const want of expected) {
    const found = actual.indexOf(want, i);
    if (found === -1) return want;
    i = found + 1;
  }
  return null;
}

/** `expect.args` in its keyed form, whichever way it was written. */
export function expectedArgs(expect: {
  args?: Record<string, Scalar> | Record<string, Record<string, Scalar>>;
  calls?: string[];
}): Record<string, Record<string, Scalar>> {
  const args = expect.args;
  if (!args) return {};
  const keyed = Object.values(args).every((v) => typeof v === "object" && v !== null);
  if (keyed) return args as Record<string, Record<string, Scalar>>;
  const target = expect.calls?.[expect.calls.length - 1];
  if (!target) {
    // Validation in `dry.ts` refuses this combination before a model is
    // called, so reaching here means a caller built an `Expect` by hand.
    return {};
  }
  return { [target]: args as Record<string, Scalar> };
}

/** `expect.count` in its keyed form. A bare number means "the last count any
 *  call reported", so the verb it belongs to is read off the transcript. */
function expectedCounts(
  expect: { count?: number | Record<string, number> },
  t: Transcript,
): Record<string, number> {
  const count = expect.count;
  if (count === undefined) return {};
  if (typeof count === "object") return count;
  const last = [...t.calls].reverse().find((call) => call.count !== undefined);
  // No call reported anything: attribute the expectation to a verb that cannot
  // have reported it, so the failure says "no count" against a real name.
  return { [last?.name ?? "(no call reported a count)"]: count };
}

function lastCount(t: Transcript, verbName: string): number | undefined {
  for (let i = t.calls.length - 1; i >= 0; i -= 1) {
    const call = t.calls[i]!;
    if (call.name === verbName && call.count !== undefined) return call.count;
  }
  return undefined;
}

/** Only the keys the case mentioned; see `Expect.args` on why an extra
 *  argument the agent passed is not a failure. */
function matches(actual: Record<string, Scalar>, wanted: Record<string, Scalar>): boolean {
  return Object.entries(wanted).every(([k, v]) => actual[k] === v);
}

function argText(args: Record<string, Scalar>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return ` (${entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})`;
}
