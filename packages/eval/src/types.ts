/**
 * driverkit/eval — the shapes of a case, a run and a verdict.
 *
 * WHAT THIS PACKAGE IS FOR. Nothing else in the library tells an author
 * whether their verb list is any good. The single biggest lever on whether an
 * agent picks the right verb is each verb's `describe`, and today editing one
 * is superstition: you change a sentence, the agent behaves differently, and
 * you have no way to say whether it behaves BETTER. This package replays
 * plain-English asks against a mounted driver and a real model and reports
 * what happened, so that editing a `describe` becomes an experiment.
 *
 * THE CASE THAT MOTIVATED IT is in `examples/contacts/evals`. Asked to select
 * one named contact, a real model correctly REFUSED, because the only
 * selection verb took a company predicate and selecting her would have
 * selected all 410 people at her employer. The verb list was wrong and the
 * model was right, and nothing in the repository would have caught it. The
 * valuable cases are all of that shape: not "did it work" but "did it do the
 * expensive wrong thing", which is why the format below spends most of its
 * fields on what must NOT happen.
 *
 * THE FOUR NUMBERS ARE NOT ONE NUMBER. A verb chosen wrongly costs a retry.
 * An argument wrong costs a retry. Six steps where four would do costs
 * latency and money. A commit that should not have happened costs the rows.
 * Averaging those into a score would let a false commit be paid for with two
 * tidy navigations, so `Judgement` keeps them apart and `report.ts` prints
 * them apart, and there is deliberately no aggregate anywhere in this package.
 */

import type { Driver, Manifest, Result, Scalar, Snapshot, VerbKind } from "driverkit";
import type { StopReason, Think } from "driverkit/agent";

/**
 * A bound on a number of steps: `6`, `"<=6"`, `"<6"`.
 *
 * A string is accepted because `steps: "<=6"` is what an author writes when
 * they mean "no worse than this" and a bare `6` reads as "exactly six", which
 * is almost never what anybody means about a model. A bare number is taken as
 * `<=` all the same, with a note, rather than refused: a format that rejects
 * the obvious spelling of the common intent is a format people fight.
 */
export type StepBound = number | string;

/** One call in a case's `setup`: run before the ask, not scored, not counted
 *  against the step bound. It is how a case puts the app where the ask makes
 *  sense — on a company's screen, with something already selected — without
 *  spending model turns on the arrangement and then measuring them. */
export interface SetupCall {
  verb: string;
  args?: Record<string, Scalar>;
}

/**
 * One route through the app, as a case expects it: the verbs, their arguments
 * and the counts they report.
 *
 * It exists so that `Expect.anyOf` can hold more than one of them. An app
 * where two different sequences are both right — a bulk verb with a predicate,
 * or a screen-scoped verb that means the same thing once you are on the screen
 * — cannot be written down as one ordered `calls`, and a case that names only
 * the author's route FAILS THE AGENT FOR FINDING THE OTHER ONE. See
 * `Expect.anyOf`.
 */
export interface ExpectPath {
  /** As `Expect.calls`: a subsequence, in order. */
  calls: string[];
  /** As `Expect.args`, scoped to this route. A flat map applies to the last
   *  verb in THIS route's `calls`. */
  args?: Record<string, Scalar> | Record<string, Record<string, Scalar>>;
  /** As `Expect.count`, scoped to this route — which is the point: the verb
   *  that reports the number is route-specific, and the number is not. */
  count?: number | Record<string, number>;
}

/**
 * What should happen. Every field is optional and a case must state at least
 * one, because an expectation of nothing is a case that cannot fail.
 *
 * Read the fields as four different questions, in descending order of what
 * getting them wrong costs you: did data move that should not have
 * (`commits`), did it choose the right verb (`calls`, `forbid`, `anyOf`), did
 * it pass the right arguments (`args`, `count`), and how far did it wander
 * (`steps`).
 */
