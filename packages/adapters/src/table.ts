/**
 * driverkit/adapters — read a rendered table into rows.
 *
 * Why this exists: `mount()` wants a `visible()` that returns the rows on
 * screen, and the core's documentation reasonably assumes you can get them out
 * of a store. Plenty of apps cannot. The rows live in a template, or in a grid
 * component's internals, or in three components that each own a column. This
 * reads them back out of the DOM, which is the one place every app agrees they
 * are.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: read only what is actually rendered.
 *
 * A virtualised grid renders forty rows of a hundred thousand, and those forty
 * are exactly what to report -- not because it is easier, but because
 * `Snapshot` means "what a human could see right now". Reaching past the DOM
 * for the full dataset would break the cost argument (a hundred rows on screen
 * is a hundred rows in the prompt whether the table holds a hundred or a
 * million) and it would also show an agent rows the person at the keyboard
 * cannot see, which is the one thing `Snapshot` is written to prevent.
 *
 * THE CORRESPONDING OBLIGATION, and the field that carries it:
 *
 * If the rendered rows are a WINDOW onto something larger, `page` must say so.
 * `Snapshot.page`'s absence is a positive claim -- "the agent is seeing
 * everything" -- so a windowed table that reports no `page` tells an agent that
 * the forty rows it got are all the rows there are. Asked whether invoice
 * INV-9000 exists, that agent will answer no. Confidently. With evidence.
 *
 * This function cannot detect a window on its own: a virtualised grid's DOM
 * looks exactly like a short table's DOM, which is the entire point of
 * virtualisation. For a while that left no honest option -- assert
 * completeness, or invent a total -- and the best this file could do was warn
 * the developer and hope. `Snapshot.page.total` is now optional, which gives
 * the third state and with it the truthful answer:
 *
 *   page absent            these are all the rows there are
 *   page, total given      a window, and the whole is this big
 *   page, total absent     a window, and I do not know how big the whole is
 *
 * So the default is now the third state. Reading a table reports a window of
 * unknown size unless the markup says the total (`data-dk-total`, `opts.total`)
 * or the author declares the table complete (`opts.complete`). An agent that
 * gets `page` with no `total` cannot conclude a record is absent -- it knows it
 * is looking through a window and can page or filter instead. That reaches the
 * agent, which the old warning never did; the warning survives as advice to
 * supply a total, not as the last line of defence.
 *
 * Note which way the default leans. Claiming "a window of unknown size" about
 * a table that happens to be complete costs an agent a redundant check. The
 * reverse costs it a wrong answer about whether a record exists, and nothing
 * in the snapshot would contradict it. `complete: true` is therefore something
 * an author opts into deliberately, not something this function falls into by
 * failing to detect a grid.
 */

import type { Row, Scalar } from "driverkit";
import { collapse, resolveRoot } from "./dom.ts";
import type { ElementLike, QueryRootLike } from "./dom.ts";

export interface TableOptions {
  /** Where to look. Defaults to the real `document`; see `dom.ts` on why this
   *  is an option at all. */
  document?: QueryRootLike;
  /** Narrow the search before `selector` runs. A selector or an element. */
  root?: string | QueryRootLike;

  /** Rows within the container. Default: `tbody tr`, falling back to `tr`
   *  (minus any row that contains a `th`, so a bare `<table>` with no `<tbody>`
   *  does not report its header row as data). */
  rowSelector?: string;
  /** Cells within a row. Default `td`, falling back to `th, td` for markup
   *  that uses a row header -- a `<th scope="row">` holding the id is common
   *  and dropping it would lose the column the ids come from. */
  cellSelector?: string;
  /** Header cells within the container. Default `th`. */
  headerSelector?: string;

  /** Column keys, positionally, overriding every other source. The escape
   *  hatch for a table whose headers are icons. */
  columns?: string[];
  /** Attribute that names a column, on a `th` or on a `td`. Default
   *  `data-dk-col`. A per-cell one wins over the header, so a table that
   *  renames its visible header for a human does not rename the key an agent
   *  learned. */
  colAttribute?: string;

