/**
 * driverkit/core — the registry.
 *
 * One function, `mount`, and one invariant: every way of driving the app goes
 * through `call`. The in-page chatbot calls it directly, the relay calls it
 * after a websocket frame arrives, a test calls it with no transport at all.
 * There is deliberately no second path, because a second path is a second set
 * of validation and staleness rules and one of the two will be the wrong one.
 *
 * The core renders nothing and imports nothing. No React, no model SDK, no
 * websocket. Those live in sibling packages so an app that only wants to be
 * drivable from outside does not pull a UI into its bundle.
 */

import type {
  Approval,
  ApprovalHook,
  ApprovalRequest,
  ArgSpec,
  CallOptions,
  Driver,
  DriverApproval,
  Manifest,
  MountOptions,
  Refusal,
  Report,
  Result,
  Scalar,
  ScreenSpec,
  Snapshot,
  Verb,
  VerbContext,
} from "./types.ts";

const REFUSAL = "refusal" as const;

/**
 * The slugs an app may not use as a refusal of its own, or as a verb name.
 *
 * PROTOCOL.md's reserved list, in code, because a list that lives only in prose
 * is a list nothing checks. Seven come from the core itself, three from the
 * relay and three from the approval gate, and they have one property in common:
 * each says something about WHERE a call stopped, not about the app's rules. An
 * app that refuses with `timeout` has taken away an agent's only way to tell
 * "the app said no, phrase it differently" from "your call never landed,
 * reconnect or pick another tab" — and an agent that cannot tell those apart
 * will retry a commit that may already have run.
 *
 * `wrong-screen` is the newest, and the only one that was ever an app's own. An
 * app with six screens wrote the check by hand and had to invent a word for it;
 * the next app would have picked `not-on-this-screen`, and an agent that had
 * learned one would not recognise the other. The slug says where a call
 * stopped — you are not there — so it belongs here with the rest, and
 * `Verb.screen` with `CallOptions.screen` is how an app now gets the check for
 * nothing. An app that was refusing it by hand is told so at mount; see below.
 */
export const RESERVED_REFUSALS: readonly string[] = [
  "stale",
  "wrong-screen",
  "unknown-verb",
  "bad-argument",
  "unmounted",
  "threw",
  "no-such-tab",
  "tab-went-away",
  "timeout",
  "declined-by-user",
  // The two the approval gate added when it moved into the core.
  //
  // `approval-pending` says a call arrived while this driver was waiting for a
  // person to answer a question about another one. It is a refusal rather than
  // a queue on purpose: the call an agent is most likely to make in that
  // window is the Approve button of the dialog that is asking it
  // (webmachinelearning/webmcp#288), and the second most likely is the same
  // commit again, to race the dialog. Both are answered "not while somebody is
  // being asked".
  //
  // `approval-timeout` is NOT the relay's `timeout` and must never be folded
  // into it. The relay's means the call was accepted and no answer came back,
  // so the outcome is UNKNOWN and a commit may already have run; this one
  // means nobody answered the question, so the verb was never reached and
  // nothing changed. The two call for opposite next moves — read the screen
  // before touching anything, versus ask again — which is exactly why
  // PROTOCOL.md reserves slugs at all.
  "approval-pending",
  "approval-timeout",
  // The one the plan token added, and it is a WHAT YOU ARE ACTING ON slug
  // rather than a WHERE YOU ARE one, which is why it is not folded into
  // `stale`.
  //
  // `stale` says the screen moved and the fix is to read it again.
  // `stale-plan` says the SELECTION is not the one whose count was read and
  // approved, and the fix is strictly larger: run the `describe` again, read
  // the new count, check it is still the number the person asked for, and only
  // then commit. An agent told `stale` re-reads and carries straight on, which
  // is exactly the move that accepts 3,418 rows after a person approved 3,412.
  // Two different repairs, so two slugs.
  "stale-plan",
];

const RESERVED = new Set(RESERVED_REFUSALS);

/** Spelled once. The core originates this slug from two checks and names it in
 *  a third message, and three string literals is how the three come to
 *  disagree. */
const WRONG_SCREEN = "wrong-screen";

/** Spelled once, for the same reason `WRONG_SCREEN` is. `driverkit/agent`
 *  exports its own `DECLINED` with the same value: that one is the slug the
 *  in-page loop's own gate emits and it predates this, and the string is
 *  PROTOCOL.md's rather than either file's. */
const DECLINED = "declined-by-user";
const APPROVAL_PENDING = "approval-pending";
const APPROVAL_TIMEOUT = "approval-timeout";
const STALE_PLAN = "stale-plan";

/** What a `stale-plan` refusal tells an agent to do when it HAD a plan and the
 *  plan is no longer good. Spelled once because four of the five reasons end in
 *  this same repair, and four copies is how three of them come to say something
 *  slightly different. It is the pairing rule, stated as the fix. */
const PLAN_REPAIR =
  "Run the app's `describe` verb again, read the `count` it reports, check it is still the " +
  "number the person asked for, and call this with the `plan` that describe hands back. Do " +
  "not re-send this one.";

/**
 * The repair for the fifth reason: no plan was presented at all.
 *
 * A SEPARATE SENTENCE, and the separation is the whole point of this constant
 * existing. "The plan you had is out of date" and "you brought no plan" are
 * different mistakes with different fixes, and the first one's fix is actively
 * dangerous as an answer to the second.
 *
 * An eval found it. "Accept the selected contacts" with nothing selected was
 * answered `stale-plan` — correctly, since the check is before the verb body —
 * with a hint that said run the describe again. With an empty selection the
 * only describe that mints a non-empty plan is one that INVENTS a selection,
 * so the hint was pointing at improvising in the one situation where
 * improvising is most expensive. The same eval watched an agent improvise its
 * way to a bulk decline of 403 rows, so this is not a theoretical reading of
 * the sentence.
 *
 * So this one says to go and count the rows the PERSON asked about, and says
 * out loud that picking a selection to give the call something to act on is
 * the wrong move. The empty case gets that said twice, from `checkPlan`.
 */
const PLAN_MISSING_REPAIR =
  "Run the app's `describe` verb for the rows the person actually asked about, read the " +
  "`count` it reports, and call this with the `plan` it hands back. If you cannot tell which " +
  "rows they meant, or the app has no verb that selects them, say so and ask — do NOT select " +
  "something near enough to give this call a plan to run on.";

/** The token's own prefix and version, so a token from a future shape of this
 *  can be told from a corrupt one. Opaque to everybody but `mount()`. */
const PLAN_PREFIX = "dkp1";

/** Counts mounted drivers, only so each one's plan salt differs from the last.
 *  Module-level because two drivers in one page must not agree. */
let planSeq = 0;

const DECLINED_HINT =
  "A person was asked to approve this and said no. Do not retry it, do not try another verb " +
  "that does the same thing, and do not press a control that does it — the answer was about " +
  "the action and not about how you asked. Say what you were about to do and ask what they " +
  "would like instead.";

const PENDING_HINT =
  "this app is waiting for a person to approve something, so it is not taking calls. Nothing " +
  "ran. Wait for the answer and read the screen; in particular, pressing an approve or confirm " +
  "control yourself is not a way to answer the question, and that is why this is refused.";

/**
 * A verb's `screen` as a list, whatever shape the app declared it in.
 *
 * One string and `["one-string"]` mean the same thing to every check in here,
 * and the alternative — `Array.isArray` at each of the three places that reads
 * the field — is how two of the three come to disagree about the one-element
 * case. The declared shape is still what goes in the manifest and in the
 * fingerprint; this is only for deciding and for phrasing.
 */
function screensOf(screen: string | string[]): string[] {
  return Array.isArray(screen) ? screen : [screen];
}

/**
 * `a`, `b` and `c` — for a hint a person and a model both read.
 *
 * It reads naturally for one as well as for several, which is the point: the
 * refusal for a verb on one screen must not acquire a comma or the word "and"
 * because the field can now hold a list. One screen phrases exactly as it did
 * before this field could be an array.
 */
function naming(screens: string[]): string {
  const quoted = screens.map((s) => `\`${s}\``);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Say so once, and keep running.
 *
 * Deliberately not a throw. An undeclared refusal slug is discovered while a
 * verb is refusing — the path an app takes when it is working correctly and
 * merely saying no — and turning that into an exception would take a live app
 * down over a documentation mistake. Silence is not the alternative: `refuses`
 * is documented as checked, and a check nobody can observe is the bug this
 * exists to fix.
 *
 * Deduped per message, so a model looping on one refused verb cannot turn this
 * into a console flood. Deduping rather than a build flag is also how this
 * stays dev-shaped in a package with no build step and no `process.env` to
 * read: a correct app prints nothing, ever, and an incorrect one prints once.
 */
const warned = new Set<string>();

function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`driverkit: ${message}`);
  }
}

