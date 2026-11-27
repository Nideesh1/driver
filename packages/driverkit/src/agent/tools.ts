/**
 * The manifest, rendered as a tool list and a system prompt.
 *
 * **Nothing in this file knows the name of a single verb.** Each verb in the
 * manifest becomes one tool, its `args` become the tool's `inputSchema`, and
 * its `refuses` go into the description so a model can decline to make a call
 * that was always going to be declined. The app's verb table is the only
 * description of the app that exists, and it lives next to the code that
 * implements it.
 *
 * This is the twin of `tools_for`/`verb_tool` in
 * `python/src/driverkit/mcp_server.py`, and the notes below are the same
 * strings. The Python half renders for an MCP client driving the app from
 * outside; this half renders for a chatbot inside the page. A verb that is
 * described one way through MCP and another way in the widget is a bug: the
 * whole promise is that the app declares its capabilities once.
 *
 * Everything here is the STATIC half. It is a pure function of the manifest,
 * which the core guarantees does not vary between two users or two minutes, so
 * the output is byte-identical across every turn of every session of every
 * person using the app — which is what makes it worth caching in the prompt
 * prefix. Reaching into `driver.snapshot()` from this file would quietly undo
 * that for everybody; it is not imported here, which is the cheapest way to
 * make that impossible rather than merely discouraged.
 */

import type { ArgSpec, Manifest } from "../core/index.ts";
import type { JsonSchema, ToolSpec } from "./types.ts";

/**
 * The one tool that is not a verb.
 *
 * It is the protocol's own read, not an app feature, and no app should have to
 * declare it. Verb names are kebab-case by the core's contract and this is
 * snake_case so they cannot collide; `toolsFor` checks anyway rather than
 * silently shadowing a verb.
 *
 * MCP's other hand-written tool, `list_tabs`, is deliberately absent. In-page
 * there is one app and it is the one the person is looking at; a tool that
 * lists tabs would invite a model to ask which tab it is driving, and the
 * honest answer is "this one, there is no other".
 */
export const READ_SCREEN = "read_screen";

const RESULT_NOTE =
  "Returns the screen as it is AFTER this runs, so you do not need to read it again.";
const REFUSAL_NOTE =
  "A refusal is a normal answer, not an error: read the reason and change what you do, " +
  "rather than repeating the same call.";

/**
 * `kind` folded into the description, because it is the difference between a
 * call that is free to try and one that is irreversible, and nothing else in
 * the tool definition can express that. Asked to "select the top 1000 and bulk
 * accept", a model that cannot tell `select` from `accept` finds out by doing
 * it, and the finding out costs a thousand accepted rows.
 *
 * Verbatim from the Python half, including the asterisks around the commit
 * banner. It looks shouty in a source file and it is the one place in this
 * library where shouting is the correct engineering decision.
 *
 * `read` says "changes no data and reports no count" and no longer says
 * "changes nothing", because `go`, `open-contact` and `back` are reads and they
 * move the person's screen out from under them. The two things the sentence
 * must get right are the ones that decide whether the next call is safe; "the
 * person will see it" is said as well, because they will.
 */
const KIND_NOTE: Record<string, string> = {
  read:
    "READ-ONLY: this changes no data and reports no count. Free to call, free to get " +
    "wrong. It may still move what the person is looking at — navigating is a read — " +
    "so they will see you do it.",
  describe:
    "DESCRIBE: this changes what is SELECTED and changes no data. " +
    "Safe to call — the worst outcome is the wrong rows highlighted. It reports a " +
    "`count` of what it matched; read that count before you commit to anything.",
  commit:
    "*** COMMIT: THIS CHANGES DATA AND MAY BE IRREVERSIBLE. ***\n" +
    "Do not call it to find out what it does. If it acts on a selection, use the " +
    "app's `describe` verb first, check the `count` it reports is the number you " +
    "expect, and only then commit.",
};

/**
 * The commit banner for a commit the app says it can undo.
 *
 * A separate string rather than a sentence appended to the shouted one, and the
 * difference is the point. `set-setting("dense-rows", "true")` and accepting
 * 3,412 contacts were both getting THIS CHANGES DATA AND MAY BE IRREVERSIBLE,
 * and a banner that appears on a page-size change is a banner a model learns to
 * read past — the same way a person learns to click Yes without reading. So the
 * reversible one is not shouted, and the irreversible one keeps its asterisks
 * and its capitals and goes on meaning something.
 *
 * It still says the data changes, because it does. `reversible` is a claim
 * about there being a way back, not that nobody minds.
 */