  /** Attribute holding a row's id, read off the row element or any cell in it.
   *  Default `data-dk-id`. */
  idAttribute?: string;
  /** Column key to take the id from when there is no id attribute. */
  idColumn?: string;
  /** Last resort before positional ids. Default: the first cell's text. */
  idFrom?: (row: ElementLike, cells: Record<string, Scalar>, index: number) => string | null;

  /** Total rows behind the window, when the markup does not say. A number, or
   *  a function if your app knows it at read time. */
  total?: number | (() => number);
  /** Declare that the rendered rows ARE all the rows, so `page` is omitted.
   *
   *  This is the only way to make this function assert completeness, and it is
   *  deliberately a statement by the author rather than an inference: nothing
   *  readable from the DOM distinguishes a complete table from a window onto a
   *  million rows. Set it where you know (a table you rendered from a list you
   *  hold entirely), and leave it alone everywhere else -- the default says "a
   *  window of unknown size", which is wrong in the cheap direction. */
  complete?: boolean;
  /** Attribute holding the total. Default `data-dk-total`. */
  totalAttribute?: string;
  /** 0-based index of the rendered window. Default: whatever
   *  `pageIndexAttribute` says, else 0. */
  pageIndex?: number | (() => number);
  /** Default `data-dk-page`. 0-based. */
  pageIndexAttribute?: string;
  /** Page size, when the window is not full (a last page of 3 of 50 is still
   *  size 50). Default: the number of rows rendered. */
  pageSize?: number;

  /** Turn a cell's collapsed text into the value an agent sees. Default:
   *  the text, unchanged. */
  cellValue?: (text: string, column: string, cell: ElementLike) => Scalar;

  /** What to do when `selector` matches nothing. Default `throw`.
   *
   *  `throw` is the default because the alternative is the quietest and worst
   *  failure in this package: `{ rows: [] }` is not "I could not look", it is
   *  "there are no records", and an agent cannot tell those apart. `fromDom`
   *  catches the throw and reports a snapshot with NO `rows` field and a note,
   *  which is the honest third answer -- rows absent means "this snapshot
   *  carries no row information". `empty` exists for a caller who genuinely
   *  renders no table when there is no data. */
  ifMissing?: "throw" | "empty";

  /** Diagnostics an app author should see and an agent must never be told:
   *  duplicate ids, positional id fallbacks, a possible undeclared window.
   *  Default: `console.warn` once per distinct message, if there is a console. */
  onWarn?: (message: string) => void;
}

export interface TableRead {
  rows: Row[];
  /**
   * Omitted only when the author declared `complete`. Otherwise present, with
   * `total` when it is known. See the file comment.
   *
   * `total` is optional, matching `Snapshot.page`, and it has to be: this
   * reader is the main source of the total-absent case, because the DOM cannot
   * tell a virtualised grid from a short list. Declaring it required was a lie
   * about this function's own output -- `pageOf` returns `{ index, size }` with
   * no total whenever nothing declared one -- and the lie propagated, because a
   * caller spreading a `TableRead` into a `Snapshot` was told by the types that
   * it had a number it did not have.
   */
  page?: { index: number; size: number; total?: number };
}

/**
 * Read a rendered table.
 *
 * ```ts
 * const { rows, page } = rowsFromTable("#invoices");
 * ```
 *
 * `selector` may also be an element, for an app that already has the ref.
 */
