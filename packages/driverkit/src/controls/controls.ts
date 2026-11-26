/**
 * driverkit/controls — the controls layer.
 *
 * ```ts
 * const dk = controlsFromDom({ root: "#app", rows: "#contacts" });
 *
 * mount({
 *   app: "Contacts",
 *   verbs: [...myShortcuts, ...dk.verbs],
 *   visible: () => dk.withControls(myVisible()),
 * });
 * ```
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A SECOND LAYER AT ALL.
 *
 * Everything else in driverkit is a shortcut: somebody writes
 * `select-where(company, status?)` and an agent selects four hundred rows in
 * one call, with a count in front of the commit. That is the layer worth
 * having and it is not going anywhere.
 *
 * It is also, on its own, incomplete — and the incompleteness is structural
 * rather than a gap somebody can close by writing more verbs. A real failure:
 * a demo whose only selection verb was `select-where(company)`, asked to
 * select one named contact. The model refused, correctly, because the only
 * tool it had would have selected all four hundred and ten contacts at that
 * company in order to get one of them. It did the right thing with the wrong
 * vocabulary. You cannot enumerate your way out of that: somebody will always
 * ask for the thing nobody listed.
 *
 * So this layer is complete BY CONSTRUCTION instead of by curation. One
 * action, total coverage: whatever the person at the keyboard could press,
 * tick or type into, an agent can too.
 *
 *   controls    one action, total coverage     press a button, type in a field
 *   shortcuts   one call, many rows            select-where(...), accept-selected
 *
 * Neither replaces the other. A shortcut is how a thousand rows move in one
 * call with one number in front of it; a control is how the nine hundred and
 * ninety-ninth thing nobody listed gets done at all. They compose in one
 * `mount()` and an agent cannot tell which layer a verb came from.
 *
 * WHAT THIS IS NOT.
 *
 * It is not selector automation wearing a hat. The agent never sees a
 * selector, a path or a coordinate: it sees `accept` because somebody typed
 * `data-dk-control="accept"` next to their own button, and that word is the
 * only way in. Nothing here searches by label text, by role, by position or by
 * similarity, and a name that is not marked on the page is a refusal and never
 * a near miss — because a near miss is how an agent presses Delete when it
 * meant Dismiss. `Verb.at` is the one selector in the library and it is
 * presentational: it exists so a watching human sees an outline, it is never
 * used to find anything, and nothing here reads it.
 *
 * WHERE THE TWO HALVES LIVE, which is the decision the rest follows from.
 *
 *   static, cached, in the manifest    THAT the app can press a control:
 *                                      three verbs, three argument lists.
 *   dynamic, uncached, in the snapshot WHICH controls are on this screen now:
 *                                      `Snapshot.controls`.
 *
 * Getting that backwards is the expensive mistake and it has an obvious
 * shape — put the control names in a verb's `ArgSpec.oneOf`. It reads as a
 * kindness (the model cannot then name a control that does not exist) and it
 * drops a per-screen list into the prompt prefix, so every navigation busts
 * the cache for that user and every user's prefix differs from every other's.
 * The library's whole cost argument is that the static half is static. So the
 * control names are a plain `string` argument, validated against the page at
 * call time, and the list of them rides in the snapshot beside the rows.
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { ScreenControl, Snapshot, Verb, VerbContext, VerbKind } from "../core/index.ts";
import { collapse, defaultEvent, resolveRoot } from "./dom.ts";
import type { ElementLike, EventCtor, FieldLike, QueryRootLike } from "./dom.ts";
import { rowHandles } from "./rows.ts";
import type { RowIdOptions } from "./rows.ts";

/** Where the rows are, so a control inside one is reported once and addressed
 *  by row id. A selector, an element, or a selector plus the options that
 *  decide how a row's id is spelled (`rows.ts`). */
export type RowsSpec =
  | string
  | ElementLike
  | ({ container: string | ElementLike } & RowIdOptions);

