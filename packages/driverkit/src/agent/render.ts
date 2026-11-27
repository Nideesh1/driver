/**
 * Rendering a Snapshot and a Result for a model to read.
 *
 * This is the TypeScript twin of `python/src/driverkit/render.py`, and the
 * duplication is on purpose: the Python half renders for an MCP client driving
 * the app from outside, this half renders for a chatbot sitting inside the
 * page, and **a model must read the same sentences about the same screen
 * either way.** Two halves of one library that describe one app differently is
 * not a cosmetic problem — a prompt that worked through MCP and misbehaves in
 * the widget is a bug with no stack trace. When you change wording here,
 * change it there.
 *
 * Why render text at all rather than `JSON.stringify` at the boundary: a tool
 * result is prompt. The snapshot that comes back from every call is the
 * uncached half, so its bytes are paid for on every turn, and JSON spends a
 * large share of them on punctuation and on repeating each column name once
 * per row. The thing a model re-reads most often is the thing we made
 * smallest.
 *
 * The second rule is that the post-call snapshot is never dropped. `Result`
 * carries it so acting and observing are one round trip; a renderer that
 * returned "ok" and nothing else would hand that saving straight back, because
 * the model's next move would be to read the screen it was just given.
 *
 * **One difference from the Python half, and it is a simplification.** There
 * are no relay refusals here. `no-such-tab`, `tab-went-away` and `timeout`
 * describe a call that never reached a tab, and in-page there is no tab to
 * miss and no deadline to blow: `driver.call()` is a function call that always
 * returns a `Result` with a `snapshot`. So the unknown-outcome branch, which
 * is most of the Python file, has nothing to render and is absent rather than
 * ported as dead code.
 */

import type { Result, Row, Scalar, Snapshot } from "../core/index.ts";

/** Verbatim from the Python half. Both describe the same `Result` field. */
const COUNT_NOTE =
  "This is what a commit verb acting on the current selection would affect. " +
  "Check it is the number you expect before committing.";

/**
 * The line that carries a plan token to the model.
 *
 * Rendered directly under the count, because it is the count's receipt and
 * means nothing apart from it. Without this line the token exists in the
 * `Result` and the model never sees it, so every commit that requires one is
 * refused — the field would be plumbing that reaches everywhere except the one
 * reader that has to use it.
 *
 * Verbatim with `render.py`. The two renderers say the same words to the same
 * model and a difference between them is a difference in what an agent is told
 * depending on how it connected.
 */
const PLAN_NOTE =
  "Pass this `plan` back to the commit verb that acts on this selection. It is the receipt " +
  "for the count above: if anything moves the selection first the commit is refused as " +
  "`stale-plan` rather than acting on rows nobody counted. One commit per plan. Reading and " +
  "navigating do not move the selection and do not spend this plan, so go and check whatever " +
  "you need to before you commit.";

/**
 * The screen as a short text block.
 *
 * ```
 * screen: contacts
 * where: contacts, filtered to Acme (rev 8)
 * selected: c-8821
 * rows 1-2 of 5
 * id      company  status
 * c-8820  Acme     new
 * c-8821  Acme     accepted
 * ```
 *
 * Field order is fixed so the same screen renders identically every time: a
 * model comparing two reads should see a diff only where the screen changed.
 *
 * `screen` goes FIRST, above the prose, and is omitted by an app that does not
 * declare one. It is the one line on this block a model can compare for
 * equality: `where` carries the filter, the sort and a drill-down's record
 * description, so it moves for reasons that are not navigation, and two reads
 * either side of a `go` differ in a dozen ways. One short word that changes if
 * and only if the screen changed is worth a line of the uncached half.
 */
