/**
 * driverkit/check — the snapshot honesty checker.
 *
 * WHY A WRAPPER AND NOT A `mount({ strict: true })`, AND NOT AN `eval`
 * SUBCOMMAND. Three shapes were available and the choice decides which checks
 * are even possible, so the argument is here rather than in a changelog.
 *
 * A STRICT MODE inside `mount()` can only ever run the weak half of this list.
 * The checks that matter are DIFFERENTIAL — call a verb and see whether `rev`
 * moved, page a list and see whether `page` appeared, call `visible()` twice
 * with nothing in between and see whether it changed. `call()` cannot drive
 * the app to find out: a strict mode that called a `commit` to test whether
 * `rev` bumps would be the library mutating an app's data to grade it, and one
 * that called a paging verb would move the screen under the person watching.
 * So the only thing a strict mode could check is what one resting snapshot
 * says about itself — `rows` against `page.size`, `selected` against `rows` —
 * which is the cheap third of what is here and the third least likely to be
 * wrong. It would also have to decide what to DO on a failure. Refusing the
 * call makes a dev flag change behaviour, which means dev and prod no longer
 * run the same code; warning is what `warn()` in the core already does, and
 * duplicating that mechanism behind a flag buys nothing.
 *
 * AN `eval` SUBCOMMAND puts a deterministic, free, offline check behind the
 * one tool in the repository that needs a model and an API key. Honesty is not
 * a model question — every check here is mechanical — and a check that costs
 * money per run is a check somebody runs once before a demo instead of on
 * every commit. `packages/eval` is also a development tool nobody installs
 * (see `tsconfig.build.json`), so the check would not ship to the adopter at
 * all.
 *
 * THE WRAPPER wins on the one thing that decides whether a checker is worth
 * writing: whether an author actually runs it. It is a function they call from
 * their own test file, against their own mounted driver, with no key and no
 * network —
 *
 *   import { assertHonest } from "driverkit/check";
 *   test("the snapshot tells the truth", () => assertHonest(mountMyApp()));
 *
 * — so it fails in the place an author is already looking when they break it.
 * It is also the only one of the three that is itself testable against
 * deliberately dishonest apps, which is how the checks in here are known to
 * fire at all.
 *
 * WHAT IT COSTS A PRODUCTION APP: nothing, structurally rather than by
 * promise. This file is a separate entry in the package's `exports` map, it is
 * imported by nothing in `src/` outside this folder, and the core does not
 * know it exists. An app that never imports `driverkit/check` does not bundle
 * it, and `sideEffects: false` is what lets a bundler prove that. There is no
 * flag to leave on in production because there is no flag.
 *
 * WHAT A DISHONEST `visible()` CAN STILL GET AWAY WITH is in `CHECKS` at the
 * bottom of this file, and it is a long list. A checker that claimed
 * completeness would be the thing not to trust.
 */

import type { ArgSpec, Driver, Manifest, Scalar, Snapshot } from "../core/types.ts";
import type { CheckOptions, CheckReport, Finding } from "./types.ts";

/** Default budget for one `visible()`. See `CheckOptions.visibleBudgetMs`. */
const VISIBLE_BUDGET_MS = 1;
const VISIBLE_SAMPLES = 200;

/**
 * Drive a mounted driver and report where its `visible()` is not telling the
 * truth.
 *
 * Mutates the app, which is worth saying first: it calls the app's own `read`
 * and `describe` verbs, so the screen moves and the selection changes. Point
 * it at a driver you built for the test, not at one a person is looking at.
 * `commit` verbs are left alone unless `CheckOptions.commits` says otherwise.
 *
 * Never throws for a finding — findings are the return value. It still throws
 * for the things that are not findings: a driver that is unmounted, or an app
 * whose `visible()` itself throws, because neither is a statement about
 * honesty and reporting them as one would bury them.
 */