export interface ControlsConfig {
  /**
   * The attribute that marks a control. Default `data-dk-control`.
   *
   * Deliberately NOT `data-dk`, which binds one hand-written verb to one
   * button. The two marks say different things: `data-dk` says "a verb I wrote
   * and described clicks this", and `data-dk-control` says "publish this to an
   * agent as a control it may press at will". Folding them together would
   * silently publish every button an app marked so one of its own verbs could
   * click it — including the ones whose author wrapped them in a narrower verb
   * on purpose — and publishing
   * is consent. Pass `{ attribute: "data-dk" }` to opt into exactly that, once
   * you have looked at the list.
   */
  attribute?: string;
  /** Where the author declares what a control does. Default `data-dk-kind`,
   *  whose value is `read`, `describe` or `commit`. */
  kindAttribute?: string;
  /** The human label, when the control's own text is not it (an icon button).
   *  Default `data-dk-label`, falling back to text, `aria-label`, `title`. */
  labelAttribute?: string;
  /** Force or deny "this control takes text". Default `data-dk-field`, read as
   *  `true`/`false`. Absent means the tag decides. */
  fieldAttribute?: string;
  /**
   * The attribute that takes a control back out. Default `data-dk-human-only`.
   *
   * An element carrying it is not enumerated and cannot be pressed or typed
   * into, even though it is marked as a control. The case it exists for is the
   * one in webmachinelearning/webmcp#288: ChatGPT's in-app browser called a
   * proposal-only tool, the proposal did not execute itself, so the agent
   * clicked the page's own Approve button and the receipt recorded "approved
   * by you". `press` and `commit-control` over `data-dk-control` are exactly
   * that bypass — one action, total coverage, including coverage of the button
   * that exists to stop the action.
   *
   * So the Yes of a confirmation, the signature field, the "I agree" tick and
   * the 2FA box carry this, and an agent naming one gets `no-such-control` —
   * indistinguishable from a name that was never marked, because a different
   * refusal would tell a prober which buttons are the interesting ones.
   *
   * IT IS THE WEAKEST OF THE THREE LAYERS and it is named as such because it
   * is the one an author can forget. The core's `approval-pending` lock needs
   * nobody to remember anything — while an approval is open no call runs at
   * all — and the widget's own dialog lives inside a shadow root this
   * enumerator never walks. Use this for a gate of your own that lives in the
   * light DOM, and never as the only thing between an agent and a commit.
   *
   * THE MARK IS INHERITED. An element inside something marked human-only is
   * itself human-only, so one attribute on a `<dialog>` takes the Yes, the
   * signature field and the 2FA box inside it out together. This used to read
   * the element and nothing else, which meant the natural way to write the
   * mark — on the gate — did nothing at all, and the only way that worked was
   * to repeat it on every descendant. The walk goes all the way out, past
   * `root`, and `data-dk-human-only="false"` on a descendant re-opens that one
   * control. See `humanOnly`.
   */
  humanOnlyAttribute?: string;

  /** Narrow every lookup. A control outside this root does not exist. */
  root?: string | QueryRootLike;
  document?: QueryRootLike;
  /** Where the rows are. Omit for a screen with no table: then every control
   *  is a screen control. */
  rows?: RowsSpec;

  /** Declare kinds in code instead of in markup, for generated or
   *  third-party markup you cannot annotate. Consulted before the attribute,
   *  and returning `undefined` falls through to it. */
  kind?: (name: string, el: ElementLike) => VerbKind | undefined;

  /** Decide whether a control should refuse. Default: refuse on `disabled` or
   *  `aria-disabled="true"`, because pressing a disabled button succeeds, does
   *  nothing, and reports `ok`. Return a reason slug, or null to allow. */
  refuseWhen?: (el: ElementLike, name: string) => string | null;

  /** Rename the three verbs, for an app that already has a verb called
   *  `press`. `mount()` throws on a duplicate name, so this is the fix. */
  names?: { press?: string; type?: string; commit?: string };

  /** The most controls to list in one snapshot. Default 40. Over it, the list
   *  is truncated and says so — see `enumerate`. */
  limit?: number;

  /** Also render the control list into `Snapshot.note`. Default true, and
   *  transitional: see the note on `note()`. */
  inNote?: boolean;

  /** Put text into a field your own way. The default assigns `value` and fires
   *  `input` and `change`; a React controlled input may need the native setter
   *  instead. See the limits section of CONTROLS.md. */
  setValue?: (el: FieldLike, text: string) => void;
  /** `Event`, defaulting to the global. */
  Event?: EventCtor;

  /** Diagnostics for the app author, which an agent must never be told:
   *  undeclared kinds, two controls sharing a name. Default: `console.warn`
   *  once per distinct message. */
  onWarn?: (message: string) => void;
}

export interface ControlsBinding {
  /** The three generic verbs. Spread these into `mount({ verbs })` beside
   *  whatever you wrote by hand. */
  verbs: Verb<any>[];
  /** The controls on screen right now. For `Snapshot.controls`. */
  controls: () => ScreenControl[];
  /** The control list as one short line, for `Snapshot.note`. */
  note: () => string | undefined;
  /** Add both to a snapshot your app already builds. Non-destructive: an
   *  existing `note` is kept and this is appended to it. */
  withControls: <S extends Snapshot>(snapshot: S) => S;
}

/** The slugs the control verbs refuse with. Declared on every one of them, so
 *  the list reaches the model in the CACHED half and a well-briefed agent
 *  avoids the call rather than discovering the answer by making it. */
const REFUSES = [
  "no-such-control",
  "no-such-row",
  "needs-row",
  "not-a-row-control",
  "wrong-verb",
  "disabled",
] as const;

/** `<input>` types that are not text. Everything else on an `input`, including
 *  `date` and `number`, takes text and is a field. A checkbox is a control you
 *  press, which is why this list exists at all: typing into one is nonsense and
 *  pressing one is the commonest per-row action there is. */