export interface Expect {
  /**
   * The verbs that must be called, in this order, as a **subsequence** of what
   * actually ran.
   *
   * A subsequence and not an exact list, which is the one judgement call in
   * this format worth defending. An agent that reads the screen twice, is
   * refused `wrong-screen` once and then does the right thing in the right
   * order has chosen correctly and wandered — and those are two different
   * findings with two different fixes (the verb list versus the `describe`'s
   * wording). Scoring them as one failure would hide the good news. So
   * ORDER and PRESENCE are judged here, and the wandering is judged by
   * `steps`, which is reported as its own number and never as a pass or a
   * fail.
   */
  calls?: string[];
  /**
   * Several routes, any one of which is right. **The field that stops a case
   * punishing a better answer.**
   *
   * `calls` asserts ONE ordered route, and an app usually has more than one.
   * The demo has two honest ways to accept a company's pending contacts —
   * `select-where(company, status)` from anywhere, or `open-company` then the
   * screen-scoped `select-pending-here` — and a model that takes the second
   * has not made a mistake; it has used the verb that means exactly "the
   * pending ones in front of me". A case naming only the first scored that
   * 0/3 and the finding was about the case.
   *
   * Each branch is a whole route with its own `args` and `count`, because the
   * verb that reports the number differs between them and the NUMBER DOES
   * NOT. The run passes if any branch is satisfied, and the report names the
   * route that was taken; when none is, every branch's reason is printed, so
   * "it did something else entirely" still reads as a failure rather than as
   * a list of near misses.
   *
   * Mutually exclusive with `calls`, `args` and `count`: a case states one
   * route or several, and a top-level route beside a list of them would be
   * two formats for the same claim. `forbid`, `commits`, `refused` and
   * `steps` stay at the top level, because they are claims about the whole
   * run and not about a route — a forbidden verb is forbidden whichever way
   * the agent went.
   *
   * **Reach for the end state first.** Two branches are an honest statement
   * that your app has two right answers; six are an author enumerating a
   * model's whims. If what you care about is that 112 rows moved and nothing
   * else did, assert the commit and the count it reported and leave the route
   * alone.
   */
  anyOf?: ExpectPath[];
  /**
   * Verbs that must not be called at all.
   *
   * **The field the valuable cases are written with.** "Select one named
   * person" is expressed as `calls: ["select-contact"]` *and*
   * `forbid: ["select-where"]`, because the failure being guarded against is
   * not an absence — it is the agent reaching for the bulk verb and taking
   * four hundred rows. A case that only said what should happen would pass a
   * run that did both.
   */
  forbid?: string[];
  /**
   * The arguments a call must have been made with.
   *
   * Two spellings. A flat map of scalars — `{ company: "Acme Industrial" }` —
   * applies to the LAST verb named in `calls`, which is the one an ask is
   * usually about. A map of maps — `{ "select-where": { company: "..." } }` —
   * names the verb for each, for a case that cares about more than one. The
   * two are told apart by whether the values are objects, which is
   * unambiguous because an argument can only ever be a `Scalar`.
   *
   * Only the keys present are checked. An extra argument the agent passed that
   * the case did not mention is not a failure: `select-contact(id, add)` is
   * right with or without `add`, and a format that demanded every argument be
   * enumerated would turn every optional argument into a false alarm.
   */
  args?: Record<string, Scalar> | Record<string, Record<string, Scalar>>;
  /**
   * The `Report.count` a call reported, asserted EXACTLY.
   *
   * A number means the last count any call reported; a map names the verb.
   * Exact because the demo's data is seeded — 238, 410, 112, 3,412 are
   * assertable numbers — and the discipline is the point: if this drifts, the
   * agent may have been perfect and the FIXTURE moved, which is a different
   * and more alarming finding. `--dry-run` replays the expected call with the
   * expected arguments directly against the driver and compares, so fixture
   * drift is caught for free, with no model in the loop, before any case runs.
   */
  count?: number | Record<string, number>;
  /**
   * Which commits were allowed to run. `"none"` is the common and important
   * value: a `describe` must not change data, an ambiguous ask must not change
   * data, and an empty selection must not be made non-empty so that a commit
   * has something to do.
   *
   * A commit that was ATTEMPTED and refused is not a false commit — nothing
   * moved — and is reported separately as a near miss. The thing this field
   * counts is a `kind: "commit"` verb that returned `ok`.
   */
  commits?: "none" | string[];
  /**
   * A refusal slug that must have come back from some call, or a list of slugs
   * any one of which will do. How "accept them with nothing selected" is
   * written down: the right behaviour is to try, be told no, and relay that —
   * not to invent a selection so the sentence becomes true.
   *
   * A LIST is allowed because the refusal an app answers with is not always
   * the app's own. The core checks a plan token before it runs the verb, so
   * the same ask can come back `stale-plan` or `nothing-selected` depending on
   * whether a describe happened to mint a token first, and both are the right
   * outcome: nothing moved and the agent was told why. A case that had to name
   * exactly one would be asserting which layer answered, which is not what
   * anybody cares about and changes when the core does.
   */
  refused?: string | string[];
  /**
   * `true` when the right behaviour is to ASK rather than guess.
   *
   * Some asks are genuinely ambiguous — a name five different people share —
   * and an agent that picks one is wrong even when it picks the one you meant,
   * because it did not know. The library may not have an ask mechanism yet. So
   * this case is **skipped, not failed**, when none is found: see
   * `RunOptions.askVerb` and `askMechanism`. A harness that failed an app for
   * lacking a feature the library has not shipped would be measuring the
   * library.
   */
  asks?: true;
  /**
   * How many model round trips this should take. **Not a pass or a fail.**
   *
   * It is the drift number. A run that chose every verb correctly in nine
   * steps where four would do is telling you something real about the
   * `describe`s — the agent is reading the screen to find out what the
   * manifest should have told it — and that finding is worth a number and not
   * a red cross, because the alternative is authors loosening the bound until
   * it stops complaining.
   */
  steps?: StepBound;
}