export async function checkDriver(driver: Driver, options: CheckOptions = {}): Promise<CheckReport> {
  const findings: Finding[] = [];
  const skipped: Array<{ verb: string; why: string }> = [];
  let calls = 0;

  /**
   * Record a finding, ONCE.
   *
   * Deduped by check and message, and that is not tidiness. The static checks
   * run against every snapshot the run produces — the resting one and the one
   * after each call — because a defect that only appears on the third screen
   * is exactly the one a single read would miss. The cost of that is that a
   * standing defect, which is most of them, is rediscovered on every call and
   * would be reported once per verb. An author handed eleven copies of one
   * sentence reads it as eleven problems, starts counting instead of reading,
   * and the one finding further down that was different gets lost.
   *
   * By MESSAGE and not by slug, because the messages carry the particulars:
   * two verbs that each leave `rev` behind are two bugs and say so with two
   * verb names, while one `rows`/`page.size` contradiction seen eleven times
   * is one sentence eleven times.
   */
  const said = new Set<string>();
  const add = (f: Finding): void => {
    const key = `${f.check}\u0000${f.message}`;
    if (said.has(key)) return;
    said.add(key);
    findings.push(f);
  };

  const manifest = driver.manifest();

  // ---- visible() on its own -----------------------------------------------
  //
  // First, and before a single verb runs, because both of these are properties
  // of the function rather than of any call — and because if `visible()`
  // mutates, every differential check below is comparing against a snapshot
  // the act of reading already changed, and the rest of this report would be
  // noise. Said in that order in `impure`'s message.

  const first = driver.snapshot();
  const second = driver.snapshot();
  const impure = stable(first) !== stable(second);
  if (impure) {
    add({
      check: "visible-mutates",
      severity: "lie",
      message:
        "two `visible()` calls with nothing in between returned different snapshots. " +
        "`call()` reads it twice per verb — once before the verb and once after — so " +
        "whatever is changing is being attributed to the verb. If it is a timestamp or a " +
        "`Math.random` in `where`, take it out: `rev` is how an agent is told something " +
        "changed, and a snapshot that differs between the two reads makes `stale` fire on " +
        "calls that were never stale. If it is a counter being incremented or a cache being " +
        "filled, move it out of `visible()` — it is documented as a read.",
    });
  }

  const visibleUs = timeVisible(driver, options.visibleSamples ?? VISIBLE_SAMPLES);
  const budgetUs = (options.visibleBudgetMs ?? VISIBLE_BUDGET_MS) * 1000;
  if (visibleUs > budgetUs) {
    add({
      check: "visible-expensive",
      severity: "warn",
      message:
        `\`visible()\` averaged ${Math.round(visibleUs)}µs, over the ` +
        `${Math.round(budgetUs)}µs budget. It is documented as \`must be cheap: it runs on ` +
        "each verb call`, and `call()` runs it twice, so this is paid twice per verb. The " +
        "two usual causes are re-filtering or re-sorting the whole table in here instead of " +
        "reading a window the app already has, and re-hashing a large selection for " +
        "`selectionId` — keep a running value for that one.",
    });
  }

  // ---- what one resting snapshot says about itself ------------------------

  staticChecks(first, undefined, add);
  manifestChecks(manifest, first, add);

  // ---- then drive -----------------------------------------------------------
  //
  // `read` before `describe` before `commit`, which is `VerbKind`'s own ladder
  // of what a wrong call costs you, cheapest first. Not the manifest's order:
  // an app whose first verb is `accept-selected` would otherwise have its
  // whole check run against a table that had already been emptied.
  const order = { read: 0, describe: 1, commit: 2, undeclared: 3 } as const;
  const verbs = [...manifest.verbs].sort(
    (a, b) => order[a.kind ?? "undeclared"] - order[b.kind ?? "undeclared"],
  );

  /** Row-id signatures seen on a screen while `page` was absent. See
   *  `window-without-page`: one screen showing two different row sets while
   *  claiming completeness for both is the detection. */
  const completeClaims = new Map<string, string>();
  const noteClaim = (snapshot: Snapshot): void => {
    if (snapshot.page !== undefined) return;
    const rows = snapshot.rows;
    if (rows === undefined || rows.length === 0) return;
    // Keyed by screen, falling back to `where`. A `read` verb that navigates
    // legitimately shows a different set of rows with no `page`, because on the
    // new screen those really are all the rows there are — so comparing across
    // screens would report every multi-screen app. `where` is the weaker key
    // and changes with the filter as well, which only makes this miss things;
    // see `CHECKS`.
    const key = snapshot.screen ?? snapshot.where;
    const sig = rows.map((r) => r.id).join("\u0000");
    const was = completeClaims.get(key);
    if (was === undefined) {
      completeClaims.set(key, sig);
      return;
    }
    if (was === sig) return;
    add({
      check: "window-without-page",
      severity: "lie",
      message:
        `the \`${key}\` screen has now shown two different sets of rows with no \`page\` ` +
        "block. An absent `page` is a claim that these are all the rows there are — the " +
        'renderer says "rows N (all of them)" on the strength of it — and a screen that ' +
        "can show a different set is a window. Publish `page: { index, size }` and leave " +
        "`total` off if you do not know it; that third state exists exactly so a window " +
        "does not have to be reported as a whole.",
    });
  };
  noteClaim(first);

  for (const verb of verbs) {
    if (options.verbs && !options.verbs.includes(verb.name)) {
      skipped.push({ verb: verb.name, why: "not in `options.verbs`" });
      continue;
    }
    if (verb.kind === "commit" && !options.commits) {
      skipped.push({
        verb: verb.name,
        why: "a commit, and `options.commits` is off. `rev-did-not-move` is the check this costs you",
      });
      continue;
    }
    if (verb.consumes === "plan") {
      // Not callable without a token, and a token comes from the `describe`
      // that minted it over the selection it left behind — which this checker
      // cannot pair up without knowing which describe goes with which commit.
      // Refusing to guess: a `stale-plan` refusal reported as a finding would
      // be the checker's bug dressed as the app's.
      skipped.push({ verb: verb.name, why: "consumes a plan, which this checker does not mint" });
      continue;
    }

    const live = driver.snapshot();
    if (!onScreen(verb.screen, live.screen)) {
      skipped.push({
        verb: verb.name,
        why: `scoped to ${JSON.stringify(verb.screen)} and the app is on \`${live.screen}\``,
      });
      continue;
    }

    const args = argsFor(verb, options.args?.[verb.name]);
    if (args === null) {
      skipped.push({
        verb: verb.name,
        why: "has a required argument with no `oneOf`; pass one in `options.args` to check it",
      });
      continue;
    }

    const before = live;
    calls++;
    const result = await driver.call(verb.name, args);
    const after = result.snapshot;

    if (!result.ok) {
      // A refusal is not a finding. The checker called the verb with made-up
      // arguments on a screen it did not set up, and the app saying no is the
      // app working. Recorded in `skipped` so the coverage stays honest: this
      // verb told us nothing.
      skipped.push({ verb: verb.name, why: `refused \`${result.refused}\`` });
      continue;
    }

    staticChecks(after, verb.name, add);
    noteClaim(after);

    if (after.rev < before.rev) {
      add({
        check: "rev-went-backwards",
        severity: "lie",
        verb: verb.name,
        message:
          `\`rev\` went from ${before.rev} to ${after.rev} across \`${verb.name}\`. It is ` +
          "documented as monotonic, and every agent holding the older number will now pass " +
          "the `stale` check with a snapshot it has never seen. If this is a hash or a " +
          "version string, use a counter.",
      });
    } else if (after.rev === before.rev && stable(bodyOf(before)) !== stable(bodyOf(after))) {
      // The strong form of the check, and the reason it is this and not "a
      // describe must bump rev". A `describe` that matched nothing changes
      // nothing and must NOT bump — reporting that would be a false positive
      // on a correct app. What is never correct is the snapshot CHANGING while
      // `rev` stands still, and that is what is compared: everything but `rev`,
      // before against after.
      add({
        check: "rev-did-not-move",
        severity: "lie",
        verb: verb.name,
        message:
          `\`${verb.name}\` changed the snapshot and left \`rev\` at ${before.rev}. This is ` +
          "the one that defeats everything quietly: `stale` cannot refuse a call made " +
          "against the screen before this one, and a plan token minted here binds a `rev` " +
          "that no longer identifies anything, so a `commit` acts on a selection nobody " +
          "counted. Bump `rev` wherever the app's state changes — once, in the setter — not " +
          "in each verb, which is how one verb comes to forget.",
      });
    }

    if (verb.kind === "describe" && result.count === undefined) {
      add({
        check: "describe-without-count",
        severity: "lie",
        verb: verb.name,
        message:
          `\`${verb.name}\` declares \`kind: "describe"\` and returned no \`count\`. The ` +
          "count is the whole reason `describe` is a separate kind from `read`: it is the " +
          "number a person approves before a `commit` moves anything, and without it the " +
          "describe/commit pairing is advisory. Return `{ count }` — including `0`, which " +
          'is a real answer and not the same as "I do not count" — or declare this `read`.',
      });
    }
  }

  return {
    findings,
    ok: !findings.some((f) => f.severity === "lie"),
    skipped,
    calls,
    visibleUs,
  };
}