export function renderSnapshot(snapshot: Snapshot): string {
  const lines = snapshot.screen
    ? [`screen: ${snapshot.screen}`, `where: ${snapshot.where} (rev ${snapshot.rev})`]
    : [`where: ${snapshot.where} (rev ${snapshot.rev})`];

  const selected = snapshot.selected ?? [];
  if (selected.length > 0) {
    // Before the rows, because "this one" is usually the subject of the next
    // verb and the model should not have to scan the table to find it.
    lines.push("selected: " + selected.join(", "));
  }

  if (snapshot.selectedCount !== undefined && snapshot.selectedCount !== selected.length) {
    // The ids and the size of a selection are different facts, and the size is
    // the one a commit decision turns on. `selected` carries only what is on
    // screen — ten thousand ids in the uncached half is the token budget
    // gone — so a model holding three ids and about to commit has to be told in
    // words that the list is a window onto the selection and not the selection.
    lines.push(
      `selected ${commas(snapshot.selectedCount)} rows in all; ` +
        (selected.length
          ? `the ${selected.length} ids above are only the ones on screen`
          : "none of them are on screen"),
    );
  } else if (selected.length === 0) {
    // An absent value reads as a claim — the same defect already fixed on
    // `page` and on `rows`, in the one remaining place it was still live.
    //
    // This block used to be nothing at all: the selection was described only
    // when it was non-empty, so a screen with nothing selected said NOTHING
    // about selections, and silence cannot be told from "this screen does not
    // report selections". The library's own rule is that a commit is never
    // made on a count nobody read, so a model asked to accept the selection
    // here obeyed the rule against a screen that told it nothing — and went
    // navigating other screens hunting for the number. Observed in an eval
    // run, not imagined.
    //
    //   selectedCount: 0            the app counts, and the answer is none
    //   count absent, selected []   the app says which ids on screen are
    //                               selected and none are, but does not count,
    //                               so a row off screen may still be selected
    //   both absent                 the app does not report selections at all
    //
    // Three sentences because they are three different facts, and the whole
    // bug was one of them being rendered as another. The middle one is the
    // weakest claim and the one nobody thinks about; conflating it with the
    // first would say "nothing is selected" on the strength of a window.
    if (snapshot.selectedCount === 0) {
      lines.push("selected: none (0 rows; this screen counts the selection)");
    } else if (snapshot.selected === undefined) {
      lines.push("(this screen reports no selection)");
    } else {
      lines.push(
        "selected: none on screen; this screen does not count the selection, so rows off " +
          "screen may be selected",
      );
    }
  }

  if (snapshot.note) lines.push(`note: ${snapshot.note}`);

  const rows = snapshot.rows;
  if (rows === undefined) {
    // Absent rows and zero rows are different claims. An app with no table on
    // screen reports no rows; a filter that matched nothing reports an empty
    // list, and an agent told "no rows" in the first case would conclude the
    // records do not exist.
    lines.push("(this screen reports no rows)");
    return lines.join("\n");
  }

  const page = snapshot.page;
  if (page !== undefined) {
    const first = rows.length ? page.index * page.size + 1 : 0;
    const seen = page.index * page.size + rows.length;

    if (page.total === undefined) {
      // `page.total` is optional, and total-absent is the NORMAL case for
      // anything reading a rendered DOM: an adapter cannot tell a virtualised
      // grid from a short list, so it is the only honest thing it can say. The
      // unguarded interpolation this replaces printed `of undefined` into the
      // prompt on every turn of every DOM-adapted app.
      //
      // Rendered as a claim rather than as a gap. "of at least 20" is true,
      // which "of undefined" and "of 20" are not — the first is noise a model
      // ignores or hallucinates around, the second tells it the table ends
      // where the window ends and invites it to report that a record does not
      // exist. The count a nobody-knows total would need is simply not said.
      lines.push(
        rows.length
          ? `rows ${first}-${first + rows.length - 1} of at least ${seen} (total unknown)`
          : `rows 0 of at least ${seen} (total unknown)`,
      );
      lines.push(
        "the total is not known, so more rows may exist off screen; use the app's own paging " +
          "verb to look further, and do not report that something is absent on the strength " +
          "of this window",
      );
    } else {
      lines.push(
        rows.length
          ? `rows ${first}-${first + rows.length - 1} of ${page.total}`
          : `rows 0 of ${page.total}`,
      );
      if (seen < page.total) {
        // Said in words, because `of 5` alone has repeatedly been read by
        // models as "I have all five".
        lines.push("more rows exist off screen; use the app's own paging verb to reach them");
      }
    }
  } else {
    // No `page` is a claim that this is everything. Worth stating, since the
    // alternative reading — "the driver forgot to tell me" — leads an agent to
    // hunt for a paging verb that does not exist.
    lines.push(`rows ${rows.length} (all of them)`);
  }

  if (rows.length === 0) {
    lines.push("(no rows on screen)");
    return lines.join("\n");
  }

  for (const line of table(rows)) lines.push(line);
  return lines.join("\n");
}

/**
 * A Result as text: the outcome, then the screen it left behind.
 *
 * A refusal renders as an ordinary outcome and not as an error banner. The
 * slug is the one the manifest already declared under `refuses`, so an agent
 * that read the tool description recognises the word and generally knows the
 * fix; wrapping it in alarm language mostly teaches a model to retry the same
 * call unchanged.
 *
 * Byte-identical to what `render_result` produces in the Python half, which is
 * why the join lives here and not only where the loop needs the halves apart.
 * `drive` composes the same two pieces with a seam of its own between them —
 * see `renderOutcome` — but this exported renderer, the one an MCP client's
 * agent reads, goes on saying exactly what the Python one says.
 */
