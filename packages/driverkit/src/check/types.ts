/**
 * driverkit/check — the types.
 *
 * WHAT THIS SUBPATH IS FOR, since the rest of the library is about describing
 * an app and this one is about doubting the description.
 *
 * `packages/eval` answers "does a model pick the right verb for what the
 * person said". That is a question about the model. There is a second question
 * nobody was asking: **does the app's own `visible()` tell the truth.** Every
 * safety mechanism in the core is built on a snapshot being an honest account
 * of what a person can see — `stale` rests on `rev` moving, the plan token
 * rests on `rev` and `selectionId`, the renderer's three-state `page` rule
 * rests on absence meaning "these are all the rows there are" — and all of
 * that is the app author's half of the contract, written once in an afternoon
 * and never checked again.
 *
 * A dishonest `visible()` is the worst failure mode this library has, because
 * nothing about it is loud. The verbs work. The evals pass. The agent is
 * quietly misled forever, and the symptom shows up as "the model keeps saying
 * the record does not exist" months later.
 *
 * So the checks here are the lies the library's own comments already name,
 * turned into something mechanical. Nothing in this subpath is imported by the
 * core, by `driverkit/agent` or by `driverkit/widget`, and nothing in the core
 * knows it exists — see `checkDriver` for why that is the shape rather than a
 * `strict` flag on `mount()`.
 */

import type { Scalar, Snapshot } from "../core/types.ts";

/**
 * One thing the checker found, named so an author can act on it.
 *
 * `check` is a stable slug and `message` is a sentence. The slug is what a
 * test asserts and what an author greps for; the sentence is what tells them
 * which field in which function to change. Both, because a slug on its own
 * sends somebody to read this file and a sentence on its own cannot be
 * asserted without pinning its wording.
 */
export interface Finding {
  /** Stable, kebab-case. Named in `CHECKS` with one line each. */
  check: string;
  /**
   * How sure the checker is that this is WRONG, as opposed to weak.
   *
   *   `"lie"`  — the snapshot contradicts itself or contradicts what the app
   *              just did. There is no app for which this is correct, so a
   *              test suite should fail on it.
   *   `"warn"` — the snapshot makes a weaker claim than it looks like it
   *              makes, or costs more than it is documented to cost. A real
   *              app may ship this on purpose.
   *
   * Two levels and not three. The decision a reader makes with this is binary
   * — fail the build or print it — and a middle level is a level everybody
   * configures differently, which is how a checker's output stops being
   * comparable between two apps.
   */
  severity: "lie" | "warn";
  /** The verb whose call revealed it, when a call did. Absent for a finding
   *  read straight off a resting snapshot. */
  verb?: string;
  /** One or two sentences, in the author's terms, naming the field and the
   *  fix. Never "assertion failed". */
  message: string;
}

/**
 * What `checkDriver` hands back.
 *
 * `skipped` is as load-bearing as `findings` and is the reason this is an
 * object rather than an array. A checker that drove three of an app's eleven
 * verbs and reported "no findings" has told the author their app is honest,
 * which is a far more damaging lie than the ones it is looking for. So the
 * coverage is reported beside the result, every time, with the reason each
 * verb was left alone.
 */
export interface CheckReport {
  /** Every lie and every warning, in the order they were found. */
  findings: Finding[];
  /** `true` when nothing of severity `"lie"` was found. Warnings do not move
   *  it: an app may ship a warning knowingly, and a flag that went false for
   *  one would be a flag nobody could use in CI. */
  ok: boolean;
  /** Verbs the checker did not call, and why. The honesty of the report. */
  skipped: Array<{ verb: string; why: string }>;
  /** How many `driver.call()` the check made. An author who sees a number they
   *  did not expect against a live backend should know it. */
  calls: number;
  /** Mean microseconds per `visible()`, measured. Reported whether or not it
   *  tripped the budget, because the number is more useful than the verdict. */
  visibleUs: number;
}

export interface CheckOptions {
  /**
   * Let the checker call `kind: "commit"` verbs. **Off by default.**
   *
   * The default is the whole usability of this tool. A checker that accepts a
   * thousand contacts the first time somebody runs it is a checker they run
   * once, and the author who most needs it is the one pointing it at an app
   * wired to a real backend. `read` and `describe` are the two kinds that
   * promise no data moves, so those run by default and this field is how an
   * author says their app is disposable.
   *
   * The cost of the default is stated rather than hidden: `rev-did-not-move`
   * is the most valuable check here and a commit is the clearest way to
   * provoke it, so a run with this off reports every commit verb in `skipped`.
   * A `describe` still provokes it in most apps — it changes the selection,
   * which is a change — which is why the default is not useless.
   */
  commits?: boolean;
  /**
   * Arguments to call a verb with, by verb name.
   *
   * The checker cannot invent a predicate. `select-where` takes
   * `company=Acme` and there is no way to derive that from an `ArgSpec`, so a
   * verb with a required argument and nothing here is SKIPPED and said so,
   * rather than called with a guess and reported as refusing. A guess would
   * produce a `bad-argument` refusal that looks like a finding and is not.
   *
   * `oneOf` is the one exception: an argument that declares its values has one
   * the checker can use without guessing, so it uses the first.
   */
  args?: Record<string, Record<string, Scalar>>;
  /** Only these verbs. Everything else lands in `skipped`. For an author
   *  narrowing in on one thing, and for a test. */
  verbs?: string[];
  /**
   * The budget for one `visible()`, in milliseconds. Default 1.
   *
   * `MountOptions.visible` is documented as "must be cheap: it runs on each
   * verb call", and `call()` runs it twice — once before the verb and once
   * after — so the real multiplier on an author's mistake is two per call and
   * not one. One millisecond is a generous line for a function whose job is to
   * read state the app already has in hand; an app over it is usually
   * re-filtering or re-hashing inside it. See `Snapshot.selectionId`, which
   * says exactly that about large selections.
   */
  visibleBudgetMs?: number;
  /** How many times to call `visible()` when timing it. Default 200. Lower it
   *  if the app's `visible()` is slow enough that 200 is itself the problem. */
  visibleSamples?: number;
}

/** What the differential checks compare. Internal to the subpath; exported so
 *  a test can build one without a driver. */
export interface Pair {
  before: Snapshot;
  after: Snapshot;
}
