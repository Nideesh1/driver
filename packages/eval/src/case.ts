/**
 * Reading a case file, and refusing a case file that cannot mean anything.
 *
 * **JSON, parsed with `JSON.parse`.** The format was going to be YAML, and the
 * reason it is not is the library's zero-dependency promise: a YAML parser is
 * either a dependency or three hundred lines of this package's own that get
 * one edge case wrong and silently read `count: 0238` as a string. JSON costs
 * an author some braces and buys a parser that cannot be wrong, an editor that
 * already validates it, and a `--save` file in the same format as the cases.
 *
 * Validation is strict and early for one reason: these files are compared
 * against a real model at real cost, and `calls: ["select_where"]` with an
 * underscore would otherwise be a red case that looks like a model failure.
 * Everything that can be checked without a model is checked here or in
 * `dry.ts`, and the message always names the file and the field.
 */

import type {
  EvalCase,
  Expect,
  ExpectPath,
  LoadedCase,
  Scalar,
  SetupCall,
  StepBound,
} from "./types.ts";

/** Thrown for a case file that cannot be read as a case. Not returned: a
 *  malformed file is a programming error in the suite, not a finding about the
 *  app, and folding the two together is how a typo gets reported as a verb
 *  list problem. */
export class CaseError extends Error {}

const EXPECT_FIELDS = new Set([
  "calls",
  "anyOf",
  "forbid",
  "args",
  "count",
  "commits",
  "refused",
  "asks",
  "steps",
]);

const CASE_FIELDS = new Set(["id", "ask", "why", "setup", "expect", "skip"]);

/**
 * One case from parsed JSON.
 *
 * `source` is carried on the result rather than only used in messages, because
 * the report prints it: a red case is looked up by file, and "case 7" is not a
 * path anybody can open.
 */
export function parseCase(raw: unknown, source: string): LoadedCase {
  const at = (field: string) => `${source}: \`${field}\``;
  if (!isObject(raw)) throw new CaseError(`${source}: a case must be a JSON object`);

  for (const key of Object.keys(raw)) {
    if (!CASE_FIELDS.has(key)) {
      throw new CaseError(
        `${at(key)} is not a field of a case. Fields: ${[...CASE_FIELDS].join(", ")}`,
      );
    }
  }

  const id = raw["id"];
  if (typeof id !== "string" || !id.trim()) throw new CaseError(`${at("id")} must be a string`);
  const ask = raw["ask"];
  if (typeof ask !== "string" || !ask.trim()) {
    throw new CaseError(`${at("ask")} must be the plain-English ask, as a string`);
  }
  const why = raw["why"];
  if (why !== undefined && typeof why !== "string") {
    throw new CaseError(`${at("why")} must be a string`);
  }
  const skip = raw["skip"];
  if (skip !== undefined && typeof skip !== "string") {
    throw new CaseError(`${at("skip")} must be a string saying WHY it is skipped`);
  }

  const expect = parseExpect(raw["expect"], source);
  const setup = parseSetup(raw["setup"], source);

  return {
    id,
    ask,
    ...(why === undefined ? {} : { why }),
    ...(skip === undefined ? {} : { skip }),
    ...(setup === undefined ? {} : { setup }),
    expect,
    source,
  };
}

function parseSetup(raw: unknown, source: string): SetupCall[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new CaseError(`${source}: \`setup\` must be a list of calls`);
  return raw.map((entry, i) => {
    if (!isObject(entry) || typeof entry["verb"] !== "string") {
      throw new CaseError(`${source}: \`setup[${i}]\` must be { verb, args? }`);
    }
    const args = entry["args"];
    if (args !== undefined && !isScalarMap(args)) {
      throw new CaseError(`${source}: \`setup[${i}].args\` must be a map of scalars`);
    }
    return {
      verb: entry["verb"],
      ...(args === undefined ? {} : { args: args as Record<string, Scalar> }),
    };
  });
}