/**
 * `checkDriver`, but it throws on a lie. The one-liner for a test file.
 *
 * Throws on `"lie"` only, and prints the warnings into the message of the
 * error it throws when there is one. A warning on its own is not a failure:
 * `visible-expensive` is a judgement about an app's own performance budget and
 * a suite that failed on it would be a suite somebody turns off.
 */
export async function assertHonest(driver: Driver, options: CheckOptions = {}): Promise<CheckReport> {
  const report = await checkDriver(driver, options);
  if (report.ok) return report;
  const lines = report.findings.map((f) => `  [${f.severity}] ${f.check}${f.verb ? ` (${f.verb})` : ""}: ${f.message}`);
  // The coverage goes in the failure too. An author reading this is about to
  // fix one line in `visible()`, and the next thing they should know is how
  // much of their app was never looked at.
  const cover = report.skipped.length
    ? `\nnot checked: ${report.skipped.map((s) => `${s.verb} (${s.why})`).join("; ")}`
    : "";
  throw new Error(
    `driverkit/check: this app's \`visible()\` is not telling the truth.\n${lines.join("\n")}${cover}`,
  );
}

// ---------------------------------------------------------------------------

/** Everything a single snapshot can contradict about itself. */
function staticChecks(s: Snapshot, verb: string | undefined, add: (f: Finding) => void): void {
  const at = verb === undefined ? {} : { verb };
  const rows = s.rows;
  const page = s.page;

  if (rows !== undefined) {
    const ids = rows.map((r) => r.id);
    const seen = new Set<string>();
    for (const id of ids) {
      if (id === undefined || id === "") {
        add({
          check: "row-without-id",
          severity: "lie",
          ...at,
          message:
            "a row in `rows` has no `id`. `id` is what verbs take, so a row without one is " +
            "a row an agent can read about and cannot act on, and `selected` cannot refer " +
            "to it either.",
        });
        break;
      }
      if (seen.has(id)) {
        add({
          check: "duplicate-row-id",
          severity: "lie",
          ...at,
          message:
            `two rows on screen share the id \`${id}\`. An agent resolving "this one" to an ` +
            "id has no way to say which, and a per-row control addressed by id reaches " +
            "whichever the app happens to find first.",
        });
        break;
      }
      seen.add(id);
    }

    if (page !== undefined) {
      if (!(page.size > 0)) {
        add({
          check: "page-size-not-positive",
          severity: "lie",
          ...at,
          message:
            `\`page.size\` is ${page.size}. The renderer computes the row numbers a model ` +
            "reads from `index * size`, so a zero or negative size prints a window that " +
            "does not exist.",
        });
      } else if (rows.length > page.size) {
        add({
          check: "rows-exceed-page-size",
          severity: "lie",
          ...at,
          message:
            `\`rows\` has ${rows.length} entries and \`page.size\` is ${page.size}. One of ` +
            "the two is wrong, and either way the agent is being shown rows the person at " +
            "the keyboard is not — which is the one rule `Snapshot` exists to enforce.",
        });
      }
      if (page.index < 0 || !Number.isInteger(page.index)) {
        add({
          check: "page-index-not-a-page",
          severity: "lie",
          ...at,
          message: `\`page.index\` is ${page.index}; it is a zero-based page number.`,
        });
      }
      const seenThrough = page.index * page.size + rows.length;
      if (page.total !== undefined && page.total < seenThrough) {
        add({
          check: "page-total-below-window",
          severity: "lie",
          ...at,
          message:
            `\`page.total\` is ${page.total} but this window already reaches row ` +
            `${seenThrough}. The renderer prints "rows N-M of ${page.total}" from these, so ` +
            "a model is being told the table ends before the rows it can already see. If " +
            "the total is not known, leave `total` off — that third state exists for this.",
        });
      }
    }
  }

  const selected = s.selected;
  if (selected !== undefined && selected.length > 0) {
    if (rows !== undefined) {
      const onScreenIds = new Set(rows.map((r) => r.id));
      const strays = selected.filter((id) => !onScreenIds.has(id));
      if (strays.length > 0) {
        add({
          check: "selected-not-on-screen",
          severity: "lie",
          ...at,
          message:
            `\`selected\` names ${strays.length} id(s) that are not in \`rows\` ` +
            `(${strays.slice(0, 3).join(", ")}${strays.length > 3 ? ", …" : ""}). It is ` +
            'documented as on-screen ids only — it answers "which of the things in front of ' +
            'me is \'this one\'" — and the size of the selection belongs in `selectedCount`. ' +
            "Filling it with off-screen ids is also the token-budget mistake its own comment " +
            "is about: `select-where` selects thousands, and thousands of ids ride in the " +
            "uncached half of every result from then on.",
        });
      }
    }
    if (s.selectedCount === undefined) {
      add({
        check: "selected-count-missing",
        severity: "warn",
        ...at,
        message:
          `\`selected\` carries ${selected.length} id(s) and \`selectedCount\` is absent. ` +
          'Absent means "I do not count", so a model handed these ids and a bulk commit ' +
          "will believe that is the whole selection. If the number is knowable, publish it; " +
          "if the selection really is only what is on screen, publish it anyway — " +
          "`selectedCount: n` and an absent one are different claims and only one of them " +
          "is yours.",
      });
    } else if (s.selectedCount < selected.length) {
      add({
        check: "selected-count-below-selected",
        severity: "lie",
        ...at,
        message:
          `\`selectedCount\` is ${s.selectedCount} and \`selected\` lists ` +
          `${selected.length} ids. \`selected\` is a subset of the selection — the part on ` +
          "screen — so the count can never be smaller than it.",
      });
    }
  }
}

