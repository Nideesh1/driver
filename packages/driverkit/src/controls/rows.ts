/**
 * driverkit/controls — which rows are on screen, and what each one is called.
 *
 * This is NOT a reader. It produces no `Row`, no cell values, no `page` and
 * nothing that reaches `visible()`; it answers the one question the controls
 * layer cannot avoid asking. A per-row control is addressed by row id, and the
 * id an agent passes back is one it read out of `Snapshot.rows` — so this file
 * has to spell a row's id the way the app's own `visible()` spells it, or a
 * control refuses for a row that is plainly on screen.
 *
 * It is deliberately smaller than the reader that used to answer this.
 * `rowsFromTable` had to guess a whole data shape out of markup — column keys,
 * header slugs, totals, window position — and every one of those was a shape
 * somebody's app did differently. None of it is needed to name a row, so none
 * of it is here. What remains is the id precedence and nothing else:
 *
 *   1. `data-dk-id` on the row element.
 *   2. `data-dk-id` on any cell inside it.
 *   3. `idFrom(row, index)`, for markup you cannot annotate.
 *   4. The first cell's text.
 *   5. `row<n>`, positionally, with a warning.
 *
 * If your rows carry the ids your snapshot reports — and they should, because
 * that is the id an agent will pass back — put them in `data-dk-id` and
 * nothing below step 1 ever runs.
 */

import { collapse, resolveRoot } from "./dom.ts";
import type { ElementLike, QueryRootLike } from "./dom.ts";

/** How a row's id is spelled. Every field is optional, and the defaults suit a
 *  plain `<table>`; a row carrying `data-dk-id` needs none of them. */
export interface RowIdOptions {
  /** Where to look. Defaults to the real `document`; see `dom.ts` on why this
   *  is an option at all. */
  document?: QueryRootLike;
  /** Narrow the search before the container selector runs. */
  root?: string | QueryRootLike;
  /** Rows within the container. Default: `tbody tr`, falling back to `tr`
   *  minus any row containing a `th`, so a `<tbody>`-less table does not
   *  report its own header row as a row. */
  rowSelector?: string;
  /** Cells within a row. Default `td`, falling back to `th, td` for markup
   *  that puts the id in a `<th scope="row">`. */
  cellSelector?: string;
  /** Attribute holding a row's id, on the row or on any cell in it.
   *  Default `data-dk-id`. */
  idAttribute?: string;
  /** Last resort before positional ids, for generated or third-party markup
   *  you cannot add an attribute to. */
  idFrom?: (row: ElementLike, index: number) => string | null;
  /** Diagnostics an app author should see and an agent must never be told.
   *  Default: `console.warn` once per distinct message, if there is a console. */
  onWarn?: (message: string) => void;
}

/**
 * The row elements of a container, each paired with the id a control accepts
 * for it.
 *
 * Returns `[]` for a container that is not there rather than throwing. Zero
 * row-controls is a claim about this screen's controls, which the screen-level
 * ones answer anyway; it is not a claim about the records, which is the claim
 * that must never be made by accident.
 */
export function rowHandles(
  selector: string | ElementLike,
  opts: RowIdOptions = {},
): Array<{ el: ElementLike; id: string }> {
  const container = find(selector, opts);
  if (!container) return [];

  const warn = warner(opts.onWarn);
  const idAttribute = opts.idAttribute ?? "data-dk-id";
  const cellSelector = opts.cellSelector ?? "td";

  const out: Array<{ el: ElementLike; id: string }> = [];
  const seen = new Map<string, number>();

  rowsOf(container, opts.rowSelector).forEach((rowEl, rowIndex) => {
    let cells = [...rowEl.querySelectorAll(cellSelector)];
    if (cells.length === 0 && !opts.cellSelector) cells = [...rowEl.querySelectorAll("th, td")];
    if (cells.length === 0) return; // a spacer row, or a row of one colspan

    const id = idOf(rowEl, cells, rowIndex, idAttribute, opts, warn);
    const at = seen.get(id);
    if (at !== undefined) {
      // Not renamed. A suffixed id (`c-0184#2`) would be an id no verb in the
      // app accepts, traded for one that at least round-trips. Reported
      // instead: two rows sharing an id means every "that one" acts on
      // whichever is found first, and only the app author can fix it.
      warn(
        `controls: rows ${at} and ${rowIndex} both have id \`${id}\`. ` +
          `A per-row control named with that id will act on whichever is found first. ` +
          `Set ${idAttribute} on each row.`,
      );
    } else {
      seen.set(id, rowIndex);
    }
    out.push({ el: rowEl, id });
  });

  return out;
}

function find(selector: string | ElementLike, opts: RowIdOptions): ElementLike | null {
  if (typeof selector !== "string") return selector;
  const root = resolveRoot(opts.root, opts.document, "the controls row scan");
  return root.querySelector(selector);
}

/** Rows, with the fallback that keeps a `<tbody>`-less table from reporting its
 *  own header row as a row. */
function rowsOf(container: ElementLike, rowSelector: string | undefined): ElementLike[] {
  if (rowSelector) return [...container.querySelectorAll(rowSelector)];
  const inBody = [...container.querySelectorAll("tbody tr")];
  if (inBody.length) return inBody;
  return [...container.querySelectorAll("tr")].filter(
    (tr) => tr.querySelectorAll("th").length === 0,
  );
}

function idOf(
  rowEl: ElementLike,
  cells: ElementLike[],
  rowIndex: number,
  idAttribute: string,
  opts: RowIdOptions,
  warn: (m: string) => void,
): string {
  const onRow = collapse(rowEl.getAttribute(idAttribute));
  if (onRow) return onRow;
  for (const cell of cells) {
    const onCell = collapse(cell.getAttribute(idAttribute));
    if (onCell) return onCell;
  }
  if (opts.idFrom) {
    const custom = opts.idFrom(rowEl, rowIndex);
    if (custom) return custom;
  }
  const first = collapse(cells[0]?.textContent);
  if (first !== "") return first;

  // Positional, and loudly. An id that is really a row number is stable only
  // until somebody sorts the table, and a control called with `row3` after a
  // sort acts on a row the agent never saw — the exact failure `rev` exists to
  // prevent, reintroduced one layer down where `rev` cannot see it.
  warn(
    `controls: row ${rowIndex} has no id, so it is addressed as \`row${rowIndex}\`. ` +
      `Positional ids move when the table is sorted or scrolled. Set ${idAttribute} on the row.`,
  );
  return `row${rowIndex}`;
}

/** Default warnings go to the console once each. `visible()` runs on every
 *  verb call, so a per-call set would repeat the same line for the life of the
 *  page, and a warning that scrolls is a warning nobody reads. */
const alreadySaid = new Set<string>();

function warner(onWarn?: (m: string) => void): (m: string) => void {
  if (onWarn) return onWarn;
  const said = alreadySaid;
  const console = (globalThis as { console?: { warn?: (m: string) => void } }).console;
  return (message: string) => {
    if (said.has(message) || !console?.warn) return;
    said.add(message);
    console.warn(`driverkit: ${message}`);
  };
}
