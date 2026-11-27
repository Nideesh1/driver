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
  AskAnswer,
  AuditEvent,
  AuditHook,
  CallOptions,
  Driver,
  DriverApproval,
  ElsewhereChannel,
  ElsewhereNotice,
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
  // The one the cost ceiling added, and it is a WHAT IT COST slug rather than
  // a WHERE YOU ARE or a WHAT YOU ARE ACTING ON one.
  //
  // Every other slug on this list describes something an agent can repair.
  // `budget-spent` is the only one whose honest hint is "do not try again" —
  // the ceiling was declared by whoever mounted the app, it does not reset, and
  // the only thing that moves it is a person changing `MountOptions.budget`. It
  // is reserved for the usual reason: an app that refused `budget-spent` on a
  // business rule would be telling an agent to stop forever over something it
  // could have phrased differently.
  //
  // ONE SLUG FOR BOTH CEILINGS, and the ladder is why. Two slugs earn their
  // place when two repairs differ — `stale` versus `stale-plan` is the live
  // example on this list. The call budget and the commit budget end in the
  // identical repair, which is no repair: stop, and tell the person. So the
  // slug is one and the HINT names which ceiling, with both numbers.
  "budget-spent",
  // The one cross-tab staleness added, and it is a WHAT YOU ARE ACTING ON slug
  // like `stale` and `stale-plan` rather than a new kind of thing.
  //
  // It is the only slug on this list that the core originates from something it
  // was TOLD rather than something it can see. Every other staleness check
  // compares two values out of `visible()`; this one fires because another
  // driver of the same app said a commit landed, which is a fact no value in
  // this tab can carry. See `MountOptions.elsewhere`.
  //
  // WHY NOT `stale`. `stale` means "the number you echoed is not the number on
  // screen, read again", and re-reading is a repair that WORKS. Here the number
  // on screen matches and is wrong, so an agent told `stale` would re-read,
  // get the same rev, believe itself current and commit — which is the silent
  // failure this exists to end, re-created by reusing the slug. The repair is
  // different and much larger: this tab's copy of the data is behind and only
  // the app refreshing fixes it.
  "changed-elsewhere",
  // The three the question verb added. All three say WHY NOBODY ANSWERED, which
  // is a fourth kind of thing on this list — not where the call stopped, not
  // what it was acting on, not what it cost — and the reason there are three of
  // them rather than one is the reason there are two of `stale` and
  // `stale-plan`: the repairs differ.
  //
  // `ask-unanswered` — the question was put in front of somebody and no answer
  // came back. The channel works and this question went unanswered, so asking
  // once more, or asking something shorter, is a move that can succeed. **The
  // verb did not run and nothing changed**, exactly as with `approval-timeout`,
  // and for the same reason that slug is not the relay's `timeout`: nobody is
  // in any doubt about what happened.
  //
  // `nobody-to-ask` — there is no person on this path at all: a cron run, a
  // test harness, an app that declared no way to ask. Every further question is
  // wasted, so the repair is strictly larger — decide from what is known, or
  // stop and say what is missing. An agent told `ask-unanswered` for this will
  // ask again into an empty room until something else stops it, which is why
  // folding the two would be the same mistake as folding `stale` into
  // `stale-plan`.
  //
  // `asks-spent` — the app's question allowance is gone, so this one was never
  // put. Deliberately NOT `budget-spent`, and this is the one departure from
  // "one slug for both ceilings" a few lines up. That rule's own justification
  // is that the call ceiling and the commit ceiling "end in the identical
  // repair, which is no repair: stop, and tell the person" — and a spent
  // question allowance ends in a real one: say in your answer what you would
  // have asked. It also must not be `budget-spent` because `drive` ends the
  // whole run on that slug, which would mean an agent that asked one question
  // too many could no longer finish the sentence it was asking about.
  "ask-unanswered",
  "nobody-to-ask",
  "asks-spent",
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
const BUDGET_SPENT = "budget-spent";
const CHANGED_ELSEWHERE = "changed-elsewhere";
const ASK_UNANSWERED = "ask-unanswered";
const NOBODY_TO_ASK = "nobody-to-ask";
const ASKS_SPENT = "asks-spent";

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

/** Counts mounted drivers, only so each one can tell its own cross-tab notices
 *  from a sibling's. Module-level for the reason `planSeq` is: two drivers in
 *  one page must not agree, and two drivers in one page is exactly the case a
 *  test of this feature sets up. */
let elsewhereSeq = 0;

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
 * What stands in for a `sensitive` argument's value in an audit record.
 *
 * Fixed rather than configurable, and exported rather than private. A marker
 * an app can change is a marker that the person reading somebody else's log
 * cannot recognise, and a marker nobody can import is one every test and every
 * sink spells out by hand and eventually spells differently. See
 * `ArgSpec.sensitive`.
 */
export const REDACTED = "[redacted]";

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
 * The reserved question verb.
 *
 * Reserved in the same WEAK sense `goto` is, and the same rule decides it: an
 * app that declares its own verb named `ask` keeps it and the core adds
 * nothing, because the app's meaning wins over ours. What "reserved" buys is
 * one name instead of one per app — `ask`, `ask-user`, `clarify`, `check-with-
 * me`, none of which the next agent recognises — which is the argument that
 * made `goto` reserved and `wrong-screen` a reserved refusal.
 *
 * It is NOT in `RESERVED_REFUSALS`, so a verb may be named this. The three
 * slugs the mechanism added are, for the usual reason: an app that refused
 * `nobody-to-ask` on a business rule would be telling an agent to stop asking
 * for the rest of a run over something it could have phrased differently.
 */
const ASK = "ask";

/** The name of `ask`'s one argument. Spelled once: it is named in the schema,
 *  in two refusals and in the record. */
const ASK_QUESTION_ARG = "question";

/**
 * How long a question waits for an answer when the app did not say.
 *
 * **45 seconds, and the number is chosen against the relay's 60.** See
 * `MountOptions.askTimeout`: a question that outlives the transport's deadline
 * converts "nobody answered", which is a fact the agent can act on, into the
 * relay's `timeout`, which PROTOCOL.md defines as outcome unknown. Of the two
 * errors, firing late is the expensive one here — the opposite way round from
 * `approvalTimeout`, which waits forever because a lapsed approval DENIES a
 * commit and a lapsed question denies nothing.
 *
 * Exported so the two numbers can be reasoned about together rather than being
 * two literals in two packages.
 */
const DEFAULT_ASK_TIMEOUT_MS = 45_000;

export { ASK, ASK_QUESTION_ARG, DEFAULT_ASK_TIMEOUT_MS };

/**
 * `ask`'s description, which every agent reads in the cached half.
 *
 * Here rather than in `driverkit/agent` and `mcp_core.py` for the reason
 * `GOTO_DESCRIBE` is: this verb is the core's own, the two renderers describe
 * what an APP declared, and a sentence about a core verb written twice in two
 * languages is a sentence that drifts.
 *
 * THREE THINGS IT HAS TO SAY, and the third is the one the whole mechanism
 * stands on. What the verb is for: an instruction you cannot carry out without
 * guessing. What the three refusals mean, since the difference between "nobody
 * answered" and "there is nobody" decides whether asking again is worth a turn.
 * And that **an answer is not an approval** — because the single most likely
 * misuse of this verb is to ask "shall I accept these 3,412?", read a yes, and
 * treat it as the consent the approval gate exists to collect. The core refuses
 * that structurally, and a model that has been told so does not spend a turn
 * discovering it.
 */
