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

import type { Result, Row, Scalar, Snapshot } from "driverkit";

/** Verbatim from the Python half. Both describe the same `Result` field. */
const COUNT_NOTE =
  "This is what a commit verb acting on the current selection would affect. " +
  "Check it is the number you expect before committing.";

/**
 * The screen as a short text block.
 *
 * ```
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
 */
export function renderSnapshot(snapshot: Snapshot): string {
  const lines = [`where: ${snapshot.where} (rev ${snapshot.rev})`];

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
 */
export function renderResult(result: Result): string {
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
  } else {
    head = `refused: ${result.refused}`;
    if (result.hint) head += `\nhint: ${result.hint}`;
  }

  return head + "\n\n" + renderSnapshot(result.snapshot);
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
