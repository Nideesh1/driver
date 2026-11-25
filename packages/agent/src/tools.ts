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

import type { ArgSpec, Manifest } from "driverkit";
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
 */
const KIND_NOTE: Record<string, string> = {
  read: "READ-ONLY: this changes nothing. Free to call, free to get wrong.",
  describe:
    "DESCRIBE: this changes what is SELECTED or FILTERED and changes no data. " +
    "Safe to call — the worst outcome is the wrong rows highlighted. It reports a " +
    "`count` of what it matched; read that count before you commit to anything.",
  commit:
    "*** COMMIT: THIS CHANGES DATA AND MAY BE IRREVERSIBLE. ***\n" +
    "Do not call it to find out what it does. If it acts on a selection, use the " +
    "app's `describe` verb first, check the `count` it reports is the number you " +
    "expect, and only then commit.",
};

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

  const description = [verb.describe];
  if (verb.kind && KIND_NOTE[verb.kind]) {
    // Second, straight after what the verb does and ahead of the mechanical
    // notes, so a model skimming the first two lines of a description cannot
    // miss that a verb commits. An unknown or absent kind adds nothing: this
    // package does not manufacture a safety claim the app did not make, in
    // either direction.
    description.push(KIND_NOTE[verb.kind]!);
  }
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
 * The system prompt. A pure function of the manifest and the host's static
 * `instructions`, and of nothing else.
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

    "Every verb says what it does to the world. READ-ONLY changes nothing. DESCRIBE " +
      "changes only what is selected or filtered and reports a `count` of what it " +
      "matched. COMMIT changes data and may be irreversible.\n\n" +
      "Never commit on a selection whose count you have not read. The pairing is: run " +
      "the app's `describe` verb with the predicate, read the `count` it reports, check " +
      "that count is the number the person asked for, and only then run the `commit` " +
      "verb — which takes no predicate and acts on the current selection. If the count " +
      "is not what you expected, stop and say so in plain words. Asked to accept a " +
      "thousand rows, accepting fifty thousand because a filter was wider than anybody " +
      "thought is the single worst thing you can do here, and checking the count is how " +
      "you avoid it.",

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

  // Last, not first: a host's app-specific note is an addition to these rules
  // and not a replacement for them, and a model reading in order should meet
  // the safety rules before the local colour. Static, like the rest — see
  // `DriveOptions.instructions`.
  if (instructions) parts.push(instructions);

  return parts.join("\n\n");
}