function parseExpect(raw: unknown, source: string): Expect {
  if (!isObject(raw)) throw new CaseError(`${source}: \`expect\` must be a JSON object`);
  for (const key of Object.keys(raw)) {
    if (!EXPECT_FIELDS.has(key)) {
      throw new CaseError(
        `${source}: \`expect.${key}\` is not an expectation. ` +
          `Fields: ${[...EXPECT_FIELDS].join(", ")}`,
      );
    }
  }

  const expect: Expect = {};

  const calls = raw["calls"];
  if (calls !== undefined) {
    if (!isStringList(calls)) {
      throw new CaseError(`${source}: \`expect.calls\` must be a list of verb names`);
    }
    expect.calls = calls;
  }

  // Several routes, any one of which is right. Refused beside `calls`, `args`
  // or `count` rather than merged with them: a top-level route plus a list of
  // routes is two spellings of one claim, and whichever way a reader took it
  // the other half would be silently ignored. See `Expect.anyOf`.
  const anyOf = raw["anyOf"];
  if (anyOf !== undefined) {
    for (const field of ["calls", "args", "count"]) {
      if (raw[field] !== undefined) {
        throw new CaseError(
          `${source}: \`expect.anyOf\` cannot be used with \`expect.${field}\`. A case states ` +
            `one route or several; put the route in a branch of \`anyOf\`. \`forbid\`, ` +
            `\`commits\`, \`refused\` and \`steps\` stay at the top level — they are claims ` +
            `about the run, not about a route.`,
        );
      }
    }
    if (!Array.isArray(anyOf) || anyOf.length < 2) {
      throw new CaseError(
        `${source}: \`expect.anyOf\` must be a list of TWO OR MORE routes, each ` +
          `\`{ calls, args?, count? }\`. With one route, write it as \`calls\` — a branch ` +
          `list of one is a route pretending to be a choice.`,
      );
    }
    expect.anyOf = anyOf.map((branch, i) => parsePath(branch, source, `expect.anyOf[${i}]`));
  }

  const forbid = raw["forbid"];
  if (forbid !== undefined) {
    if (!isStringList(forbid)) {
      throw new CaseError(`${source}: \`expect.forbid\` must be a list of verb names`);
    }
    expect.forbid = forbid;
  }

  const args = parseArgs(raw["args"], source, "expect.args");
  if (args !== undefined) expect.args = args;

  const count = parseCount(raw["count"], source, "expect.count");
  if (count !== undefined) expect.count = count;

  const commits = raw["commits"];
  if (commits !== undefined) {
    if (commits === "none") expect.commits = "none";
    else if (isStringList(commits)) expect.commits = commits;
    else {
      throw new CaseError(
        `${source}: \`expect.commits\` must be \`"none"\` or a list of the commit verbs ` +
          `that are allowed to run`,
      );
    }
  }

  const refused = raw["refused"];
  if (refused !== undefined) {
    if (typeof refused === "string" && refused.trim()) expect.refused = refused;
    else if (isStringList(refused) && refused.length > 0) expect.refused = refused;
    else {
      throw new CaseError(
        `${source}: \`expect.refused\` must be a refusal slug, or a list of slugs any one of ` +
          `which is an acceptable "no"`,
      );
    }
  }

  const asks = raw["asks"];
  if (asks !== undefined) {
    if (asks !== true) {
      throw new CaseError(
        `${source}: \`expect.asks\` is \`true\` or absent. There is no \`false\`: ` +
          `"must not ask" is not an expectation anybody holds, and spelling it would ` +
          `invite a case that fails an agent for being careful.`,
      );
    }
    expect.asks = true;
  }

  const steps = raw["steps"];
  if (steps !== undefined) {
    parseBound(steps as StepBound, source); // throws if it cannot mean a bound
    expect.steps = steps as StepBound;
  }

  if (Object.keys(expect).length === 0) {
    throw new CaseError(
      `${source}: \`expect\` states nothing, so the case cannot fail. ` +
        `At minimum say \`commits: "none"\`.`,
    );
  }

  return expect;
}

/** One branch of `expect.anyOf`: a whole route, validated with exactly the
 *  same rules as the top-level fields it stands in for. */
function parsePath(raw: unknown, source: string, at: string): ExpectPath {
  if (!isObject(raw)) {
    throw new CaseError(`${source}: \`${at}\` must be \`{ calls, args?, count? }\``);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "calls" && key !== "args" && key !== "count") {
      throw new CaseError(
        `${source}: \`${at}.${key}\` is not part of a route. A branch holds \`calls\`, ` +
          `\`args\` and \`count\`; everything else belongs at the top level of \`expect\`.`,
      );
    }
  }
  const calls = raw["calls"];
  if (!isStringList(calls) || calls.length === 0) {
    throw new CaseError(
      `${source}: \`${at}.calls\` must be a non-empty list of verb names. A branch IS a ` +
        `route, so it has to say what the route is.`,
    );
  }
  const args = parseArgs(raw["args"], source, `${at}.args`);
  const count = parseCount(raw["count"], source, `${at}.count`);
  return {
    calls,
    ...(args === undefined ? {} : { args }),
    ...(count === undefined ? {} : { count }),
  };
}