export function rowsFromTable(
  selector: string | ElementLike,
  opts: TableOptions = {},
): TableRead {
  const warn = warner(opts.onWarn);
  const container = find(selector, opts);
  if (!container) {
    if (opts.ifMissing === "empty") return { rows: [] };
    throw new Error(
      `driverkit: rowsFromTable found no element matching \`${String(selector)}\`. ` +
        `Reporting zero rows would tell an agent the records do not exist, so this throws instead. ` +
        `Pass { ifMissing: "empty" } only if your app really renders no table when there is no data.`,
    );
  }

  const rows = readRows(container, opts, warn).map(({ values, id }) => ({ ...values, id }));
  const page = pageOf(container, rows.length, opts, warn);
  return page ? { rows, page } : { rows };
}

/** One rendered row: the element, the id the snapshot will show for it, and the
 *  cell values. Internal; `rowsFromTable` and `rowHandles` are the two views of
 *  it, and they share this so an id can never be spelled one way in `rows` and
 *  another way where a control addresses it. */
interface RowRead {
  el: ElementLike;
  id: string;
  values: Record<string, Scalar>;
}

/**
 * The row elements of a container, paired with the ids `rowsFromTable` would
 * report for them.
 *
 * Exported for `controls.ts`. A per-row control is addressed by row id, and the
 * id an agent passes back is one it read out of `Snapshot.rows` — so the two
 * must be computed by the same code, including the positional `row0` fallback
 * and the `data-dk-id`/`idColumn`/`idFrom` precedence. Two near-identical id
 * rules in one package would diverge on the first bug report, and the symptom
 * would be a control that refuses for a row that is plainly on screen.
 *
 * Returns `[]` for a container that is not there, rather than throwing the way
 * `rowsFromTable` does. The asymmetry is deliberate: zero rows is a claim about
 * the records and must not be made by accident, while zero row-controls is a
 * claim about the screen's controls, which the page-level ones answer anyway.
 */
export function rowHandles(
  selector: string | ElementLike,
  opts: TableOptions = {},
): Array<{ el: ElementLike; id: string }> {
  const container = find(selector, opts);
  if (!container) return [];
  return readRows(container, opts, warner(opts.onWarn)).map(({ el, id }) => ({ el, id }));
}

function readRows(
  container: ElementLike,
  opts: TableOptions,
  warn: (m: string) => void,
): RowRead[] {
  const headerSelector = opts.headerSelector ?? "th";
  const colAttribute = opts.colAttribute ?? "data-dk-col";
  const idAttribute = opts.idAttribute ?? "data-dk-id";

  const headers = [...container.querySelectorAll(headerSelector)];
  // Header keys, positionally. `data-dk-col` on the `th` beats its text,
  // because the text is written for a person and may be "" (an icon column) or
  // may change when a designer does, and a column key that changes is a
  // breaking change to every prompt that mentioned it.
  const headerKeys = dedupe(
    headers.map((th) => collapse(th.getAttribute(colAttribute)) || slug(collapse(th.textContent)) || ""),
    warn,
  );

  const rowEls = rowsOf(container, opts.rowSelector, headerSelector);
  const cellSelector = opts.cellSelector ?? "td";

  const read: RowRead[] = [];
  const seen = new Map<string, number>();

  rowEls.forEach((rowEl, rowIndex) => {
    let cellEls = [...rowEl.querySelectorAll(cellSelector)];
    if (cellEls.length === 0 && !opts.cellSelector) cellEls = [...rowEl.querySelectorAll("th, td")];
    if (cellEls.length === 0) return; // a spacer row, or a row of one colspan

    const values: Record<string, Scalar> = {};
    const byIndex: Scalar[] = [];
    cellEls.forEach((cell, i) => {
      const key =
        opts.columns?.[i] ??
        (collapse(cell.getAttribute(colAttribute)) || undefined) ??
        (headerKeys[i] || undefined) ??
        `col${i}`;
      const text = collapse(cell.textContent);
      const value = opts.cellValue ? opts.cellValue(text, key, cell) : text;
      // First writer wins. Two cells claiming one key is the app author's bug;
      // letting the later one overwrite would make the row's contents depend on
      // column order, which is the kind of thing that changes under a sort.
      if (!(key in values)) values[key] = value;
      byIndex[i] = value;
    });

    const id = idOf(rowEl, cellEls, values, byIndex, rowIndex, idAttribute, opts, warn);
    const at = seen.get(id);
    if (at !== undefined) {
      // Not renamed. A suffixed id (`INV-1#2`) would be an id no verb in the
      // app accepts, traded for an id that at least round-trips. Reported
      // instead, because two rows sharing an id means every "park that one"
      // silently acts on whichever the app finds first, and the app author is
      // the only one who can fix it.
      warn(
        `rowsFromTable: rows ${at} and ${rowIndex} both have id \`${id}\`. ` +
          `An agent naming that id will act on whichever your verb finds first. ` +
          `Set ${idAttribute} on each row, or point idColumn at a unique column.`,
      );
    } else {
      seen.set(id, rowIndex);
    }

    read.push({ el: rowEl, id, values });
  });

  return read;
}

