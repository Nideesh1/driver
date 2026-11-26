/**
 * driverkit/adapters — the whole integration, as one object literal.
 *
 * ```ts
 * const dom = fromDom({
 *   where: "invoices",
 *   table: "#invoices",
 *   clicks: {
 *     save: { describe: "save the open invoice", kind: "commit" },
 *     "next-page": { describe: "show the next page of invoices", kind: "read" },
 *   },
 * });
 * const driver = mount({ app: "Invoices", ...dom });
 * ```
 *
 * That is the point of this function: for an app with no store and no exported
 * functions, the entire adoption is the literal above plus one `data-dk`
 * attribute per button. Nothing is refactored, nothing is lifted into a store,
 * and no verb is written by hand until the app author wants a better one --
 * which they will, and `verbs` is where those go, mixed in beside the clicks.
 *
 * The composition is not just convenience. Three of the decisions here are
 * ones a caller wiring A + B + C by hand would plausibly get wrong:
 *
 *  - `rev` defaults to observing the TABLE, not the document. Observing the
 *    whole document would bump on every unrelated animation in the page, and
 *    the false-stale rate in `rev.ts` stops being a round trip and starts
 *    being a livelock.
 *  - a missing table yields a snapshot with NO `rows` and a note, never
 *    `rows: []`. Absent rows says "this snapshot carries no row information";
 *    an empty array says "there are no records", and only one of those is true
 *    while a view is still mounting.
 *  - rows read from a table carry `page` by default, with `total` only when
 *    the markup declared one. An absent `page` is a claim that the agent sees
 *    every record, and nothing in a rendered DOM can support that claim --
 *    `table: { selector, complete: true }` is how an author makes it.
 *  - every click verb refuses on a disabled element instead of clicking it and
 *    reporting success. See the honest-cost note in `click.ts`.
 */

import type { Row, Scalar, Snapshot, Verb, VerbContext } from "driverkit";
import { collapse, defaultDocument, resolveRoot } from "./dom.ts";
import type { ElementLike, MutationObserverCtor, QueryRootLike, TimersLike } from "./dom.ts";
import { rowsFromTable } from "./table.ts";
import type { TableOptions } from "./table.ts";
import { revFromMutations } from "./rev.ts";
import type { RevHandle, RevOptions } from "./rev.ts";
import { findHandle } from "./click.ts";
import { controlsFromDom } from "./controls.ts";
import type { ControlsBinding, ControlsConfig } from "./controls.ts";

/** A click verb. The long form exists so `kind` can be declared, and `kind`
 *  should be declared: `click.ts` explains why no adapter can infer it. */
export interface ClickVerbSpec {
  describe: string;
  /** What the handler does to the world. Absent makes no safety claim in
   *  either direction, which for a button is usually the wrong answer -- look
   *  at the handler and say. */
  kind?: Verb["kind"];
  /** The `data-dk` value, when it differs from the verb name. */
  handle?: string;
  /** Extra refusals this verb can return, beyond `disabled`. */
  refuses?: string[];
}

export interface DomConfig {
  /** Where the user is, in their words. A function if it moves. */
  where: string | (() => string);

  /** The rendered rows. A selector, an element, or a selector plus any
   *  `rowsFromTable` option. */
  table?: string | ElementLike | ({ selector: string | ElementLike } & TableOptions);

  /** Staleness. A number or getter if your app already has a counter (mix
   *  freely -- a real counter is better than this package's), an options
   *  object to tune the observer, or omitted to observe the table. */
  rev?: number | (() => number) | ({ target?: string | object } & RevOptions);

  /** Row ids the user has selected, in selection order. A getter, or a
   *  selector matching the selected row elements -- their ids are read the
   *  same way the table reads them. */
  selected?: (() => string[]) | string;

  /** Verb name to click handle. A bare string is the description. */
  clicks?: Record<string, string | ClickVerbSpec>;

  /**
   * The controls layer: enumerate every element the app marked
   * `data-dk-control` and give an agent three generic verbs for using them.
   *
   * `true` takes the defaults and points the row scan at `table`, which is
   * what you want on a screen whose rows are the thing being driven. An object
   * is `controlsFromDom`'s config, merged over the shared `root`/`document`.
   *
   * This is the layer that makes coverage complete: a `clicks` entry is a verb
   * somebody wrote for one button, and there will always be a button nobody
   * wrote one for. See CONTROLS.md.
   */
  controls?: true | ControlsConfig;

  /** Hand-written verbs, beside the clicks. This is how you climb the ladder
   *  one verb at a time instead of all at once: a verb that calls a real
   *  function is strictly better than a verb that clicks, and nothing here
   *  stops you from having both kinds in one mount. */
  verbs?: Verb<any>[];

  /** Anything the rows cannot carry. Keep it short; it is uncached. */
  note?: string | (() => string);

  /** The `data-dk` attribute, if your app spells it differently. */
  attribute?: string;
  /** Narrow every lookup in here. */
  root?: string | QueryRootLike;
  document?: QueryRootLike;
  MutationObserver?: MutationObserverCtor;
  timers?: TimersLike;