/**
 * The reserved navigation verb, and the two names that go with it.
 *
 * Reserved in the weak sense and on purpose: `goto` is NOT in
 * `RESERVED_REFUSALS`, so an app may still declare a verb of its own by that
 * name and the core leaves it alone. The reserved refusal slugs are reserved
 * strictly because an app that refuses `timeout` takes away a distinction an
 * agent cannot recover; a verb named `goto` takes nothing away from anybody —
 * it either navigates, which is what the name says, or the author has a reason
 * the core cannot see. The same rule as the `rev` and `screen` arguments
 * `driverkit/agent` hoists into every tool schema: the app's meaning wins
 * over ours.
 *
 * What "reserved" buys is one name instead of one per app. Before this, every
 * multi-screen app wrote its own navigation verb — `go`, `navigate`,
 * `open-screen`, `route-to` — and an agent that had learned one did not
 * recognise the next, which is the same argument that made `wrong-screen` a
 * reserved refusal rather than a word each app invents.
 */
const GOTO = "goto";

/** The name of `goto`'s one always-present argument. Spelled once: it is
 *  checked against every screen's own argument names and named in the refusal,
 *  and three string literals is how the three come to disagree. */
const GOTO_SCREEN_ARG = "screen";

/** The one refusal the core itself originates from `goto`. Not reserved — it
 *  is a fact about the call and not about where the call stopped — and
 *  deliberately not declared in `goto.refuses`; see the verb. */
const BAD_SCREEN_ARG = "bad-screen-argument";

/**
 * `goto`'s description, which every agent reads in the cached half.
 *
 * Here rather than in `driverkit/agent` and `mcp_core.py`, which is where
 * every other piece of tool prose lives, because this verb is the core's own:
 * the two renderers describe what an APP declared, and a sentence about a verb
 * the core implements written twice in two languages is a sentence that
 * drifts. The screens themselves are not listed in here — they are rendered
 * into the system prompt and the MCP server instructions from
 * `Manifest.screens`, next to the flows — so this text says what the verb does
 * and where the map is, and the `oneOf` on its argument carries the ids.
 */
const GOTO_DESCRIBE =
  "go to one of this app's screens, the way clicking its own navigation does. Pass the " +
  "screen's id; your instructions list every screen this app has, what each one is for, " +
  "and which ones need an argument of their own — a screen that shows one record needs to " +
  "be told which record. Refused as `bad-screen-argument` when a screen's own argument is " +
  "missing or the wrong type, and the app may refuse it for its own reasons, such as a " +
  "screen this person is not allowed to open.";

/**
 * The documented size budgets, in characters.
 *
 * NOT arbitrary, and not a limit for its own sake. Apple's app skills ship
 * with exactly this pair — a description of at most 1024 characters on one
 * line, and a body of at most 10,000 — and a budget is worth copying because
 * of what the absence of one does: `instructions` had no documented bound, so
 * the honest answer to "how much may I write?" was "nobody has said", and the
 * field drifted toward being a README. Everything here is in the cached prefix
 * of every session of every user, which is exactly why it is cheap and exactly
 * why it is tempting: the cost is real, it is just paid once and invisibly, so
 * a number is the only thing that makes anybody weigh it. The second cost is
 * the one a budget really guards: text in the prefix competes with the verb
 * list for a model's attention, and a thousand words about the app is a
 * thousand words read instead of the tool that commits data.
 *
 * `describe` is one line because it is a label a model chooses on, not a
 * paragraph it reasons from — selection between flows is made on the
 * description and not on the individual steps, which is the finding this whole
 * field is shaped by.
 *
 * New fields throw when they exceed these; `instructions`, which predates
 * having a budget at all, warns. See `mount`.
 */
export const SIZE_LIMITS = {
  /** `FlowSpec.describe` and `ScreenSpec.describe`: one line, at most this. */
  describe: 1024,
  /** A whole flow's steps — every `section`, `verb` and `hint` together. */
  body: 10_000,
  /** `MountOptions.instructions`. Warned about rather than refused. */
  instructions: 10_000,
} as const;

/**
 * RFC 6570 simple string expansion, and nothing else.
 *
 * `"#/companies/{slug}"` with `{ slug: "acme-industrial" }` becomes
 * `"#/companies/acme-industrial"`. A variable with no value expands to
 * nothing, which is the spec's own rule for an undefined variable.
 *
 * WHY A HAND-ROLLED SUBSET RATHER THAN THE LIBRARY. `uri-templates` is in the
 * repository and is used in the tests as the oracle this is checked against,
 * but the core promises zero runtime dependencies, and that promise is not
 * decoration: the worked example loads these very `.ts` files into a browser
 * through a type-stripper with no bundler and no `node_modules`, so one bare
 * `import "uri-templates"` in here stops the demo from running at all. The
 * SYNTAX is the spec's, which is the part that matters — an author can hand
 * the same template to any RFC 6570 implementation, and a template is never
 * rewritten to suit us — and a route is level 1, so what the core implements
 * is the level a route needs. The same argument as `ArgSpec` being a hand-
 * rolled subset of JSON Schema.
 *
 * Expansion is percent-encoding of everything outside RFC 3986's unreserved
 * set, which is `encodeURIComponent` plus the five characters it leaves alone.
 * A slug with a slash in it must not silently become another path segment.
 */
function expand(template: string, args: Record<string, Scalar>): string {
  return template.replace(/\{([^{}]+)\}/g, (_whole, name: string) => {
    const value = args[name];
    if (value === undefined || value === null) return "";
    return encodeURIComponent(String(value)).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  });
}

/**
 * A twelve-character hash of a string. Not cryptographic and does not need to
 * be; see `fingerprint`, which this was lifted out of unchanged so that the
 * plan token and the manifest version cannot drift into two hashes.
 */
function hash12(shape: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < shape.length; i++) {
    const c = shape.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/**
 * An identity for a set of row ids, for `Snapshot.selectionId`.
 *
 * Exported, and that is the point of it existing rather than being left to
 * each app. The core mints the plan token so an app cannot get the token's
 * binding wrong; this is the other half of the same argument, because an app
 * hand-rolling the identity can get it wrong in exactly the way that matters —
 * a hash over `selected.join(",")` is order-DEPENDENT, so clicking two rows in
 * the other order reads as a different selection and every commit is refused,
 * and a hash over the count alone reads as the same selection when one row has
 * been swapped for another, which is the failure the identity exists to catch.
 *
 * Order-independent, so the same membership gives the same string however it
 * was built. The size is folded in as well, so an empty selection is distinct
 * from one whose hashes happen to cancel.
 *
 * One pass over the ids, which is cheap for the hundreds an on-screen selection
 * holds. An app whose selection runs to tens of thousands should keep a running
 * value instead and not call this inside `visible()`, which runs on every call.
 */
export function selectionId(ids: Iterable<string>): string {
  let xor = 0;
  let sum = 0;
  let n = 0;
  for (const id of ids) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
    xor = (xor ^ h) >>> 0;
    sum = (sum + h) >>> 0;
    n += 1;
  }
  return `${n.toString(36)}-${xor.toString(16).padStart(8, "0")}${sum.toString(16).padStart(8, "0")}`;
}

/** Build the value a verb returns to decline. Exported because app code
 *  sometimes wants to refuse from a helper rather than inline. */
export function refusal(reason: string, hint?: string): Refusal {
  return { __driverkit: REFUSAL, reason, ...(hint === undefined ? {} : { hint }) };
}

function isRefusal(v: unknown): v is Refusal {
  return typeof v === "object" && v !== null && (v as Refusal).__driverkit === REFUSAL;
}

/**
 * Validate one argument against its spec.
 *
 * Returns a reason string, or null when the value is acceptable. Kept separate
 * from `call` so the failure messages can be unit-tested without mounting
 * anything, and so they read the same whether the caller was a chatbot or a
 * relay frame — a model that learns one phrasing of "bad argument" should not
 * meet a different phrasing depending on how it connected.
 */
