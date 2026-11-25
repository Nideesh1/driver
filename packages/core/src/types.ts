/**
 * driverkit — the types.
 *
 * The whole library rests on a split that is worth stating before any code:
 *
 *   A VERB is static. Its name, its arguments and what it refuses are the same
 *   for every user on every day, so they can be sent to a model once, cached in
 *   the prompt prefix, and never sent again.
 *
 *   A SNAPSHOT is dynamic. It is what a human could see at this moment, and
 *   nothing more, so it is small by construction and goes in the tail where it
 *   is never cached.
 *
 * Keeping anything per-user or per-screen out of the verb list is not tidiness,
 * it is the entire cost argument. One user-specific string in the static half
 * busts the cache for everybody and the library stops being cheap to drive.
 */

/** A value an agent can pass to a verb. Deliberately not `any`: if an argument
 *  cannot survive JSON it cannot cross the relay to an agent in another
 *  process, and a verb that only works in-page is a verb that works once. */
export type Scalar = string | number | boolean | null;

/** What a verb accepts. A tiny subset of JSON Schema, hand-rolled so the core
 *  package keeps its promise of zero runtime dependencies. */
export interface ArgSpec {
  type: "string" | "number" | "boolean";
  /** Shown to the model. Write it for a reader who cannot see your app. */
  describe: string;
  /** If present, the only accepted values. Cheaper and safer than prose. */
  oneOf?: Scalar[];
  /** Absent means required. */
  optional?: boolean;
}

/**
 * What a verb does to the world, declared in the cached half so an agent knows
 * before it calls.
 *
 *   `read`     — changes nothing. Free to call, free to get wrong.
 *   `describe` — changes what is SELECTED or FILTERED, changes no data, and
 *                reports a `count`. Also safe: the worst outcome is the wrong
 *                rows highlighted.
 *   `commit`   — changes data. May be irreversible.
 *
 * This exists because of one failure mode. Asked to "select the top 1000 rows
 * and bulk accept", an agent that cannot tell `select` from `accept` has to
 * discover the difference by doing it, and the discovery costs you a thousand
 * accepted rows. A screenshot cannot tell it apart either, and neither can an
 * OpenAPI spec, which says what a call takes but not what it costs you.
 *
 * The pairing rule that makes bulk work safe: a `describe` verb takes the
 * predicate and returns the count, a `commit` verb takes NO predicate and acts
 * on the current selection. Two calls, so a count is always seen before data
 * moves. A verb that both selects and accepts is how fifty thousand rows get
 * accepted because a filter was wider than anybody thought.
 */
export type VerbKind = "read" | "describe" | "commit";

/**
 * Something the app can do.
 *
 * `refuses` is the field people skip and the one that earns its place. A
 * screenshot cannot tell an agent what a button will do, and neither can a
 * name: `delete` is reachable on screen whether or not this particular row is
 * deletable. Listing the refusals up front, in the half that gets cached, lets
 * an agent avoid the call instead of discovering the answer by making it.
 *
 * On bulk work, note what a verb must NOT be. If the only way to select a
 * thousand rows is a thousand `select(id)` calls, an agent will make a
 * thousand round trips and lose its way somewhere in the middle. So a verb
 * that operates on many rows takes a PREDICATE and resolves it inside the app,
 * where the rows already are — `select(where, limit)`, never `select(id)`
 * repeated. The agent should never learn an id it did not need.
 */
export interface Verb<A extends Record<string, Scalar> = Record<string, Scalar>> {
  /** Stable, kebab-case, unique within a mount. This is the agent's handle on
   *  it, so renaming one is a breaking change to every stored prompt. */
  name: string;
  /** One line, imperative, in the user's own vocabulary: "accept the selected
   *  contacts". Not "calls patchContacts" — the agent cannot see your code,
   *  and a name drawn from your internals makes it guess at your intent. */
  describe: string;
  /** What this does to the world. Optional, and an absent one makes NO safety
   *  claim in either direction: treating it as `read` would tell an agent an
   *  irreversible verb is free to try, and treating it as `commit` would mark
   *  every verb of an app written before this field as dangerous, which is a
   *  warning on everything and therefore a warning on nothing. Declare it. */
  kind?: VerbKind;
  args?: Record<string, ArgSpec>;
  /**
   * The refusals this verb can return, as short stable slugs.
   *
   * Documentation for the model, and the list a `refuse()` is checked against:
   * declaring it opts this verb into the check, and a refusal with a slug that
   * is not on the list warns once (see `RESERVED_REFUSALS` and `mount`).
   * Leaving it absent makes no claim and is not checked, the same way an absent
   * `kind` makes no safety claim.
   *
   * None of these may be a slug from `RESERVED_REFUSALS`. An app that refuses
   * with `timeout` has taken away an agent's only way to tell "the app said no"
   * from "your call never landed".
   */
  refuses?: string[];
  /**
   * Do the thing.
   *
   * Return nothing for the ordinary case. Return `ctx.refuse(...)` for an
   * expected "no". Return a `Report` when the verb has a number or a sentence
   * the snapshot cannot carry — above all a `describe` verb's `count`, which is
   * the number the person would have had to see before pressing a bulk button.
   *
   * Throwing is a bug, not a "no".
   */
  run: (
    args: A,
    ctx: VerbContext,
  ) => void | Refusal | Report | Promise<void | Refusal | Report>;
}