export function renderResult(result: Result): string {
  return renderOutcome(result) + "\n\n" + renderSnapshot(result.snapshot);
}

/**
 * The outcome half of a `Result`: `ok`, the count, or the refusal and its hint.
 *
 * Split out because the two halves of a tool result age at different rates, and
 * only something that can hold them apart can act on that. The screen below is
 * current for exactly one turn. THIS half stays true forever: it is the answer
 * to "what did my third call actually do", and it is a line or two rather than
 * a table. The loop keeps it and drops the screen from older tool turns — see
 * `pruneScreens`.
 */
export function renderOutcome(result: Result): string {
  let head: string;

  if (result.ok) {
    head = "ok" + (result.note ? ` — ${result.note}` : "");
    if (result.count !== undefined) {
      // On its own line, high up, with thousands separators. This is the
      // number a person would have to see before pressing a bulk button, and
      // the reason `describe` and `commit` are separate verbs; a renderer that
      // folds it into prose further down has given back the safety the split
      // was bought with. 1000 and 10000 also look alike at a glance, which is
      // the mistake that costs the most.
      head += `\ncount: ${commas(result.count)} matched\n${COUNT_NOTE}`;
    }
    if (result.plan !== undefined) {
      head += `\nplan: ${result.plan}\n${PLAN_NOTE}`;
    }
  } else {
    head = `refused: ${result.refused}`;
    if (result.hint) head += `\nhint: ${result.hint}`;
  }

  return head;
}

/**
 * The shortest honest wait worth a line in a prompt.
 *
 * One second, and the number is the whole token argument. A duration on every
 * call is a line in every turn forever, for a capability most runs never use,
 * and `pruneScreens` cut a ten-step run from 5,775 to 1,397 characters by
 * refusing to pay exactly that kind of per-step rent. So the default is that a
 * call which took no time says nothing: a snappy app renders not one byte more
 * than it did before this existed, and the bytes get spent only on the calls
 * where elapsed time is a fact about the app rather than noise.
 *
 * A second is also roughly where a wait stops being invisible to the person
 * watching the panel. Below it, the model learning the number changes no
 * decision it could make; above it, "this verb is slow" is a real property of
 * the app that explains why the next step should not be another one of these.
 */
export const SLOW_MS = 1000;

/**
 * How long a call took, as one line for the outcome half of a tool turn.
 *
 * ```
 * ok — 3,412 contacts accepted
 * took: ~2s
 *
 * On screen now:
 * screen: contacts
 * ```
 *
 * **Why this is a function and not a field on `Result`.** A `Result` is what
 * the APP returned; a duration is a fact about the call that wrapped it, which
 * the app never measured and cannot be asked to. Putting it on the wire would
 * invite an app to fill it in, and then the number a model reads would be an
 * app's claim about its own speed rather than an observation. The caller
 * measures, the caller renders, and this is the one place either half of the
 * library says it in words.
 *
 * **Why it is bucketed rather than exact.** Every other byte of a rendered
 * turn is a function of app state, so two identical runs produce identical
 * transcripts — which is what eval caching, snapshot tests and anything that
 * diffs transcripts are built on. A wall-clock millisecond count breaks that
 * for every reader at once. Rounding to a coarse bucket gives it back for the
 * ordinary case: a verb that takes 2.1s one run and 2.3s the next renders
 * `~2s` both times, so the transcript is stable wherever the app's own
 * behaviour is. It does not make the output a pure function of state — a
 * bucket boundary is still a boundary, and a call that straddles one renders
 * two ways — and that is why `Clock.now` is injectable through `DriveOptions
 * .clock`: a suite or an eval that needs a byte-exact transcript pins the
 * clock and gets one. Buckets are for production, the injected clock is for
 * determinism, and neither is asked to do the other's job.
 *
 * `~` is on the number on purpose. A model shown `took: 2.13s` will compare
 * two of them to three figures and report a difference that is scheduler
 * noise; `~2s` cannot be over-read, and reads naturally in an answer a person
 * gets back.
 *
 * **What this must never include.** The time a person spent deciding. `ms` in
 * an `AuditEvent` is approval-inclusive by design — a reader of the record
 * wants that gap back — but telling a MODEL that a call "took 40 seconds" when
 * 38 of them were somebody reading a confirmation dialog is a false claim
 * about the app's speed, and a model that believes it will go looking for a
 * faster route around a verb that is not slow. The caller is responsible for
 * handing in work time only; see `DriveOptions.waited`, which is how a host
 * that gates commits INSIDE `driver.call()` subtracts its own dialog.
 *
 * `floorMs` below is the "not interesting" threshold, and `0` renders every
 * call. Returns the EMPTY STRING rather than a sentinel when there is nothing
 * worth saying, so a caller appends it unconditionally and the fast path adds
 * no line at all.
 *
 * Verbatim with `render.py`. Both halves say the same words about the same
 * number, which is the rule for everything in this file: a prompt that worked
 * through MCP and misbehaves in the widget is a bug with no stack trace.
 */