/** One case: a plain-English ask plus what should happen. */
export interface EvalCase {
  /** Stable, unique in a suite. Part of the cache key and the diff key, so
   *  renaming one discards its history — which is correct, since a case whose
   *  ask was rewritten is a different case. */
  id: string;
  /** What a person would type. */
  ask: string;
  /** Why this case exists and what failure it is guarding against. Prose, for
   *  the human reading the report when it goes red. */
  why?: string;
  /** Calls to run before the ask, to put the app where the ask makes sense. */
  setup?: SetupCall[];
  expect: Expect;
  /** A reason to skip. Present means the case is loaded, validated and not
   *  run — the honest way to park a case, since deleting it loses the
   *  expectation and commenting it out loses the validation. */
  skip?: string;
}

/** Where a case came from, for an error message that names a file. */
export interface LoadedCase extends EvalCase {
  readonly source: string;
}

/** One call the agent made, as the harness saw it. */
export interface CallRecord {
  /** The model round trip this call belonged to, 1-based. */
  step: number;
  name: string;
  args: Record<string, Scalar>;
  /** From the manifest; absent for `read_screen` and for a name the manifest
   *  does not have. */
  kind?: VerbKind;
  /** `false` for a refusal. `null` when there was no `Result` at all — which
   *  is `read_screen` and a call to a verb that does not exist. */
  ok: boolean | null;
  refused?: string;
  /** What the verb reported, when it reported a number. */
  count?: number;
}

/** What one run of one case produced. Serialisable: this is what the cache
 *  stores and what a diff is computed from. */
export interface Transcript {
  calls: CallRecord[];
  /** Model round trips. */
  steps: number;
  stop: StopReason;
  /** The agent's last prose. Kept because an ambiguous ask's whole answer is
   *  in here, and because a human reading a red case wants to know what it
   *  thought it was doing. */
  text?: string;
  /** Milliseconds the run took. Reported, never asserted. */
  ms?: number;
  /** True when this came back from the cache rather than from a model. */
  cached?: boolean;
}

export type Mark = "ok" | "wrong" | "n/a" | "skip";

/** How one run of one case scored. Four numbers, kept apart on purpose. */
export interface Judgement {
  /** The expected verbs appeared in order and nothing forbidden was called. */
  verb: Mark;
  /** The named arguments matched. */
  args: Mark;
  /** The reported counts matched. A `wrong` here is as likely to be fixture
   *  drift as a bad argument, which is why it is its own mark and why the
   *  message says so. */
  counts: Mark;
  /** The expected refusal came back. */
  refusal: Mark;
  /** The agent asked instead of guessing. `skip` when the library offers
   *  nothing to assert against. */
  asked: Mark;
  steps: { taken: number; bound?: number; over: boolean };
  /**
   * Commits that ran and should not have. **The expensive failure.**
   *
   * A list rather than a count, because the useful report is not "1" but
   * "accept-selected ran on 410 rows after an ambiguous ask".
   */
  falseCommits: CallRecord[];
  /** Commits that were attempted and refused. Not a failure — nothing moved —
   *  and worth printing, because a verb list that makes an agent try the
   *  expensive thing and get told no is one edit away from one that does not. */
  nearMisses: CallRecord[];
  /** One line each, for the report. */
  notes: string[];
  /**
   * Did this run do the right thing.
   *
   * **`steps` is deliberately not part of it.** Drift is a cost, not an error,
   * and folding it in would mean an author who widens a bound has "fixed" a
   * case. A false commit, by contrast, fails the case on its own whatever else
   * went right.
   */
  pass: boolean;
}

/** One case, n runs, scored. */
export interface CaseResult {
  id: string;
  ask: string;
  why?: string;
  /** `"skip"` for a case that was not run, with `skipReason`. */
  skipped?: boolean;
  skipReason?: string;
  runs: Array<{ transcript: Transcript; judgement: Judgement }>;
  /** Runs that passed, out of runs attempted. The headline for this case, and
   *  a rate rather than a boolean on purpose: see `RunOptions.runs`. */
  passed: number;
  attempted: number;
  /** Every false commit across every run, flattened. Non-empty means this case
   *  is red no matter what the rate says. */
  falseCommits: CallRecord[];
}