/**
 * What a verb has to say about what it just did, beyond the screen.
 *
 * This exists for `count`. A `describe` verb resolves a predicate inside the
 * app — "every contact at Acme" — and the only thing that makes the following
 * `commit` safe is the person or the agent seeing how many rows that matched
 * BEFORE anything irreversible runs. The screen cannot carry it: the whole
 * point is that the match is larger than the window, so `rows` shows twenty of
 * three thousand and `page.total` is about the table, not about the selection.
 *
 * Without this the pairing rule is advice. With it, it is a number.
 */
export interface Report {
  /** How many rows the verb matched or selected. `0` is a real answer and is
   *  distinct from omitting the field, which means "I do not count". */
  count?: number;
  /** One short line for the agent that the snapshot has nowhere to put. */
  note?: string;
}

export interface VerbContext {
  /** Decline, with a reason the agent can act on. See `refuse`. */
  refuse: (reason: string, hint?: string) => Refusal;
}

/** The marker returned by `ctx.refuse`. Not an Error: a refusal is an ordinary
 *  outcome the agent is expected to handle, and making it an exception pushes
 *  app authors toward try/catch around their own business rules. */
export interface Refusal {
  readonly __driverkit: "refusal";
  reason: string;
  hint?: string;
}

/** One row of whatever the screen is showing. `id` is what verbs take. */
export interface Row {
  id: string;
  [column: string]: Scalar | undefined;
}

/**
 * What a human could see right now.
 *
 * The rule this type exists to enforce: an agent is never shown more than the
 * person at the keyboard. Same filters, same sort, same page. That is what
 * keeps the cost flat as the data grows — a hundred rows on screen is a
 * hundred rows in the prompt whether the table holds a hundred or a million —
 * and it is also what makes "park that one" resolvable without a query.
 */
export interface Snapshot {
  /** Where the user is, in their words: "contacts, filtered to Acme". */
  where: string;
  /** Monotonic, bumped on every change. An agent echoes it back to prove it is
   *  acting on what it saw; see `stale` in PROTOCOL.md. */
  rev: number;
  /** Only the rows actually on screen. */
  rows?: Row[];
  /**
   * Present when `rows` is a window onto something larger.
   *
   * Three states, and the third exists because without it the type forces a
   * lie. **Absence is a claim that the agent is seeing everything** — so an
   * adapter reading a rendered table, which cannot tell a virtualised grid
   * from a short list, had no honest option: omit `page` and assert
   * completeness it cannot know, or invent a total. Either way an agent
   * eventually concludes a record does not exist because it could not see it.
   *
   *   page absent          these are all the rows there are
   *   page, total given    a window, and you know how big the whole is
   *   page, total absent   a window, and you do NOT know how big the whole is
   *
   * The third is the weakest claim and the right default whenever you are
   * reading the DOM rather than a store. An agent that needs certainty from it
   * must widen the window or use a `describe` verb that counts server-side.
   */
  page?: { index: number; size: number; total?: number };
  /**
   * Row ids the user has selected, in selection order. Resolves "this one".
   *
   * **Only the ids on screen belong here**, exactly like `rows`, and for the
   * same reason. `select-where` exists to select thousands of rows in one call,
   * so a driver that honestly fills this with every selected id puts tens of
   * kilobytes of ids into the UNCACHED half of every result from then on — paid
   * for on every turn, and on a big table straight through the relay's 1 MiB
   * body limit. An author who fills it with ten thousand ids has silently
   * broken their own token budget, which is the whole cost argument this type
   * exists to protect.
   *
   * So this field answers "which of the things in front of me is 'this one'",
   * and `selectedCount` answers "how big is the selection". Both are needed:
   * an agent cannot resolve a pronoun from a number, and cannot decide whether
   * a commit is safe from a truncated list.
   */
  selected?: string[];
  /**
   * How many rows are selected in all, including the ones off screen.
   *
   * The honest size of the selection, which `selected` deliberately does not
   * carry. Omitting it means "I do not count" — distinct from `0`, which is a
   * real answer — and when it is larger than `selected.length` the renderer
   * says so in words, because a model handed three ids and a bulk commit will
   * otherwise believe three rows are about to change.
   *
   * It is not a substitute for a `describe` verb's `Report.count`. That one is
   * the number a commit decision turns on at the moment it is made; this one is
   * a property of the screen, and is what makes a selection made several turns
   * ago still legible.
   */
  selectedCount?: number;
  /** Anything else the agent needs and the rows cannot carry. Keep it short;
   *  this is the uncached half. */
  note?: string;
}

