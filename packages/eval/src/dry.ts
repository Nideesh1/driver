/**
 * `--dry-run`: everything that can be checked without spending a model call.
 *
 * It exists because the suite costs real money, and a suite that spends it to
 * discover `calls: ["select_where"]` has an underscore in it is a suite nobody
 * runs twice. So this validates the case files against the live manifest — the
 * verbs exist, the arguments exist and typecheck, the case does not forbid a
 * commit it also expects — and then does the thing that turns out to matter
 * most:
 *
 * **IT REPLAYS THE EXPECTED PATH AGAINST THE REAL DRIVER.** The case says
 * `select-where(company: "Grayson Robotics", status: "new")` should report 238.
 * This calls exactly that, on a throwaway driver, with no model anywhere, and
 * compares. If it reports 237, the assertion is wrong about the app and every
 * count in the suite is now measuring something else — so a mismatch is an
 * ERROR and is named **fixture drift**, loudly, because the alternative is a
 * red suite that looks like a model regression and is a data change.
 *
 * It is also the answer to "how do I know the eval is right". A count
 * assertion that the app itself reproduces without a model is an assertion
 * about the app; one that only a model can satisfy is an assertion about the
 * model.
 */

import { checkArg, RESERVED_REFUSALS } from "driverkit";
import type { ArgSpec, Driver, Manifest, Scalar } from "driverkit";

import { parseBound } from "./case.ts";
import { askMechanism, expectedArgs, routes } from "./score.ts";
import type { DryResult, EvalCase, ExpectPath, LoadedCase } from "./types.ts";

export interface DryOptions {
  newDriver: () => Driver | Promise<Driver>;
  askVerb?: string;
  /** Skip the replay and only check the files. For a suite whose expected
   *  paths are not replayable, or a case file edited on a machine that cannot
   *  load the app. */
  noReplay?: boolean;
}