function find(selector: string | ElementLike, opts: TableOptions): ElementLike | null {
  if (typeof selector !== "string") return selector;
  const root = resolveRoot(opts.root, opts.document, "rowsFromTable");
  return root.querySelector(selector);
}

/** Rows, with the fallback that keeps a `<tbody>`-less table from reporting its
 *  own header row as data. */
function rowsOf(
  container: ElementLike,
  rowSelector: string | undefined,
  headerSelector: string,
): ElementLike[] {
  if (rowSelector) return [...container.querySelectorAll(rowSelector)];
  const inBody = [...container.querySelectorAll("tbody tr")];
  if (inBody.length) return inBody;
  return [...container.querySelectorAll("tr")].filter(
    (tr) => tr.querySelectorAll(headerSelector).length === 0,
  );
}

function idOf(
  rowEl: ElementLike,
  cellEls: ElementLike[],
  values: Record<string, Scalar>,
  byIndex: Scalar[],
  rowIndex: number,
  idAttribute: string,
  opts: TableOptions,
  warn: (m: string) => void,
): string {
  const onRow = collapse(rowEl.getAttribute(idAttribute));
  if (onRow) return onRow;
  for (const cell of cellEls) {
    const onCell = collapse(cell.getAttribute(idAttribute));
    if (onCell) return onCell;
  }
  if (opts.idColumn !== undefined) {
    const fromColumn = values[opts.idColumn];
    if (fromColumn !== undefined && fromColumn !== null && String(fromColumn) !== "") {
      return String(fromColumn);
    }
  }
  if (opts.idFrom) {
    const custom = opts.idFrom(rowEl, values, rowIndex);
    if (custom) return custom;
  }
  const first = byIndex[0];
  if (first !== undefined && first !== null && String(first) !== "") return String(first);

  // Positional, and loudly. An id that is really a row number is stable only
  // until somebody sorts the table, and a verb called with `row3` after a sort
  // acts on a row the agent never saw -- the exact failure `rev` exists to
  // prevent, reintroduced one layer down where `rev` cannot see it.
  warn(
    `rowsFromTable: row ${rowIndex} has no id, so it is reported as \`row${rowIndex}\`. ` +
      `Positional ids move when the table is sorted or scrolled. ` +
      `Set ${idAttribute} on the row, or pass idColumn.`,
  );
  return `row${rowIndex}`;
}

/**
 * Describe the window.
 *
 * `page` is omitted ONLY when the author declared the table complete. In every
 * other case it is present, because the rows this function returns came out of
 * a DOM that cannot tell completeness from virtualisation.
 *
 * What the fields mean when `total` is unknown:
 *
 *   `size`  the number of rows rendered. For a virtualised grid the rendered
 *           count IS the window, and no other number is available or honest.
 *           `opts.pageSize` overrides it for a paginator whose last page is
 *           short (3 rows of a size-50 page is still size 50).
 *
 *   `index` whatever `data-dk-page` or `opts.pageIndex` says, else 0. A 0 here
 *           does NOT assert "the first page" -- it is the only value available
 *           when nothing declared one, and an undeclared paginator sitting on
 *           page 4 will report 0. It is reported as a number because the field
 *           is required, so read it as "no page position was declared" rather
 *           than as a position. An agent is not misled by it the way it would
 *           be by an absent `page`: `page` is there, so it knows it is looking
 *           through a window either way, and `index` only affects whether it
 *           can say WHERE. If your app paginates, declare the attribute.
 */