  /** Decide whether a click should refuse. Default: refuse when the element
   *  carries `disabled` or `aria-disabled="true"`, because clicking a disabled
   *  button succeeds, does nothing, and reports `ok`. Return a reason slug, or
   *  null to allow. */
  refuseWhen?: (el: ElementLike, name: string) => string | null;
}

export interface DomBinding {
  verbs: Verb<any>[];
  visible: () => Snapshot;
  /** Tear down the mutation observer this created, if it created one.
   *  Idempotent. Does not unmount the driver. */
  stop: () => void;
}

export function fromDom(config: DomConfig): DomBinding {
  const table = normaliseTable(config);
  const rev = normaliseRev(config, table);
  const refuseWhen = config.refuseWhen ?? disabledCheck;
  const attribute = config.attribute ?? "data-dk";
  const controls = normaliseControls(config, table);

  const clickOpts = {
    attribute,
    ...(config.root === undefined ? {} : { root: config.root }),
    ...(config.document === undefined ? {} : { document: config.document }),
  };

  const clickVerbs: Verb<any>[] = Object.entries(config.clicks ?? {}).map(([name, spec]) => {
    const resolved: ClickVerbSpec = typeof spec === "string" ? { describe: spec } : spec;
    const handle = resolved.handle ?? name;
    return {
      name,
      describe: resolved.describe,
      ...(resolved.kind ? { kind: resolved.kind } : {}),
      refuses: ["disabled", ...(resolved.refuses ?? [])],
      run: (_args: Record<string, Scalar>, ctx: VerbContext) => {
        // Looked up here rather than captured, and checked before clicking.
        // `findHandle` + an explicit throw rather than `clickHandle`, because
        // the refusal has to happen between finding the element and clicking
        // it, and there is no way to interpose on a function that does both.
        const el = findHandle(handle, clickOpts);
        if (!el) {
          throw new Error(
            `driverkit: no handle \`${handle}\` for verb \`${name}\`. ` +
              `Add ${attribute}="${handle}" to the element this verb should click.`,
          );
        }
        const reason = refuseWhen(el, name);
        if (reason) {
          return ctx.refuse(
            reason,
            `the \`${name}\` control is on screen but not actionable right now`,
          );
        }
        el.click();
      },
    };
  });

  const visible = (): Snapshot => {
    const snapshot: Snapshot = {
      where: typeof config.where === "function" ? config.where() : config.where,
      rev: rev.read(),
    };

    let note = typeof config.note === "function" ? config.note() : config.note;

    if (table) {
      try {
        const read = rowsFromTable(table.selector, table.opts);
        snapshot.rows = read.rows;
        if (read.page) snapshot.page = read.page;
      } catch (err) {
        // `rows` stays absent. Not `[]`: the core documents an absent `page` as
        // a claim that the agent sees everything, and `rows: []` is the same
        // shape of lie one field over -- it says the screen has no records when
        // the truth is that this adapter could not look. The note is what tells
        // an agent to read again rather than conclude.
        const why = err instanceof Error ? err.message : String(err);
        note = note
          ? `${note} (rows unavailable: ${why})`
          : `rows unavailable, so this snapshot lists none -- that is not a claim the screen is empty: ${why}`;
      }
    }

    const selected = readSelected(config, table);
    if (selected && selected.length) snapshot.selected = selected;
    if (note) snapshot.note = note;
    // Last, so the control list is folded into whatever note the rows left
    // behind rather than replacing it. `withControls` is non-destructive for
    // exactly this reason -- a "rows unavailable" note is the one an agent most
    // needs and the easiest to clobber.
    return controls ? controls.withControls(snapshot) : snapshot;
  };

  return {
    verbs: [...clickVerbs, ...(controls ? controls.verbs : []), ...(config.verbs ?? [])],
    visible,
    stop: rev.stop,
  };
}

/**
 * Wire the controls layer, defaulting its row scan to the table.
 *
 * The default matters more than it looks. A per-row control reported once and
 * addressed by row id is the only reason a twenty-row screen with six controls
 * on each row is six snapshot entries and not a hundred and twenty — and that
 * collapsing needs to know where the rows are. A caller who wired
 * `controlsFromDom` by hand and forgot `rows` would get a hundred and twenty
 * entries under twenty names, a duplicate-name warning for each, and a
 * snapshot that grows with the table. So when `fromDom` already knows the
 * table, it says so.
 */
function normaliseControls(
  config: DomConfig,
  table: { selector: string | ElementLike; opts: TableOptions } | null,
): ControlsBinding | null {
  if (!config.controls) return null;
  const given: ControlsConfig = config.controls === true ? {} : config.controls;
  const rows: ControlsConfig["rows"] =
    given.rows ??
    (table ? ({ container: table.selector, ...table.opts } as ControlsConfig["rows"]) : undefined);
  return controlsFromDom({
    ...(config.root === undefined ? {} : { root: config.root }),
    ...(config.document === undefined ? {} : { document: config.document }),
    ...given,
    ...(rows === undefined ? {} : { rows }),
  });
}