export async function dryRun(
  cases: Array<EvalCase | LoadedCase>,
  options: DryOptions,
): Promise<DryResult> {
  const probe = await options.newDriver();
  const manifest = probe.manifest();
  probe.unmount();

  const verbs = new Map(manifest.verbs.map((v) => [v.name, v]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const replayed: DryResult["replayed"] = [];
  const mentioned = new Set<string>();

  const askVerb = askMechanism(manifest, options.askVerb);

  for (const c of cases) {
    const where = "source" in c && c.source ? `${c.source} (${c.id})` : c.id;
    const seen = new Set<string>();
    // Every route a case allows, so `anyOf` is checked branch by branch and a
    // typo in the second route is not discovered by paying a model to take it.
    const branches = routes(c.expect);
    const named = [
      ...branches.flatMap((b) => b.calls ?? []),
      ...(c.expect.forbid ?? []),
      ...(c.expect.commits === "none" || c.expect.commits === undefined ? [] : c.expect.commits),
      ...branches.flatMap((b) => Object.keys(expectedArgs(b))),
      ...branches.flatMap((b) => (typeof b.count === "object" ? Object.keys(b.count) : [])),
      ...(c.setup ?? []).map((s) => s.verb),
    ];
    for (const name of named) {
      seen.add(name);
      mentioned.add(name);
      if (!verbs.has(name)) {
        errors.push(
          `${where}: no verb named \`${name}\`` + suggestion(name, [...verbs.keys()]) +
            `. A verb rename is a breaking change to every case that named it.`,
        );
      }
    }

    // A flat `args` has nowhere to attach without a `calls` to read the last
    // verb off. Caught here rather than at parse time because the keyed
    // spelling is fine without `calls`, and the parser does not know which
    // this is until it has seen the values.
    if (c.expect.args && !c.expect.calls) {
      const flat = Object.values(c.expect.args).every(
        (v) => typeof v !== "object" || v === null,
      );
      if (flat) {
        errors.push(
          `${where}: \`expect.args\` is a flat map, which applies to the last verb in ` +
            `\`expect.calls\` — and this case has no \`calls\`. Name the verb: ` +
            `\`"args": { "<verb>": { ... } }\`.`,
        );
      }
    }

    for (const branch of branches) {
      for (const [verbName, args] of Object.entries(expectedArgs(branch))) {
        const verb = verbs.get(verbName);
        if (!verb) continue;
        for (const [arg, value] of Object.entries(args)) {
          const spec = verb.args?.[arg];
          if (!spec) {
            errors.push(
              `${where}: \`${verbName}\` takes no argument \`${arg}\`` +
                suggestion(arg, Object.keys(verb.args ?? {})),
            );
            continue;
          }
          const complaint = checkArg(arg, spec, value);
          if (complaint) errors.push(`${where}: \`${verbName}\`: ${complaint}`);
        }
      }
    }

    // A case that lists a commit in `calls` and does not allow it in `commits`
    // contradicts itself, and the contradiction is unfalsifiable: the run
    // fails whatever the agent does. Checked here because it is a mistake in
    // the case, not a finding about the app.
    if (c.expect.commits !== undefined) {
      const allowed = c.expect.commits === "none" ? new Set<string>() : new Set(c.expect.commits);
      for (const name of branches.flatMap((b) => b.calls ?? [])) {
        if (verbs.get(name)?.kind === "commit" && !allowed.has(name)) {
          // Unless the case also expects a refusal — "accept them with nothing
          // selected" expects exactly this: the commit verb IS called, it is
          // told no, and no data moves. That case is the whole reason
          // `refused` exists, so it cannot be the one combination the
          // validator rejects.
          if (c.expect.refused !== undefined) continue;
          errors.push(
            `${where}: expects \`${name}\` to be called and allows ` +
              (c.expect.commits === "none" ? "no commit" : `only ${[...allowed].join(", ")}`) +
              `, so the case can never pass. If the point is that the commit is REFUSED, ` +
              `say so with \`"refused": "<slug>"\`.`,
          );
        }
      }
      if (c.expect.commits !== "none") {
        for (const name of c.expect.commits) {
          if (verbs.has(name) && verbs.get(name)!.kind !== "commit") {
            warnings.push(
              `${where}: \`commits\` lists \`${name}\`, which is \`${verbs.get(name)!.kind}\` ` +
                `and cannot be a false commit. The field is about data moving.`,
            );
          }
        }
      }
    }

    for (const branch of branches) {
      if (typeof branch.count !== "object") continue;
      for (const [verbName, n] of Object.entries(branch.count)) {
        const kind = verbs.get(verbName)?.kind;
        if (kind === "read") {
          warnings.push(
            `${where}: \`count.${verbName}\` expects ${n}, but \`${verbName}\` is a \`read\` ` +
              `and a read reports no count by definition.`,
          );
        }
      }
    }

    if (c.expect.refused !== undefined) {
      const declared = new Set<string>(RESERVED_REFUSALS);
      for (const name of branches.flatMap((b) => b.calls ?? [])) {
        for (const slug of verbs.get(name)?.refuses ?? []) declared.add(slug);
      }
      const wanted = typeof c.expect.refused === "string" ? [c.expect.refused] : c.expect.refused;
      for (const slug of wanted) {
        if (!declared.has(slug)) {
          warnings.push(
            `${where}: \`${slug}\` is not reserved and is not declared by any verb ` +
              `this case expects. Either the slug is a typo or the verb's \`refuses\` is short.`,
          );
        }
      }
    }

    if (typeof c.expect.steps === "number") {
      warnings.push(
        `${where}: \`steps: ${c.expect.steps}\` is read as a ceiling. Write \`"<=${c.expect.steps}"\` ` +
          `so the next reader does not take it for an equality.`,
      );
    }

    if (c.expect.asks && !askVerb) {
      warnings.push(
        `${where}: expects the agent to ASK, and this manifest has no ask verb. The case will ` +
          `run and the expectation will be reported as an observation rather than asserted; ` +
          `pass \`--ask-verb <name>\` once the app has one.`,
      );
    }

    if (c.skip) warnings.push(`${where}: skipped — ${c.skip}`);
    if (seen.size === 0 && !c.expect.refused && !c.expect.asks) {
      warnings.push(`${where}: names no verb, so only its commit and step claims are checked.`);
    }
  }

  if (!options.noReplay) {
    for (const c of cases) {
      if (c.skip) continue;
      // Every branch of an `anyOf`, not just the first. Each route states its
      // own count and each is replayable without a model, so a suite that
      // allows two routes gets both of its numbers checked against the
      // fixture — which is strictly more fixture coverage than the single
      // route it replaced, and the reason `anyOf` carries `count` per branch.
      const branches = routes(c.expect);
      for (const [i, branch] of branches.entries()) {
        await replayCase(
          c,
          branch,
          branches.length > 1 ? ` route ${i + 1}` : "",
          verbs,
          options,
          errors,
          warnings,
          replayed,
        );
      }
    }
  }

  return {
    errors,
    warnings,
    replayed,
    unexercised: manifest.verbs.map((v) => v.name).filter((name) => !mentioned.has(name)),
  };
}

/**
 * Run a case's expected path by hand and compare the counts.
 *
 * Only when the path is fully determined: every verb in `calls` either takes
 * no required argument or has every required one stated. A case that leaves an
 * id to the agent — "find her and select her" — cannot be replayed, and that
 * is said out loud as a warning rather than skipped silently, because it means
 * the case's count assertion is checked by the model run alone.
 */
async function replayCase(
  c: EvalCase | LoadedCase,
  branch: Partial<ExpectPath>,
  label: string,
  verbs: Map<string, Manifest["verbs"][number]>,
  options: DryOptions,
  errors: string[],
  warnings: string[],
  replayed: DryResult["replayed"],
): Promise<void> {
  const where = ("source" in c && c.source ? `${c.source} (${c.id})` : c.id) + label;
  const path = branch.calls ?? [];
  const wanted = branch.count;
  if (path.length === 0 || wanted === undefined) return;

  const args = expectedArgs(branch);
  for (const name of path) {
    const verb = verbs.get(name);
    if (!verb) return; // already an error
    const required = Object.entries(verb.args ?? {}).filter(
      ([, spec]: [string, ArgSpec]) => spec.optional !== true,
    );
    const have = args[name] ?? {};
    const missing = required.filter(([arg]) => have[arg] === undefined).map(([arg]) => arg);
    if (missing.length > 0) {
      warnings.push(
        `${where}: cannot replay the expected path without a model — \`${name}\` needs ` +
          `${missing.join(", ")} and the case does not state ${missing.length > 1 ? "them" : "it"}. ` +
          `Its count is therefore checked only by the live run.`,
      );
      return;
    }
  }

  const driver = await options.newDriver();
  try {
    for (const step of c.setup ?? []) {
      const result = await driver.call(step.verb, step.args ?? {});
      if (!result.ok) {
        errors.push(`${where}: setup \`${step.verb}\` was refused \`${result.refused}\``);
        return;
      }
    }
    const counts = new Map<string, number>();
    // The plan token, forwarded from the last `describe` that minted one.
    //
    // A `commit` declaring `consumes: "plan"` cannot be called bare — the core
    // refuses it `stale-plan` — so a replay that did not carry the token could
    // not walk a describe→commit path at all, which is most of what is worth
    // replaying. Carrying it is not a loophole: it is the pairing the core is
    // enforcing, performed by hand, and it means the dry run exercises the
    // same two-call shape the model has to find.
    let plan: string | undefined;
    for (const name of path) {
      const wantsPlan = verbs.get(name)!.consumes === "plan";
      const result = await driver.call(
        name,
        (args[name] ?? {}) as Record<string, Scalar>,
        wantsPlan && plan !== undefined ? { plan } : {},
      );
      if (!result.ok) {
        const acceptable =
          c.expect.refused === undefined
            ? []
            : typeof c.expect.refused === "string"
              ? [c.expect.refused]
              : c.expect.refused;
        if (acceptable.includes(result.refused)) continue;
        warnings.push(
          `${where}: replaying \`${name}\` was refused \`${result.refused}\`` +
            (result.hint ? ` — ${result.hint}` : "") +
            `. The expected path may be in the wrong order, or need a \`setup\`.`,
        );
        // `break`, not `return`: the counts already collected are still real,
        // and they are usually the ones the case asserts — a `describe` runs
        // before the `commit` that failed.
        break;
      }
      if (result.plan !== undefined) plan = result.plan;
      if (result.count !== undefined) counts.set(name, result.count);
    }

    const pairs: Array<[string, number]> =
      typeof wanted === "number"
        ? [[[...counts.keys()].pop() ?? "(nothing reported a count)", wanted]]
        : Object.entries(wanted);

    for (const [name, expected] of pairs) {
      const actual = counts.get(name);
      replayed.push({ id: c.id + label, verb: name, expected, actual });
      if (actual !== expected) {
        errors.push(
          `FIXTURE DRIFT — ${where}: replaying \`${name}\` with the case's own arguments ` +
            `reported ${actual === undefined ? "no count" : actual}, not ${expected}. ` +
            `No model was involved: the app and the case file disagree about the data. ` +
            `Fix the number or find out what changed the fixture before trusting any count ` +
            `in this suite.`,
        );
      }
    }
  } finally {
    driver.unmount();
  }
}

/** A cheap "did you mean". Edit distance rather than a prefix match, because
 *  the mistakes this catches are `select_where` and `selct-where`, which share
 *  no useful prefix with the right answer. */
function suggestion(wrong: string, candidates: string[]): string {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const d = distance(wrong, candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  if (best === undefined || bestScore > Math.max(2, Math.floor(wrong.length / 3))) return "";
  return `. Did you mean \`${best}\`?`;
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
