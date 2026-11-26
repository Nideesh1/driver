#!/usr/bin/env node --experimental-strip-types
/**
 * `driverkit eval` — the command.
 *
 *     node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals --dry-run
 *     node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals --runs 3
 *     node --experimental-strip-types packages/eval/src/cli.ts --diff before.json after.json
 *
 * Three design constraints are enforced here rather than documented:
 *
 * **It is not a CI check.** It costs model calls and a model is nondeterministic,
 * so a red suite in CI would be a build that fails on a Tuesday. Running live
 * with `CI` set in the environment is refused unless `--allow-ci` is passed,
 * which is the one place the harness gets to have an opinion about where it
 * belongs. `--dry-run` is the part that is safe to run anywhere, and the part
 * that catches a mistyped verb name.
 *
 * **No API key.** The default model is the demo's own `/api/chat`, posted to
 * with `backendThink` — the key stays on that server, and this process never
 * reads, forwards or logs one. Point `--endpoint` at anything that speaks the
 * same four fields.
 *
 * **The app is supplied by the suite.** A suite directory carries an `app.mjs`
 * exporting `newDriver()`, so this package does not import the demo and a
 * second app needs no change in here.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { backendThink } from "driverkit/agent";
import type { Driver } from "driverkit";

import { cacheKey, CaseError } from "./case.ts";
import { dryRun } from "./dry.ts";
import { fileCache, loadCases, readResult, writeResult } from "./files.ts";
import { failed, regressed, renderDiff, renderDry, renderPlan, renderReport } from "./report.ts";
import { runSuite } from "./run.ts";
import type { LoadedCase, SuiteResult } from "./types.ts";

const USAGE = `driverkit eval — does this app's verb list actually work?

  driverkit-eval <suite-dir> [options]
  driverkit-eval --diff <before.json> <after.json>

  <suite-dir>            a directory of .json cases, plus an app.mjs exporting newDriver()

  --dry-run              validate the cases and replay their counts; call no model
  --runs N               runs per case (default 3; 1 prints a flakiness banner)
  --max-steps N          hard cap on model round trips per run (default 12)
  --only a,b             just these case ids
  --endpoint URL         the Think endpoint (default http://127.0.0.1:$DK_PORT/api/chat)
  --model NAME           what to record as the model (default $DK_MODEL)
  --app FILE             the module exporting newDriver() (default <suite-dir>/app.mjs)
  --ask-verb NAME        the verb that means "ask the person", once the app has one
  --cache DIR            transcript cache (default <suite-dir>/.cache); --no-cache to skip
  --save FILE            write the result, for --diff later
  --baseline FILE        run, then diff against this saved result
  --diff A B             compare two saved results and exit; runs nothing
  --allow-ci             run live even with CI set in the environment
  --json                 print the result as JSON instead of a report
`;

interface Args {
  suite?: string;
  dryRun: boolean;
  runs: number;
  maxSteps: number;
  only?: string[];
  endpoint: string;
  model: string;
  app?: string;
  askVerb?: string;
  cache?: string;
  noCache: boolean;
  save?: string;
  baseline?: string;
  diff?: [string, string];
  allowCi: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const port = process.env["DK_PORT"] || "8770";
  const args: Args = {
    dryRun: false,
    runs: 3,
    maxSteps: 12,
    endpoint: `http://127.0.0.1:${port}/api/chat`,
    model: process.env["DK_MODEL"] || "unknown",
    noCache: false,
    allowCi: false,
    json: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new CaseError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--dry-run": args.dryRun = true; break;
      case "--runs": args.runs = Number(next()); break;
      case "--max-steps": args.maxSteps = Number(next()); break;
      case "--only": args.only = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--endpoint": args.endpoint = next(); break;
      case "--model": args.model = next(); break;
      case "--app": args.app = next(); break;
      case "--ask-verb": args.askVerb = next(); break;
      case "--cache": args.cache = next(); break;
      case "--no-cache": args.noCache = true; break;
      case "--save": args.save = next(); break;
      case "--baseline": args.baseline = next(); break;
      case "--diff": args.diff = [next(), next()]; break;
      case "--allow-ci": args.allowCi = true; break;
      case "--json": args.json = true; break;
      case "-h":
      case "--help": process.stdout.write(USAGE); process.exit(0);
      default:
        if (arg.startsWith("-")) throw new CaseError(`unknown option ${arg}\n\n${USAGE}`);
        rest.push(arg);
    }
  }
  if (rest[0] !== undefined) args.suite = rest[0];
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new CaseError("--runs must be >= 1");
  if (!Number.isInteger(args.maxSteps) || args.maxSteps < 1) {
    throw new CaseError("--max-steps must be >= 1");
  }
  return args;
}

/**
 * The suite's own app binding.
 *
 * A module rather than a flag with a class name in it, because what a harness
 * needs is a FACTORY: `newDriver()` must hand back a driver over freshly built
 * data every time, and only the app can know how to do that. The demo's is six
 * lines.
 */
