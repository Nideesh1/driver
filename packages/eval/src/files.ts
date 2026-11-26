/**
 * The disk. Kept in one file so everything else in this package is testable
 * without one — `runSuite` takes a `TranscriptCache` interface and `dryRun`
 * takes a driver factory, so the only thing that needs a temporary directory
 * is this.
 */

import fs from "node:fs";
import path from "node:path";

import { parseCase, CaseError } from "./case.ts";
import type { LoadedCase, SuiteResult, Transcript, TranscriptCache } from "./types.ts";

/**
 * Every case in a directory, in filename order.
 *
 * Filename order rather than declaration order, and the suite is a directory
 * of files rather than one big file, because a case is the unit people edit
 * and argue about: one failure mode per file, named after the failure, is a
 * `git log` that reads like a list of the mistakes an agent made against this
 * app. Numbered prefixes (`01-`, `02-`) order them.
 *
 * A file may hold one case, a list of cases, or `{ cases: [...] }` — the last
 * so that a suite can be kept in a single file by somebody who prefers that,
 * without this package having two formats.
 */
export function loadCases(target: string): LoadedCase[] {
  const stat = fs.statSync(target);
  const files = stat.isDirectory()
    ? fs
        .readdirSync(target)
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .sort()
        .map((name) => path.join(target, name))
    : [target];

  const cases: LoadedCase[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const where = path.relative(process.cwd(), file);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new CaseError(`${where}: not valid JSON — ${(err as Error).message}`);
    }
    const list = Array.isArray(raw)
      ? raw
      : isObject(raw) && Array.isArray(raw["cases"])
        ? raw["cases"]
        : [raw];
    for (const entry of list) {
      const parsed = parseCase(entry, where);
      const already = seen.get(parsed.id);
      if (already) {
        throw new CaseError(
          `${where}: case id \`${parsed.id}\` is already used by ${already}. Ids are the ` +
            `cache key and the diff key, so two cases cannot share one.`,
        );
      }
      seen.set(parsed.id, where);
      cases.push(parsed);
    }
  }
  return cases;
}

/**
 * Transcripts cached as one small JSON file per key.
 *
 * One file per key rather than one index, because the writes are interleaved
 * with model calls that can be interrupted at any point: a half-written index
 * loses every run in it, and a half-written single file loses one run and is
 * discarded by the `JSON.parse` that reads it. Reads are lazy and failures are
 * silent — a cache that throws is worse than a cache that misses.
 */
export function fileCache(dir: string): TranscriptCache {
  fs.mkdirSync(dir, { recursive: true });
  return {
    get(key) {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), "utf8")) as Transcript;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(value));
      } catch {
        /* a cache that cannot write is still a working harness */
      }
    },
  };
}

/** A saved run, for `--diff`. Plain JSON: the same thing `--save` wrote. */
export function readResult(file: string): SuiteResult {
  return JSON.parse(fs.readFileSync(file, "utf8")) as SuiteResult;
}

export function writeResult(file: string, result: SuiteResult): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