/** What the manifest promises, against what the snapshot provides. Two checks
 *  the core also warns about once at call time; they are repeated here because
 *  a console warning in a browser tab is not a thing a test suite fails on. */
function manifestChecks(manifest: Manifest, s: Snapshot, add: (f: Finding) => void): void {
  if (s.screen === undefined) {
    const scoped = manifest.verbs.filter((v) => v.screen !== undefined).map((v) => v.name);
    if (scoped.length > 0) {
      add({
        check: "screen-scoped-verbs-without-screen",
        severity: "lie",
        message:
          `${scoped.length} verb(s) are scoped to a screen (${scoped.slice(0, 3).join(", ")}` +
          `${scoped.length > 3 ? ", …" : ""}) and \`visible()\` returns no \`screen\`, so the ` +
          "check they asked for never runs. Every one of them is callable from every screen, " +
          "which is the `next-page` landing on another company's list that `Verb.screen` " +
          "exists to stop. Fill in `Snapshot.screen`, or drop `screen` from the verbs.",
      });
    }
  }
  if (s.selectionId === undefined) {
    const consuming = manifest.verbs.filter((v) => v.consumes === "plan").map((v) => v.name);
    if (consuming.length > 0) {
      add({
        check: "plan-without-selection-id",
        severity: "warn",
        message:
          `${consuming.join(", ")} consume a plan and \`visible()\` publishes no ` +
          "`selectionId`, so the token binds the `rev` and the count and nothing about the " +
          "selection itself. It still catches every change the app bumps `rev` for — which " +
          "is why this is a warning — and it cannot catch one row being swapped for another " +
          "at the same `rev`. `selectionId([...ids])` is exported for this.",
      });
    }
  }
}