function pageOf(
  container: ElementLike,
  rendered: number,
  opts: TableOptions,
  warn: (m: string) => void,
): { index: number; size: number; total?: number } | undefined {
  if (opts.complete) return undefined;

  const totalAttribute = opts.totalAttribute ?? "data-dk-total";
  const declared =
    typeof opts.total === "function"
      ? opts.total()
      : typeof opts.total === "number"
        ? opts.total
        : readNumber(container, totalAttribute);

  const index =
    typeof opts.pageIndex === "function"
      ? opts.pageIndex()
      : typeof opts.pageIndex === "number"
        ? opts.pageIndex
        : (readNumber(container, opts.pageIndexAttribute ?? "data-dk-page") ?? 0);

  const size = opts.pageSize ?? rendered;

  if (declared === undefined) {
    // Advice now, not a last line of defence: the snapshot already tells the
    // agent the truth. What it cannot tell the agent is how much is out of
    // view, which is the difference between "page until you find it" and "it
    // is not in the 3,412 I know about".
    if (rendered >= 25) {
      warn(
        `rowsFromTable: ${rendered} rows and no ${totalAttribute}, so the snapshot reports a window ` +
          `of unknown size. The agent will not conclude a record is missing, but it also cannot tell ` +
          `how much it has not seen. Set ${totalAttribute} (and ${opts.pageIndexAttribute ?? "data-dk-page"}), ` +
          `pass { total }, or pass { complete: true } if these really are all the rows.`,
      );
    }
    return { index, size };
  }

  return { index, size, total: declared };
}

function readNumber(el: ElementLike, attribute: string): number | undefined {
  const raw = collapse(el.getAttribute(attribute));
  if (raw === "") {
    const inside = el.querySelector(`[${attribute}]`);
    if (inside) return readNumber(inside, attribute);
    return undefined;
  }
  const n = Number(raw.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** A column key from header text. Lowercased and hyphenated to match the
 *  core's kebab-case house style, so an agent reading `due-date` has met the
 *  same convention it met in every verb name. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Two columns that slug to the same key would silently merge, so the later one
 *  keeps its position instead. Reported, because the right fix is a
 *  `data-dk-col` the app author chose. */
function dedupe(keys: string[], warn: (m: string) => void): string[] {
  const used = new Set<string>();
  return keys.map((key, i) => {
    if (key === "") return "";
    if (!used.has(key)) {
      used.add(key);
      return key;
    }
    warn(
      `rowsFromTable: two headers both read \`${key}\`; column ${i} is reported as \`col${i}\`. ` +
        `Set data-dk-col on each to give them names an agent can use.`,
    );
    return `col${i}`;
  });
}

/** Default warnings go to the console once each. An app author watching rows
 *  re-read on every verb call would otherwise get the same line forever, and a
 *  warning that scrolls is a warning nobody reads. */
const alreadySaid = new Set<string>();

function warner(onWarn?: (m: string) => void): (m: string) => void {
  if (onWarn) return onWarn;
  // Module-scoped, not per call: `visible()` runs on every verb call, so a
  // per-call set would repeat the same line for the life of the page.
  const said = alreadySaid;
  const console = (globalThis as { console?: { warn?: (m: string) => void } }).console;
  return (message: string) => {
    if (said.has(message) || !console?.warn) return;
    said.add(message);
    console.warn(`driverkit: ${message}`);
  };
}