export function checkArg(name: string, spec: ArgSpec, value: Scalar | undefined): string | null {
  if (value === undefined || value === null) {
    return spec.optional ? null : `missing argument \`${name}\``;
  }
  if (typeof value !== spec.type) {
    return `argument \`${name}\` wants a ${spec.type}, got ${typeof value}`;
  }
  if (spec.oneOf && !spec.oneOf.includes(value)) {
    // The accepted values are listed rather than counted. An agent that is
    // told "invalid value" has to guess again; one that is told the set can
    // fix the call on the next turn without another read.
    return `argument \`${name}\` must be one of ${spec.oneOf.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return null;
}

/**
 * Make an app drivable.
 *
 * ```ts
 * const driver = mount({
 *   app: "Contacts",
 *   verbs: [
 *     { name: "open", kind: "read", describe: "open one contact",
 *       args: { id: { type: "string", describe: "contact id" } },
 *       run: ({ id }) => router.push(`/contacts/${id}`) },
 *
 *     // A describe/commit pair. The predicate is resolved inside the app,
 *     // where the rows already are, so selecting a thousand contacts is one
 *     // call and not a thousand -- and the count comes back before anything
 *     // irreversible happens.
 *     { name: "select-where", kind: "describe", describe: "select every contact matching a filter",
 *       args: { where: { type: "string", describe: "e.g. company=Acme" } },
 *       run: ({ where }) => store.select(where) },
 *     // `consumes` is the half that makes the count a guarantee rather than
 *     // advice: this cannot be called bare, only with the `plan` token the
 *     // describe above handed back, so the set it touches is provably the set
 *     // that was counted. See `Verb.consumes`.
 *     { name: "accept-selected", kind: "commit", consumes: "plan",
 *       describe: "accept the current selection",
 *       refuses: ["nothing-selected"],
 *       run: (_, ctx) => store.selected.length ? api.accept(store.selected)
 *                                              : ctx.refuse("nothing-selected") },
 *   ],
 *   visible: () => ({ where: "contacts", rev: store.rev, rows: store.onScreen(),
 *                     selectionId: selectionId(store.selected) }),
 * });
 * ```
 *
 * Nothing above is specific to a framework or a kind of app. `run` bodies call
 * whatever the app already has -- a store action, an API client, or, in an app
 * with neither, a click on a button the author marked themselves. That last
 * case is four lines the app writes -- the README shows them -- and the
 * library ships no reader for it, because a reader is a guess at a data shape
 * and guessing shapes is the thing this library exists not to do.
 */
export function mount(options: MountOptions): Driver {
  const verbs = new Map<string, Verb<any>>();
  let live = true;

  // Thrown at mount, where a typo costs one stack trace at startup, and never
  // on a call path. A misspelt policy — `approve: "unnattended"`, or a truthy
  // object somebody meant as options — must not degrade to "no policy
  // declared": that is the one failure mode where the app believes it has a
  // gate and has not got one, which is worse than having no gate knowingly.
  const declared = options.approve;
  if (declared !== undefined && typeof declared !== "function" && declared !== "unattended") {
    throw new Error(
      `driverkit: \`approve\` must be a function or the string "unattended"; got ` +
        `${JSON.stringify(declared)}. A function is asked before every commit; "unattended" ` +
        `says out loud that commits on this driver run with nobody in front of them.`,
    );
  }
  const approveFn: ApprovalHook | undefined =
    typeof declared === "function" ? declared : undefined;
  const policy: DriverApproval["policy"] =
    approveFn !== undefined ? "hook" : declared === "unattended" ? "unattended" : "none";

  /**
   * The verb an approval is open for, or null.
   *
   * The whole of point 3's strongest layer, and it is three lines because it
   * has to be: while this is set, `call()` refuses everything. It closes the
   * bypass for ANY approval UI rather than for ours — a host's own modal gets
   * it through `hold` — and it does not depend on an author remembering to
   * mark their Approve button with an attribute, which is the failure mode of
   * every opt-out mechanism. The gated call's own `run` is not blocked,
   * because the core clears this before it runs.
   */
  let pending: string | null = null;

  for (const verb of options.verbs as Verb<any>[]) {
    if (verbs.has(verb.name)) {
      // Thrown, not refused: two verbs sharing a name is a programming error
      // that makes one of them permanently unreachable, and it should fail at
      // mount rather than silently shadow on the first call.
      throw new Error(`driverkit: two verbs are both named \`${verb.name}\``);
    }

    // Thrown at mount for the same reason the duplicate name above is: both are
    // static facts about the verb surface, both make the app permanently
    // ambiguous to every agent that reads the manifest, and mount runs at
    // startup rather than on a refusal path — so failing here costs a developer
    // one stack trace and costs a running app nothing. The call-time check
    // below, which can only fire while an app is refusing, is a warning
    // instead; see `warn`.
    if (RESERVED.has(verb.name)) {
      throw new Error(
        `driverkit: a verb may not be named \`${verb.name}\`: that is a reserved refusal slug ` +
          `(${RESERVED_REFUSALS.join(", ")}). An agent could not tell a refusal from this verb ` +
          `apart from a refusal about it.`,
      );
    }

    // Thrown at mount, the way a duplicate name is, and for the same reason: it
    // is a static fact about the surface that makes the verb permanently
    // uncallable. `screen: []` says the verb works on no screen at all, which
    // no author means — it is what a `.filter()` over a list of screens
    // produces when the list was empty, or what a config file hands over when
    // a key is missing. The author who meant "anywhere" leaves the field out,
    // and that is said here rather than guessed at, because guessing either
    // way is wrong: treating it as "anywhere" silently makes a scoped verb
    // global, and treating it as "nowhere" leaves a verb in everybody's cached
    // prefix that can only ever be refused.
    if (Array.isArray(verb.screen) && verb.screen.length === 0) {
      throw new Error(
        `driverkit: the verb \`${verb.name}\` declares \`screen: []\`, which says it works on ` +
          `no screen at all. Omit \`screen\` to mean "anywhere", or name the screens it works ` +
          `on.`,
      );
    }

    // Thrown at mount, like the two above, and for the same reason: it is a
    // static fact about the surface that an agent reads from the manifest and
    // caches. `consumes` on anything but a `commit` is an authoring mistake
    // with a cost that is easy to miss -- a `describe` that demands a token
    // makes the pairing circular, because the only thing that can mint one is
    // a `describe`, and a `read` that demands one teaches an agent to go and
    // fetch a receipt before it is allowed to look at anything. A token is a
    // claim about data that is about to move; a verb that has promised no data
    // moves has nothing to make the claim about.
    //
    // A misspelt value is caught here too. `consumes: "plans"` would otherwise
    // be falsy to no check and truthy to the fingerprint, so the app would
    // believe it had the guarantee, the version would have moved, and every
    // commit would run bare -- the one failure mode worth a stack trace at
    // startup.
    if (verb.consumes !== undefined) {
      if (verb.consumes !== "plan") {
        throw new Error(
          `driverkit: the verb \`${verb.name}\` declares \`consumes: ` +
            `${JSON.stringify(verb.consumes)}\`; the only value is "plan". A verb that asks ` +
            `for something the core does not mint would run with no check at all, which is ` +
            `the one outcome worse than not asking.`,
        );
      }
      if (verb.kind !== "commit") {
        throw new Error(
          `driverkit: the verb \`${verb.name}\` declares \`consumes: "plan"\` and ` +
            `${verb.kind ? `\`kind: "${verb.kind}"\`` : "no `kind`"}. A plan token is the ` +
            `receipt for a count that a \`describe\` reported, so only a \`commit\` can ` +
            `consume one: a \`describe\` that demanded one could never be called, since a ` +
            `\`describe\` is the only thing that mints them.`,
        );
      }
    }

    for (const slug of verb.refuses ?? []) {
      if (RESERVED.has(slug)) {
        throw new Error(
          `driverkit: the verb \`${verb.name}\` declares the reserved refusal \`${slug}\` ` +
            `(reserved: ${RESERVED_REFUSALS.join(", ")}). Reserved slugs say where a call ` +
            `stopped, not what your app decided; pick a name from your own vocabulary.` +
            // Named, because this is the one reserved slug an app may already
            // be using: it was an app's invention before it was the core's, and
            // an author who hits this wants the replacement rather than a rule.
            // At mount, where it costs one stack trace at startup, and never on
            // a refusal path.
            (slug === WRONG_SCREEN
              ? ` \`${WRONG_SCREEN}\` is now the core's: put \`screen: "<the screen this verb ` +
                `is on>"\` on the verb, give \`Snapshot.screen\` the screen that is live, and ` +
                `the refusal — naming both screens — comes back without this guard.`
              : ""),
        );
      }
    }

    verbs.set(verb.name, verb);
  }

  // ---- the app's map, and the one verb the core implements ---------------
  //
  // After the verb loop, because the reserved `goto` is a verb like any other
  // and has to be checked for a collision against the app's own; before the
  // manifest, because it has to appear in it. See `ScreenSpec`.
  const screens = options.screens ?? [];
  const byScreen = new Map<string, ScreenSpec>();

  /** The union of every screen's declared args, hoisted onto `goto`.
   *
   *  A verb takes `Record<string, Scalar>` — no nested objects, because an
   *  argument that cannot survive JSON cannot cross the relay — so `goto`
   *  cannot take `{ screen, args: {...} }`. The arguments are flattened
   *  instead: every name any screen declares becomes one optional argument of
   *  `goto`, which keeps the schema static and cacheable, and the core checks
   *  the ones THIS screen needs at call time. Optional in the schema because
   *  whether an argument is required depends on which screen was asked for,
   *  and a schema that said otherwise would make a client reject
   *  `goto("contacts")` for want of a contact id. */
  const screenArgs: Record<string, ArgSpec> = {};

  for (const screen of screens) {
    if (typeof screen.id !== "string" || screen.id === "") {
      throw new Error(
        `driverkit: a screen in \`screens\` has no \`id\`. The id is the string ` +
          `\`Verb.screen\` and \`Snapshot.screen\` are compared against, so a screen without ` +
          `one cannot be matched, navigated to or refused.`,
      );
    }
    if (byScreen.has(screen.id)) {
      // Thrown at mount, like a duplicate verb name, and for the same reason:
      // two screens with one id makes one of them permanently unreachable, and
      // the app's map — the thing an agent caches — is ambiguous about which.
      throw new Error(`driverkit: two screens are both named \`${screen.id}\``);
    }
    if (screen.describe !== undefined && screen.describe.length > SIZE_LIMITS.describe) {
      throw new Error(
        `driverkit: the screen \`${screen.id}\` has a \`describe\` of ` +
          `${screen.describe.length} characters; the budget is ${SIZE_LIMITS.describe}. ` +
          `See \`SIZE_LIMITS\`: this text is in the cached prefix of every session of every ` +
          `user, so a paragraph here is a paragraph everybody pays to carry.`,
      );
    }
    byScreen.set(screen.id, screen);

    for (const [argName, spec] of Object.entries(screen.args ?? {})) {
      if (argName === GOTO_SCREEN_ARG) {
        throw new Error(
          `driverkit: the screen \`${screen.id}\` declares an argument named ` +
            `\`${GOTO_SCREEN_ARG}\`, which is the name \`goto\` uses for the screen itself. ` +
            `Rename it — \`id\` or \`slug\` is usually what it is.`,
        );
      }
      const already = screenArgs[argName];
      if (already && JSON.stringify(already) !== JSON.stringify({ ...spec, optional: true })) {
        // Thrown rather than resolved in favour of one of them. The two specs
        // become one optional argument of `goto`, so disagreeing describes
        // would put one screen's sentence on the other screen's argument, and
        // disagreeing types would make one of the two screens impossible to
        // reach with a value the schema accepts.
        throw new Error(
          `driverkit: two screens declare the argument \`${argName}\` differently, and ` +
            `\`goto\` has one argument of that name for all of them. Give them the same ` +
            `\`type\`, \`describe\` and \`oneOf\`, or name them apart.`,
        );
      }
      // Optional, always: see `screenArgs`. The spec is otherwise the app's
      // own, `oneOf` included, so a wrong value is refused with the accepted
      // set listed.
      screenArgs[argName] = { ...spec, optional: true };
    }
  }

  if (screens.length && options.navigate === undefined) {
    // Said once, not thrown. Publishing a map and no way to walk it is a
    // legitimate thing to do — an agent that knows the screens exist and what
    // their addresses look like knows more than one that does not — but it is
    // the less likely of the two readings, and a `goto` that silently did not
    // appear is a bad half-hour. Refusing to mount would be worse: the map is
    // additive and useful on its own.
    warn(
      "`screens` was declared without `navigate`, so the reserved `goto` verb is not " +
        "offered: the core has no router and cannot navigate on its own. Pass " +
        "`navigate: ({ screen, args, url }) => …` to get `goto`, or ignore this if the map " +
        "is all you wanted.",
    );
  }

  if (screens.length && options.navigate !== undefined && verbs.has(GOTO)) {
    // The app claimed the name, so the app keeps it. The same rule as the
    // `rev` and `screen` arguments `driverkit/agent` hoists into every tool
    // schema: an app that declared its own wins, because the app's meaning
    // wins over ours. Said once all the same, because the author who hits this
    // is likelier to have two navigation verbs by accident than on purpose.
    warn(
      "`screens` and `navigate` were both declared and this app also declares its own verb " +
        "named `goto`, so the core's reserved one is not added and `navigate` is never " +
        "called. The app's verb wins; drop one of the two.",
    );
  }

  if (screens.length && options.navigate !== undefined && !verbs.has(GOTO)) {
    const navigate = options.navigate;
    const ids = [...byScreen.keys()];
    verbs.set(GOTO, {
      name: GOTO,
      // A `read` by the ladder's own definition, which is what the reworded
      // `read` comment was reworded for: `goto` changes no data and reports no
      // count, and what it does do — move the person's screen out from under
      // them — is what `read` now says out loud a read may do. A fourth kind
      // for navigation was the alternative and it was refused there: the three
      // kinds are a ladder of what a wrong call COSTS you, and a wrong
      // navigation costs exactly what a wrong read costs, which is that the
      // person has to look somewhere else.
      kind: "read",
      describe: GOTO_DESCRIBE,
      args: {
        [GOTO_SCREEN_ARG]: {
          type: "string",
          describe:
            "the screen's id. Your instructions list every screen this app has and what " +
            "each one is for.",
          // The accepted set, in the schema. Static — these are the names of
          // the app's screens, which are the same for every user forever — so
          // it is cacheable, and an id that is not one of them is refused by
          // the core's own argument check WITH THE WHOLE LIST in the reason,
          // which is a fix the model can make on its next turn without a read.
          oneOf: ids,
        },
        ...screenArgs,
      },
      // No `refuses`, and that is deliberate rather than an omission. Most of
      // what `goto` can say no to belongs to the app: the navigate hook is
      // where "you may not open that screen" and "there is no such record"
      // are said, in the app's own vocabulary, which the core cannot
      // enumerate. Declaring a partial list would turn `refuses` from
      // documentation into a check that warns at an app for refusing
      // correctly. The one slug the core itself originates is named in the
      // description instead.
      run: async (args: Record<string, Scalar>, ctx: VerbContext) => {
        const id = String(args[GOTO_SCREEN_ARG]);
        const screen = byScreen.get(id);
        if (!screen) {
          // Reached only if `oneOf` was bypassed -- a hand-written caller, or
          // a future core that stops checking. Named rather than left to
          // throw.
          return ctx.refuse(
            BAD_SCREEN_ARG,
            `no screen named \`${id}\`. This app has: ${ids.join(", ")}.`,
          );
        }
        const supplied: Record<string, Scalar> = {};
        for (const [argName, spec] of Object.entries(screen.args ?? {})) {
          const value = args[argName];
          const reason = checkArg(argName, spec, value);
          if (reason) {
            // The screen is named as well as the argument. "missing argument
            // `slug`" on a verb that takes six optional arguments does not say
            // which screen wanted it, and the agent's next guess is another
            // refused call.
            return ctx.refuse(
              BAD_SCREEN_ARG,
              `the \`${id}\` screen needs its own arguments and ${reason}`,
            );
          }
          if (value !== undefined && value !== null) supplied[argName] = value;
        }
        const url = screen.url === undefined ? undefined : expand(screen.url, supplied);
        return navigate(
          { screen: id, args: supplied, ...(url === undefined ? {} : { url }) },
          ctx,
        );
      },
    });
  }

  // ---- the app's recipes --------------------------------------------------
  const flows = options.flows ?? [];
  const flowIds = new Set<string>();
  for (const flow of flows) {
    if (typeof flow.id !== "string" || flow.id === "") {
      throw new Error("driverkit: a flow in `flows` has no `id`");
    }
    if (flowIds.has(flow.id)) {
      throw new Error(`driverkit: two flows are both named \`${flow.id}\``);
    }
    flowIds.add(flow.id);
    if (typeof flow.describe !== "string" || flow.describe === "") {
      throw new Error(
        `driverkit: the flow \`${flow.id}\` has no \`describe\`. It is the field a model ` +
          `chooses a flow on — the selection is made on the description and not on the ` +
          `individual steps — so a flow without one is a flow nothing will pick.`,
      );
    }
    if (flow.describe.length > SIZE_LIMITS.describe || /[\n\r]/.test(flow.describe)) {
      throw new Error(
        `driverkit: the flow \`${flow.id}\` must have a one-line \`describe\` of at most ` +
          `${SIZE_LIMITS.describe} characters (got ${flow.describe.length}` +
          `${/[\n\r]/.test(flow.describe) ? ", with a line break" : ""}). See \`SIZE_LIMITS\`.`,
      );
    }
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
      throw new Error(
        `driverkit: the flow \`${flow.id}\` has no \`steps\`. A flow with no steps is a ` +
          `sentence, and \`instructions\` is where a sentence goes.`,
      );
    }
    const body = flow.steps.map((s) => `${s.section ?? ""}${s.verb}${s.hint}`).join("");
    if (body.length > SIZE_LIMITS.body) {
      throw new Error(
        `driverkit: the flow \`${flow.id}\` has ${body.length} characters of steps; the ` +
          `budget is ${SIZE_LIMITS.body}. See \`SIZE_LIMITS\`.`,
      );
    }
    for (const step of flow.steps) {
      // Thrown at mount, the way a duplicate verb name is. A recipe citing a
      // verb nobody implemented is a dead end whose only symptom is an agent
      // halfway through a job meeting `unknown-verb` -- after the navigation
      // and before the commit, which is the worst place to find out. Checked
      // against the map AFTER `goto` was added to it, so a flow may name the
      // reserved verb like any other.
      if (!verbs.has(step.verb)) {
        const known = [...verbs.keys()].sort().join(", ");
        throw new Error(
          `driverkit: the flow \`${flow.id}\` names the verb \`${step.verb}\`, which this ` +
            `app does not have. known: ${known}. A flow is a recipe an agent reads and ` +
            `follows with real verbs, so a step naming one that does not exist is a dead ` +
            `end it would find halfway through the job.`,
        );
      }
      if (typeof step.hint !== "string" || step.hint === "") {
        throw new Error(
          `driverkit: the step \`${step.verb}\` of the flow \`${flow.id}\` has no \`hint\`. ` +
            `The verb's own \`describe\` already says what the verb does; the hint is what ` +
            `to do with it here, which is the part that makes this a recipe.`,
        );
      }
    }
  }

  if (options.instructions && options.instructions.length > SIZE_LIMITS.instructions) {
    // Warned and not thrown, which is the one inconsistency in here and it is
    // deliberate. `instructions` existed before it had a budget, so an app
    // that mounted yesterday with a very long briefing must still mount today:
    // a new throw on an old field is exactly the kind of change the additive
    // rule forbids. `screens` and `flows` are new, nothing can already be over
    // their budget, and so they throw.
    warn(
      `\`instructions\` is ${options.instructions.length} characters; the documented budget ` +
        `is ${SIZE_LIMITS.instructions}. It is sent in the cached prefix of every session, ` +
        `so the cost is paid once per person rather than once per turn — but a briefing ` +
        `this long is competing with the verbs for the model's attention. See \`SIZE_LIMITS\`.`,
    );
  }

  // ALL OR NONE, said once at mount.
  //
  // An eval found the hole this exists to name. The worked example declared
  // `consumes: "plan"` on `accept-selected` and left `decline-selected` bare,
  // and an agent asked for a job the app could not do improvised its way to the
  // bare one: 403 rows changed status with no count read and nothing gated. The
  // verb an agent reaches for when it is off its intended path is the
  // least-declared one, so a guarantee is only as strong as its weakest
  // sibling.
  //
  // WHY A WARNING AND NOT A THROW. Because adopting this field one verb at a
  // time is a legitimate state to be in for the length of an afternoon, and an
  // app that cannot mount halfway through its own migration is an app whose
  // author reverts the first half. The author who is told, once, at startup, in
  // the words of the two verbs involved, fixes it; a throw would be a change
  // that breaks an app for declaring a safety field on one verb, which teaches
  // the opposite lesson.
  //
  // WHAT IT CAN AND CANNOT SEE. The signal is a `commit` with NO ARGUMENTS: a
  // verb that takes nothing can only be acting on ambient state, which is the
  // selection or the open record, which is the thing a plan is a receipt for.
  // Deliberately narrow. `set-setting(name, value)` names what it changes and
  // must not be nagged about; `set-status(status)`, which changes the one record
  // whose screen is open, has an argument and will NOT be caught — a false
  // negative that is accepted on purpose, because the honest alternative is
  // warning about every commit with an argument, which is a warning on
  // everything and therefore a warning on nothing. The rule in `Verb.consumes`
  // is the thing to remember; this catches the shape that bit us.
  const consuming = [...verbs.values()].filter((v) => v.consumes === "plan");
  if (consuming.length) {
    const bare = [...verbs.values()].filter(
      (v) => v.kind === "commit" && v.consumes === undefined && v.args === undefined,
    );
    if (bare.length) {
      warn(
        `\`${consuming[0]!.name}\` consumes a plan but ${bare.map((v) => `\`${v.name}\``).join(", ")} ` +
          `${bare.length > 1 ? "are commits" : "is a commit"} that takes no arguments and asks ` +
          `for no plan. A commit with no arguments acts on the selection, so an agent that ` +
          `wants to move rows without a counted plan will use that one — which makes the ` +
          `check on \`${consuming[0]!.name}\` advisory. Declare \`consumes: "plan"\` on every ` +
          `commit that acts on the selection, or on none of them.`,
      );
    }
  }

  // Computed once. The manifest is the half that gets cached by whoever is
  // driving, so it must not vary call to call; deriving it lazily on every
  // read would invite someone to fold `visible()` into it.
  const manifest: Manifest = {
    version: fingerprint(options.app, verbs, options.instructions, options.screens, options.flows),
    app: options.app,
    // The app's own briefing, in the half that is cached once. Omitted rather
    // than sent as an empty string, so an app that passes nothing produces the
    // manifest it produced before this field existed -- byte for byte, which
    // is what the fingerprint hashes.
    ...(options.instructions ? { instructions: options.instructions } : {}),
    verbs: [...verbs.values()].map((v) => ({
      name: v.name,
      describe: v.describe,
      ...(v.kind ? { kind: v.kind } : {}),
      // Copied through untouched and never read by anything in here. `at` is a
      // hint for whoever is drawing the run, not a way to find an element; see
      // `Verb.at`.
      ...(v.at ? { at: v.at } : {}),
      // `screen` IS read in here, by `call` below, and it is still copied for
      // the same reason `kind` is: the manifest is the only description of this
      // verb an agent gets, and "works only on the companies list" is a fact it
      // should read in the cached half rather than discover by being refused.
      //
      // Copied in the shape the app declared, a string staying a string rather
      // than being normalised to a one-element array. Every client reading
      // `verbs[].screen` today reads it as a string, and normalising would move
      // every single-screen app's manifest -- and its fingerprint -- for a
      // change that app did not make.
      ...(v.screen ? { screen: v.screen } : {}),
      ...(v.reversible ? { reversible: v.reversible } : {}),
      // Copied for the reason `screen` is, and more urgently: `screen` tells an
      // agent WHERE a verb can be called and this tells it HOW. A client that
      // did not see this renders a tool with no `plan` property and no sentence
      // about the pairing, so the model calls the commit bare and is refused
      // every time, with nothing in the half it cached to explain the fix.
      ...(v.consumes ? { consumes: v.consumes } : {}),
      ...(v.args ? { args: v.args } : {}),
      ...(v.refuses ? { refuses: v.refuses } : {}),
    })),
    // The map and the recipes, copied through as declared. Both omitted
    // entirely when the app declared neither, so the manifest of an app that
    // uses neither is the document it was before these fields existed -- byte
    // for byte, which is what the fingerprint hashes and what every stored
    // `Manifest.version` out there was computed from.
    ...(options.screens ? { screens: options.screens } : {}),
    ...(options.flows ? { flows: options.flows } : {}),
  };

  const read = (): Snapshot => options.visible();

  // ---- the plan token ----------------------------------------------------
  //
  // One record per plan this driver has minted and not yet retired. The whole
  // mechanism is nine lines of state and it is worth saying what each piece is
  // load-bearing for.

  /** What a minted plan claimed, so a later commit can be checked against it
   *  rather than against a hash that only proves the token's provenance. */
  interface Plan {
    /** The `describe` that minted it. Named back in the refusal, so an agent
     *  told its plan is stale is told which call to make again. */
    verb: string;
    /** The `rev` the count was taken at. The expiry rule; see `minted`. */
    rev: number;
    /** `Snapshot.selectionId` at that moment, or undefined in an app that does
     *  not publish one. */
    selection?: string;
    /** The number the agent was shown and a person may have approved. Half of
     *  the two numbers a `stale-plan` hint names. */
    count: number;
    /** Set when a commit has run on it. A plan is good for ONE commit. */
    used: boolean;
  }

  /**
   * A per-driver salt, folded into every token's hash.
   *
   * Two things make this necessary rather than decorative. Without it, two
   * drivers mounted from the same verb table and driven through the same calls
   * mint the SAME token string — the bound fields are identical — so a plan
   * from one app would be honoured by another, which is a receipt that proves
   * nothing about where it came from. And with the formula sitting in this file
   * in plain sight, an agent that wanted to skip the describe could compute a
   * token for itself; a salt it has never seen is what stops that being a
   * three-line bypass of the whole mechanism.
   *
   * `Math.random` rather than a crypto import, because the core has no
   * dependencies and this is not a security boundary: the thing on the other
   * end is a confused agent, not an attacker with the page's own privileges,
   * and anything that could read this variable could already call the verb.
   */
  const planSalt = `${(planSeq += 1)}.${Math.random().toString(36).slice(2)}`;

  const plans = new Map<string, Plan>();
  /** The `rev` every record in `plans` was minted at. A plan is only valid at
   *  the rev it was taken at, so the map never needs to hold two revs' worth
   *  and is cleared the moment a newer one mints. That is the expiry rule
   *  paying for itself twice: as the check, and as the bound on the memory. */
  let plansAt = -1;
  let planCount = 0;

  /**
   * Whether this app uses plans at all, decided once, statically.
   *
   * An app with no `consumes` verb gets no tokens minted, so its `describe`
   * verbs return exactly the `Result` they returned before this existed —
   * byte for byte, which matters because that result is rendered into a
   * transcript and asserted on. Minting unconditionally would put a `plan`
   * field, and a line of rendered text, into every app in the world for a
   * feature none of them had asked for.
   */
  const usesPlans = [...verbs.values()].some((v) => v.consumes === "plan");

  /** How large a selection says it is, as the screen reports it.
   *
   *  `selectedCount` first and `selected.length` only as a fallback, which is
   *  the order those two fields document: `selected` is by design just the ids
   *  on screen, so reading it first would report 20 for a selection of 3,412
   *  and the `stale-plan` hint would name a number nobody was ever shown. */
  const sizeOf = (s: Snapshot): number | undefined =>
    s.selectedCount ?? (s.selected ? s.selected.length : undefined);

  /**
   * Mint a token for the selection a `describe` just left behind.
   *
   * The token is opaque to everybody but this driver, and it carries its `rev`
   * in clear on purpose: a plan is retired the moment a newer one is minted, so
   * a token that is no longer in the map must still be able to say whether it
   * was a plan from two revs ago — which is a useful refusal naming both
   * numbers — or a string that was never a plan at all. The hash is over every
   * bound field, so a token cannot be edited into a claim about another verb,
   * another rev or another selection.
   */
  function mint(verb: string, after: Snapshot, count: number): string {
    if (after.rev !== plansAt) {
      plans.clear();
      plansAt = after.rev;
    }
    // A guard, not a policy. An app whose `rev` never moves could mint without
    // limit, and this driver may live for the life of a tab. The oldest goes,
    // and an agent holding it is refused `stale-plan` -- which is the right
    // answer for a plan that is some thousands of describes old.
    if (plans.size >= 64) {
      const oldest = plans.keys().next().value;
      if (oldest !== undefined) plans.delete(oldest);
    }
    planCount += 1;
    const n = planCount;
    const bound = JSON.stringify([planSalt, verb, after.rev, after.selectionId ?? null, count, n]);
    const token = `${PLAN_PREFIX}.${after.rev}.${n}.${hash12(bound)}`;
    plans.set(token, {
      verb,
      rev: after.rev,
      ...(after.selectionId === undefined ? {} : { selection: after.selectionId }),
      count,
      used: false,
    });
    return token;
  }

  /** The `rev` a token says it was minted at, or null when it is not a token
   *  this core could have produced. Only ever used to phrase a refusal. */
  function revOf(token: string): number | null {
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== PLAN_PREFIX) return null;
    const rev = Number(parts[1]);
    return Number.isSafeInteger(rev) ? rev : null;
  }

  /**
   * The five ways a plan can fail, and the hint for each.
   *
   * Returns the hint to refuse with, or null to allow. Every branch names the
   * same repair — see `PLAN_REPAIR` — and the branches differ only in what they
   * say went wrong, because "your plan is stale" with no account of how is a
   * dead end in exactly the way a bare `wrong-screen` was.
   */
  function checkPlan(name: string, token: string | undefined, before: Snapshot): string | null {
    if (token === undefined || token === "") {
      const empty = sizeOf(before) === 0;
      return (
        `\`${name}\` acts on the current selection, so it may only be called with the ` +
        `\`plan\` token from the \`describe\` verb that counted it. You sent none, so nothing ` +
        `ran: without one, the number you read and the rows that move are two different ` +
        `claims.` +
        // Said when the app reports an empty selection, because this is the
        // case where the generic advice reads as an instruction to go and find
        // something to act on. Only when the app actually counts -- an absent
        // `selectedCount` means "I do not count", and "nothing is selected" is
        // not a thing to assert from a missing field.
        (empty
          ? ` Nothing is selected right now, so there is no count for a plan to be taken on` +
            ` and nothing for this verb to do.`
          : "") +
        ` ${PLAN_MISSING_REPAIR}`
      );
    }

    const plan = plans.get(token);
    if (!plan) {
      const was = revOf(token);
      if (was !== null && was !== before.rev) {
        // The common case, and the one the whole feature is about: the agent
        // is holding a receipt from before something moved.
        return (
          `that plan was taken at rev ${was} and the screen is now at rev ${before.rev}, so ` +
          `the selection it counted is not the selection on screen. ${PLAN_REPAIR}`
        );
      }
      return (
        `\`${token}\` is not a plan this app has outstanding — it was never minted here, or it ` +
        `has been superseded by a later one. Nothing ran. ${PLAN_REPAIR}`
      );
    }

    // BOTH NUMBERS, in every refusal about a plan this driver actually minted,
    // the way `wrong-screen` names both screens. "Your plan is stale" sends a
    // model back to re-read and work out what changed; "you were shown 3,412
    // and the selection is now 3,418" is a sentence it can say to the person
    // who approved the first number, which is the whole job. Appended to each
    // reason rather than built into one, so each branch still says what went
    // wrong as well as by how much.
    const now = sizeOf(before);
    const both =
      ` You were shown ${plan.count}; the selection is now ` +
      `${now === undefined ? "not counted by the app" : String(now)}.`;

    if (plan.used) {
      // Single use, and the refusal says so rather than saying "stale", because
      // an agent told "stale" will re-read and try the same token again.
      return (
        `that plan has already been used by a commit. A plan is good for one commit, so that a ` +
        `count a person approved once cannot be acted on twice.${both} ${PLAN_REPAIR}`
      );
    }

    if (plan.rev !== before.rev) {
      return (
        `that plan was taken at rev ${plan.rev} and the screen is now at rev ${before.rev}, so ` +
        `the selection it counted is not the selection on screen.${both} ${PLAN_REPAIR}`
      );
    }

    // The case `rev` alone cannot catch: an app that changed its selection
    // without moving its `rev`.
    if (plan.selection !== undefined && plan.selection !== before.selectionId) {
      return (
        `that plan named a different selection from the one on screen now.${both} ` +
        `${PLAN_REPAIR}`
      );
    }

    if (plan.selection === undefined) {
      // Said once, not refused, and it is the honest disclosure of how strong
      // this check actually is in this app. The verb asked for a plan, the app
      // publishes no `selectionId`, so the token binds the `rev` and the count
      // and nothing else -- which catches every change the app bumps its `rev`
      // for and no change it makes quietly. Refusing instead would break an
      // app that adopted `consumes` before `selectionId`; saying nothing would
      // let the weaker check be mistaken for the stronger one. See `warn`.
      warn(
        `the verb \`${name}\` consumes a plan but \`visible()\` returns no \`selectionId\`, so ` +
          `the token can only bind the \`rev\` and the count. A selection that changes without ` +
          `moving \`rev\` will not be caught. Fill in \`Snapshot.selectionId\` — ` +
          `\`selectionId(ids)\` from this package is the one to use.`,
      );
    }

    return null;
  }

  /** The manifest entry for a verb, which is what an approval hook is handed.
   *  Built from the manifest rather than from the `Verb` so a gate reads the
   *  declared facts and cannot reach `run`; see `ApprovalRequest`. */
  const entries = new Map(manifest.verbs.map((v) => [v.name, v] as const));

  const ctx: VerbContext = { refuse: refusal };

  /**
   * Ask, and turn the three answers into the three outcomes.
   *
   * Returns null to allow, or the refusal to send back. The lock is taken for
   * the duration and released in a `finally`: a hook that throws must not
   * leave a driver that refuses every later call, and it must not be read as
   * consent either — a failed ask is a no, which is the rule
   * `onBeforeCommit` already had and the only safe way round it is a person.
   */
  async function askApproval(
    name: string,
    args: Record<string, Scalar>,
    before: Snapshot,
  ): Promise<Result | null> {
    const req: ApprovalRequest = { name, args, verb: entries.get(name)!, snapshot: before };
    const was = pending;
    pending = name;
    let decision: Approval;
    try {
      decision = await deadline(approveFn!(req), options.approvalTimeout);
    } catch (err) {
      decision = `the approval could not be asked for (${
        err instanceof Error ? err.message : String(err)
      }), and a failed ask is a no, never a yes`;
    } finally {
      pending = was;
    }

    if (decision === undefined || decision === true) return null;
    if (decision === false) return no(DECLINED, DECLINED_HINT, read());
    if (typeof decision === "string") return no(DECLINED, decision, read());
    if (typeof decision === "object" && decision !== null && decision.timedOut === true) {
      return no(
        APPROVAL_TIMEOUT,
        decision.hint ??
          `\`${name}\` needed a person's approval and nobody answered. **The verb did not ` +
            `run and nothing changed** — this is not the relay's \`timeout\`, which means the ` +
            `outcome is unknown. Ask the person, then call it again.`,
        read(),
      );
    }
    // An answer the core does not recognise is a denial. Reading an unknown
    // shape as consent is how a refactor of a hook's return type silently
    // removes the gate, and the cost of being wrong the other way is one
    // refused commit.
    warn(
      `the \`approve\` hook answered with ${JSON.stringify(decision)}, which is not an ` +
        `approval. Treated as a refusal. Return true, false, a reason, or { timedOut: true }.`,
    );
    return no(
      DECLINED,
      "the app's approval hook answered with something that is not a decision, so this was " +
        "not allowed. That is a bug in the app rather than in your call.",
      read(),
    );
  }

  async function call(
    name: string,
    args: Record<string, Scalar> = {},
    opts: CallOptions = {},
  ): Promise<Result> {
    if (!live) return no("unmounted", "this driver was unmounted", read());

    // BEFORE the verb is even looked up, and that order is the point. This is
    // not a fact about the call, it is a fact about the app: somebody is being
    // asked a question and nothing else runs until they answer. Checking it
    // after the lookup would answer `unknown-verb` to a call made during an
    // approval, which is a true statement about the wrong thing.
    //
    // It is also what makes point 4 structural rather than hopeful: the second
    // call for a verb whose approval is open cannot race the dialog, because
    // it is refused here — including when it is the same verb, and including
    // when it is the gate's own Approve button arriving as a `press`.
    if (pending !== null) {
      return no(
        APPROVAL_PENDING,
        `\`${pending}\` is waiting to be approved, so ${PENDING_HINT}`,
        read(),
      );
    }

    const verb = verbs.get(name);
    if (!verb) {
      // The known names are listed. An outside agent may be holding a manifest
      // from a previous version of the app, and the list is how it finds out
      // what moved without a second round trip.
      const known = [...verbs.keys()].sort().join(", ");
      return no("unknown-verb", `no verb named \`${name}\`. known: ${known}`, read());
    }

    const before = read();

    // WHICH SCREEN comes before WHICH REV, which comes before the arguments.
    // Each check describes a wider mistake than the next, and the widest one is
    // the useful answer: if the agent is not on the screen it thinks it is,
    // then the rev and the arguments both describe something it never saw, and
    // answering "the number moved" sends it to re-read a screen when what it
    // needs is to navigate back. A `next-page` that lands on another company's
    // contact list and answers `ok` is the live bug this ordering exists to
    // make impossible.
    //
    // Both screen checks are skipped when the app does not fill in
    // `Snapshot.screen`. There is nothing to compare against, and inventing a
    // comparison -- treating absent as "not that one" -- would refuse every
    // screen-scoped verb in an app that simply has not adopted the field.
    if (opts.screen !== undefined && before.screen !== undefined && opts.screen !== before.screen) {
      return no(
        WRONG_SCREEN,
        `you believed you were on the \`${opts.screen}\` screen but the app is on ` +
          `\`${before.screen}\`; read the screen again before acting on it`,
        before,
      );
    }

    if (verb.screen !== undefined) {
      const wants = screensOf(verb.screen);
      if (before.screen === undefined) {
        // Said once, not refused. The app declared a verb→screen mapping and no
        // live screen, so the check it asked for cannot run -- which is a
        // mistake in the app rather than in the call, and refusing a verb an
        // author believes they scoped correctly would break a working app over
        // a missing field. See `warn`.
        warn(
          `the verb \`${name}\` names ${wants.length > 1 ? "the screens" : "the screen"} ` +
            `${naming(wants)} but \`visible()\` returns no \`screen\`, so the check cannot run. ` +
            `Fill in \`Snapshot.screen\` with the id of the screen that is live, or drop ` +
            `\`screen\` from the verb.`,
        );
      } else if (!wants.includes(before.screen)) {
        // ALL the screens are named, the live one and every one the verb works
        // on. `wrong-screen` on its own is a dead end: an agent that is told no
        // and not told where to go has to guess, and the guess is another
        // refused call. Naming only one of several would be a subtler version
        // of the same dead end -- it would send an agent to the contacts list
        // when the company screen it is two clicks from would have done. The
        // verb that navigates is the app's and cannot be named from here, which
        // is what `Manifest.instructions` is for.
        return no(
          WRONG_SCREEN,
          `you are on the \`${before.screen}\` screen; \`${name}\` works on the ` +
            `${naming(wants)} ${wants.length > 1 ? "screens" : "screen"}. Go ` +
            `${wants.length > 1 ? "to one of those" : "there"} first, then call it again.`,
          before,
        );
      }
    }

    // WHICH SELECTION comes after WHICH SCREEN and BEFORE WHICH REV, and this
    // is the one ordering decision in `call()` that is not obvious, so here is
    // the argument.
    //
    // The ladder is by how WIDE the mistake is, widest first, because the
    // widest answer is the one whose repair subsumes the others'. A wrong
    // screen is still the widest: a plan taken on another screen is a claim
    // about a selection the agent was never looking at, so there is nothing
    // useful to say about it until it is standing in the right place.
    //
    // But `stale-plan` is WIDER than `stale`, and that is why it goes above it
    // rather than below. A token binds the `rev` it was taken at, so every
    // stale `rev` is also a stale plan -- the set is strictly larger -- and the
    // two repairs are not the same size. `stale` says "read again", and an
    // agent that reads again and carries on is the agent that accepts 3,418
    // rows after a person approved 3,412. `stale-plan` says "run the describe
    // again, read the new count, check it, then commit", which is the repair
    // that actually fixes a moved selection. Answering the narrower one first
    // would hand back the cheaper instruction for the more expensive mistake.
    //
    // It is also before the argument check for the reason `rev` is: a commit
    // whose selection has moved is not a commit whose arguments are worth
    // discussing. And it is before the approval gate, which is last, so nobody
    // is ever asked to approve a commit that was already going to be refused.
    if (verb.consumes === "plan") {
      const stale = checkPlan(name, opts.plan, before);
      if (stale) return no(STALE_PLAN, stale, before);
    }

    // Staleness is checked BEFORE arguments, and that order is deliberate. If
    // the screen has moved on, the arguments describe a row the agent never
    // saw, so complaining about their shape would be answering the wrong
    // question -- and the fix is the same either way: read again.
    if (opts.rev !== undefined && opts.rev !== before.rev) {
      return no(
        "stale",
        `you acted on rev ${opts.rev} but the screen is at rev ${before.rev}; read again`,
        before,
      );
    }

    if (verb.args) {
      for (const [argName, spec] of Object.entries(verb.args)) {
        const reason = checkArg(argName, spec, args[argName]);
        if (reason) return no("bad-argument", reason, before);
      }
    }

    // LAST of the checks and immediately before `run`, which is the only place
    // it can go. Asking a person about a call that is about to be refused for
    // a stale rev, a wrong screen or a missing argument is asking them to
    // approve something that was never going to happen — and the second time
    // that happens they stop reading the question.
    if (verb.kind === "commit" && approveFn !== undefined) {
      const refused = await askApproval(name, args, before);
      if (refused) return refused;
    }

    // Burned HERE, between the last check and `run`, and the position is the
    // decision rather than an accident of where it fitted.
    //
    // A plan is single-use. Terraform's model is a saved plan that performs
    // exactly the steps it holds, and replaying one that has already been
    // applied is the double-apply; here it is the double-accept, which is the
    // single most expensive thing an agent can do with a bulk verb. The count
    // was shown once and approved once, so it buys one commit.
    //
    // Burned on ENTERING `run` rather than on a successful return, so a verb
    // that changes half a selection and then throws cannot have its token
    // re-presented. And burned AFTER the approval gate, not before, so a commit
    // that a person declined -- or that lapsed with nobody answering -- leaves
    // the token alive: nothing moved, the count is still the count, and making
    // somebody re-run the describe because they hesitated is how a gate teaches
    // people to stop reading it.
    if (verb.consumes === "plan" && opts.plan !== undefined) {
      const spent = plans.get(opts.plan);
      if (spent) spent.used = true;
    }

    let outcome: void | Refusal | Report;
    try {
      outcome = await verb.run(args, ctx);
    } catch (err) {
      // An app bug is reported as a failed call rather than allowed to
      // propagate. The alternative kills the websocket pump in the relay, and
      // a driver that dies on one bad verb takes every other verb with it.
      return no(
        "threw",
        `the verb \`${name}\` threw: ${err instanceof Error ? err.message : String(err)}`,
        read(),
      );
    }

    if (isRefusal(outcome)) {
      if (RESERVED.has(outcome.reason)) {
        // Reported as `threw` rather than passed through, and rather than
        // raised. Passing it through is the bug: the agent now reads `timeout`
        // from a call that landed and answered, and the reserved list stops
        // meaning anything. Raising would be worse — this is reached only while
        // a working app is saying no, and killing the run over a slug turns a
        // declined commit into a dead panel. `threw` is already the core's word
        // for "the app's own code is broken", which is exactly what this is,
        // and it leaves the reserved slugs saying only what they are for.
        warn(
          `the verb \`${name}\` refused with the reserved slug \`${outcome.reason}\`; ` +
            `reported as \`threw\`. Reserved: ${RESERVED_REFUSALS.join(", ")}.`,
        );
        return no(
          "threw",
          `the verb \`${name}\` refused with \`${outcome.reason}\`, which is a reserved slug and ` +
            `not an app refusal. This is a bug in the app, not something to retry differently.`,
          read(),
        );
      }

      // Declaring `refuses` opts the verb into the check; leaving it absent
      // makes no claim, the same way an absent `kind` makes no safety claim.
      // Warning on every app that never filled the field in would be a warning
      // on everything and therefore a warning on nothing.
      if (verb.refuses && !verb.refuses.includes(outcome.reason)) {
        warn(
          `the verb \`${name}\` refused with \`${outcome.reason}\`, which is not in its declared ` +
            `refuses [${verb.refuses.join(", ")}]. The manifest is the only description of this ` +
            `verb an agent gets, and an undeclared refusal is one it cannot plan around.`,
        );
      }

      return no(outcome.reason, outcome.hint, read());
    }

    // Read again after running, not before: the point of returning a snapshot
    // is to show what the call did.
    //
    // `count` is forwarded with `?? undefined` rather than a truthiness check,
    // because a `describe` verb that matched nothing must report `0` and not
    // silently become "I do not count" — those are different answers, and the
    // difference decides whether a commit should follow.
    const after = read();

    // The mint, and everything about when it happens is load-bearing.
    //
    // AFTER `run`, from the snapshot the call left behind, because the whole
    // claim is about the selection that now exists and not the one that did a
    // moment ago.
    //
    // Only on a `describe`, and only on one that reported a `count`. Those two
    // conditions are the same condition said twice: `describe` is the kind that
    // promises a pending count, and a `count` is the number a commit decision
    // turns on. A `read` leaves nothing pending and a `commit` has already
    // moved the data, so a token from either would be a receipt for a decision
    // nobody is about to make.
    //
    // Only in an app that has a verb consuming them, which is what keeps this
    // additive: every `describe` in every app written before this returns the
    // exact `Result` it returned before, with no `plan` field and no extra line
    // in anything that renders it.
    //
    // `count` is forwarded with `!== undefined` rather than a truthiness check,
    // because a `describe` verb that matched nothing must report `0` and not
    // silently become "I do not count" — those are different answers, and the
    // difference decides whether a commit should follow. A plan is minted for a
    // count of `0` for the same reason: "commit on nothing" is a decision an
    // agent can make, and it should be made against a receipt like any other.
    const counted = outcome && outcome.count !== undefined ? outcome.count : undefined;
    const plan =
      usesPlans && verb.kind === "describe" && counted !== undefined
        ? mint(name, after, counted)
        : undefined;

    return {
      ok: true,
      ...(counted === undefined ? {} : { count: counted }),
      ...(outcome && outcome.note !== undefined ? { note: outcome.note } : {}),
      ...(plan === undefined ? {} : { plan }),
      snapshot: after,
    };
  }

  function no(refused: string, hint: string | undefined, snapshot: Snapshot): Result {
    return { ok: false, refused, ...(hint === undefined ? {} : { hint }), snapshot };
  }

  return {
    manifest: () => manifest,
    snapshot: read,
    call,
    approval: {
      policy,
      // Offered whatever the policy is, including `"none"`. The widget's
      // in-page dialog is an approval UI on a driver that may well have
      // declared nothing, and it needs the lock exactly as much as the core's
      // own hook does: the agent it is asking is not the only agent that can
      // reach this driver.
      hold: async <T>(verb: string, ask: () => Promise<T>): Promise<T> => {
        const was = pending;
        pending = verb;
        try {
          return await ask();
        } finally {
          pending = was;
        }
      },
    },
    unmount: () => {
      live = false;
    },
  };
}