/**
 * `consumes: "plan"` folded into the description.
 *
 * In the cached half for exactly the reason `refuses` and `screen` are: the
 * point is that the bare call is never made. A model that learns the pairing
 * here runs the `describe` first and keeps the token; a model that learns it
 * from a refusal has already spent a round trip, and on a commit it has spent
 * it in front of a person waiting for an answer.
 *
 * It says what the token is FOR and not merely that it is required, because
 * "pass the plan" reads as ceremony and gets dropped, while "the number you
 * read is the number that moves" is the reason it exists. Verbatim from the
 * Python half.
 */
const PLAN_NOTE =
  "REQUIRES A PLAN. This acts on the selection, so it may only be called with the `plan` " +
  "token that the app's `describe` verb returned beside its `count`. Run that describe, read " +
  "the count, check it is the number the person asked for, and pass the `plan` straight back " +
  "here. If anything has moved the selection in between — the person ticked a row, data " +
  "arrived — this is refused as `stale-plan` and the refusal names both counts. Reading and " +
  "navigating do not move the selection and do not spend the plan, so go and confirm whatever " +
  "you are unsure of first. That is the point of the token: the number you read is the number " +
  "that moves.";

const COMMIT_REVERSIBLE_NOTE =
  "COMMIT (reversible): this changes data, and the app says the change can be undone. " +
  "Still a change the person will see, so do not call it to find out what it does; if it " +
  "acts on a selection, read the `count` from the app's `describe` verb first.";

/**
 * `screen` folded into the description.
 *
 * The tool list is the same on every screen — a verb list that changed with the
 * screen would bust the prompt prefix on every navigation, which is the cost
 * argument — so this sentence is how a model learns, in the cached half, that a
 * verb it can see will not work where it is standing. Exactly the argument for
 * putting `refuses` in here: the point is that the call is never made.
 *
 * A verb on several screens names them all, because naming one of three is
 * worse than naming none: a model told `next-page` is "ONLY ON THE `contacts`
 * SCREEN" will navigate away from the company list it was already standing on
 * to do something it could have done where it was. The one-screen wording is
 * byte-for-byte what it was before this could be a list, so no app's cached
 * prefix moved for a feature it does not use.
 */
function screenNote(screen: string | string[]): string {
  const screens = Array.isArray(screen) ? screen : [screen];
  const quoted = screens.map((s) => `\`${s}\``);
  const where =
    quoted.length > 1
      ? `ONLY ON THE ${quoted.slice(0, -1).join(", ")} AND ${quoted[quoted.length - 1]} SCREENS.`
      : `ONLY ON THE ${quoted[0]} SCREEN.`;
  return (
    `${where} The screen you are on is the \`screen\` line of ` +
    "every screen you read. Called from anywhere else this is refused as `wrong-screen`, " +
    "and the refusal names where you are and where the verb lives."
  );
}

/**
 * One `ArgSpec` as one JSON Schema property.
 *
 * `oneOf` becomes `enum`. See the note on `JsonSchema`: the two names look
 * alike and the meanings diverge, and emitting JSON Schema's `oneOf` would
 * produce a schema that validates anything.
 */
export function argSchema(spec: ArgSpec): JsonSchema {
  if (spec.type !== "string" && spec.type !== "number" && spec.type !== "boolean") {
    // Thrown, not skipped. The core's three types are a closed set, so an
    // unknown one is a bug that should be loud here rather than become a
    // property no client will validate.
    throw new Error(`driverkit: unknown arg type ${JSON.stringify(spec.type)}`);
  }
  return {
    type: spec.type,
    description: spec.describe,
    ...(spec.oneOf ? { enum: spec.oneOf } : {}),
  };
}