/**
 * How far up `data-dk-human-only` is looked for. See `humanOnly`.
 *
 * A number rather than an unbounded loop, because the only way `parentElement`
 * can fail to terminate is a fake that points an element at itself — a bug
 * worth surfacing as a wrong answer rather than as a page that stops
 * responding. 64 is deeper than any real markup's control-to-`<body>` distance
 * and the walk stops at the first element carrying the attribute anyway.
 */
const HUMAN_ONLY_DEPTH = 64;

const NOT_TEXT = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "image",
  "color",
  "range",
]);

/**
 * Bind the controls layer over a DOM.
 *
 * Nothing is captured. Every call re-reads the page, for the reason
 * `rows.ts` gives at length: any app worth adapting re-renders, and a node
 * captured at mount is a node that has since been detached — pressing it does
 * precisely nothing, with no error, and the verb reports success.
 */
export function controlsFromDom(config: ControlsConfig = {}): ControlsBinding {
  const attribute = config.attribute ?? "data-dk-control";
  const kindAttribute = config.kindAttribute ?? "data-dk-kind";
  const labelAttribute = config.labelAttribute ?? "data-dk-label";
  const fieldAttribute = config.fieldAttribute ?? "data-dk-field";
  const humanOnlyAttribute = config.humanOnlyAttribute ?? "data-dk-human-only";
  const limit = config.limit ?? 40;
  const refuseWhen = config.refuseWhen ?? disabledCheck;
  const warn = warner(config.onWarn);

  const names = {
    press: config.names?.press ?? "press",
    type: config.names?.type ?? "type-into",
    commit: config.names?.commit ?? "commit-control",
  };

  // ── reading the page ──────────────────────────────────────────────────────

  function root(): QueryRootLike {
    return resolveRoot(config.root, config.document, "controlsFromDom");
  }

  function rowsOf(): Array<{ el: ElementLike; id: string }> {
    if (config.rows === undefined) return [];
    const spec = config.rows;
    const shared: RowIdOptions = {
      ...(config.root === undefined ? {} : { root: config.root }),
      ...(config.document === undefined ? {} : { document: config.document }),
      ...(config.onWarn === undefined ? {} : { onWarn: config.onWarn }),
    };
    if (typeof spec === "string") return rowHandles(spec, shared);
    if (typeof spec === "object" && "container" in spec) {
      const { container, ...rest } = spec;
      return rowHandles(container, { ...shared, ...rest });
    }
    return rowHandles(spec, shared);
  }

  interface Found {
    el: ElementLike;
    name: string;
    /** The row id this element sits in, or null for a screen control. */
    row: string | null;
  }

  /**
   * Every marked element, each told whether it is inside a row.
   *
   * The row test is a containment test and not an ancestor walk, and it stays
   * one now that `ElementLike` has an optional `parentElement` for
   * `humanOnly`: it asks "is this element inside one of the rows the snapshot
   * is showing", which is exactly the question and tests against a known set,
   * rather than "does it have a `tr` somewhere above it", which is a different
   * question and the wrong answer in a nested table. The opt-out cannot be
   * written that way — there is no set of marked wrappers to test against —
   * which is why that one walks and this one does not.
   */
  function scan(): Found[] {
    const r = root();
    const inRow = new Map<ElementLike, string>();
    for (const row of rowsOf()) {
      for (const el of row.el.querySelectorAll(`[${attribute}]`)) inRow.set(el, row.id);
      // A row element may itself be the control — a clickable `<tr>`.
      if (isMarked(row.el, attribute)) inRow.set(row.el, row.id);
    }

    const out: Found[] = [];
    const withheld = new Set<string>();
    for (const el of r.querySelectorAll(`[${attribute}]`)) {
      const name = collapse(el.getAttribute(attribute));
      if (!name) continue;
      // Dropped HERE, in the one function every other function in this file
      // reads the page through, so the opt-out cannot be true of the
      // enumeration and false of the three verbs. A control that is not in
      // this list does not exist to the layer at all — which is the same
      // answer an unmarked button gets, deliberately.
      if (humanOnly(el)) {
        // Said once, and only to the author. A control that vanished because
        // of a mark on a `<dialog>` three levels up is the one case of this
        // attribute that looks like a bug in the library, so the library says
        // which it was.
        if (humanOnlyAbove(el)) withheld.add(name);
        continue;
      }
      out.push({ el, name, row: inRow.get(el) ?? null });
    }
    if (withheld.size) {
      warn(
        `controls: ${withheld.size} control(s) are inside an element marked ` +
          `${humanOnlyAttribute} and are not published: ` +
          `${[...withheld].slice(0, 12).join(", ")}. That is what the mark means — an agent is ` +
          `told nothing about them, exactly as if they were never marked as controls. Put ` +
          `${humanOnlyAttribute}="false" on one to open it again.`,
      );
    }
    return out;
  }

  /**
   * Marked for a person only, on this element or on anything above it.
   *
   * Presence is the signal, because `data-dk-human-only` with no value is how
   * an author writes it; the one exception is the literal `false`, so a
   * templating language that always emits the attribute can still say no — and
   * a `false` on the element itself wins over a mark further up, which is the
   * only reading that lets an author open one control inside a closed region.
   *
   * THE ANCESTOR WALK, which this did not have. Marking a `<dialog>` used to
   * mark nothing: every button inside the confirmation stayed enumerable and
   * pressable, which is the opposite of what the author wrote. The mark that is
   * natural to write — one attribute on the thing that is the gate — was the
   * one that did not work, and the mark that worked had to be repeated on
   * every Yes, every signature field and every 2FA box inside it. An opt-out
   * whose correct use is the laborious one is an opt-out that will be got
   * wrong.
   *
   * It walks OUT PAST `root`, not up to it. A human-only region that contains
   * the root is a region an author marked and the enumerator is standing
   * inside; stopping at the root would silently ignore it, and that is the
   * direction in which being wrong costs something. The visible consequence is
   * that a root inside a marked region enumerates nothing at all, which is
   * loud, is what the markup says, and is warned about once.
   *
   * TWO THINGS IT DOES NOT SEE, both worth knowing before relying on it. A
   * shadow boundary: `parentElement` is null on the top node of a shadow tree,
   * so a mark on the HOST element does not reach controls inside it — mark
   * something inside the tree. And an `ElementLike` that does not implement
   * `parentElement` at all (a non-DOM renderer's adapter, an older fake) reads
   * as having no ancestors, which is the element-only behaviour this had
   * before and is the compatible answer rather than the safe one.
   *
   * `DEPTH` bounds the walk. A real DOM cannot cycle, and a hand-written
   * `ElementLike` whose `parentElement` points at itself is a bug in a fake
   * that should surface as a wrong answer rather than as a hung page.
   */
  function humanOnly(el: ElementLike): boolean {
    let node: ElementLike | null | undefined = el;
    for (let depth = 0; node && depth < HUMAN_ONLY_DEPTH; depth += 1) {
      const value = node.getAttribute(humanOnlyAttribute);
      if (value !== null && value !== undefined) {
        return collapse(value).toLowerCase() !== "false";
      }
      node = node.parentElement;
    }
    return false;
  }

  /** Was this element's mark inherited from an ancestor? Only for the author's
   *  diagnostic: an agent is never told a control is being withheld, because a
   *  different answer for a withheld control is an oracle over which buttons
   *  are the interesting ones. */
  function humanOnlyAbove(el: ElementLike): boolean {
    const own = el.getAttribute(humanOnlyAttribute);
    return (own === null || own === undefined) && humanOnly(el);
  }

  function kindOf(name: string, el: ElementLike): VerbKind | undefined {
    const fromHook = config.kind?.(name, el);
    if (fromHook) return fromHook;
    const declared = collapse(el.getAttribute(kindAttribute)).toLowerCase();
    if (declared === "read" || declared === "describe" || declared === "commit") return declared;
    if (declared !== "") {
      warn(
        `controls: the control \`${name}\` declares ${kindAttribute}="${declared}", which is not ` +
          `read, describe or commit. Treating it as undeclared, which routes it through the ` +
          `commit verb and asks the human every time.`,
      );
    }
    return undefined;
  }

  function isField(el: ElementLike): boolean {
    const declared = collapse(el.getAttribute(fieldAttribute)).toLowerCase();
    if (declared === "true") return true;
    if (declared === "false") return false;
    const tag = (((el as FieldLike).tagName ?? "") as string).toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    return !NOT_TEXT.has(collapse(el.getAttribute("type")).toLowerCase());
  }

  function labelOf(name: string, el: ElementLike): string | undefined {
    const explicit = collapse(el.getAttribute(labelAttribute));
    if (explicit) return clip(explicit);
    const text = collapse(el.textContent);
    if (text) return clip(text);
    const aria = collapse(el.getAttribute("aria-label"));
    if (aria) return clip(aria);
    const title = collapse(el.getAttribute("title"));
    if (title) return clip(title);
    const placeholder = collapse(el.getAttribute("placeholder"));
    if (placeholder) return clip(placeholder);
    // No label is better than the name repeated as one: a model reading
    // `accept (accept)` learns nothing and pays for the second word.
    return undefined;
  }

  // ── the enumeration ───────────────────────────────────────────────────────

  /**
   * The controls on screen, one entry per NAME rather than per element.
   *
   * This is the field that keeps the snapshot small, and the brief it has to
   * meet is concrete: twenty rows with six controls each must not be a hundred
   * and twenty entries. So a control found inside a row is described once,
   * marked `per: "row"`, and addressed by row id — which works because the
   * markup that rendered it was one template, so the twenty copies are the same
   * control twenty times over and differ in nothing an agent needs.
   *
   * `disabled` is the one property that genuinely varies between the copies
   * (row 3's Delete greyed out, row 4's not). Collapsing cannot preserve that,
   * so it claims `disabled` only when EVERY copy is disabled, and the call-time
   * check refuses for the specific row. The snapshot is therefore not quite a
   * complete account of a row control's availability, and the alternative —
   * one entry per row per control — costs the cost argument. Said plainly in
   * CONTROLS.md rather than hidden here.
   */
  function enumerate(): { controls: ScreenControl[]; hidden: number } {
    const byName = new Map<string, { s: ScreenControl; copies: number; disabled: number }>();
    const dupes = new Set<string>();
    const undeclared: string[] = [];

    for (const { el, name, row } of scan()) {
      const existing = byName.get(name);
      const off = refuseWhen(el, name) !== null;

      if (existing) {
        existing.copies += 1;
        if (off) existing.disabled += 1;
        // Two screen controls sharing a name is an authoring bug: the verb acts
        // on whichever the page yields first, exactly like two rows sharing an
        // id. Not renamed — a suffixed name would be a name no screen shows.
        if (row === null || existing.s.per !== "row") dupes.add(name);
        continue;
      }

      const kind = kindOf(name, el);
      if (kind === undefined) undeclared.push(name);
      const label = labelOf(name, el);
      byName.set(name, {
        s: {
          name,
          ...(label === undefined ? {} : { label }),
          ...(kind === undefined ? {} : { kind }),
          ...(row === null ? {} : { per: "row" as const }),
          ...(isField(el) ? { field: true as const } : {}),
        },
        copies: 1,
        disabled: off ? 1 : 0,
      });
    }

    for (const name of dupes) {
      warn(
        `controls: two controls are both named \`${name}\`. A verb naming it acts on whichever ` +
          `the page yields first. Give them different ${attribute} values.`,
      );
    }
    if (undeclared.length) {
      // Worded as a decision the author owes, not as a nuisance they can
      // clear. The line this replaces ended "and the question goes away",
      // which is true and is also an instruction to type the cheapest value:
      // `read` silences the gate on every one of these in one pass, and
      // `read` on something that changes data is the one claim the library
      // cannot catch and will act on. So the undeclared state is named as the
      // SAFE one it is, and the declaration is named as a claim.
      warn(
        `controls: ${undeclared.length} control(s) declare no ${kindAttribute}: ` +
          `${undeclared.slice(0, 12).join(", ")}. Each is reachable only through ` +
          `\`${names.commit}\`, which asks the person first — so this is safe, and it is the ` +
          `state to leave them in until somebody has read the handler. ` +
          `${kindAttribute}="read|describe|commit" is a CLAIM about what the control does, and ` +
          `nothing here can check it: \`read\` on a button that changes data takes away the only ` +
          `thing standing in front of an agent pressing it. Declare the ones you have read.`,
      );
    }

    const all = [...byName.values()].map(({ s, copies, disabled }) =>
      copies > 0 && disabled === copies ? { ...s, disabled: true as const } : s,
    );

    // Over the limit the list is cut rather than sent. A truncated list that
    // says it is truncated costs the agent a paging step; a 200-entry list
    // costs every turn of every session, in the half that is never cached.
    if (all.length <= limit) return { controls: all, hidden: 0 };
    warn(
      `controls: ${all.length} controls on screen, over the limit of ${limit}, so ${all.length - limit} ` +
        `are not listed. Narrow \`root\` to the part of the page an agent should drive, or raise \`limit\` ` +
        `knowing it is paid for on every turn.`,
    );
    return { controls: all.slice(0, limit), hidden: all.length - limit };
  }

  /**
   * The control list as one line of text.
   *
   * Transitional, and default-on because without it the layer does not work:
   * `Snapshot.controls` is structured and new, and nothing that renders a
   * snapshot for a model reads it yet. `note` is rendered by every renderer
   * there is, so that is where the controls go until they do. Turn it off with
   * `inNote: false` once your renderer prints `controls`, and the duplication —
   * which is real, and in the uncached half — goes away.
   *
   * The grammar is terse on purpose and the legend is in the verbs'
   * descriptions, which are cached. Bare name means the author declared it
   * `read`; anything else is parenthesised.
   */
  function render(controls: ScreenControl[], hidden: number): string | undefined {
    if (controls.length === 0) return undefined;
    const screen = controls.filter((c) => c.per !== "row");
    const perRow = controls.filter((c) => c.per === "row");
    const parts: string[] = [];
    if (screen.length) parts.push(`controls: ${screen.map(one).join(", ")}`);
    if (perRow.length) parts.push(`each row: ${perRow.map(one).join(", ")}`);
    if (hidden) parts.push(`${hidden} more control(s) on this screen are not listed`);
    return parts.join("; ");
  }

  function one(c: ScreenControl): string {
    const marks: string[] = [];
    if (c.field) marks.push("text");
    if (c.kind === "describe" || c.kind === "commit") marks.push(c.kind);
    if (c.kind === undefined) marks.push("undeclared");
    if (c.disabled) marks.push("disabled");
    const label = c.label && c.label.toLowerCase() !== c.name.toLowerCase() ? ` “${c.label}”` : "";
    return `${c.name}${label}${marks.length ? ` (${marks.join(", ")})` : ""}`;
  }

  // ── acting ────────────────────────────────────────────────────────────────

  /**
   * Which verb a control's declared kind routes to.
   *
   * The whole safety argument of this layer is in these three lines, so there
   * is no cleverness in them. `read` and `describe` go to the safe door, where
   * the mechanism then picks between pressing and typing; `commit` and
   * **undeclared** go to the gated one, which takes both. The second half of
   * that is the load-bearing choice and CONTROLS.md argues it at length: a
   * control nobody declared is an unreviewed button, and the library cannot
   * tell a Next Page from a Delete Account by looking at either.
   */
  function routeOf(kind: VerbKind | undefined, field: boolean): string {
    if (kind === undefined || kind === "commit") return names.commit;
    return field ? names.type : names.press;
  }

  interface Resolved {
    el: ElementLike;
    kind: VerbKind | undefined;
    field: boolean;
  }

  /**
   * Find the element a call named, or refuse.
   *
   * Resolved from the page at call time and never from the snapshot the model
   * was shown. A control that has been re-rendered away since then is the
   * ordinary case, not an exception — the person at the keyboard has been
   * clicking the whole time the model was thinking — so it is a refusal with a
   * list of what IS there, and never a click on whatever is nearest.
   */
  function resolve(
    verb: string,
    control: string,
    row: string | undefined,
    ctx: VerbContext,
  ): Resolved | ReturnType<VerbContext["refuse"]> {
    const found = scan();
    const matching = found.filter((f) => f.name === control);

    if (matching.length === 0) {
      const offered = [...new Set(found.map((f) => f.name))].sort();
      return ctx.refuse(
        "no-such-control",
        offered.length
          ? `this screen offers no control named \`${control}\`. It offers: ${offered.join(", ")}. ` +
              `Read the screen's control list rather than remembering one — it changes as you navigate.`
          : `this screen offers no controls at all. Nothing on it is marked with ${attribute}, so ` +
              `there is nothing for \`${verb}\` to press here.`,
      );
    }

    const wantsRow = matching.some((f) => f.row !== null);

    if (row === undefined || row === "") {
      if (wantsRow) {
        const ids = [...new Set(rowsOf().map((r) => r.id))];
        return ctx.refuse(
          "needs-row",
          `\`${control}\` is on each row, so it needs a row id in \`row\`. Rows on screen: ` +
            `${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}.`,
        );
      }
      return describeEl(matching[0]!.el, control);
    }

    if (!wantsRow) {
      return ctx.refuse(
        "not-a-row-control",
        `\`${control}\` belongs to the screen, not to a row, so it cannot be pressed for row ` +
          `\`${row}\`. Call it without \`row\`.`,
      );
    }

    const onRow = matching.find((f) => f.row === row);
    if (!onRow) {
      const ids = rowsOf().map((r) => r.id);
      if (!ids.includes(row)) {
        return ctx.refuse(
          "no-such-row",
          `no row \`${row}\` is on screen. Rows on screen: ${ids.slice(0, 8).join(", ")}` +
            `${ids.length > 8 ? ", …" : ""}. The screen may have paged or filtered since you read ` +
            `it; read it again. Quoting \`rev\` turns this into a \`stale\` refusal instead.`,
        );
      }
      return ctx.refuse(
        "no-such-control",
        `row \`${row}\` is on screen but offers no \`${control}\`. Row controls are not always ` +
          `rendered on every row.`,
      );
    }
    return describeEl(onRow.el, control);
  }

  function describeEl(el: ElementLike, control: string): Resolved {
    return { el, kind: kindOf(control, el), field: isField(el) };
  }

  /**
   * The sentence a routing refusal carries.
   *
   * Four cases, and each names the verb to use instead, because a refusal that
   * only says no costs a model a turn and teaches it nothing. The undeclared
   * one is phrased as a fact about the app rather than about the control: the
   * model has not made a mistake, the markup is simply silent, and the next
   * call it should make is the gated one.
   */
  function whyWrongVerb(control: string, verb: string, route: string, resolved: Resolved): string {
    if (resolved.kind === undefined) {
      return (
        `the app has not declared what \`${control}\` does, so it is treated as though it changes ` +
        `data. Use \`${route}\`, which asks the person first.`
      );
    }
    if (route === names.commit) {
      return `\`${control}\` is declared \`${resolved.kind}\`. Use \`${route}\` for it.`;
    }
    if (resolved.field && verb === names.press) {
      return (
        `\`${control}\` is a field, not a button. Use \`${names.type}\` and pass the text you ` +
        `want in it.`
      );
    }
    if (!resolved.field && verb === names.type) {
      return `\`${control}\` is a button, not a field. Use \`${names.press}\` for it.`;
    }
    return `\`${control}\` is declared \`${resolved.kind}\`. Use \`${route}\` for it.`;
  }

  /** The checks every control verb makes once it has an element, in the order
   *  that gives the most useful refusal: routing before availability, because a
   *  model told `disabled` about a control it should not have called through
   *  this verb at all will retry it here when the button enables. */
  function gate(
    verb: string,
    control: string,
    hasText: boolean,
    resolved: Resolved,
    ctx: VerbContext,
  ): ReturnType<VerbContext["refuse"]> | null {
    const route = routeOf(resolved.kind, resolved.field);
    if (route !== verb) {
      return ctx.refuse("wrong-verb", whyWrongVerb(control, verb, route, resolved));
    }

    // Only the gated verb can be ambiguous about the mechanism, because it is
    // the one verb that takes both kinds of control. The text and the control
    // must agree: assigning text to a button is nonsense, and clicking a field
    // because no text came with the call is the silent-nothing failure.
    if (verb === names.commit) {
      if (resolved.field && !hasText) {
        return ctx.refuse(
          "wrong-verb",
          `\`${control}\` is a field: it takes text. Pass \`text\`.`,
        );
      }
      if (!resolved.field && hasText) {
        return ctx.refuse(
          "wrong-verb",
          `\`${control}\` is a button, not a field, so there is nowhere to put text. Call ` +
            `\`${verb}\` again without \`text\`.`,
        );
      }
    }

    const why = refuseWhen(resolved.el, control);
    if (why) {
      return ctx.refuse(
        why,
        `the \`${control}\` control is on screen but not actionable right now. Something has to ` +
          `change before it will work — a selection, a required field, a permission.`,
      );
    }
    return null;
  }

  /**
   * Put text into a field.
   *
   * Assigning `value` is not typing, and the difference is the failure this
   * library cares most about. A framework learns about a keystroke from an
   * event; a field whose `value` was assigned and nothing else looks right on
   * screen, has told the app nothing, and is wiped by the next render — while
   * the verb reports `ok`. So this fires `input` and `change`, and when it
   * cannot (no `Event`, no `dispatchEvent`) it throws rather than doing the
   * half of the job that looks like all of it.
   */
  function putText(el: FieldLike, control: string, text: string): void {
    if (config.setValue) {
      config.setValue(el, text);
      return;
    }
    const Ev = config.Event ?? defaultEvent();
    if (!Ev || typeof el.dispatchEvent !== "function") {
      throw new Error(
        `driverkit: cannot type into \`${control}\`: no way to fire an input event ` +
          `(${!Ev ? "no Event constructor" : "the element has no dispatchEvent"}). Assigning value ` +
          `without an event would look typed and tell your app nothing. Pass options.Event, or ` +
          `options.setValue to put text in your own way.`,
      );
    }
    el.focus?.();
    el.value = text;
    el.dispatchEvent(new Ev("input", { bubbles: true }));
    el.dispatchEvent(new Ev("change", { bubbles: true }));
  }

  // ── the verbs ─────────────────────────────────────────────────────────────

  const CONTROL_ARG = {
    type: "string" as const,
    describe:
      "the name of a control, exactly as the screen's control list spells it. Not a selector, " +
      "not a label, not a guess: a name the screen does not list is refused rather than matched " +
      "to the nearest thing.",
  };
  const ROW_ARG = {
    type: "string" as const,
    describe:
      "the id of the row to act on, for a control the screen lists under `each row`. Use an id " +
      "from the rows on screen. Omit it for a control that belongs to the screen itself.",
    optional: true as const,
  };

  const LEGEND =
    "The screen lists the controls it is offering right now, under `controls` (the screen's own) " +
    "and `each row` (one per row, named with `row`). A bare name is a control the app declared " +
    "harmless; `(describe)` changes what is selected or filtered; `(commit)` changes data; " +
    "`(undeclared)` means the app never said, so it is treated as though it changes data; " +
    "`(text)` takes text; `(disabled)` is on screen but not actionable. The list changes as you " +
    "navigate, so read it rather than remembering it.";

  const press: Verb<any> = {
    name: names.press,
    kind: "describe",
    describe:
      "use one of the controls the screen is offering: press a button, tick a checkbox, switch " +
      "tabs, follow a link. This is the verb for a control the app declared harmless — a bare name " +
      `or \`(describe)\` in the list. A \`(commit)\` or \`(undeclared)\` control is refused here ` +
      `and goes through \`${names.commit}\`; a \`(text)\` control through \`${names.type}\`. ` +
      "It presses exactly one control and reports no count. " +
      LEGEND,
    refuses: [...REFUSES],
    args: { control: CONTROL_ARG, row: ROW_ARG },
    run: ({ control, row }, ctx) => {
      const resolved = resolve(names.press, control, row, ctx);
      if ("reason" in resolved) return resolved;
      const refused = gate(names.press, control, false, resolved, ctx);
      if (refused) return refused;
      resolved.el.click();
    },
  };

  const typeInto: Verb<any> = {
    name: names.type,
    kind: "describe",
    describe:
      "put text into one of the fields the screen is offering — a search box, a filter, a form " +
      "input. Replaces whatever is in it; pass an empty string to clear it. This is the verb for " +
      `a field the app declared harmless. A \`(commit)\` or \`(undeclared)\` field is refused ` +
      `here and goes through \`${names.commit}\`. ` +
      LEGEND,
    refuses: [...REFUSES],
    args: {
      control: CONTROL_ARG,
      text: {
        type: "string",
        describe: "the text to put in the field. An empty string clears it.",
      },
      row: ROW_ARG,
    },
    run: ({ control, text, row }, ctx) => {
      const resolved = resolve(names.type, control, row, ctx);
      if ("reason" in resolved) return resolved;
      const refused = gate(names.type, control, true, resolved, ctx);
      if (refused) return refused;
      putText(resolved.el as FieldLike, control, text);
    },
  };

  const commitControl: Verb<any> = {
    name: names.commit,
    kind: "commit",
    describe:
      "use a control that changes data — or one whose effect the app never declared, which is " +
      "treated the same way. One call presses one control, so one irreversible action is one " +
      "question to the person watching. Pass `text` for a field. If the control is listed as " +
      `harmless or \`(describe)\`, this refuses and \`${names.press}\` or \`${names.type}\` is ` +
      "the verb for it — routing a safe press through here would ask the person a question that " +
      "did not need asking, and a gate that asks about everything is a gate nobody reads. " +
      LEGEND,
    refuses: [...REFUSES],
    args: {
      control: CONTROL_ARG,
      text: {
        type: "string",
        describe: "the text to put in the field, when the control is one that takes text.",
        optional: true,
      },
      row: ROW_ARG,
    },
    run: ({ control, text, row }, ctx) => {
      const resolved = resolve(names.commit, control, row, ctx);
      if ("reason" in resolved) return resolved;
      const hasText = text !== undefined && text !== null;
      const refused = gate(names.commit, control, hasText, resolved, ctx);
      if (refused) return refused;
      if (hasText) putText(resolved.el as FieldLike, control, text as string);
      else resolved.el.click();
    },
  };

  const controls = () => enumerate().controls;

  const note = () => {
    if (config.inNote === false) return undefined;
    const { controls: list, hidden } = enumerate();
    return render(list, hidden);
  };

  return {
    verbs: [press, typeInto, commitControl],
    controls,
    note,
    withControls: <S extends Snapshot>(snapshot: S): S => {
      const { controls: list, hidden } = enumerate();
      const line = config.inNote === false ? undefined : render(list, hidden);
      return {
        ...snapshot,
        ...(list.length ? { controls: list } : {}),
        ...(line ? { note: snapshot.note ? `${snapshot.note}. ${line}` : line } : {}),
      };
    },
  };
}