/** The snapshot minus `rev`, for the did-it-change comparison. Built by
 *  rebuilding rather than by deleting a key, so the field order is this
 *  function's and not the app's — two snapshots from the same `visible()` have
 *  the same order anyway, but a `delete` on a caller's object would be this
 *  checker mutating the app it is grading. */
function bodyOf(s: Snapshot): Omit<Snapshot, "rev"> {
  const { rev: _rev, ...body } = s;
  return body;
}

/**
 * A stable string for a snapshot.
 *
 * `JSON.stringify` with sorted keys at every level, because two snapshots from
 * the same `visible()` agree on key order and two from different code paths in
 * the same `visible()` do not — an app that spreads `...(selected.length ? {
 * selected } : {})` emits the key in one branch and not the other, and a
 * plain stringify would call that a change.
 */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = (v as Record<string, unknown>)[k];
    }
    return out;
  });
}

/** Mean microseconds per `visible()`. `performance.now()` where there is one —
 *  `Date.now()` has a millisecond floor, and the budget being checked is one
 *  millisecond, so a correct app would measure as exactly 0 or exactly over. */
function timeVisible(driver: Driver, samples: number): number {
  const now =
    typeof globalThis.performance?.now === "function"
      ? () => globalThis.performance.now()
      : () => Date.now();
  const n = Math.max(1, samples);
  // Warm once outside the measurement. A first call that fills a lazy cache is
  // a real cost an author should know about, but charging it to the mean over
  // 200 samples reports it as 1/200th of itself and as nothing at all.
  driver.snapshot();
  const start = now();
  for (let i = 0; i < n; i++) driver.snapshot();
  return ((now() - start) * 1000) / n;
}