export function renderDuration(ms: number, floorMs: number = SLOW_MS): string {
  const whole = Math.floor(ms);
  // A negative or non-finite figure is a broken clock, not a fast call, and
  // the honest rendering of a measurement that did not happen is silence. A
  // monotonic clock cannot go backwards; an injected one can, and a test
  // clock that does should not put `took: ~-1s` in a prompt.
  if (!Number.isFinite(whole) || whole < 0) return "";
  if (whole < floorMs) return "";
  return `took: ${bucket(whole)}`;
}

/**
 * Whole milliseconds as a coarse, stable label.
 *
 * Integer arithmetic only, and no locale and no float formatting anywhere:
 * `toFixed` and `%.1f` are the two things most likely to disagree between the
 * two implementations, and this function's entire job is to agree. Each band
 * floors rather than rounds, so the label never claims more time than elapsed.
 *
 *   under 100ms   `under 0.1s`   said in words, because `~0.0s` reads as zero
 *                                and `~0.1s` would overstate it
 *   under 1s      `~0.4s`        tenths: the resolution a `floorMs: 0` caller
 *                                asked for, and the one at which two fetches
 *                                are actually worth comparing
 *   under 10s     `~2s`          whole seconds
 *   under 1m      `~15s`         five-second steps. Tens were the first try and
 *                                understated badly at the top of the band —
 *                                19 seconds rendering `~10s` is a 47% lie, and
 *                                "it took ten seconds" is the sentence a model
 *                                will repeat to somebody. Five is still far
 *                                coarser than any scheduler noise, so the
 *                                label is stable where the app is
 *   1m and over   `~3m`          whole minutes
 */
function bucket(ms: number): string {
  if (ms < 100) return "under 0.1s";
  if (ms < 1000) return `~0.${Math.floor(ms / 100)}s`;
  if (ms < 10_000) return `~${Math.floor(ms / 1000)}s`;
  if (ms < 60_000) return `~${Math.floor(ms / 5_000) * 5}s`;
  return `~${Math.floor(ms / 60_000)}m`;
}

/**
 * Rows as a padded text table.
 *
 * Columns are `id` first, then every other key in the order it was first
 * seen — the union over all rows, not the first row's keys. Rows are not
 * required to agree, and silently dropping a column that only some rows carry
 * would hide exactly the outlier a person is usually asking about.
 */
function table(rows: Row[]): string[] {
  const columns = ["id"];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const cells = rows.map((row) => columns.map((c) => cell(row[c])));
  const widths = columns.map((c) => c.length);
  for (const rowCells of cells) {
    for (let i = 0; i < rowCells.length; i++) {
      widths[i] = Math.max(widths[i]!, rowCells[i]!.length);
    }
  }

  const line = (values: string[]): string =>
    values
      // The last column is not padded: trailing spaces are tokens that carry
      // nothing.
      .map((v, i) => (i < values.length - 1 ? v.padEnd(widths[i]!) : v))
      .join("  ")
      .replace(/\s+$/, "");

  return [line(columns), ...cells.map(line)];
}

function cell(value: Scalar | undefined): string {
  if (value === undefined || value === null) return "-";
  if (value === true) return "true";
  if (value === false) return "false";
  return String(value);
}

/**
 * Thousands separators, hand-rolled.
 *
 * Not `toLocaleString()`. That reads the host's locale, so the same count
 * renders `1,000` for one person and `1.000` for another and `1 000` for a
 * third — a per-user difference in the uncached half, and in the one number
 * the commit decision turns on. The Python half writes `1,000`; so does this.
 *
 * Exported because the widget asks the person "accept 1,000 contacts?" about
 * the same number the model was told about. One implementation, so the figure
 * in the prompt and the figure on the button cannot come to disagree about
 * where the comma goes.
 */
export function commas(n: number): string {
  const digits = Math.trunc(Math.abs(n)).toString();
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return (n < 0 ? "-" : "") + out;
}