/**
 * One manifest verb as one tool.
 *
 * `optional` is expressed by omission from `required`, which is how JSON
 * Schema says it; an `"optional": true` key would be ignored by every
 * validator and the argument would silently become mandatory.
 *
 * `rev` is added as an extra optional property on every verb. It is not an app
 * argument — it is `CallOptions.rev`, the staleness claim, hoisted into the
 * schema because a model has nowhere else to put it. Passing the `rev` it last
 * read is what turns "act on a row somebody already moved" into a clean
 * `stale` refusal, and in-page that is not a rare case: the person is sitting
 * right there, clicking, while the model thinks. A verb that declares its own
 * `rev` argument keeps it and does not get the hoisted one, because the app's
 * meaning wins over ours.
 */
export function verbTool(verb: Manifest["verbs"][number]): ToolSpec {
  const args = verb.args ?? {};
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(args)) {
    properties[name] = argSchema(spec);
    if (!spec.optional) required.push(name);
  }

  if (!("rev" in properties)) {
    properties.rev = {
      type: "integer",
      description:
        "Optional. The `rev` from the last screen you read. If the screen has " +
        "moved since, the call is refused as `stale` instead of acting on " +
        "something you did not see. Omit it to skip that check.",
    };
  }

  // Hoisted exactly as `rev` is, and for a failure `rev` does not catch: a
  // paging call sent with no rev once landed on a screen the agent had never
  // seen, paged a different company's list and answered `ok`. "You are
  // somewhere else" and "the number moved" are different mistakes with
  // different fixes, so they are different claims and different refusals.
  //
  // A verb with its own `screen` argument keeps it and does not get this one —
  // `go(screen)` is a real verb in a real app — because the app's meaning wins
  // over ours. The same rule as `rev`.
  if (!("screen" in properties)) {
    properties.screen = {
      type: "string",
      description:
        "Optional. The `screen` from the last screen you read. If the app is on " +
        "another screen now, the call is refused as `wrong-screen` instead of acting " +
        "on a screen you never saw. Omit it to skip that check.",
    };
  }

  // Hoisted like `rev` and `screen`, with one difference: ONLY onto a verb that
  // declares `consumes`. `rev` and `screen` are claims any verb can make, so
  // they go on everything; a plan token means nothing to a verb that does not
  // consume one, and adding the property to every tool in every app would move
  // every cached prompt prefix in the world for a feature those apps do not
  // use. That prefix is the cost argument the library is built on.
  //
  // NOT in `required`, although the core will refuse the call without it, and
  // that is deliberate. `required` moves the failure into the client's
  // validator, where the refusal's hint — which names both counts and spells
  // out the pairing — never reaches the model. This library's stance throughout
  // is that an agent learns from a refusal it can act on, so the schema stays
  // permissive and the core is strict. The description says it is required.
  if (verb.consumes === "plan" && !("plan" in properties)) {
    properties.plan = {
      type: "string",
      description:
        "Required. The `plan` token from the `describe` verb that counted this " +
        "selection, passed back exactly as it was given. Without it the call is " +
        "refused as `stale-plan`, and so is a token taken before the selection moved.",
    };
  }

  const description = [verb.describe];
  if (verb.kind === "commit" && verb.reversible) {
    // Checked before the table, so a reversible commit reads differently from
    // an irreversible one. `reversible` is read only here, on a `commit`: on a
    // `read` or a `describe` it is a claim about nothing, and the app has
    // already said no data moves.
    description.push(COMMIT_REVERSIBLE_NOTE);
  } else if (verb.kind && KIND_NOTE[verb.kind]) {
    // Second, straight after what the verb does and ahead of the mechanical
    // notes, so a model skimming the first two lines of a description cannot
    // miss that a verb commits. An unknown or absent kind adds nothing: this
    // package does not manufacture a safety claim the app did not make, in
    // either direction.
    description.push(KIND_NOTE[verb.kind]!);
  }
  // Third, above `screen`, because HOW a verb may be called outranks WHERE: a
  // model that goes to the right screen and calls the commit bare has still
  // lost the turn, and this is the sentence that stops it. Both still outrank
  // the mechanics.
  if (verb.consumes === "plan") description.push(PLAN_NOTE);
  if (verb.screen) description.push(screenNote(verb.screen));
  description.push(RESULT_NOTE);
  if (verb.refuses && verb.refuses.length) {
    // In the description rather than only in the error path, because this is
    // the half that gets cached in the prompt prefix: the point of `refuses`
    // is that a well-briefed agent never makes the call.
    description.push("May refuse: " + verb.refuses.join(", ") + ". " + REFUSAL_NOTE);
  }

  return {
    name: verb.name,
    description: description.join("\n\n"),
    inputSchema: {
      type: "object",
      properties,
      required,
      // The app named its own arguments; an extra one is a mistake worth
      // catching at the client rather than sending to a verb that will ignore
      // it.
      additionalProperties: false,
    },
  };
}