/** `disabled` and `aria-disabled` only, read off the author's own markup.
 *  Deliberately not a visibility or pointer-events check: those need
 *  layout, layout needs a real browser, and a heuristic that is right in
 *  Chrome and wrong in a test is worse than a rule the author can read off
 *  their own markup. */
function disabledCheck(el: ElementLike): string | null {
  if (el.getAttribute("disabled") !== null) return "disabled";
  if (collapse(el.getAttribute("aria-disabled")) === "true") return "disabled";
  return null;
}

/** Is this element itself marked? `querySelectorAll` never returns the node it
 *  was called on, so a clickable row has to be checked directly. */
function isMarked(el: ElementLike, attribute: string): boolean {
  return collapse(el.getAttribute(attribute)) !== "";
}

/** A label is for recognising a control, not for reading its contents. A cell
 *  with a paragraph in it would otherwise put the paragraph in every snapshot. */
function clip(text: string): string {
  return text.length <= 40 ? text : `${text.slice(0, 39)}…`;
}

const alreadySaid = new Set<string>();

function warner(onWarn?: (m: string) => void): (m: string) => void {
  if (onWarn) return onWarn;
  // Module-scoped: the enumeration runs on every verb call, so a per-binding
  // set would repeat the same line for the life of the page.
  const console = (globalThis as { console?: { warn?: (m: string) => void } }).console;
  return (message: string) => {
    if (alreadySaid.has(message) || !console?.warn) return;
    alreadySaid.add(message);
    console.warn(`driverkit: ${message}`);
  };
}