/** `disabled` and `aria-disabled` only. Deliberately not a visibility or
 *  pointer-events check: those need layout, layout needs a real browser, and a
 *  heuristic that is right in Chrome and wrong in a test is worse than a rule
 *  the app author can read off the markup. */
function disabledCheck(el: ElementLike): string | null {
  if (el.getAttribute("disabled") !== null) return "disabled";
  if (collapse(el.getAttribute("aria-disabled")) === "true") return "disabled";
  return null;
}

function normaliseTable(
  config: DomConfig,
): { selector: string | ElementLike; opts: TableOptions } | null {
  if (config.table === undefined) return null;
  const spec = config.table;
  const shared = {
    ...(config.root === undefined ? {} : { root: config.root }),
    ...(config.document === undefined ? {} : { document: config.document }),
  };
  if (typeof spec === "string") return { selector: spec, opts: shared };
  if (isTableSpec(spec)) {
    const { selector, ...rest } = spec;
    return { selector, opts: { ...shared, ...rest } };
  }
  return { selector: spec, opts: shared };
}

function isTableSpec(
  spec: ElementLike | ({ selector: string | ElementLike } & TableOptions),
): spec is { selector: string | ElementLike } & TableOptions {
  return "selector" in spec;
}

/**
 * Where `rev` comes from.
 *
 * Note the default target: the table container, not the document. An observer
 * on `document` in a real app sees every toast, every hover, every spinner in
 * the chrome, and `rev.ts`'s "a false stale costs one round trip" stops being
 * true when the false stales never stop arriving.
 */
function normaliseRev(
  config: DomConfig,
  table: { selector: string | ElementLike; opts: TableOptions } | null,
): { read: () => number; stop: () => void } {
  const spec = config.rev;
  if (typeof spec === "number") return { read: () => spec, stop: () => {} };
  if (typeof spec === "function") return { read: spec, stop: () => {} };

  const revOpts: RevOptions = {
    ...(config.MutationObserver === undefined ? {} : { MutationObserver: config.MutationObserver }),
    ...(config.timers === undefined ? {} : { timers: config.timers }),
    ...(config.document === undefined ? {} : { document: config.document }),
    ...(spec ?? {}),
  };

  const target = spec?.target ?? defaultRevTarget(config, table);
  const handle: RevHandle = revFromMutations(target, revOpts);
  return { read: handle.rev, stop: handle.stop };
}

function defaultRevTarget(
  config: DomConfig,
  table: { selector: string | ElementLike; opts: TableOptions } | null,
): string | object {
  if (!table) {
    throw new Error(
      "driverkit: fromDom needs a rev. Pass `rev` (a number, a getter, or " +
        "{ target }), or pass `table` so the rendered rows can be observed.",
    );
  }
  if (typeof table.selector !== "string") return table.selector;
  const root = resolveRoot(config.root, config.document, "fromDom");
  const found = root.querySelector(table.selector);
  if (!found) {
    // Resolved once, at setup, because a MutationObserver has to be given a
    // node. An app that mounts driverkit before it renders the table hits this,
    // and the fix is a real one rather than a shrug: observe a container that
    // outlives the table.
    throw new Error(
      `driverkit: fromDom cannot observe \`${table.selector}\` because it is not in the page yet. ` +
        `Call fromDom after the table renders, or pass rev: { target: "#a-container-that-always-exists" }.`,
    );
  }
  return found;
}

/** Selected ids, read the way the table reads ids: the id attribute if the app
 *  set one, else the first cell's text. Same rule in both places on purpose --
 *  an id in `selected` that is spelled differently from the same row's id in
 *  `rows` resolves "this one" to nothing. */
function readSelected(
  config: DomConfig,
  table: { selector: string | ElementLike; opts: TableOptions } | null,
): string[] | undefined {
  if (config.selected === undefined) return undefined;
  if (typeof config.selected === "function") return config.selected();

  const idAttribute = table?.opts.idAttribute ?? "data-dk-id";
  const root = resolveRoot(config.root, config.document, "fromDom selected");
  const ids: string[] = [];
  for (const el of root.querySelectorAll(config.selected)) {
    const direct = collapse(el.getAttribute(idAttribute));
    if (direct) {
      ids.push(direct);
      continue;
    }
    const inner = el.querySelector(`[${idAttribute}]`);
    const nested = inner ? collapse(inner.getAttribute(idAttribute)) : "";
    if (nested) {
      ids.push(nested);
      continue;
    }
    const firstCell = el.querySelector(table?.opts.cellSelector ?? "td");
    const text = collapse(firstCell ? firstCell.textContent : el.textContent);
    if (text) ids.push(text);
  }
  return ids;
}

/** Re-exported for a caller who wants the row type without reaching into core
 *  through a relative path. */
export type { Row };