async function loadApp(file: string): Promise<() => Driver | Promise<Driver>> {
  const url = pathToFileURL(path.resolve(file)).href;
  let module: Record<string, unknown>;
  try {
    module = (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new CaseError(`cannot load ${file} — ${(err as Error).message}`);
  }
  const factory = module["newDriver"] ?? module["default"];
  if (typeof factory !== "function") {
    throw new CaseError(
      `${file} must export \`newDriver()\` returning a freshly mounted driver over fresh ` +
        `data. A fresh one per run is what keeps one case's commit out of another case's counts.`,
    );
  }
  return factory as () => Driver | Promise<Driver>;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.diff) {
    const before = readResult(args.diff[0]);
    const after = readResult(args.diff[1]);
    process.stdout.write(renderDiff(before, after) + "\n");
    return regressed(before, after) ? 1 : 0;
  }

  if (!args.suite) {
    process.stderr.write(USAGE);
    return 2;
  }

  let cases: LoadedCase[] = loadCases(args.suite);
  if (args.only) {
    const wanted = new Set(args.only);
    const unknown = args.only.filter((id) => !cases.some((c) => c.id === id));
    if (unknown.length > 0) throw new CaseError(`--only names no such case: ${unknown.join(", ")}`);
    cases = cases.filter((c) => wanted.has(c.id));
  }

  const appFile = args.app ?? path.join(args.suite, "app.mjs");
  const newDriver = await loadApp(appFile);

  // Always, including before a live run. The validation is free and the
  // replay is the only thing that can tell a model regression from a fixture
  // change, so a live run that skipped it would be a report whose counts
  // nobody has checked.
  const dry = await dryRun(cases, {
    newDriver,
    ...(args.askVerb === undefined ? {} : { askVerb: args.askVerb }),
  });
  if (args.dryRun || dry.errors.length > 0) {
    process.stdout.write(renderDry(dry) + "\n");
    if (dry.errors.length > 0) {
      process.stderr.write(
        "\nNo model was called. Fix the errors above before paying for a run.\n",
      );
      return 1;
    }
    return 0;
  }
  if (dry.warnings.length > 0) {
    process.stdout.write(renderDry({ ...dry, replayed: [], unexercised: [] }) + "\n\n");
  }

  if (process.env["CI"] && !args.allowCi) {
    process.stderr.write(
      "CI is set in the environment, and this spends real model calls on a nondeterministic\n" +
        "model. It is not a CI check: a verb list that works four times in five would make\n" +
        "your build red on a Tuesday. Run `--dry-run` in CI, this by hand, or pass\n" +
        "`--allow-ci` if you have decided otherwise.\n",
    );
    return 2;
  }

  const probe = await newDriver();
  const manifestVersion = probe.manifest().version;
  probe.unmount();
  const cache =
    args.noCache
      ? undefined
      : fileCache(args.cache ?? path.join(args.suite, ".cache"));
  const cached = cache
    ? cases
        .filter((c) => !c.skip)
        .reduce(
          (n, c) =>
            n +
            Array.from({ length: args.runs }, (_, run) =>
              cache.get(cacheKey(c, manifestVersion, args.model, run)) ? 1 : 0,
            ).reduce((a: number, b: number) => a + b, 0),
          0,
        )
    : 0;

  process.stdout.write(
    renderPlan({
      cases,
      runs: args.runs,
      maxSteps: args.maxSteps,
      cached,
      model: args.model,
      endpoint: args.endpoint,
    }) + "\n\n",
  );

  const result: SuiteResult = await runSuite(cases, {
    newDriver,
    think: backendThink(args.endpoint),
    model: args.model,
    runs: args.runs,
    maxSteps: args.maxSteps,
    ...(args.askVerb === undefined ? {} : { askVerb: args.askVerb }),
    ...(cache === undefined ? {} : { cache }),
    onRun: (e) => {
      if (e.phase !== "done") return;
      const mark = e.judgement?.falseCommits.length
        ? "FALSE COMMIT"
        : e.judgement?.pass
          ? "ok"
          : "fail";
      process.stdout.write(
        `  ${e.case.id} run ${e.run}/${e.of} ${mark}${e.cached ? " (cached)" : ""}\n`,
      );
    },
  });

  process.stdout.write("\n");
  process.stdout.write(
    (args.json ? JSON.stringify(result, null, 2) : renderReport(result)) + "\n",
  );
  if (args.save) writeResult(args.save, result);

  if (args.baseline) {
    const before = readResult(args.baseline);
    process.stdout.write("\n" + renderDiff(before, result) + "\n");
    if (regressed(before, result)) return 1;
  }

  return failed(result) ? 1 : 0;
}

// `import.meta.main` is not in the TS lib for this target, and checking
// `argv[1]` is the portable spelling.
if (process.argv[1] && /cli\.ts$|driverkit-eval$/.test(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    });
}