/**
 * What the agent gets back. Carries the snapshot AFTER the call, so acting and
 * observing are one round trip rather than two. With ten steps that is ten
 * saved model turns, each of which would have re-read the whole prefix — the
 * round trips, not the manifest, are what actually cost money.
 *
 * `count` is how a `describe` verb reports what it matched: "1,000 selected of
 * 3,412 matching". It is the number a human would have to see before pressing
 * a bulk button, and the reason `describe` and `commit` are separate verbs.
 *
 * A driver mounted in a page ALWAYS fills `snapshot`. That guarantee is worth
 * keeping in the type, so in-page callers never check for it. See `WireResult`
 * for the one case where it can be missing.
 */
export type Result =
  | { ok: true; note?: string; count?: number; snapshot: Snapshot }
  | { ok: false; refused: string; hint?: string; snapshot: Snapshot };

/**
 * What an agent receives over the relay: a `Result`, or a refusal from the
 * relay itself about a call that never reached a tab.
 *
 * The distinction is not pedantry. A relay can refuse because the tab id is
 * unknown, because the tab closed, or because the tab accepted the call and
 * went silent past the deadline. In none of those cases is there a screen to
 * report, and the alternatives are both worse than a missing field: inventing
 * an empty snapshot tells an agent the app has no rows, and returning a
 * different shape makes every client parse two shapes and handle the rarer one
 * badly.
 *
 * So the shape holds and `snapshot` goes missing, which is the truthful thing
 * to say — nothing ran and nobody looked. A client must read its absence as
 * "the call did not arrive", never as "the screen is empty".
 */
export type WireResult =
  | Result
  | { ok: false; refused: RelayRefusal; hint?: string; snapshot?: undefined };

/** Refusals that come from the relay rather than from an app's verb. Listed as
 *  a closed set so a client can tell "your app said no" (retry differently)
 *  from "your call never landed" (reconnect, or pick another tab). */
export type RelayRefusal = "no-such-tab" | "tab-went-away" | "timeout";

/** The static half: hand this to a model once and cache it. Contains no data,
 *  no ids, no user, nothing that varies between two people or two minutes. */
export interface Manifest {
  /** Changes when the verb list changes, so an agent can tell its cached copy
   *  went stale without diffing. */
  version: string;
  app: string;
  verbs: Array<{
    name: string;
    describe: string;
    kind?: VerbKind;
    args?: Record<string, ArgSpec>;
    refuses?: string[];
  }>;
}

/**
 * One row of `GET /dk/tabs`.
 *
 * Declared here rather than left in the protocol document because this is the
 * listing every client hits first, and it carries a subtlety prose loses: the
 * id field is `tab`, not `id`, spelled the same as in the `hello` frame. A
 * client that re-derived this shape from the markdown is exactly how the first
 * version of it ended up mutually incompatible between two implementations.
 *
 * `manifestVersion` is lifted out of the manifest so a client can tell whether
 * its cached copy is current without fetching the whole thing — which is the
 * only reason the version exists.
 */
export interface TabInfo {
  tab: string;
  app?: string;
  /** Only so a human can tell two tabs apart when asked "which one?". */
  title?: string;
  url?: string;
  manifestVersion?: string;
  rev?: number;
  /** ISO 8601. A string on purpose: nothing computes with it, and parsing it
   *  would invent a failure mode for a field only ever shown to a person. */
  since?: string;
}

export interface MountOptions {
  /** Shown in the manifest. A name a human would recognise. */
  app: string;
  verbs: Verb<never>[] | Verb<Record<string, Scalar>>[] | Verb<any>[];
  /** Called fresh on every read. Must be cheap: it runs on each verb call. */
  visible: () => Snapshot;
}

export interface Driver {
  /** The static half. Stable across calls unless the verbs change. */
  manifest: () => Manifest;
  /** The dynamic half, read on demand. */
  snapshot: () => Snapshot;
  /** Run a verb. Never throws for an expected refusal; see `Result`. */
  call: (name: string, args?: Record<string, Scalar>, opts?: CallOptions) => Promise<Result>;
  /** Stop serving. Idempotent. */
  unmount: () => void;
}

export interface CallOptions {
  /** The `rev` the agent believes it is acting on. If the screen has moved on,
   *  the call is refused as `stale` rather than applied to a row the agent
   *  never saw. Omitting it opts out of the check. */
  rev?: number;
}