const ASK_DESCRIBE =
  "ask the person a question and get their answer back as this call's result. For an " +
  "instruction you cannot carry out without guessing — two records match the name they " +
  "gave, nothing is selected and you do not know which rows they meant, the company they " +
  "named does not exist. Asking is better than guessing and far better than acting on a " +
  "guess.\n\n" +
  "It is not free and it is not unlimited: each question costs the person's attention, the " +
  "app may cap how many you get, and nothing else runs while one is open. So ask once, ask " +
  "the narrowest question that unblocks you, and put everything you already know into it — " +
  "`which Ada Duarte did you mean: the one at Acme or the one at Initech?` rather than " +
  "`which one?`.\n\n" +
  "**An answer is not permission.** A commit still goes to whoever approves commits in this " +
  "app, whatever the person told you here, and a `yes` to a question of yours authorises " +
  "nothing — so do not ask for approval with this, and do not report a commit as approved " +
  "because an answer sounded like a yes.\n\n" +
  "Refused as `ask-unanswered` when the question was put and nobody answered: the question " +
  "was seen by nobody who replied, nothing in the app changed, and asking again later or " +
  "more briefly may work. Refused as `nobody-to-ask` when there is no person on this run at " +
  "all — a scheduled job, a test — in which case stop asking: say what you need and what you " +
  "could not decide. Refused as `asks-spent` when the app's question allowance is gone, " +
  "which means the same thing for the rest of this run.";

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
  /** `FlowSpec.describe` and `ScreenSpec.describe`: one line, at most this.
   *  Also `FlowStep.skipWhen`, which is a one-line condition for the same
   *  reason — it is read beside the step, not reasoned from. */
  describe: 1024,
  /** A whole flow's steps — every `section`, `verb`, `hint` and `skipWhen`
   *  together. Everything rendered into the prefix counts, so moving a sentence
   *  out of a `hint` and into a `skipWhen` buys no room. */
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
  /** How to stop listening on `MountOptions.elsewhere`, if the channel gave us
   *  one. Held here rather than beside the channel because `unmount` is at the
   *  bottom of the file and a subscription nothing unsubscribes is a leak per
   *  mounted driver -- which in a hot-reloading dev server is one per save. */
  let unlisten: (() => void) | undefined;

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
  /** What the app itself said, for all time. `connect()` reads this one. */
  const declaredPolicy: NonNullable<DriverApproval["declared"]> =
    approveFn !== undefined ? "hook" : declared === "unattended" ? "unattended" : "none";

  /**
   * An approver installed after mount, by a dialog that lives in the page.
   *
   * `DriverApproval.adopt` carries the argument; this is the mechanism, and it
   * is two variables because releasing has to be safe. The hook is what the
   * gate calls; the token is who owns it, so a disposer handed out earlier
   * cannot unhook whoever adopted after it — which is the shape every
   * "unsubscribe twice" bug has.
   *
   * Only ever set when the app declared nothing. An app with its own `hook` is
   * already asked on every path, and `unattended` is an app saying commits
   * here run with nobody watching; installing a dialog over either of those
   * would be the library overruling a sentence somebody wrote.
   */
  let adopted: ApprovalHook | undefined;
  let adoptedBy: object | undefined;

  /** Who is asked right now, which is what a record has to say. See
   *  `DriverApproval.policy`: `adopted` is deliberately not `hook`. */
  function policyNow(): DriverApproval["policy"] {
    if (approveFn !== undefined) return "hook";
    if (declared === "unattended") return "unattended";
    return adopted !== undefined ? "adopted" : "none";
  }

  /**
   * Where the records go, or nowhere.
   *
   * Read once, into a `const`, because an app that passes no hook has to behave
   * byte-identically to one mounted before audit existed -- and the test for
   * that is `onAudit === undefined`, checked once per call rather than a field
   * lookup on an options object somebody might mutate afterwards. Not validated
   * at mount the way `approve` is: a misspelt policy makes an app believe it has
   * a gate it has not got, which is a safety claim, while a hook that is not a
   * function throws on the first call and is caught by `record` -- reported, the
   * call unaffected. The asymmetry is the point.
   */
  const onAudit: AuditHook | undefined = options.onAudit;

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
  let pending: { verb: string; question: boolean } | null = null;

  // ---- the cost ceiling ---------------------------------------------------
  //
  // Two counters and a validation. `MountOptions.budget` carries the argument
  // for what is bounded and what was rejected; what is here is the mechanism.
  //
  // Validated at mount for the reason the approval policy is: a budget of 0 or
  // -1 means the app is never drivable, which nobody means, and discovering it
  // as `budget-spent` on the very first call is the one shape where an author
  // believes they configured a ceiling and have in fact configured a wall.
  const budget = options.budget;
  if (budget !== undefined) {
    for (const field of ["calls", "commits", "asks"] as const) {
      const limit = budget[field];
      if (limit === undefined) continue;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(
          `driverkit: \`budget.${field}\` is ${JSON.stringify(limit)}; it must be a positive ` +
            `integer, or absent to mean no ceiling. A budget of ${JSON.stringify(limit)} is not ` +
            `a tight ceiling, it is an app that refuses its first call — and it would do that ` +
            `with a \`budget-spent\` hint, which reads as a runaway rather than as a typo.`,
        );
      }
    }
  }
  /** Every `call()` that got past the approval lock, refused ones included.
   *  Kept whether or not a ceiling was declared: `Driver.budget` reports it
   *  either way, and a number somebody debugging a chatty app can read is
   *  worth two increments. */
  let callsUsed = 0;
  /** `commit` verbs that actually reached `run`. */
  let commitsUsed = 0;
  /** Questions that actually reached a person. A question refused for a spent
   *  allowance, or one the app answered `{ nobody: true }` to, is not counted:
   *  neither took anybody's attention, which is the thing this number bounds. */
  let asksUsed = 0;
  /** When this allowance began, for `Budget.window`. `Date.now()` here means
   *  "this mount started one", and a record read back below replaces it with
   *  the moment the allowance it belongs to actually started. */
  let budgetSince = budget?.store === undefined ? 0 : Date.now();
  /**
   * Why the ceiling can no longer be kept, or null while it can be.
   *
   * The fail-closed flag, and the asymmetry it encodes is deliberate: a
   * transcript that cannot be stored costs a conversation, and a budget that
   * cannot be stored costs whatever an agent in a loop spends between now and
   * somebody noticing. So a store that cannot be read, or that throws on a
   * write, stops the AGENT — every later call is refused `budget-spent` with
   * this sentence in the hint — and does not stop the app, which the person at
   * the keyboard goes on using exactly as before.
   *
   * A string rather than a boolean because the two causes need different
   * sentences. "I could not read your allowance" is usually a private window
   * and is nobody's bug; "I could not write it down" is usually a full quota
   * and is the one where somebody has to act.
   */
  let budgetBroken: string | null = null;

  /**
   * Whether this driver is keeping its allowance in a store at all.
   *
   * A `store` with no ceiling declared enforces nothing: an app that passed one
   * and set neither `calls` nor `commits` has asked for nothing to be enforced,
   * and refusing its calls because its storage is blocked would be a ceiling
   * invented out of a field that set none.
   */
  const budgetKept =
    budget?.store !== undefined &&
    (budget.calls !== undefined || budget.commits !== undefined || budget.asks !== undefined);

  /**
   * Pull the stored allowance into the counters, taking the HIGHER figure.
   *
   * **Called at mount and again before every charge, and the re-read is what
   * makes "one app, one ceiling" true rather than aspirational.** Two tabs open
   * at once each hold their own copy of the counters, so a mount-time read
   * alone gave each of them the whole allowance — two tabs, two ceilings, which
   * is the reload bypass wearing a different hat. A tab that charges has to
   * look at what the others have spent.
   *
   * **Higher wins, never lower.** `localStorage` has no compare-and-swap, so
   * two tabs charging in the same millisecond can lose one increment — an
   * off-by-one, bounded, and vastly better than an off-by-a-factor-of-tabs. But
   * a read that answered with a SMALLER figure, from a tab that was behind or a
   * record somebody edited, must never hand an allowance back; `Math.max` is
   * the whole of that guarantee.
   *
   * `Number.isInteger` and `Math.max(0, ...)` because this came off a store the
   * person sitting there can edit. Tampering is explicitly out of scope — see
   * `Budget.store`, it is a cost control and not a security boundary — but a
   * negative or fractional figure is the one input that would make the ceiling
   * comparison never fire at all, and that is worth one guard.
   */
  function syncSpend(): void {
    if (!budgetKept || budgetBroken !== null) return;
    const read = budget!.store!.load();
    if (!read.ok) {
      budgetBroken =
        "the stored record of this app's spend ceiling could not be read, so there is no way " +
        "to tell how much of the allowance is already spent. Rather than assume none of it is, " +
        "this driver refuses every call: an unreadable ceiling that let calls through would be " +
        "no ceiling at all. The app itself still works normally for the person at the keyboard.";
      return;
    }
    if (read.spent === null) return;
    const record = read.spent;
    // Two reasons to throw a record away, both host-held and neither reachable
    // by the agent. See `Budget.epoch` and `Budget.window`.
    if ((record.epoch ?? undefined) !== budget!.epoch) return;
    if (budget!.window !== undefined && Date.now() - record.since >= budget!.window) return;
    if (Number.isInteger(record.calls)) callsUsed = Math.max(callsUsed, record.calls);
    if (Number.isInteger(record.commits)) commitsUsed = Math.max(commitsUsed, record.commits);
    // Absent on a record written before questions were counted, which is read
    // as 0 rather than as a reason to throw the record away: see
    // `BudgetRecord.asks`. The other two numbers in it are still true, and
    // discarding an allowance because a field was added would hand every app
    // with a store a fresh ceiling on upgrade.
    if (Number.isInteger(record.asks)) asksUsed = Math.max(asksUsed, record.asks!);
    if (Number.isFinite(record.since)) budgetSince = record.since;
  }

  /**
   * Write the counters down, and fail closed if that cannot be done.
   *
   * Called after each increment rather than on an interval or at unload. The
   * event this exists for is a page that goes away without warning — a reload,
   * a crash, a `goto` — so any scheme that batches is a scheme that loses
   * exactly the calls it was built to remember.
   *
   * The throw is caught HERE and not left to the caller, because the call it is
   * about has already happened: the verb ran, the data moved, and failing the
   * `Result` now would tell an agent nothing happened when something did. What
   * a failed write changes is the FUTURE — from here on nothing is allowed,
   * because nothing more can be accounted for.
   */
  function rememberSpend(): void {
    if (!budgetKept || budgetBroken !== null) return;
    try {
      budget!.store!.save({
        calls: callsUsed,
        commits: commitsUsed,
        // Written whatever the app declared, like the two above, so that adding
        // `budget.asks` later does not have to treat every existing record as
        // having asked nothing since the epoch.
        asks: asksUsed,
        since: budgetSince,
        ...(budget!.epoch === undefined ? {} : { epoch: budget!.epoch }),
      });
    } catch {
      budgetBroken =
        "this app's spend ceiling could not be written down — storage is full, or blocked — so " +
        "from here on there is no way to carry the count across a page load. Rather than let " +
        "an uncounted call through, this driver refuses every later one. The app itself still " +
        "works normally for the person at the keyboard; somebody has to free up storage or " +
        "lift the ceiling.";
    }
  }

  // At mount, so `Driver.budget` reports the true figure to a panel before a
  // single call is made -- a settings view that said "0 of 200" on a page whose
  // allowance was half spent would be the panel lying about the one number it
  // is there to show.
  syncSpend();

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

    // THE ONE KIND AN APP MAY NOT DECLARE, and this throw is the structural
    // half of "a question is not consent".
    //
    // Every other kind is a claim about what the app's own code does, and the
    // app is the only thing that can make it. `ask` is a claim about a PERSON,
    // and the core is the only thing that can make it good: it owns the lock
    // that stops the agent acting while a question is open, the deadline that
    // keeps "nobody answered" a fact rather than the relay's unknown outcome,
    // the allowance, and the audit row. A verb wearing the kind with none of
    // those behind it would be a question nothing counted and nothing locked --
    // and the first thing anybody would build with it is a confirmation
    // dialog, whose yes would then be the one thing `MountOptions.approve`
    // exists to be asked for. So the kind is the core's and the hook is the
    // app's; see `MountOptions.ask`.
    //
    // Thrown rather than warned because it is a safety claim being made
    // falsely, which is the same grounds the misspelt `approve` policy throws
    // on. Additive, because no app can already be declaring it: it was not a
    // value of `VerbKind` until this feature, so nothing that compiles today
    // can hit this.
    if (verb.kind === ASK) {
      throw new Error(
        `driverkit: the verb \`${verb.name}\` declares \`kind: "ask"\`, which only the core ` +
          `may mint. A question has to be locked, deadlined, counted against ` +
          `\`budget.asks\` and recorded, and none of that can be true of a verb body — a ` +
          `verb wearing this kind would be a question nothing counted, and a "yes" to it ` +
          `would look like the approval \`approve\` exists to collect. Pass ` +
          `\`ask: ({ question }) => …\` to \`mount()\` and the core offers the \`ask\` verb ` +
          `itself; declare this verb with the kind it really has, or leave \`kind\` off.`,
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

  // ---- the one question the core implements ------------------------------
  //
  // Added exactly as `goto` is: after the app's own verbs so a collision can be
  // seen, before the manifest because it has to appear in it, and only when the
  // app supplied the one function the core cannot write. See `MountOptions.ask`.
  //
  // The whole of the mechanism's behaviour is in `decide()`, not in the `run`
  // below. That is not an accident of where it fitted: the lock, the deadline,
  // the allowance and the `waitedMs` the record needs are all things `call()`
  // owns and a verb body cannot see. What `run` is for is the dead placeholder
  // underneath -- see the comment on it.
  const askFn = options.ask;
  if (askFn !== undefined && typeof askFn !== "function") {
    // Thrown at mount for the reason a misspelt `approve` is: an app that
    // believes it can ask and cannot has a verb in everybody's cached prefix
    // that only ever refuses, and the author finds out from a model's
    // transcript rather than from a stack trace.
    throw new Error(
      `driverkit: \`ask\` must be a function; got ${JSON.stringify(askFn)}. It is handed ` +
        `\`{ question }\` and returns the person's words, \`{ answered: false }\` when nobody ` +
        `replied, or \`{ nobody: true }\` when there is nobody on this path.`,
    );
  }
  if (askFn !== undefined && verbs.has(ASK)) {
    // The app claimed the name, so the app keeps it -- the `goto` rule, and the
    // `rev`/`screen` argument rule one layer up: the app's meaning wins over
    // ours. Said once all the same, because an author with two ways to ask the
    // same person the same thing has one of them by accident.
    warn(
      "`ask` was declared and this app also declares its own verb named `ask`, so the " +
        "core's reserved one is not added and the `ask` hook is never called. The app's " +
        "verb wins; drop one of the two. Note that an app's own ask verb is gated, " +
        "counted and recorded as an ordinary verb and gets none of what the core's does: " +
        "no lock while the question is open, no deadline, no `budget.asks`.",
    );
  }
  /** Whether the core's own `ask` is the verb under that name, so `decide` can
   *  tell it from an app's verb that happens to be called the same thing. An
   *  identity check and not a name check, because the name is the thing an app
   *  is allowed to take. */
  let coreAsk: Verb<any> | undefined;
  if (askFn !== undefined && !verbs.has(ASK)) {
    coreAsk = {
      name: ASK,
      kind: ASK,
      describe: ASK_DESCRIBE,
      // No `refuses`. The three slugs this verb can come back with are all
      // reserved, and `refuses` may not name a reserved slug -- which is the
      // right answer rather than an awkward one: they say where the question
      // stopped and not what the app decided, so they belong in the reserved
      // list and are named in the description instead. The same shape as
      // `goto`, whose one core refusal is also described rather than declared.
      args: {
        [ASK_QUESTION_ARG]: {
          type: "string",
          describe:
            "what to ask, in your own words, as one short question. Put everything you " +
            "already know into it so the person can answer in a word.",
        },
      },
      /**
       * The dead placeholder, and it is load-bearing.
       *
       * Lifted straight from the pattern that works elsewhere: a tool whose
       * body returns a plain, honest "no response was recorded for this", so
       * that if the mechanism above it is ever skipped the model is told the
       * truth instead of reading an `ok` for a question nobody saw. `decide()`
       * answers every `ask` before `run` is reached, so **this should be
       * unreachable** — which is exactly why it has to say something a model
       * can act on rather than throw or return nothing.
       *
       * It refuses rather than reporting, because `ok — …` is the shape an
       * ANSWER has and a placeholder that borrowed it would be a fabricated
       * answer. `nobody-to-ask` is the honest slug: no question was put to
       * anybody.
       */
      run: (_args: Record<string, Scalar>, ctx: VerbContext) =>
        ctx.refuse(
          NOBODY_TO_ASK,
          "no question was put to anybody: this app offers the `ask` verb and the call did " +
            "not reach the person. Nothing in the app changed and no answer was recorded. " +
            "Do not treat this as a reply, and do not ask again — say what you needed to " +
            "know and what you could not decide without it.",
        ),
    };
    verbs.set(ASK, coreAsk);
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
    // `skipWhen` is in the sum because it is rendered into the same cached
    // prefix as the hint it was lifted out of. A flow that moved a sentence
    // from one field to the other must not be able to grow a budget by doing
    // it.
    const body = flow.steps
      .map((s) => `${s.section ?? ""}${s.verb}${s.hint}${s.skipWhen ?? ""}`)
      .join("");
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
      // An empty `skipWhen` is the one that has to be caught, because the field
      // being PRESENT is what makes a step optional: a step marked skippable
      // with no stated condition tells a model it may drop a step whenever it
      // likes, which is the opposite of what an author who typed the field
      // meant. The length and the newline are the `describe` rule, for the
      // `describe` reason -- it is a one-line condition rendered beside the
      // step, not a paragraph to reason from.
      if (step.skipWhen !== undefined) {
        if (typeof step.skipWhen !== "string" || step.skipWhen === "") {
          throw new Error(
            `driverkit: the step \`${step.verb}\` of the flow \`${flow.id}\` has an empty ` +
              `\`skipWhen\`. Present means this step may be skipped, so the field has to say ` +
              `WHEN — "the person already named the company". A skippable step with no ` +
              `condition is an invitation to drop it for no reason.`,
          );
        }
        if (step.skipWhen.length > SIZE_LIMITS.describe || /[\n\r]/.test(step.skipWhen)) {
          throw new Error(
            `driverkit: the \`skipWhen\` on the step \`${step.verb}\` of the flow ` +
              `\`${flow.id}\` must be one line of at most ${SIZE_LIMITS.describe} characters ` +
              `(got ${step.skipWhen.length}` +
              `${/[\n\r]/.test(step.skipWhen) ? ", with a line break" : ""}). ` +
              `See \`SIZE_LIMITS\`.`,
          );
        }
      }
    }

    // THE ONE PIECE OF DATA FLOW BETWEEN STEPS, CHECKED WHERE IT CAN BE SEEN.
    //
    // A `commit` that declares `consumes: "plan"` can only be called with the
    // token a `describe` returned beside its count. So a flow that reaches such
    // a step without an earlier `describe` step is a recipe whose only possible
    // ending is `stale-plan`: the agent follows it, arrives at the commit with
    // no token, and is refused -- after the navigation and before anything
    // moves, which is the same worst moment a step naming a missing verb is
    // found at, and the same reason this throws rather than waits.
    //
    // Statically visible and therefore the core's job: the step order is fixed,
    // the verbs' `kind` and `consumes` are declared, and nothing per-user is
    // involved. It is also the whole of what a flow can honestly say about
    // values crossing steps -- see the note under `FlowStep` for why there is
    // no `from: "step2.slug"` to go with it.
    //
    // It throws on `flows`, which is new, by the rule stated at the
    // `instructions` budget above: a new throw on an old field would break an
    // app that mounted yesterday, and a new one cannot have mounted yet.
    let minted: string | undefined;
    for (const step of flow.steps) {
      const verb = verbs.get(step.verb)!;
      if (verb.consumes === "plan" && minted === undefined) {
        throw new Error(
          `driverkit: the flow \`${flow.id}\` reaches \`${step.verb}\`, which consumes a ` +
            `plan, with no earlier \`describe\` step to mint one. A plan token comes from ` +
            `the \`describe\` verb that counted the selection, so an agent following this ` +
            `recipe arrives at the commit with nothing to pass and is refused ` +
            `\`stale-plan\`. Put the counting step in the flow.`,
        );
      }
      if (verb.kind === "describe") minted = step.verb;
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

  // ---- what another tab did ----------------------------------------------
  //
  // Six lines of state and a sentence, and the sentence is the point: see
  // `ElsewhereChannel` for the hole, and `MountOptions.elsewhere` for what this
  // does and does not buy.

  const channel: ElsewhereChannel | undefined = options.elsewhere;

  /** This driver's identity on the channel, so it can ignore its own notices.
   *  A `BroadcastChannel` does not echo to the sender, but a websocket relay
   *  fanning out to every subscriber does, and a channel that poisoned the tab
   *  that committed would refuse the second half of every two-step job. */
  const elsewhereId = `dke${(elsewhereSeq += 1)}.${Math.random().toString(36).slice(2)}`;

  /**
   * The notice this driver is sitting on, or null.
   *
   * `at` is the `rev` this app was showing when the notice arrived, and it is
   * the whole expiry rule: the notice is outstanding for exactly as long as
   * this app's own `rev` has not moved. One notice, not a list — a second
   * commit elsewhere while the first is still outstanding tells an agent
   * nothing new, and the repair is the same one.
   */
  let elsewhere: { verb: string; at: number } | null = null;

  /** Said to the model, in the snapshot's own `note`, for as long as the notice
   *  stands. The one sentence that turns a silent lie into a visible one. */
  const elsewhereNote = (verb: string): string =>
    `WARNING: another tab of this app committed \`${verb}\` after this screen was read, so ` +
    `the rows and the rev above may be out of date even though the rev has not moved. ` +
    `A commit here is refused as \`changed-elsewhere\` until this tab refreshes.`;

  /**
   * `visible()`, plus the notice if there is one.
   *
   * EVERY read goes through here -- `driver.snapshot()`, the snapshot on every
   * `Result`, the one an approval hook is handed, the one `connect()` pushes to
   * the relay -- because a warning that reached some of those and not others
   * would be a guarantee that holds on one path, which is the defect
   * `MountOptions.approve` was moved into the core to fix.
   *
   * Carried in `note`, which is already "anything else the agent needs and the
   * rows cannot carry", and which BOTH renderers already print. The
   * alternatives were a new field on `Snapshot` -- app-published, and this is
   * the core speaking, not the app -- or a second channel to the model that
   * only one of the two renderers knew about.
   *
   * The app's own `note` is kept and appended to, never replaced: the app may
   * be saying something the person needs and this is not more important than
   * that.
   *
   * The clear lives here rather than in a timer because this is the only place
   * the core learns what `rev` is now. An app that never reads is an app
   * nothing is being driven in.
   */
  function read(): Snapshot {
    const snap = options.visible();
    if (elsewhere === null) return snap;
    if (snap.rev !== elsewhere.at) {
      elsewhere = null;
      return snap;
    }
    const sentence = elsewhereNote(elsewhere.verb);
    return { ...snap, note: snap.note ? `${snap.note} ${sentence}` : sentence };
  }

  if (channel !== undefined) {
    const stop = channel.listen((notice: ElsewhereNotice) => {
      // Its own notice, or a malformed one. Dropped rather than warned about:
      // a channel shared with a future version of this library may carry
      // frames this one does not understand, and taking a driver out of service
      // over one is how a forward-compatible addition becomes an outage.
      if (!notice || typeof notice.verb !== "string" || notice.from === elsewhereId) return;
      if (!live) return;
      // `options.visible()` and not `read()`: this is where `at` is set, so
      // reading through the annotator would be asking what the note says in
      // order to decide what the note says.
      let now: number;
      try {
        now = options.visible().rev;
      } catch {
        // `visible()` threw outside a call, which is an app bug the core
        // cannot report to anybody here. The notice is kept against a rev
        // nothing can equal, so it stands until a successful read clears it --
        // the safe direction.
        now = Number.NaN;
      }
      elsewhere = { verb: notice.verb, at: now };
    });
    if (typeof stop === "function") unlisten = stop;
  }

  /**
   * Tell the other tabs a commit landed here.
   *
   * POSTED AFTER `run`, and only for a `commit`, and not when the verb refused.
   * Each of those three is a decision:
   *
   *  - after rather than before, because a notice sent first is a claim about a
   *    change that has not happened yet, and the sibling tab would clear it on
   *    its next `rev` move -- possibly before the write landed;
   *  - `commit` only, because `read` and `describe` promise no data moves and
   *    announcing them would refuse every commit in every other tab for every
   *    read anybody did, which is a warning on everything;
   *  - not on an app refusal, because the app saying no means nothing moved.
   *    A verb that THREW does get announced: it may have changed half a
   *    selection, which is the same reason the plan token is burned on
   *    entering `run` rather than on returning from it.
   */
  function announce(name: string): void {
    if (channel === undefined) return;
    try {
      channel.post({ verb: name, from: elsewhereId });
    } catch (err) {
      // A commit that already happened is not turned into a failure because
      // the announcement could not go out. Said once, in the app author's
      // console, because a channel that never delivers makes the whole check
      // silently absent -- which is the one thing this feature must not be.
      warn(
        `the \`elsewhere\` channel threw while announcing \`${name}\` ` +
          `(${err instanceof Error ? err.message : String(err)}), so other tabs of this app ` +
          `were not told. The commit itself ran.`,
      );
    }
  }


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
    /** The `rev` the count was taken at. Named back in a refusal, and now ONLY
     *  that: the expiry rule is `plansGoodAt`, which starts here and may be
     *  carried forward over a read-only move. A carried plan still reports the
     *  rev it was taken at, because that is the call the agent made and the
     *  one it would have to make again. */
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
  /** The `rev` every record in `plans` was minted at, which is what keeps the
   *  map to one rev's worth: it is cleared the moment a newer one mints. Not
   *  the expiry check -- that is `plansGoodAt` -- so this stays the honest
   *  answer to "when was this counted" and goes on bounding the memory. */
  let plansAt = -1;
  /**
   * The `rev` the outstanding plans are still good AT, which starts equal to
   * `plansAt` and is the only thing `checkPlan` compares against.
   *
   * THE DEFECT THIS SPLITS IN TWO. `Snapshot.rev` means "the snapshot
   * changed", and a read-only navigation genuinely changes the snapshot: the
   * person is looking at a different screen. So one number was answering two
   * questions. `stale` asks "is what you were looking at still what is on
   * screen?" -- and navigation really does invalidate that, which is why the
   * `stale` check still compares the raw `rev` and is untouched here. A plan
   * token asks "is the selection you counted still the selection?" -- and
   * navigation does not touch that at all. Conflating them priced the
   * double-check above the blind commit: `select-where` then `goto` then
   * `accept-selected` was refused `stale-plan` although nothing about the
   * selection had moved, so the cheap path was to commit without re-reading.
   * The whole mechanism exists to make an agent read the number before it
   * moves 3,412 rows, and teaching it that looking first costs two extra calls
   * teaches exactly the wrong habit.
   *
   * WHAT CARRIES IT FORWARD, and every clause is a safety condition rather
   * than a convenience; see the carry in `call()`. A verb that DECLARED
   * `kind: "read"` -- the kind whose own documentation says "changes no data
   * and reports no count. It may still move what the person is looking at:
   * navigation is a read" -- that moved `rev`, while the app publishes a
   * `Snapshot.selectionId` and that string is unchanged across the call.
   *
   * WHAT DOES NOT. An app that publishes no `selectionId` carries nothing and
   * behaves exactly as it did before this existed: its token still dies on the
   * first `rev` move of any kind. That is the fail-safe direction and it is the
   * reason this was done with `selectionId` rather than with a second counter
   * an author has to remember to bump -- an author who forgot the counter would
   * get a token that never expires, which is the 3,412-row bug. A `commit`
   * carries nothing, since a commit is the thing a plan is a receipt against. A
   * verb with no declared `kind` carries nothing, because an absent `kind`
   * makes no safety claim in either direction. And a `rev` that moved with no
   * verb behind it at all -- a websocket landing between two calls -- carries
   * nothing, because the plan was already dead by the time the next verb
   * started: the carry requires that the plans were still good at the rev the
   * read STARTED from.
   */
  let plansGoodAt = -1;
  /**
   * The `Snapshot.selectionId` the outstanding plans were minted against, or
   * undefined in an app that publishes none.
   *
   * Driver-level rather than per-plan because every outstanding plan shares it:
   * `mint` clears the map whenever `rev` moves, so the map only ever holds
   * plans taken at one rev, and one rev is one selection. It is kept separately
   * from the plans all the same, so the carry can be decided when the map is
   * empty and without picking an arbitrary entry out of it.
   */
  let plansSelection: string | undefined;
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
    // Reset on every mint, carried plans included. A fresh describe is a fresh
    // count, so whatever a previous plan had been carried to is irrelevant from
    // here; and the clear above means a carried plan from an older rev is
    // retired by this mint exactly as it was before the carry existed.
    plansGoodAt = after.rev;
    plansSelection = after.selectionId;
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

    // `plansGoodAt` and not `plan.rev`, which is the whole of the fix. The two
    // are the same number until a read-only move carries them apart, and they
    // are compared here rather than in `call()` so that the one refusal still
    // names the rev the count was actually taken at.
    if (plansGoodAt !== before.rev) {
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
    ask: ApprovalHook,
    name: string,
    args: Record<string, Scalar>,
    before: Snapshot,
    trail: Trail,
  ): Promise<Result | null> {
    const req: ApprovalRequest = { name, args, verb: entries.get(name)!, snapshot: before };
    const was = pending;
    pending = { verb: name, question: false };
    // The one wait in this file that is a PERSON rather than the app, and
    // therefore the one worth timing separately. Read only when a record is
    // going to be built -- an app with no `onAudit` reads no clock here, the
    // same promise `call` already makes.
    const askedAt = onAudit === undefined ? 0 : Date.now();
    let decision: Approval;
    try {
      decision = await deadline<Approval>(ask(req), { timedOut: true }, options.approvalTimeout);
    } catch (err) {
      decision = `the approval could not be asked for (${
        err instanceof Error ? err.message : String(err)
      }), and a failed ask is a no, never a yes`;
    } finally {
      pending = was;
      // In the `finally`, so EVERY exit is timed: a yes, a no, a deadline, and
      // a hook that threw. A person who spent two minutes and then declined is
      // exactly as interesting to an auditor as one who spent two minutes and
      // approved, and a figure recorded only on the happy path is one that
      // vanishes from the records somebody is most likely to be reading.
      if (onAudit !== undefined) trail.waitedMs = Math.max(0, Date.now() - askedAt);
    }

    // The answer, written down as one of four words before it is turned into a
    // refusal. Four and not three because `declined` and `not-asked` are the
    // two an audit reader must never confuse -- one is a person refusing, the
    // other is a gate that was not there -- and a hook that THREW is recorded
    // as `declined`, deliberately, because that is the decision the core made
    // from it: a failed ask is a no.
    if (decision === undefined || decision === true) {
      trail.approval = "allowed";
      return null;
    }
    // Read through one probe rather than narrowed member by member, because
    // the two object answers have no field in common and the next one will not
    // either: a gate answers in the shapes it needs, and the core's job is to
    // recognise them without caring what else is on the object.
    const shape =
      typeof decision === "object" && decision !== null
        ? (decision as { timedOut?: unknown; asked?: unknown; hint?: unknown })
        : undefined;
    // Allowed the call, and nobody was asked. The ONE answer that allows
    // without claiming consent, and it is here so the panel's dialog can let a
    // small reversible commit past -- or let everything past when the person
    // has switched confirmations off -- without the record saying a person
    // said yes. `trail.approval` stays `not-asked`, which it already is, and
    // `policy` says there was a gate that chose not to ask. See `Approval`.
    if (shape?.asked === false) {
      // Nobody was asked, so there was no wait -- and `waitedMs` promises that
      // its absence means no question was open. The gate returned in no time
      // at all, which is indistinguishable from an instant answer by the
      // clock; `asked: false` is the one thing that tells them apart, so it is
      // what the field is cleared on.
      delete trail.waitedMs;
      return null;
    }
    trail.approval = shape?.timedOut === true ? "timed-out" : "declined";
    if (decision === false) return no(DECLINED, DECLINED_HINT, read());
    if (typeof decision === "string") return no(DECLINED, decision, read());
    if (shape?.timedOut === true) {
      return no(
        APPROVAL_TIMEOUT,
        (typeof shape.hint === "string" ? shape.hint : undefined) ??
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
        `approval. Treated as a refusal. Return true, false, a reason, ` +
        `{ timedOut: true }, or { asked: false }.`,
    );
    return no(
      DECLINED,
      "the app's approval hook answered with something that is not a decision, so this was " +
        "not allowed. That is a bug in the app rather than in your call.",
      read(),
    );
  }

  /**
   * Put the agent's question to the person, and answer the agent honestly.
   *
   * THE FIVE THINGS THIS OWNS, none of which a verb body could:
   *
   *  1. **The lock.** `pending` is held for as long as the question is open, so
   *     every other call on this driver -- from this agent or another one over
   *     the relay -- is refused `approval-pending`. An agent that could carry
   *     on acting while somebody is mid-decision is an agent acting on a screen
   *     the person is about to change, and over the relay it is two agents, one
   *     of which asked.
   *  2. **The deadline.** `MountOptions.askTimeout`, defaulting to 45 seconds,
   *     which is under the relay's 60. That is what keeps "nobody answered" a
   *     FACT rather than the relay's `timeout`, which means outcome unknown.
   *  3. **The allowance.** `budget.asks`, checked before the question is put
   *     and charged only when it actually reached somebody.
   *  4. **The record.** `trail.waitedMs`, written on every exit, which is the
   *     field that tells an auditor a question was genuinely put and for how
   *     long it stood. See `AuditEvent`.
   *  5. **Keeping nothing.** The answer is turned into this call's `Result` and
   *     is not stored anywhere. That is the whole of "a question is not
   *     consent": there is no remembered yes for a later commit to consult, so
   *     the separation is structural rather than a policy somebody could
   *     relax. `ApprovalRequest` has no field that could carry one.
   *
   * It is called from `decide` rather than from `run` because four of those
   * five are things `call()` owns, and because the fifth is only true if the
   * answer never leaves this function.
   */
  async function putQuestion(
    args: Record<string, Scalar>,
    before: Snapshot,
    trail: Trail,
  ): Promise<Result> {
    const question = String(args[ASK_QUESTION_ARG] ?? "").trim();
    // An empty question after trimming. `checkArg` has already refused a
    // missing or non-string one, so what is left is whitespace -- which would
    // put a blank box in front of somebody and is the one argument error worth
    // catching here rather than passing on.
    if (question === "") {
      return no(
        "bad-argument",
        `\`${ASK_QUESTION_ARG}\` is blank. Ask something: the person sees this text and ` +
          `nothing else, so a blank question is a box they cannot answer.`,
        before,
      );
    }
    // Bounded, and refused rather than truncated. `SIZE_LIMITS.describe` is the
    // library's one-line budget and a question is a one-line thing; truncating
    // would put half a question in front of somebody, which reads as the whole
    // of a different question. An agent that needs a paragraph has not worked
    // out what it does not know.
    if (question.length > SIZE_LIMITS.describe) {
      return no(
        "bad-argument",
        `that question is ${question.length} characters and the limit is ` +
          `${SIZE_LIMITS.describe}. Ask the narrowest question that unblocks you, in one ` +
          `line: a wall of text in front of somebody is a question they will dismiss. Say ` +
          `the rest in your final answer.`,
        before,
      );
    }

    // The allowance, BEFORE the question is put and before the lock is taken.
    // The order matters for the same reason the commit ceiling sits one line
    // above the approval gate: nobody is interrupted for a call that was
    // already going to be refused.
    if (budget?.asks !== undefined && asksUsed >= budget.asks) {
      return no(
        ASKS_SPENT,
        `this app allows ${budget.asks} question${budget.asks === 1 ? "" : "s"} per mounted ` +
          `session and all ${budget.asks} have been asked, so this one was not put to ` +
          `anybody. It does not refill, and no further question will reach them. **The rest ` +
          `of the app still works**: this is a ceiling on the person's attention, not on ` +
          `your calls. Carry on with what you can decide, and in your final answer say ` +
          `exactly what you would have asked and what you could not settle without it.`,
        before,
      );
    }

    const was = pending;
    pending = { verb: ASK, question: true };
    // Read only when a record is going to be built, the promise `call` and
    // `askApproval` both already make: an app with no `onAudit` reads no clock.
    const askedAt = onAudit === undefined ? 0 : Date.now();
    let answer: AskAnswer;
    try {
      answer = await askDeadline(askFn!({ question }), options.askTimeout);
    } catch (err) {
      // A question UI that throws must not take the app down, and must not be
      // read as an answer. The precedent is `ApprovalHook`, where a failed ask
      // is a no; here a failed ask is an UNANSWERED question and emphatically
      // not `nobody-to-ask` -- a broken panel is not evidence that nobody is
      // sitting there, and saying it is would tell an agent to stop asking for
      // the rest of the run over one exception. The message is folded in
      // because the author reading the transcript is the one who can fix it.
      answer = { answered: false };
      warn(
        `the \`ask\` hook threw, so the question was treated as unanswered: ` +
          `${err instanceof Error ? err.message : String(err)}. A failed ask is an ` +
          `unanswered question, never an answer and never a claim that nobody is there.`,
      );
    } finally {
      pending = was;
      // In the `finally`, so EVERY exit is timed -- an answer, a silence, a
      // deadline, a hook that threw. A question somebody read for two minutes
      // and then ignored is exactly as interesting to an auditor as one they
      // answered, and a figure recorded only on the happy path vanishes from
      // the records somebody is most likely to be reading. The one exit that
      // deliberately does NOT get a figure is `{ nobody: true }`, below: see
      // `AuditEvent`, where the presence of `waitedMs` is what says a question
      // reached somebody.
      if (onAudit !== undefined) trail.waitedMs = Math.max(0, Date.now() - askedAt);
    }

    const shape =
      typeof answer === "object" && answer !== null
        ? (answer as { answered?: unknown; nobody?: unknown })
        : undefined;

    // Nobody is there. The question was never put, so nothing is charged and
    // the record carries no wait: both of those are the honest reading, and
    // both are what tell this apart from a question that stood in front of
    // somebody for 45 seconds.
    if (shape?.nobody === true) {
      delete trail.waitedMs;
      return no(
        NOBODY_TO_ASK,
        "there is nobody to ask on this run: this app is being driven with no person in " +
          "front of it. The question was not put to anybody, nothing in the app changed, " +
          "and no later question will reach them either — so stop asking. Decide from what " +
          "you already know if you honestly can, and if you cannot, say what you needed to " +
          "know and what you could not settle without it.",
        before,
      );
    }

    // Charged here and nowhere else: the question reached somebody, whether or
    // not they answered. A question that sat in front of a person and was
    // ignored has spent their attention as surely as one they replied to, and a
    // counter that only counted replies would never fire on the agent that
    // interrupts somebody who has stopped reading it.
    asksUsed++;
    rememberSpend();

    if (typeof answer === "string" && answer.trim() !== "") {
      // THE ANSWER IS THE RESULT, which is the one structural thing about this
      // feature worth saying twice. It rides in `Report.note`, so it renders
      // through `ok — …` exactly as every other verb's note does and no
      // renderer in either language needed a line for it. A side channel --
      // another field on `Result`, a block in the snapshot -- would have been a
      // second place a model has to learn to look, and would have put a
      // person's words somewhere this core could keep them.
      //
      // Attributed, because `ok — yes, the one at Acme` is indistinguishable
      // from the app reporting something. The quotes and the words "the person
      // answered" are the core saying whose sentence this is, and they are the
      // core's words rather than the app's for the reason `ASK_DESCRIBE` is
      // here: a sentence written twice in two languages is a sentence that
      // drifts.
      //
      // The answer itself is passed through verbatim and never parsed. Nothing
      // in here looks for "yes": a core that classified an answer would be one
      // step from a core that acted on the classification, which is the
      // approval bypass this whole design is shaped against.
      const said = answer.trim();
      return {
        ok: true,
        note: `the person answered: "${said}"`,
        snapshot: read(),
      };
    }

    // Everything else is an unanswered question, including an answer shape this
    // core does not recognise and an empty string. The same rule `Approval`
    // applies to an unknown shape, pointed the other way: there the safe
    // reading of a shape nobody recognises is a DENIAL, and here it is that
    // nobody spoke. Reading it as an answer would put words in a person's mouth
    // and let a model act on them, which is strictly the worse of the two
    // mistakes.
    if (shape?.answered !== false) {
      warn(
        `the \`ask\` hook answered with ${JSON.stringify(answer)}, which is not an answer. ` +
          `Treated as unanswered. Return the person's words as a string, ` +
          `{ answered: false }, or { nobody: true }.`,
      );
    }
    return no(
      ASK_UNANSWERED,
      "the question was put to the person and no answer came back — they closed it, walked " +
        "away, or it stood too long. **Nothing in the app changed and the verb did not " +
        "run**; this is not the transport `timeout`, where nobody knows what happened. Do " +
        "not invent an answer and do not act on what you were going to ask about. You may " +
        "ask once more, shorter, if it is genuinely the one thing in the way; otherwise say " +
        "what you needed to know and stop.",
      before,
    );
  }

  /**
   * What `decide` writes down as it goes, for the record `call` emits after.
   *
   * It exists because of one rule: the record must not be a second source of
   * truth about what happened. Most of an `AuditEvent` is read straight off the
   * `Result` that is about to be returned, so it cannot disagree with it — but
   * four facts are decided inside `decide` and are gone by the time it returns.
   * The `rev` and `screen` the call RAN AGAINST, which on a successful commit
   * are not the ones in the result's snapshot; the approval answer, which the
   * gate alone knows; and the two plan tokens. Each is written down by the step
   * that decides it, which is the alternative to re-deriving it afterwards from
   * a second reading of the app.
   */
  interface Trail {
    rev?: number;
    screen?: string;
    approval: AuditEvent["approval"];
    plan?: string;
    minted?: string;
    /** Milliseconds a question was open, when one was. Written by
     *  `askApproval`, which is the one place in here that waits on a person, so
     *  the record cannot disagree with it. See `AuditEvent.waitedMs`. */
    waitedMs?: number;
  }

  /**
   * Hand one record to the app's hook, and survive the hook.
   *
   * NOT AWAITED, and not deadlined. See `MountOptions.onAudit`: an approval is
   * asked before the decision and its answer IS the decision, so it has to be
   * waited for; a record is emitted after the outcome is settled and, for a
   * commit, after the data has moved, so waiting on the sink can only delay the
   * agent and failing the call would make a broken logging backend into a
   * broken app. A thrown error — synchronous or from the promise — is reported
   * once rather than swallowed, because a record that vanished in silence is
   * the one failure an audit trail cannot survive.
   */
  function record(
    name: string,
    args: Record<string, Scalar>,
    opts: CallOptions,
    trail: Trail,
    result: Result,
    started: number,
  ): void {
    // The DECLARED facts, from the manifest entry, exactly as the approval hook
    // is handed them: a record of what the app claimed about this verb, and no
    // reach into `run`.
    const entry = entries.get(name);
    const shown: Record<string, Scalar> = {};
    const redacted: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      // Declared `sensitive`, so the value is replaced HERE -- before the hook,
      // which is the boundary a record is most likely to leave the box
      // across -- and the field is named, so `"[redacted]"` can never be read
      // as a string the agent actually sent. See `ArgSpec.sensitive`.
      if (entry?.args?.[key]?.sensitive === true) {
        shown[key] = REDACTED;
        redacted.push(key);
      } else {
        shown[key] = value;
      }
    }

    const at = Date.now();
    const event: AuditEvent = {
      at,
      ms: at - started,
      // Approval-inclusive `ms`, and the human share of it beside rather than
      // taken out of it. See `AuditEvent.waitedMs`: "41 seconds, 38 of them
      // waiting" answers both questions an auditor has and the sum alone
      // answers neither.
      ...(trail.waitedMs === undefined ? {} : { waitedMs: trail.waitedMs }),
      app: options.app,
      verb: name,
      args: shown,
      // The rev the call ran against, falling back to the one in the result's
      // own snapshot for the three refusals that answer before `visible()` is
      // read for comparison -- unmounted, approval-pending, unknown-verb. For
      // those the two are the same read, so this is not a guess.
      rev: trail.rev ?? result.snapshot.rev,
      ok: result.ok,
      approval: trail.approval,
      // Read now, not captured at mount: a page that acquires a gate halfway
      // through its life has records on both sides of that, and both are true.
      policy: policyNow(),
    };
    const screen = trail.screen ?? result.snapshot.screen;
    if (screen !== undefined) event.screen = screen;
    if (entry?.kind !== undefined) event.kind = entry.kind;
    if (entry?.reversible !== undefined) event.reversible = entry.reversible;
    if (redacted.length > 0) event.redacted = redacted;
    if (opts.rev !== undefined || opts.screen !== undefined) {
      event.claimed = {
        ...(opts.rev === undefined ? {} : { rev: opts.rev }),
        ...(opts.screen === undefined ? {} : { screen: opts.screen }),
      };
    }
    if (result.ok) {
      if (result.count !== undefined) event.count = result.count;
    } else {
      event.refused = result.refused;
    }
    if (trail.plan !== undefined) event.plan = trail.plan;
    if (trail.minted !== undefined) event.minted = trail.minted;

    try {
      const answered = onAudit!(event);
      if (answered !== undefined && typeof (answered as Promise<void>).then === "function") {
        void (answered as Promise<void>).catch((err: unknown) => audited(name, err));
      }
    } catch (err) {
      audited(name, err);
    }
  }

  /** Said out loud, once per distinct message, when a record did not get out. */
  function audited(name: string, err: unknown): void {
    warn(
      `the \`onAudit\` hook threw on \`${name}\`, so that call's audit record was lost: ` +
        `${err instanceof Error ? err.message : String(err)}. The call itself was unaffected — ` +
        `a record is emitted after the outcome is decided, so there is nothing left to refuse — ` +
        `but a record that vanishes in silence is the one failure an audit trail cannot survive.`,
    );
  }

  /**
   * `decide`, and then the record of what it decided.
   *
   * The split is what makes the record impossible to disagree with the
   * `Result`: there is one `Result` object, `decide` produced it at whichever
   * of its dozen exits applied, and the event is built from THAT object rather
   * than from a second look at the app. A per-exit emit would have been a dozen
   * places to forget one.
   *
   * With no hook this is the function it was before audit existed, plus one
   * object literal and one comparison: no clock is read and no record is built.
   */
  async function call(
    name: string,
    args: Record<string, Scalar> = {},
    opts: CallOptions = {},
  ): Promise<Result> {
    const trail: Trail = { approval: "not-asked" };
    const started = onAudit === undefined ? 0 : Date.now();
    const result = await decide(name, args, opts, trail);
    if (onAudit !== undefined) record(name, args, opts, trail, result, started);
    return result;
  }

  async function decide(
    name: string,
    args: Record<string, Scalar>,
    opts: CallOptions,
    trail: Trail,
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
      // One slug for both kinds of open question, and a different sentence.
      //
      // The slug is `approval-pending` either way because to the AGENT the two
      // are the same fact and call for the same move: nothing ran, somebody is
      // being asked something, wait. A second slug would be a second word for
      // one repair, which is what `RESERVED_REFUSALS` keeps refusing to add.
      //
      // The hint differs because the two are not the same thing to the PERSON
      // reading a transcript, and because the hazard the approval wording
      // exists for -- an agent pressing the Approve button of the dialog that
      // is asking it -- is not what a question is about. An agent told
      // "`accept-selected` is waiting to be approved" while what is actually
      // on screen is "which Ada Duarte did you mean?" has been told something
      // false about its own app.
      return no(
        APPROVAL_PENDING,
        pending.question
          ? `this app has put a question of yours to the person and is waiting for their ` +
            `answer, so it is not taking calls. Nothing ran. Wait for the answer: it comes ` +
            `back as the result of the \`${ASK}\` call you already made, and asking again ` +
            `will not reach them any sooner.`
          : `\`${pending.verb}\` is waiting to be approved, so ${PENDING_HINT}`,
        read(),
      );
    }

    // AFTER the approval lock and BEFORE the verb lookup, and both halves of
    // that position are decisions.
    //
    // After the lock, because a call refused `approval-pending` reached nothing
    // and must not be charged for: a confused agent polling while a person
    // reads a dialog would otherwise eat the whole ceiling without a single
    // verb running, and the ceiling is for spend, not for impatience.
    //
    // Before the lookup, because a spent budget is the widest true thing there
    // is to say about this call. Every other check in here answers "this
    // particular call is wrong, here is the repair"; this one answers "nothing
    // will work again, and no repair exists at this end". Answering
    // `unknown-verb` to a call made past the ceiling would send an agent off to
    // find a verb name that was never the problem — which is the same ordering
    // argument `wrong-screen` is above `stale` for, taken one step further out.
    //
    // Charged for whatever happens next, refusals included. See `Budget`: an
    // agent looping on `bad-argument` is the runaway this field exists for, and
    // a counter that only counted successful calls would watch it spin.
    // Before the counter comparison, because when the ceiling cannot be
    // accounted for there is no counter worth comparing. Same slug as a spent
    // ceiling on purpose: to the agent the two are the same fact — nothing more
    // will run here and no repair exists at this end — and `drive` already
    // treats `budget-spent` as an ending rather than as a mistake to retry.
    // The hint is what differs, and it is the hint a human reads.
    // What the other tabs have spent, before this tab decides it has room. See
    // `syncSpend`: without this, two tabs open at once are two ceilings.
    syncSpend();
    if (budgetBroken !== null) {
      return no(BUDGET_SPENT, budgetBroken, read());
    }

    if (budget?.calls !== undefined && callsUsed >= budget.calls) {
      return no(
        BUDGET_SPENT,
        `this app allows ${budget.calls} verb call${budget.calls === 1 ? "" : "s"} per mounted ` +
          `session and all ${budget.calls} are spent, so \`${name}\` was not run. This is a ` +
          `ceiling the app set, not a rate limit: it does not refill, and waiting or retrying ` +
          `will not change it. Stop, and say what you had got through and what is left — ` +
          `somebody has to decide whether to raise it.`,
        read(),
      );
    }
    callsUsed++;
    rememberSpend();

    const verb = verbs.get(name);
    if (!verb) {
      // The known names are listed. An outside agent may be holding a manifest
      // from a previous version of the app, and the list is how it finds out
      // what moved without a second round trip.
      const known = [...verbs.keys()].sort().join(", ");
      return no("unknown-verb", `no verb named \`${name}\`. known: ${known}`, read());
    }

    const before = read();
    // Written down HERE, at the one read every check below compares against, so
    // the record says what the call ran against and not what the screen looked
    // like afterwards. On a successful bulk commit those are different revs,
    // and the one worth keeping is this one: it is the rev the count was taken
    // at and the rev a person approved.
    trail.rev = before.rev;
    if (before.screen !== undefined) trail.screen = before.screen;
    // Read HERE and kept, because the carry below needs it and the `read()`
    // that produces `after` is where a lapsed notice is cleared. A read-only
    // move clears the notice as a side effect -- a known weakness of `rev`,
    // documented on `MountOptions.elsewhere` -- so asking afterwards would
    // always answer no, and a plan would be carried across a navigation in a
    // tab the core had just been told was behind. See the carry.
    const behind = elsewhere !== null;

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

    // WHAT ANOTHER TAB DID comes after WHICH SCREEN and above every staleness
    // check, including `stale-plan`, and the ladder's own rule is why.
    //
    // The ladder is widest first, because the widest answer's repair subsumes
    // the narrower ones'. This is the widest staleness there is: `stale` says
    // the rev moved, `stale-plan` says the selection moved, and both are
    // repaired by reading this tab again -- which is exactly the repair that
    // DOES NOT WORK here, because what moved is the data behind a tab whose
    // `rev` is unchanged. Answering `stale` or `stale-plan` first would hand an
    // agent a repair that appears to succeed and leaves it believing it is
    // current: it reads again, gets the same rev, and commits. That is the
    // silent failure this check exists to end, so it has to be answered before
    // either of them.
    //
    // ONLY A `commit`, and that is the one real judgement in here. A `read` or
    // a `describe` in a tab that is behind still returns the rows the person is
    // actually looking at, and its snapshot now says in words that they may be
    // behind -- see `read()`. Refusing those as well would make a tab whose app
    // does not refetch completely undrivable, and would do it by sending an
    // agent round a loop: refused, read again, same rev, refused. A commit is
    // the one call whose cost is not paid back by reading again, which is the
    // same line `MountOptions.approve` draws for the same reason.
    //
    // WHATEVER `rev` THE AGENT CLAIMED, including none. `rev` and `screen` are
    // checks an agent opts out of by making no claim, because an agent that
    // claims nothing has at least not claimed something false. This is not of
    // that kind: it is not a claim being checked, it is the core knowing the
    // data moved. `consumes: "plan"` already makes the same exception for the
    // same reason -- a guarantee a caller can decline is not a guarantee.
    // `before` was produced by `read()` above, which is where a notice whose rev
    // has moved on is cleared. So a non-null `elsewhere` here has already been
    // checked against the live rev, and calling `read()` again in this
    // condition would be asking the question that answers itself -- and would
    // null the field between the two halves of the `&&`.
    if (verb.kind === "commit" && elsewhere !== null) {
      return no(
        CHANGED_ELSEWHERE,
        `another tab of this app committed \`${elsewhere.verb}\` after this screen was read. ` +
          `This tab is at rev ${elsewhere.at} and has not moved, so its rows -- and any count ` +
          `taken from them -- may describe data that has already changed. Reading this screen ` +
          `again will NOT fix that: the rev will be the same and it will still be behind. ` +
          `Say what happened and let the person refresh the page or switch to the tab that ` +
          `made the change; do not retry this commit here.`,
        before,
      );
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
    // rather than below. The two overlap on everything that moves the
    // selection -- and where they do, the repairs are not the same size.
    //
    // They are no longer nested the way this comment once claimed. A read-only
    // move is `stale` and is NOT `stale-plan`: the screen the agent echoed is
    // not the screen on display, and the selection it counted is still the
    // selection, so the narrower answer is the true one and it is the one that
    // comes back. See `plansGoodAt`. The ordering is unchanged, because where
    // both apply the plan is still the wider mistake. `stale` says "read
    // again", and an
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
      // Recorded BEFORE the check and whatever the check says. A token that was
      // refused is the interesting one: it is how an audit reader finds the
      // agent that tried to spend a receipt for a count that had moved.
      if (opts.plan !== undefined && opts.plan !== "") trail.plan = opts.plan;
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

    // THE QUESTION, and it is answered here rather than by `verb.run` below.
    //
    // After the argument check, so a question with no text is `bad-argument`
    // like every other malformed call. Before the commit ceiling and the
    // approval gate, which cannot apply: an `ask` is not a `commit`, and that
    // is the first of the several reasons an answer cannot be consent.
    //
    // `verb === coreAsk` is an IDENTITY check and not a name check, because the
    // name is the one thing an app is allowed to take -- an app with its own
    // verb called `ask` falls straight through to `run` and is an ordinary
    // verb, which is what the warning at mount says out loud.
    if (coreAsk !== undefined && verb === coreAsk) {
      return await putQuestion(args, before, trail);
    }

    // LAST of the checks and immediately before `run`, which is the only place
    // it can go. Asking a person about a call that is about to be refused for
    // a stale rev, a wrong screen or a missing argument is asking them to
    // approve something that was never going to happen — and the second time
    // that happens they stop reading the question.
    //
    // The commit ceiling is checked HERE, one line above the gate, and the
    // order is the gate's own argument reused: nobody is asked to approve a
    // commit that was already going to be refused. It is also the last check
    // before `run`, which is where a bound on data moved belongs — a commit
    // refused for a stale plan did not move anything and must not be charged
    // for one.
    if (verb.kind === "commit" && budget?.commits !== undefined && commitsUsed >= budget.commits) {
      return no(
        BUDGET_SPENT,
        `this app allows ${budget.commits} commit${budget.commits === 1 ? "" : "s"} per mounted ` +
          `session and all ${budget.commits} have run, so \`${name}\` was not run and no data ` +
          `moved. Reads and describes may still work; it is commits that are spent. This ` +
          `ceiling does not refill — stop, and say which commits went through.`,
        before,
      );
    }

    // The app's own hook if it declared one, otherwise whatever the page
    // installed through `adopt`, otherwise nothing. Read HERE and not at
    // mount, because a panel can be mounted after the driver is and the
    // commits that arrive after it must go through it -- that is the whole of
    // what adoption buys, and a captured `const` would have made the first
    // page load the only one that counted.
    const approver = approveFn ?? adopted;
    if (verb.kind === "commit" && approver !== undefined) {
      const refused = await askApproval(approver, name, args, before, trail);
      if (refused) return refused;
    }

    // Charged on ENTERING `run`, beside the plan token and for the same reason:
    // a commit that changes half a selection and then throws has moved data,
    // and a counter that only counted clean returns would not know it.
    if (verb.kind === "commit") {
      commitsUsed++;
      rememberSpend();
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
      // Announced, because a commit that threw may have moved half a selection
      // -- the same reason the plan token is burned on entering `run`. The
      // other tabs are told something changed and the agent is told the call
      // failed, and both of those are true at once.
      if (verb.kind === "commit") announce(name);
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
    // Before `read()`, so the snapshot this call returns is the one the OTHER
    // tabs are being warned about -- and after the refusal branches above, so
    // an app that said no has announced nothing. A driver ignores its own
    // notice, so this does not annotate the result below.
    if (verb.kind === "commit") announce(name);

    const after = read();

    // THE CARRY. A read-only move does not spend a plan.
    //
    // `Snapshot.rev` answers two questions and only one of them is the plan's;
    // see `plansGoodAt` for the argument and for why this is gated on
    // `selectionId` rather than on a second counter. What is left here is the
    // list of conditions, each of which is the safe direction of one choice:
    //
    //  - `usesPlans` and a non-empty map: nothing to carry otherwise, and an
    //    app with no consuming verb must not grow a line of behaviour it never
    //    asked for.
    //  - `kind === "read"`, read from the DECLARATION. `describe` is excluded
    //    because it is the kind that changes what is selected -- and one that
    //    counted has just minted a fresh plan anyway, which retires this one.
    //    `commit` is excluded because it is the thing a plan is a receipt
    //    against. An absent `kind` is excluded because it makes no claim.
    //  - `before.rev === plansGoodAt`: the plans were still good when this
    //    verb STARTED. A `rev` that had already moved for some other reason --
    //    a websocket between two calls -- has already killed them, and a read
    //    must not resurrect a plan by walking past the rev that buried it.
    //  - `after.rev !== before.rev`: there is a move to forgive at all.
    //  - `!behind`: no `changed-elsewhere` notice stands. The notice says this
    //    tab's data may be stale at a `rev` that has not moved, and carrying a
    //    plan over a navigation that silently cleared it would turn one extra
    //    describe into none.
    //  - a defined `selectionId`, unchanged across the call. This is the whole
    //    guarantee: the plan counted a selection, and the app is saying that
    //    the selection is the same one. An app that publishes nothing here
    //    carries nothing and keeps the behaviour it has always had, which is
    //    the fail-safe an un-adopted app needs -- and the core already warns
    //    that author once, at their first plan check.
    if (
      usesPlans &&
      verb.kind === "read" &&
      plans.size > 0 &&
      before.rev === plansGoodAt &&
      after.rev !== before.rev &&
      !behind &&
      after.selectionId !== undefined &&
      after.selectionId === plansSelection
    ) {
      plansGoodAt = after.rev;
    }

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
    // The other half of the join. The event carrying this as `minted` is the
    // one that reported the count; the event carrying the same string as `plan`
    // is the commit that spent it. Together they are the answer to "3,412 rows
    // were counted here, approved here, and moved here", which is the question
    // the whole record exists for and the one no single event can answer.
    if (plan !== undefined) trail.minted = plan;

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
      // A getter, because this one moves: `none` before a panel mounts and
      // `adopted` after. A snapshotted value would have made every record on
      // the page agree with whichever answer was true when `mount()` returned.
      get policy() {
        return policyNow();
      },
      declared: declaredPolicy,
      /**
       * Hand the gate to a dialog in the page, if nobody else has it.
       *
       * `DriverApproval.adopt` carries the whole argument. What is here is the
       * order of the two refusals, and it is the order on purpose: an app that
       * declared anything wins silently, because `approve: (req) =>
       * panel.approve(req)` is the documented wiring and warning about the
       * recommended arrangement is how a library teaches people to ignore its
       * console. A SECOND adopter is told out loud, because that one is
       * somebody's mistake and the symptom -- a dialog appearing in the other
       * panel -- is otherwise unreadable.
       */
      adopt: (hook: ApprovalHook): (() => void) | null => {
        if (typeof hook !== "function") {
          warn(
            `\`approval.adopt\` was handed ${JSON.stringify(hook)}, which is not a function, ` +
              `so nothing was installed and commits on this driver are gated by whatever ` +
              `\`approve\` the app declared.`,
          );
          return null;
        }
        if (declared !== undefined) return null;
        if (adopted !== undefined) {
          warn(
            `a second approval dialog tried to adopt \`${options.app}\` and was refused: the ` +
              `first one keeps the gate, because two gates for one commit is two dialogs. ` +
              `Commits will be confirmed in whichever panel adopted first — including commits ` +
              `started from this one. Mount one panel per driver, or declare the gate yourself ` +
              `with \`approve\` so that every panel asks through it.`,
          );
          return null;
        }
        const token = {};
        adopted = hook;
        adoptedBy = token;
        return () => {
          // Only its own. A disposer that fired late and unhooked whoever
          // adopted after it would leave the live panel's dialog silently
          // bypassed, which is this whole change running backwards.
          if (adoptedBy !== token) return;
          adopted = undefined;
          adoptedBy = undefined;
        };
      },
      // Offered whatever the policy is, including `"none"`. The widget's
      // in-page dialog is an approval UI on a driver that may well have
      // declared nothing, and it needs the lock exactly as much as the core's
      // own hook does: the agent it is asking is not the only agent that can
      // reach this driver.
      hold: async <T>(verb: string, ask: () => Promise<T>): Promise<T> => {
        const was = pending;
        // `question: false`: this is the lock for an approval UI, which is what
        // `hold` is documented as being for. The core's own question verb takes
        // the lock through `putQuestion`, which sets the other flag.
        pending = { verb, question: false };
        try {
          return await ask();
        } finally {
          pending = was;
        }
      },
    },
    // Offered whether or not a ceiling was declared, so a panel renders one
    // shape. A fresh object per read: handing out a live one would let a UI
    // mutate the app's own accounting.
    budget: () => ({
      calls: { used: callsUsed, ...(budget?.calls === undefined ? {} : { limit: budget.calls }) },
      commits: {
        used: commitsUsed,
        ...(budget?.commits === undefined ? {} : { limit: budget.commits }),
      },
      asks: { used: asksUsed, ...(budget?.asks === undefined ? {} : { limit: budget.asks }) },
    }),
    unmount: () => {
      live = false;
      // Before `live` could matter again: a channel implementation that holds a
      // `BroadcastChannel` open keeps this driver's listener -- and through the
      // closure, this driver -- alive for the life of the page.
      const stop = unlisten;
      unlisten = undefined;
      try {
        stop?.();
      } catch (err) {
        warn(
          `the \`elsewhere\` channel threw on unmount ` +
            `(${err instanceof Error ? err.message : String(err)}); the driver is unmounted ` +
            `either way.`,
        );
      }
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
function deadline<T>(promise: T | Promise<T>, lapsed: T, ms?: number): Promise<T> {
  if (ms === undefined || !(ms > 0)) return Promise.resolve(promise);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lapse = new Promise<T>((resolve) => {
    // Deliberately NOT unref'd, and that is not an oversight. `unref` says the
    // timer is not work worth staying alive for -- true right up until the hook
    // never answers. Then the timer is the ONLY pending thing, the event loop
    // concludes it has nothing to do, and the process tears down with the
    // deadline unfired: the one case this helper exists for. In a test runner
    // that surfaced as every later test in the file being CANCELLED rather than
    // failing, which is a far harder symptom to read than a held process.
    // `clearTimeout` in `finally` already buys what `unref` was reaching for.
    timer = setTimeout(() => resolve(lapsed), ms);
  });
  return Promise.race([Promise.resolve(promise), lapse]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `promise`, or an unanswered question after `ms` -- **defaulting to 45
 * seconds, unlike the approval deadline above, which defaults to forever.**
 *
 * The same timer, a different default, and the inversion is the whole point of
 * this wrapper existing rather than the call site passing a number. Waiting
 * forever on an approval is right because a lapse there DENIES a commit while
 * somebody is still reading; waiting forever on a question is wrong twice over:
 * a lapse denies nothing, and a question that outlives the relay's 60-second
 * deadline turns "nobody answered" into the relay's `timeout`, which means
 * nobody knows. Of the two errors, firing late is the expensive one here.
 *
 * The lapse value is `{ answered: false }` and not a `timedOut` shape of its
 * own, because an agent has no use for the difference: a question nobody
 * answered inside the deadline and a question the app reported unanswered are
 * the same fact and the same repair. `AskAnswer` therefore has three values and
 * not four. A non-positive `ms` waits forever, for the app that is only ever
 * driven in-page.
 */
function askDeadline(
  promise: AskAnswer | Promise<AskAnswer>,
  ms?: number,
): Promise<AskAnswer> {
  return deadline<AskAnswer>(promise, { answered: false }, ms ?? DEFAULT_ASK_TIMEOUT_MS);
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