function parseArgs(raw: unknown, source: string, at: string): Expect["args"] | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new CaseError(`${source}: \`${at}\` must be an object`);
  // The two spellings, told apart by whether the values are objects. An
  // argument can only be a `Scalar`, so this cannot be ambiguous — see
  // `Expect.args`. A MIXTURE is refused rather than guessed at, because
  // guessing would silently drop half the assertions.
  const values = Object.values(raw);
  const objects = values.filter((v) => isObject(v)).length;
  if (objects > 0 && objects !== values.length) {
    throw new CaseError(
      `${source}: \`${at}\` mixes the two spellings. Either a flat map of ` +
        `arguments for the last verb in \`calls\`, or a map of verb name to arguments.`,
    );
  }
  if (objects === 0 && !isScalarMap(raw)) {
    throw new CaseError(`${source}: \`${at}\` values must be string/number/boolean/null`);
  }
  if (objects > 0) {
    for (const [verb, inner] of Object.entries(raw)) {
      if (!isScalarMap(inner)) {
        throw new CaseError(`${source}: \`${at}.${verb}\` must be a map of scalars`);
      }
    }
  }
  return raw as NonNullable<Expect["args"]>;
}

function parseCount(raw: unknown, source: string, at: string): Expect["count"] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new CaseError(`${source}: \`${at}\` must be finite`);
    return raw;
  }
  if (isObject(raw)) {
    for (const [verb, n] of Object.entries(raw)) {
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new CaseError(`${source}: \`${at}.${verb}\` must be a number`);
      }
    }
    return raw as Record<string, number>;
  }
  throw new CaseError(`${source}: \`${at}\` must be a number or a map of them`);
}

/**
 * A step bound to the largest number of steps that still passes.
 *
 * `"<=6"` is 6, `"<6"` is 5, and a bare `6` is 6 — read as a ceiling, not as
 * an equality, because that is what everybody means and a format that insisted
 * otherwise would be corrected by its users with `"<=6"` everywhere anyway.
 * `dry.ts` warns about the bare spelling rather than refusing it.
 */
export function parseBound(bound: StepBound, source = "a case"): number {
  if (typeof bound === "number") {
    if (!Number.isInteger(bound) || bound < 1) {
      throw new CaseError(`${source}: \`expect.steps\` must be a positive whole number`);
    }
    return bound;
  }
  const m = /^\s*(<=|<)?\s*(\d+)\s*$/.exec(bound);
  if (!m) {
    throw new CaseError(
      `${source}: \`expect.steps\` must look like \`"<=6"\`, \`"<6"\` or \`6\`; got ` +
        JSON.stringify(bound),
    );
  }
  const n = Number(m[2]);
  return m[1] === "<" ? n - 1 : n;
}

/**
 * A stable fingerprint of a case's MEANING.
 *
 * The ask and the expectations, canonically ordered, and nothing else: `why`
 * and `source` are not in it, so moving a case between files or improving its
 * prose does not throw away what it cost to run. Everything that could change
 * the verdict is in it, so a case whose expectation was tightened is a cache
 * miss, which is the behaviour you want from a cache you are trusting with a
 * number somebody will read as evidence.
 */
export function caseKey(c: EvalCase): string {
  return hash(
    canonical({
      ask: c.ask,
      expect: c.expect,
      ...(c.setup ? { setup: c.setup } : {}),
    }),
  );
}

/** The cache key proper. Everything that can change what a run would produce:
 *  the case, the verb list it was run against, the model, and which of the n
 *  runs this is. See `TranscriptCache` for why the index is in here. */
export function cacheKey(c: EvalCase, manifestVersion: string, model: string, run: number): string {
  return `${c.id}.${caseKey(c)}.${hash(`${manifestVersion}\u0000${model}`)}.${run}`;
}

/** JSON with object keys sorted, so two equal cases hash equally whatever
 *  order their fields were typed in. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** FNV-1a, 32 bits, hex. Hand-rolled for the reason everything in this
 *  repository is hand-rolled: `node:crypto` would work and a dependency would
 *  work, and neither is worth it for a cache key whose only job is to change
 *  when its input does. Collisions cost a stale transcript, and the manifest
 *  version is in the key beside it. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0);
}

function isScalarMap(value: unknown): value is Record<string, Scalar> {
  if (!isObject(value)) return false;
  return Object.values(value).every(
    (v) => v === null || ["string", "number", "boolean"].includes(typeof v),
  );
}