/** Whether a verb's declared screen covers the live one. Absent on either side
 *  means there is nothing to check, which is the core's own rule. */
function onScreen(wants: string | string[] | undefined, live: string | undefined): boolean {
  if (wants === undefined || live === undefined) return true;
  return Array.isArray(wants) ? wants.includes(live) : wants === live;
}

/** Arguments to call a verb with, or `null` for "cannot, without guessing". */
function argsFor(
  verb: Manifest["verbs"][number],
  given: Record<string, Scalar> | undefined,
): Record<string, Scalar> | null {
  const spec = verb.args;
  if (!spec) return given ?? {};
  const out: Record<string, Scalar> = { ...given };
  for (const [name, arg] of Object.entries(spec) as Array<[string, ArgSpec]>) {
    if (out[name] !== undefined) continue;
    if (arg.optional) continue;
    const choice = arg.oneOf?.[0];
    if (choice !== undefined) {
      out[name] = choice;
      continue;
    }
    return null;
  }
  return out;
}

/**
 * Every check, and — the part worth reading — what each one cannot see.
 *
 * A checker that claims completeness is the one not to trust, so this list is
 * written from the other end: here is what a dishonest `visible()` still gets
 * away with after a clean run.
 *
 * THE CHECKS
 *
 *   visible-mutates                    two reads, nothing between, different answers.
 *   visible-expensive                  mean over the budget; it runs twice per call.
 *   row-without-id                     a row an agent cannot name.
 *   duplicate-row-id                   two rows one agent cannot tell apart.
 *   page-size-not-positive             a window with no width.
 *   rows-exceed-page-size              more rows than the app says fit.
 *   page-index-not-a-page              a negative or fractional page number.
 *   page-total-below-window            a total smaller than what is on screen.
 *   selected-not-on-screen             `selected` naming rows nobody can see.
 *   selected-count-missing             ids with no count: reads as the whole selection.
 *   selected-count-below-selected      a total smaller than its own on-screen part.
 *   screen-scoped-verbs-without-screen a check the app asked for that cannot run.
 *   plan-without-selection-id          a token that binds `rev` and nothing else.
 *   window-without-page                one screen, two row sets, completeness claimed twice.
 *   rev-went-backwards                 not monotonic; old revs start passing `stale`.
 *   rev-did-not-move                   the screen changed and `rev` did not.
 *   describe-without-count             the pairing rule's number, missing.
 *
 * WHAT STILL GETS THROUGH
 *
 * 1. **Rows that are simply false.** Nothing here reads the app's data, so a
 *    `visible()` that reports a status of "new" for a row the screen shows as
 *    "accepted", or that hides the three rows a filter should have matched, is
 *    invisible to every check above. This is the largest hole and it is not
 *    closable from here: the only oracle for "is this what the person can see"
 *    is the rendered page, which is what `driverkit/controls` reads and what
 *    an end-to-end test asserts. The checker verifies the snapshot's INTERNAL
 *    consistency and its consistency WITH THE APP'S OWN VERBS. It cannot
 *    verify it against the screen.
 *
 * 2. **A `rev` that moves when nothing changed.** The inverse of
 *    `rev-did-not-move`, and deliberately not checked: an app that bumps on
 *    every tick is noisy and causes spurious `stale` refusals, but `rev` is
 *    documented as monotonic and bumped on change, not as bumped ONLY on
 *    change, and an app that bumps for a change the snapshot does not expose
 *    is correct. Flagging it would report correct apps.
 *
 * 3. **A window whose rows never change.** `window-without-page` needs two
 *    different row sets on one screen to fire. An app with a single screen, no
 *    paging verb and a virtualised grid showing the first twenty of a million
 *    rows with no `page` block is exactly the case the three-state rule was
 *    added for, and it is undetectable here: every call shows the same twenty
 *    rows and the lie never contradicts itself. A paging verb with a required
 *    argument and nothing in `options.args` lands in the same place.
 *
 * 4. **`selectedCount` that is merely wrong.** A count of 5 on a selection of
 *    3,412 passes everything above as long as it is not smaller than
 *    `selected.length`. The checker has no independent count; the app is the
 *    only thing that knows. Same for `page.total`, which is checked only
 *    against the window it must not undercut.
 *
 * 5. **`selectionId` that is constant.** It is checked for presence, never for
 *    the one property it has to have. A `selectionId: "sel"` returned forever
 *    makes every plan token pass, and provoking it would need the checker to
 *    change the selection two ways and compare — which needs predicates it
 *    cannot invent. Pass two `describe` calls through `options.args` and a
 *    future check could; today it cannot.
 *
 * 6. **Anything behind a commit, when `commits` is off** — which is the
 *    default. `rev-did-not-move` is most likely to fire on a `commit`, because
 *    a commit is where an author writes to a store they forgot to wrap. A run
 *    with the default reports every commit in `skipped` for exactly this
 *    reason, and an author with a disposable fixture should turn it on.
 *
 * 7. **Anything behind a required argument.** `argsFor` refuses to guess, so
 *    `select-where` is never called unless the author says what to select. The
 *    verbs most worth driving are the ones that take a predicate.
 *
 * 8. **Dishonesty that only appears under load or over time.** Every check
 *    here runs in one process in a few milliseconds. A `visible()` that is
 *    cheap on twenty rows and quadratic on twenty thousand measures as cheap,
 *    and a `rev` that is bumped by a websocket but not by a verb looks correct
 *    because no websocket landed.
 *
 * 9. **`where`, `note` and every other sentence.** They are prose for a model
 *    and nothing mechanical can tell a true sentence about a screen from a
 *    false one. `where` claiming "filtered to Acme" over unfiltered rows is
 *    the kind of thing `packages/eval` catches by accident, through a model
 *    doing the wrong thing with it, and this never will.
 */
export const CHECKS: readonly string[] = [
  "visible-mutates",
  "visible-expensive",
  "row-without-id",
  "duplicate-row-id",
  "page-size-not-positive",
  "rows-exceed-page-size",
  "page-index-not-a-page",
  "page-total-below-window",
  "selected-not-on-screen",
  "selected-count-missing",
  "selected-count-below-selected",
  "screen-scoped-verbs-without-screen",
  "plan-without-selection-id",
  "window-without-page",
  "rev-went-backwards",
  "rev-did-not-move",
  "describe-without-count",
];