/** A whole suite run. The thing `--save` writes and `--diff` reads. */
export interface SuiteResult {
  /** When, so a diff can say which way round it is. ISO 8601. */
  at: string;
  /** `Manifest.version` of the driver under test. Part of the cache key: a
   *  verb list that changed invalidates every cached run, which is exactly
   *  what you want, since the verb list is what is being measured. */
  manifestVersion: string;
  app: string;
  /** Whatever the caller called the model. Opaque: this package never talks to
   *  a provider and so cannot discover it. */
  model: string;
  runs: number;
  cases: CaseResult[];
  /** Model round trips actually spent, cache hits excluded. The cost line. */
  modelCalls: number;
  cacheHits: number;
}

/** What `runSuite` needs. A driver factory rather than a driver, because every
 *  run must start on a clean fixture: a false commit in case three would
 *  otherwise silently change the counts case four asserts. */
export interface RunOptions {
  /** A fresh mounted driver, with its data reset. Called once per run. */
  newDriver: () => Driver | Promise<Driver>;
  /**
   * The model.
   *
   * A `Think` — the same function the rest of the library takes — so a local
   * model, a proxy, a queue or the demo's own `/api/chat` all satisfy it, and
   * **this package never sees an API key.** The CLI's default is
   * `backendThink("http://127.0.0.1:<port>/api/chat")`, which keeps the key on
   * the server where the demo already holds it.
   */
  think: Think;
  /** For the report and the cache key. */
  model?: string;
  /**
   * How many times to run each case. Default 3.
   *
   * **A model is a sampler and one sample is not a verdict.** Reporting a
   * single run as a pass would be the most misleading thing this tool could
   * do: the case that motivated this whole package was a model being right
   * about a bad verb list, and a model that is right two times in three is a
   * finding, not a pass. So the headline for a case is a RATE, a case is green
   * only if every run passed, and `runs: 1` prints a banner saying the number
   * is one draw. 3 is the smallest n that can tell "always" from "sometimes"
   * from "never".
   */
  runs?: number;
  /** Passed to `drive`. Default 12, the loop's own default. Raise it only to
   *  find out how far a confused agent goes; a case with a step bound has
   *  already said what it expects. */
  maxSteps?: number;
  /** Host guidance folded into the system prompt, as `drive` takes it. A suite
   *  that sets this is measuring the app's verbs PLUS this paragraph, which is
   *  legitimate and worth knowing. */
  instructions?: string;
  /**
   * The verb that means "ask the person", if the app has one.
   *
   * Named explicitly rather than guessed, so that a case with `asks: true`
   * starts being asserted the moment the mechanism exists, by adding one flag.
   * `askMechanism` guesses at the usual slugs when this is absent.
   */
  askVerb?: string;
  /** Where to cache transcripts. Absent means no caching, which is what a test
   *  wants and never what a person at a terminal wants. */
  cache?: TranscriptCache;
  signal?: AbortSignal;
  /** Called as each run starts and finishes, for a progress line. */
  onRun?: (e: {
    case: EvalCase;
    run: number;
    of: number;
    phase: "start" | "done";
    cached?: boolean;
    judgement?: Judgement;
  }) => void;
}

/**
 * The transcript cache.
 *
 * An interface rather than a path, so the suite can be tested without a disk
 * and so a team can put this behind something shared. Keyed on (case, manifest
 * version, model, run index) — see `cacheKey`. The run index is in the key on
 * purpose: raising `--runs` from 3 to 5 reuses the three you paid for and buys
 * two, instead of discarding the lot.
 */
export interface TranscriptCache {
  get(key: string): Transcript | undefined;
  set(key: string, value: Transcript): void;
}

/** What `--dry-run` found. No model was called to produce any of it. */
export interface DryResult {
  /** A case file that cannot be right: a verb that does not exist, an argument
   *  the verb does not take, a case that expects a commit it also forbids. */
  errors: string[];
  /** Something to look at that is not fatal: a case whose expected path could
   *  not be replayed, a bare numeric step bound. */
  warnings: string[];
  /** The expected counts, replayed against the real driver. A mismatch here is
   *  **fixture drift** and is an error, not a warning: it means the numbers in
   *  the case files no longer describe the app, so every count assertion in
   *  the suite is now measuring the wrong thing. */
  replayed: Array<{ id: string; verb: string; expected: number; actual: number | undefined }>;
  /** Verbs in the manifest that no case mentions. Not an error — most apps
   *  have verbs nobody evaluates — and the most useful line in a dry run,
   *  because it is the list of things nothing is watching. */
  unexercised: string[];
}

/** Re-exported so a consumer of this package does not have to import three
 *  others to type a `newDriver`. */
export type { Driver, Manifest, Result, Scalar, Snapshot, Think };