/**
 * `promise`, or `{ timedOut: true }` after `ms`.
 *
 * Absent or non-positive `ms` waits forever, which is `MountOptions.approvalTimeout`'s
 * documented default: a deadline that denies while somebody is still reading
 * the rows teaches them the dialog is a race. The timer is always cleared, so
 * a hook that answers in time does not hold a Node process open for the rest
 * of the deadline.
 */
function deadline(promise: Approval | Promise<Approval>, ms?: number): Promise<Approval> {
  if (ms === undefined || !(ms > 0)) return Promise.resolve(promise);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lapse = new Promise<Approval>((resolve) => {
    // Deliberately NOT unref'd, and that is not an oversight. `unref` says the
    // timer is not work worth staying alive for -- true right up until the hook
    // never answers. Then the timer is the ONLY pending thing, the event loop
    // concludes it has nothing to do, and the process tears down with the
    // deadline unfired: the one case this helper exists for. In a test runner
    // that surfaced as every later test in the file being CANCELLED rather than
    // failing, which is a far harder symptom to read than a held process.
    // `clearTimeout` in `finally` already buys what `unref` was reaching for.
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([Promise.resolve(promise), lapse]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * A short, stable hash of the verb surface.
 *
 * Only the parts an agent can observe go in: names, descriptions, argument
 * shapes, refusals. Not `run`, because reimplementing a verb's body without
 * changing its interface must not invalidate anybody's cached manifest.
 *
 * Not cryptographic and does not need to be. It answers one question -- "is
 * the copy I cached still the current one" -- and a collision costs a stale
 * manifest, not a security property.
 */
function fingerprint(
  app: string,
  verbs: Map<string, Verb<any>>,
  instructions?: string,
  screens?: readonly unknown[],
  flows?: readonly unknown[],
): string {
  // `kind` is in here on purpose. A verb reclassified from `describe` to
  // `commit` has not changed its name or its arguments, so without this the
  // fingerprint would not move and every agent holding a cached manifest would
  // go on believing an irreversible verb is free to try.
  //
  // So is `at`, for the weaker but real version of the same reason: it is part
  // of what a cached manifest claims about the surface, and a UI holding the
  // old copy would outline an element the verb no longer touches.
  //
  // `screen` and `reversible` are in for the strong version of it. Moving a
  // verb to another screen changes where a cached copy says it works, and so
  // does GIVING IT A SECOND ONE -- a verb that now also works on a company's
  // contact list is a verb whose cached description was wrong about where it
  // can be called. Dropping `reversible` from a commit changes whether an agent
  // was told there is a way back -- which is the same class of mistake as a
  // reclassified `kind`.
  //
  // The DECLARED shape is hashed, so `"contacts"` and `["contacts"]` give
  // different versions. That is not a wart: they are different bytes in the
  // manifest, a client caching the manifest would see a different document, and
  // a fingerprint that hid the difference would be claiming two cached copies
  // are interchangeable when they do not read the same. So is `instructions`: it is rendered straight into the
  // system prompt, so an agent holding the old manifest is briefed with the
  // app's old words.
  //
  // All three are APPENDED, and only when the app actually used them, so the
  // shape of an app that uses none is the exact string it was before these
  // fields existed. That is not neatness: every stored `Manifest.version` out
  // there was computed from the old string, and an upgrade of this library that
  // silently moved every app's version would tell every agent its cached
  // manifest had gone stale when nothing about the app had changed at all.
  //
  // `consumes` is in for the strongest version of the same reason, and it is
  // the one case where a cached copy being wrong costs a round trip every time:
  // a verb that has started requiring a plan token cannot be called bare any
  // more, so an agent holding the old manifest calls it the old way and is
  // refused `stale-plan` on every attempt, with nothing in its cached
  // description to explain why. Dropping `consumes` is the dangerous direction
  // of the same move -- a commit that USED to demand a receipt and no longer
  // does -- which is the same class of mistake as dropping `reversible`.
  const extras = (v: Verb<any>): Array<Record<string, unknown>> => {
    const e: Record<string, unknown> = {};
    if (v.screen) e.screen = v.screen;
    if (v.reversible) e.reversible = v.reversible;
    if (v.consumes) e.consumes = v.consumes;
    return Object.keys(e).length ? [e] : [];
  };

  const shape = JSON.stringify([
    app,
    [...verbs.values()]
      .map((v) => [
        v.name,
        v.describe,
        v.kind ?? null,
        v.at ?? null,
        v.args ?? null,
        v.refuses ?? null,
        ...extras(v),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ...(instructions ? [instructions] : []),
    // Appended last and only when present, by the same rule as the three
    // above: an app that declares neither hashes the exact string it hashed
    // before these fields existed. Tagged rather than bare, because they are
    // appended at the position `instructions` occupies when an app has no
    // briefing, and two different claims about an app must not be able to hash
    // to one shape.
    //
    // `screens` is in here for the reason `screen` on a verb is: it is what a
    // cached copy claims about where this app can be driven, and a screen that
    // gained a url template or had its sentence rewritten is a screen a model
    // was briefed about in the app's old words. `flows` is in here for the
    // reason `instructions` is -- it is rendered straight into the cached
    // system prompt -- with one extra edge: a flow names verbs, so an app that
    // renames one leaves every cached copy holding a recipe that cites a verb
    // which no longer exists.
    ...(screens ? [{ screens }] : []),
    ...(flows ? [{ flows }] : []),
  ]);
  return hash12(shape);
}