/** The whole tool list: every verb, then the one fixed read. */
export function toolsFor(manifest: Manifest): ToolSpec[] {
  const tools = manifest.verbs.map(verbTool);
  if (!tools.some((t) => t.name === READ_SCREEN)) {
    tools.push({
      name: READ_SCREEN,
      description:
        `Read what is on screen in ${manifest.app || "the app"} right now: where the ` +
        "person is, the rows visible to them, what they have selected, and the `rev` to " +
        "quote back when you act.\n\n" +
        "You see exactly what the person at the keyboard sees — same filters, same page — " +
        "and nothing more. If a record you expect is missing, it is probably off screen " +
        "rather than absent.\n\n" +
        "You are given the screen at the start and after every verb, so you rarely need " +
        "this. Use it when the person may have clicked something while you were thinking, " +
        "or after anything unexpected: it is the cheapest tool here and the only way to " +
        "settle what actually happened.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    });
  }
  return tools;
}

/**
 * The app's map, rendered for the model.
 *
 * `Manifest.screens` is the static list of every screen the app has, so this
 * belongs in the cached prefix beside the tool list rather than in any turn's
 * tail. What an agent could not do before this existed is learn that a screen
 * EXISTS without standing on it: `Snapshot.screen` says where it is and
 * `Verb.screen` says where a verb works, and between them there was still no
 * way to find out that a companies list is in there somewhere. The worked
 * example closed that gap by pasting a prose screen-map into `instructions`,
 * which is the same map the app's own route table already had, written a
 * second time in English with nothing checking that the two agree.
 *
 * The sentence about it being the same for every user is not padding. It is
 * the one thing a model cannot tell by looking: a list that might have been
 * filtered for this person is a list whose absences mean nothing, and an agent
 * that cannot trust the absences has to probe for screens anyway. See
 * `ScreenSpec`, which forbids filtering it, and which puts "you may not open
 * that" in the refusal where it can be read.
 *
 * Verbatim from the Python half.
 */
export function screensNote(screens: NonNullable<Manifest["screens"]>): string {
  const lines = [
    "THE SCREENS THIS APP HAS. The same screens for every user, always — a screen listed " +
      "here exists whether or not you have been to it. Only which one is LIVE changes, and " +
      "that is the `screen` line of every screen you read. If you cannot get to one of " +
      "these, the app will tell you why when you try; it is never missing from this list.",
  ];
  for (const screen of screens) {
    const needs = Object.keys(screen.args ?? {});
    lines.push(
      `- \`${screen.id}\`: ${screen.describe}` +
        (screen.url ? ` Address: \`${screen.url}\`.` : "") +
        (needs.length ? ` Needs: ${needs.map((n) => `\`${n}\``).join(", ")}.` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * One flow, rendered as the recipe it is.
 *
 * The id first and the `describe` on the same line, because the `describe` is
 * what a model picks a flow on — Microsoft's finding on selection across tool
 * groups is that the choice is made "based on the plugin's description, not on
 * any of the individual functions" — and the steps are what it follows once it
 * has picked. A `section` is printed once where it changes rather than on
 * every step, so a flow with phases reads as phases and a flow without one
 * costs nothing.
 *
 * TWO MARKS GO IN PARENTHESES AFTER THE VERB, and both are there so that a
 * model skimming five numbered lines can see the shape of the recipe without
 * reading every hint:
 *
 *   OPTIONAL — a step with a `skipWhen`. Which steps carry the job and which
 *   are there for the case where you do not already know the answer is
 *   structural, and before the field it was a clause buried mid-hint.
 *
 *   the plan handoff — a step whose verb consumes a plan, pointing at the
 *   numbered step whose `describe` mints it. DERIVED, not declared: it is read
 *   off `Verb.kind` and `Verb.consumes`, which the manifest already carries, so
 *   there is nothing for an author to keep in step and nothing claimed here
 *   that `mount()` has not already refused to let through. It is the one value
 *   that crosses two steps in this library — see `FlowStep` for why there is no
 *   general way to say "pass step 2's output into step 3".
 *
 * Verbatim from the Python half.
 */
function renderFlow(
  flow: NonNullable<Manifest["flows"]>[number],
  verbs: Manifest["verbs"],
): string {
  const lines = [`\`${flow.id}\` — ${flow.describe}`];
  let section: string | undefined;
  // The numbered step whose `describe` verb last minted a plan token, so the
  // mark can name it. Updated AFTER the current step is rendered: a describe
  // does not consume its own plan.
  let minted: number | undefined;
  flow.steps.forEach((step, i) => {
    if (step.section && step.section !== section) lines.push(`  (${step.section})`);
    section = step.section;
    const verb = verbs.find((v) => v.name === step.verb);
    const marks: string[] = [];
    if (step.skipWhen) marks.push(`OPTIONAL — skip it when ${step.skipWhen}`);
    if (verb?.consumes === "plan" && minted !== undefined) {
      marks.push(`takes the \`plan\` token step ${minted} returned`);
    }
    const mark = marks.length ? ` (${marks.join("; ")})` : "";
    lines.push(`  ${i + 1}. \`${step.verb}\`${mark} — ${step.hint}`);
    if (verb?.kind === "describe") minted = i + 1;
  });
  return lines.join("\n");
}

/**
 * The app's flows, rendered for the model.
 *
 * THE SENTENCE THAT MATTERS is the one saying there is no tool that runs a
 * flow. A model handed a list of numbered steps will look for the button, and
 * not finding one it may well decide the flow is unavailable; being told that
 * following the steps IS the mechanism, and why, is what turns a list into an
 * instruction. The why is honest and is the design: a flow that executed
 * internally could not adapt when step three found the record already
 * accepted, and the agent would get back an `ok` that told it nothing. Apple's
 * app skills say the same thing about themselves — "Skills don't enforce
 * deterministic behavior, and Siri doesn't run the listed intents in sequence."
 *
 * Static, so it rides in the prefix that was already being cached and costs
 * nothing per turn. Verbatim from the Python half.
 */
export function flowsNote(
  flows: NonNullable<Manifest["flows"]>,
  verbs: Manifest["verbs"] = [],
): string {
  return (
    "THE JOBS THIS APP SAYS ITS VERBS ARE USUALLY COMBINED INTO. Each one is a recipe for " +
    "YOU to carry out with the verbs you already have. **There is no tool that runs a " +
    "flow**, and that is deliberate: following the steps yourself means you see what each " +
    "one actually returned and can change course, which something running them for you " +
    "could not. Take the steps in order, read what each verb reports before the next, and " +
    "depart from the recipe when the screen says something it did not expect — then say so." +
    // The sentence about OPTIONAL steps is added only when some step actually
    // is one. Everything in here rides in the cached prefix of every session of
    // every user, and a paragraph about a construct the app does not use is the
    // kind of cost that is real, paid once, and invisible -- which is the exact
    // cost `SIZE_LIMITS` exists to make somebody weigh. An app whose flows mark
    // nothing optional gets the note it got before the field existed.
    (flows.some((f) => f.steps.some((s) => s.skipWhen))
      ? " A step marked OPTIONAL may be skipped when the condition beside it holds, and " +
        "that condition is a sentence for you to judge, not a rule something checks: when " +
        "it is not clearly true, take the step."
      : "") +
    "\n\n" +
    flows.map((f) => renderFlow(f, verbs)).join("\n\n")
  );
}

/**
 * The system prompt. A pure function of the manifest — including the app's own
 * `Manifest.instructions` — and the host's static `instructions`, and of
 * nothing else.
 *
 * Mirrors the MCP server's `initialize` instructions, with the differences
 * that are actually true in-page: there is no relay, no tab to pick, and the
 * person whose screen this is can see every word of what happens next.
 *
 * The screen is NOT in here, and that is the rule this function exists to
 * enforce. It is the uncached half; putting it in the system prompt would mean
 * re-sending and re-paying for the entire prefix on every single turn, which
 * is the exact cost the static/dynamic split was designed to avoid. It goes in
 * the newest message instead — see `loop.ts`.
 */
export function systemPrompt(manifest: Manifest, instructions?: string): string {
  const app = manifest.app || "this app";
  const parts = [
    `You are driving a live ${app} session: the page the person is looking at as you ` +
      "read this. You act only through the verbs listed as your tools, which are this " +
      "app's own. You cannot click, type, scroll or see pixels, and you do not need to.",

    "Every verb returns the screen as it is AFTER it ran, so acting and looking are one " +
      "step. Never follow a verb with a read to find out what it did — you were just " +
      "told. Quote the `rev` from the screen you are acting on, so that if the person " +
      "clicks something while you are thinking you get a `stale` refusal instead of " +
      "changing a row you never saw.",

    "Every verb says what it does to the world. READ-ONLY changes no data and reports " +
      "no count — moving to another screen is a read, and the person watching will see " +
      "it. DESCRIBE changes what is selected and reports a `count` of what it matched. " +
      "COMMIT changes data; it may be irreversible, and a COMMIT that says it is " +
      "reversible can be undone but is still a change they will see.\n\n" +
      "Never commit on a selection whose count you have not read. The pairing is: run " +
      "the app's `describe` verb with the predicate, read the `count` it reports, check " +
      "that count is the number the person asked for, and only then run the `commit` " +
      "verb — which takes no predicate and acts on the current selection. If the count " +
      "is not what you expected, stop and say so in plain words. Asked to accept a " +
      "thousand rows, accepting fifty thousand because a filter was wider than anybody " +
      "thought is the single worst thing you can do here, and checking the count is how " +
      "you avoid it.\n\n" +
      "Some commit verbs say they REQUIRE A PLAN. Those return a `plan` token beside the " +
      "`count` of the describe that counted them, and you pass it straight back. Do not " +
      "hold one over for later and do not reuse one: a plan is good for one commit and " +
      "only while nothing has moved the selection. Looking is free: reading a screen or " +
      "navigating to another one leaves the plan good, so go back and confirm anything you " +
      "are unsure of before an irreversible commit. `stale-plan` means the rows changed " +
      "under you — it names the count you were shown and the count there is now — so run " +
      "the describe again, read the new number, and say it out loud before you commit to " +
      "it. That refusal is not an obstacle; it is the one that stops you from accepting a " +
      "set the person never agreed to.",

    "A refusal is a normal answer, not an error. Read the reason and do something " +
      "different; repeating the same call unchanged will get the same answer. If you " +
      "cannot find a way through, say so — the person is right there and can do it " +
      "themselves or tell you what you are missing.",

    "You can do exactly what that person could do, and nothing more. You also see " +
      "exactly what they see — same filters, same sort, same page — so a record you " +
      "expect and cannot find is probably off screen rather than absent; use the app's " +
      "own paging verb the way a person would.",

    "When you are finished, answer in prose and say what you did. A message with no " +
      "verb call ends your turn. Keep it short: this is rendered in a small panel in " +
      "the corner of the person's screen.",
  ];

  // The map and the recipes, between the library's rules and the app's own
  // words. Both are pure functions of the static manifest, so the prefix stays
  // byte-identical across every turn of every session of every user -- which
  // is the only reason either of them is affordable at all. They go AFTER the
  // safety rules, because a recipe is a thing to do within those rules and not
  // an exception to them, and BEFORE `instructions`, because whichever text is
  // last is the one a model follows when two of them disagree and the app's
  // own voice should outrank a list the core rendered.
  if (manifest.screens && manifest.screens.length) parts.push(screensNote(manifest.screens));
  if (manifest.flows && manifest.flows.length) {
    parts.push(flowsNote(manifest.flows, manifest.verbs));
  }

  // The app's own briefing, then the host's. Both last, not first: an
  // app-specific note is an addition to these rules and not a replacement for
  // them, and a model reading in order should meet the safety rules before the
  // local colour. Both static — see `Manifest.instructions`, which is where an
  // app says the thing it needs BOTH paths to hear, and `DriveOptions
  // .instructions`, which is this host's own and reaches only this path.
  //
  // The app's goes first of the two because the host embedding the app is the
  // more specific voice, and whichever is last is the one a model follows when
  // they disagree.
  if (manifest.instructions) parts.push(manifest.instructions);
  if (instructions) parts.push(instructions);

  return parts.join("\n\n");
}
