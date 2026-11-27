/**
 * The question channel.
 *
 * `approve` is a gate: it lets the person stop the agent. This is the other
 * direction, and until it existed an agent that met an ambiguous instruction
 * had two moves — guess, or give up. The argument is the one `declined-by-user`
 * already rests on, one level up: a model that cannot tell "the person said no"
 * from "your arguments were wrong" will retry with different arguments, and a
 * model that cannot ask will guess.
 *
 * Four things in here are the feature rather than its plumbing, and each has a
 * test whose name is the decision:
 *
 *   an answered question's words are the tool's RESULT, not a side channel;
 *   an unanswered one is three different facts and not one;
 *   a question cannot approve anything, structurally and not by policy;
 *   an app that declares no hook is byte-identical to one mounted before this.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ASK, DEFAULT_ASK_TIMEOUT_MS, mount, RESERVED_REFUSALS } from "../src/core/registry.ts";
import type {
  AskAnswer,
  AuditEvent,
  Driver,
  MountOptions,
  Result,
  Snapshot,
} from "../src/core/types.ts";
import { drive } from "../src/agent/loop.ts";
import { toolsFor, systemPrompt } from "../src/agent/tools.ts";
import { renderOutcome } from "../src/agent/render.ts";
import { scripted, call as toolCall } from "./app.ts";

/**
 * A toy with one of each kind, and the question hook under the test's control.
 *
 * `ran` counts verb bodies rather than calls, because almost every claim in
 * here is about something NOT running: a commit that was declined, a question
 * that was never put, a call refused while another question was open.
 */
function toy(
  options: {
    answer?: (question: string) => AskAnswer | Promise<AskAnswer>;
    ask?: MountOptions["ask"];
    approve?: MountOptions["approve"];
    askTimeout?: number;
    asksBudget?: number;
    onAudit?: MountOptions["onAudit"];
  } = {},
): { driver: Driver; ran: () => Record<string, number>; asked: () => string[] } {
  let rev = 1;
  const ran: Record<string, number> = { look: 0, "select-all": 0, accept: 0 };
  const asked: string[] = [];
  const hook: MountOptions["ask"] | undefined =
    options.ask ??
    (options.answer === undefined
      ? undefined
      : ({ question }) => {
          asked.push(question);
          return options.answer!(question);
        });
  const driver = mount({
    app: "Toy",
    visible: (): Snapshot => ({ where: "contacts", screen: "contacts", rev, rows: [{ id: "c-1" }] }),
    ...(hook === undefined ? {} : { ask: hook }),
    ...(options.approve === undefined ? {} : { approve: options.approve }),
    ...(options.askTimeout === undefined ? {} : { askTimeout: options.askTimeout }),
    ...(options.asksBudget === undefined ? {} : { budget: { asks: options.asksBudget } }),
    ...(options.onAudit === undefined ? {} : { onAudit: options.onAudit }),
    verbs: [
      { name: "look", kind: "read", describe: "look", run: () => void ran["look"]!++ },
      {
        name: "select-all",
        kind: "describe",
        describe: "select everything",
        run: () => {
          ran["select-all"]!++;
          rev++;
          return { count: 3412 };
        },
      },
      {
        name: "accept",
        kind: "commit",
        describe: "accept the selection",
        run: () => {
          ran["accept"]!++;
          rev++;
        },
      },
    ],
  });
  return { driver, ran: () => ({ ...ran }), asked: () => [...asked] };
}

const refusalOf = (r: Result): string | undefined => (r.ok ? undefined : r.refused);

// ---- the answer reaches the model ---------------------------------------

test("an answered question's words come back as the call's own result", async () => {
  // THE DECISION: the human's answer is the tool's RESULT and not a side
  // channel. A model reads an answer in the one place it reads every other
  // outcome, so nothing had to learn where to look -- and neither renderer
  // needed a line, because the answer rides in `Report.note` and `ok — …` is
  // already how a note is printed. A new field on `Result`, or a block in the
  // snapshot, would have been a second place a model has to be taught about
  // AND a place this core could keep a person's words.
  const { driver } = toy({ answer: () => "the one at Acme, please" });
  const out = await driver.call(ASK, { question: "which Ada Duarte did you mean?" });
  assert.equal(out.ok, true);
  assert.match(String((out as { note?: string }).note), /the one at Acme, please/);
  // Attributed, because `ok — the one at Acme` is indistinguishable from the
  // app reporting something of its own. The core says whose sentence this is.
  assert.match(renderOutcome(out), /the person answered: "the one at Acme, please"/);
});

test("the question reaches the hook as the agent typed it, never paraphrased", async () => {
  // A question the library rewrote is a question the person answers and the
  // model did not ask, and the two then disagree about what was settled. The
  // core trims surrounding whitespace -- a blank box cannot be answered -- and
  // changes nothing else.
  const { driver, asked } = toy({ answer: () => "yes" });
  await driver.call(ASK, { question: "  which of the five?  " });
  assert.deepEqual(asked(), ["which of the five?"]);
});

test("an empty or enormous question is bad-argument, not a box nobody can answer", async () => {
  // Both ends of the one argument. Whitespace would put an empty box in front
  // of somebody; 2,000 characters would put a wall of text there, which is a
  // question they dismiss. Refused rather than truncated: half a question
  // reads as the whole of a different one.
  const { driver, asked } = toy({ answer: () => "yes" });
  assert.equal(refusalOf(await driver.call(ASK, { question: "   " })), "bad-argument");
  assert.equal(refusalOf(await driver.call(ASK, { question: "x".repeat(2000) })), "bad-argument");
  assert.deepEqual(asked(), [], "nobody was interrupted for a malformed question");
});

// ---- nobody answered, three ways ----------------------------------------

test("asked-and-ignored, nobody-to-ask and a spent allowance are three facts, not one", async () => {
  // THE DECISION, AND IT IS THE SAME DISCIPLINE `approval-timeout` IS KEPT
  // APART FROM `declined-by-user` BY. "Nobody answered" and "there is nobody"
  // and "you may not ask any more" call for three different next moves:
  //
  //   ask-unanswered  the channel works and this question went unanswered, so
  //                   asking once more, shorter, can succeed;
  //   nobody-to-ask   there is no person on this run, so every further question
  //                   is wasted -- a strictly larger repair;
  //   asks-spent      the same, for the rest of this run, with a real repair
  //                   underneath it: say in your answer what you would have
  //                   asked.
  //
  // An agent given one word for all three keeps asking into an empty room.
  const ignored = toy({ answer: () => ({ answered: false }) });
  assert.equal(refusalOf(await ignored.driver.call(ASK, { question: "which one?" })), "ask-unanswered");

  const empty = toy({ answer: () => ({ nobody: true }) });
  assert.equal(refusalOf(await empty.driver.call(ASK, { question: "which one?" })), "nobody-to-ask");

  const capped = toy({ answer: () => "a", asksBudget: 1 });
  assert.equal((await capped.driver.call(ASK, { question: "first?" })).ok, true);
  const spent = await capped.driver.call(ASK, { question: "second?" });
  assert.equal(refusalOf(spent), "asks-spent");
  assert.deepEqual(capped.asked(), ["first?"], "the second was never put to anybody");

  // All three distinct, and all three distinct from the approval vocabulary: an
  // auditor must never read a lapsed question as a person declining a commit.
  assert.equal(new Set(["ask-unanswered", "nobody-to-ask", "asks-spent"]).size, 3);
  for (const slug of ["ask-unanswered", "nobody-to-ask", "asks-spent"]) {
    assert.ok(RESERVED_REFUSALS.includes(slug), `${slug} must be reserved`);
  }
  assert.ok(!RESERVED_REFUSALS.includes(ASK), "the verb name is reserved only weakly");
});

test("a spent allowance refuses asks-spent and never budget-spent, so the run can still finish", async () => {
  // `budget-spent` is the one reserved slug whose honest repair is "do not try
  // again", and `drive` ends the whole run on the first one. A question
  // allowance is not that: the rest of the app still works, and the agent's job
  // now is to finish the sentence it was asking about. Reusing the slug would
  // have made asking one question too many end the run.
  const { driver } = toy({ answer: () => "a", asksBudget: 1 });
  await driver.call(ASK, { question: "first?" });
  const spent = await driver.call(ASK, { question: "second?" });
  assert.equal(refusalOf(spent), "asks-spent");
  assert.match(String(spent.ok ? "" : spent.hint), /rest of the app still works/);
  // And the ceiling is on the person's attention, not on the calls: an
  // ordinary verb still runs afterwards.
  assert.equal((await driver.call("look")).ok, true);
});

test("a question nobody could be asked costs nothing from the allowance", async () => {
  // Charged when a question reaches somebody, and `{ nobody: true }` means it
  // did not. An allowance that drained on a cron run would make the ceiling
  // fire for a reason that has nothing to do with anybody's patience -- and an
  // unanswered one IS charged, because a question that sat in front of a person
  // and was ignored has spent their attention as surely as one they answered.
  const nobody = toy({ answer: () => ({ nobody: true }), asksBudget: 2 });
  await nobody.driver.call(ASK, { question: "a?" });
  await nobody.driver.call(ASK, { question: "b?" });
  await nobody.driver.call(ASK, { question: "c?" });
  assert.equal(nobody.driver.budget!().asks.used, 0);

  const ignored = toy({ answer: () => ({ answered: false }), asksBudget: 2 });
  await ignored.driver.call(ASK, { question: "a?" });
  assert.equal(ignored.driver.budget!().asks.used, 1);
});

test("a deadline answers before the relay's would, so nobody-answered stays a fact", async () => {
  // THE WHOLE OF THE MCP PATH'S HONESTY, as one number. The relay gives a call
  // 60 seconds and then says `timeout`, which PROTOCOL.md defines as outcome
  // UNKNOWN. A question that outlived it would convert "nobody answered",
  // which an agent can act on, into "nobody knows", which is the most
  // expensive answer in the system -- over the one call where the truth was
  // plainly knowable, since no verb ran and no data moved.
  //
  // So the default is a deadline, which is the opposite of `approvalTimeout`'s
  // "wait forever": a lapsed approval DENIES a commit somebody was still
  // reading about, and a lapsed question denies nothing.
  assert.ok(DEFAULT_ASK_TIMEOUT_MS < 60_000, "an ask must answer before the relay gives up");

  const { driver } = toy({
    askTimeout: 10,
    ask: () => new Promise<AskAnswer>(() => {}),
  });
  const out = await driver.call(ASK, { question: "which one?" });
  assert.equal(refusalOf(out), "ask-unanswered");
  // And it says the verb did not run, which is the sentence that keeps it apart
  // from the relay's `timeout` in the one place a model reads.
  assert.match(String(out.ok ? "" : out.hint), /did not run/);
});

test("a question UI that throws is an unanswered question and never a claim that nobody is there", async () => {
  // A failed ask is a no in the approval gate; here a failed ask is an
  // UNANSWERED question. The difference matters because `nobody-to-ask` tells
  // an agent to stop asking for the rest of the run, and one exception in a
  // panel is not evidence about who is sitting in front of it.
  const { driver } = toy({
    ask: () => {
      throw new Error("the panel is gone");
    },
  });
  assert.equal(refusalOf(await driver.call(ASK, { question: "which one?" })), "ask-unanswered");
});

test("an answer shape the core does not recognise is unanswered, never an answer", async () => {
  // The mirror of `Approval`'s rule that an unknown shape is a DENIAL, pointed
  // the other way: there the safe reading is that nobody consented, here it is
  // that nobody spoke. Reading it as an answer would put words in a person's
  // mouth and let a model act on them, which is the worse of the two mistakes.
  const { driver } = toy({ ask: () => ({ sure: "go ahead" }) as unknown as AskAnswer });
  assert.equal(refusalOf(await driver.call(ASK, { question: "which one?" })), "ask-unanswered");
  // An empty string is the same thing: somebody pressed send on a blank box.
  const blank = toy({ answer: () => "   " });
  assert.equal(refusalOf(await blank.driver.call(ASK, { question: "which one?" })), "ask-unanswered");
});

// ---- a question is not consent ------------------------------------------

test("a question cannot approve a commit: a yes to the agent is not a yes to the gate", async () => {
  // THE DECISION, AND THE SEPARATION IS STRUCTURAL RATHER THAN A POLICY.
  //
  // The misuse this exists to make impossible: ask "shall I accept these
  // 3,412?", read a yes, and treat it as the consent `MountOptions.approve`
  // exists to collect. deepagents has the shape of this bug -- an auto-added
  // subagent inherits the main agent's tools, so an interrupt gate is
  // bypassable by delegation -- and the core's own rule from
  // `resolveToolApprovalResponse` is that on a decision the approval IS the
  // authorization, so inferring one from a typed note would let the note
  // authorize the call.
  //
  // What makes it structural here is that THERE IS NO STATE TO BE A POLICY
  // ABOUT. The answer is turned into this call's `Result` and the core keeps
  // not one byte of it: no remembered yes, no field on `ApprovalRequest`, and
  // nothing a later commit could consult. So the gate is asked exactly as it
  // would have been if the question had never happened.
  const seen: string[] = [];
  const { driver, ran } = toy({
    answer: () => "yes, accept them all, go ahead",
    approve: (req) => {
      seen.push(req.name);
      return false;
    },
  });

  const answered = await driver.call(ASK, { question: "shall I accept these 3,412?" });
  assert.equal(answered.ok, true, "the question itself is answered");
  assert.deepEqual(seen, [], "a question is not a commit and is not put to the approver");

  const commit = await driver.call("accept");
  assert.equal(refusalOf(commit), "declined-by-user");
  assert.deepEqual(seen, ["accept"], "the gate was asked anyway, after an explicit yes");
  assert.equal(ran().accept, 0, "and the commit did not run");
});

test("the approver is handed no part of an answer, so a typed note cannot authorize a call", async () => {
  // The other half of the same claim, from the gate's side. `ApprovalRequest`
  // has four fields -- name, args, the manifest entry, the snapshot -- and none
  // of them is reachable from a question. A gate that could see the answer
  // would be a gate somebody wires to it, and then the person's sentence is the
  // authorization after all.
  const fields: string[] = [];
  const { driver } = toy({
    answer: () => "yes do it",
    approve: (req) => {
      fields.push(...Object.keys(req).sort());
      return true;
    },
  });
  await driver.call(ASK, { question: "shall I?" });
  await driver.call("accept");
  assert.deepEqual(fields, ["args", "name", "snapshot", "verb"]);
  // And the snapshot it is handed is the app's own, with nothing of the
  // question in it: no note, nothing.
  assert.equal(fields.includes("answer"), false);
});

test("an app verb may not declare kind ask, so only the core can mint a question", async () => {
  // Thrown at mount, where it costs one stack trace at startup. Every other
  // kind is a claim about what the app's own code does; `ask` is a claim about
  // a PERSON, and only the core can make it good -- it owns the lock, the
  // deadline, the allowance and the record. A verb wearing the kind with none
  // of those behind it would be a question nothing counted, and the first
  // thing anybody would build with it is a confirmation dialog whose yes is
  // then the approval.
  assert.throws(
    () =>
      mount({
        app: "Toy",
        visible: (): Snapshot => ({ where: "x", rev: 1 }),
        verbs: [{ name: "check-with-me", kind: "ask", describe: "ask", run: () => {} }],
      }),
    /only the core.*may mint/s,
  );
});

test("nothing else runs while a question is open, including the thing being asked about", async () => {
  // The lock, which is the core's `pending` -- the same one an approval holds.
  // An agent that could carry on acting while somebody is mid-answer is an
  // agent acting on a screen the person is about to change; over the relay it
  // is two agents, one of which asked. And the call most worth refusing is the
  // commit the question was about, raced against the answer.
  let release: ((a: AskAnswer) => void) | undefined;
  const { driver, ran } = toy({ ask: () => new Promise<AskAnswer>((r) => (release = r)) });
  const asking = driver.call(ASK, { question: "shall I accept?" });
  await Promise.resolve();

  const during = await driver.call("accept");
  assert.equal(refusalOf(during), "approval-pending");
  assert.equal(ran().accept, 0);
  // The hint says a QUESTION is open and not that something is awaiting
  // approval. One slug, because the agent's move is the same either way --
  // wait -- and two sentences, because an agent told "`accept` is waiting to be
  // approved" while the screen says "which Ada Duarte?" has been told something
  // false about its own app.
  assert.match(String(during.ok ? "" : during.hint), /question of yours/);
  assert.match(String(during.ok ? "" : during.hint), new RegExp(`result of the \`${ASK}\` call`));

  release!("yes");
  assert.equal((await asking).ok, true);
  // And the lock is released, so the app is drivable again.
  assert.equal((await driver.call("look")).ok, true);
});

// ---- the record ---------------------------------------------------------

test("the record keeps asked-and-answered apart from asked-and-ignored and never-put", async () => {
  // A question is a human interaction and belongs in the record as much as an
  // approval does. It needed no new field, which is the decision pinned here:
  // an `asked:` enum beside `approval` would be a second way to say what `ok`,
  // the slug and `waitedMs` already say, and a second way to say one thing is a
  // second thing to get wrong.
  //
  // `waitedMs` is the load-bearing one: present exactly when a question reached
  // somebody, which is what tells "asked and ignored" from "never put".
  const rows: AuditEvent[] = [];
  const onAudit = (e: AuditEvent): void => void rows.push(e);

  const answered = toy({ answer: () => "the one at Acme", onAudit });
  await answered.driver.call(ASK, { question: "which one?" });

  const ignored = toy({ answer: () => ({ answered: false }), onAudit });
  await ignored.driver.call(ASK, { question: "which one?" });

  const nobody = toy({ answer: () => ({ nobody: true }), onAudit });
  await nobody.driver.call(ASK, { question: "which one?" });

  const [a, b, c] = rows;
  for (const row of rows) {
    assert.equal(row.verb, ASK);
    assert.equal(row.kind, "ask");
    assert.equal(row.args.question, "which one?", "the question is in the record");
    // Nobody approved anything. A row in which a question could read as an
    // approval would be the bypass this feature was built not to be.
    assert.equal(row.approval, "not-asked");
  }
  assert.equal(a!.ok, true, "asked and answered");
  assert.notEqual(a!.waitedMs, undefined);
  assert.equal(b!.refused, "ask-unanswered", "asked and ignored");
  assert.notEqual(b!.waitedMs, undefined, "it was open, and for how long is the point");
  assert.equal(c!.refused, "nobody-to-ask", "never put");
  assert.equal(c!.waitedMs, undefined, "no question was open, so there was no wait");

  // The ANSWER'S TEXT is deliberately absent. `onAudit` is the one boundary a
  // record is most likely to leave the box across -- the argument
  // `ArgSpec.sensitive` is built on -- and an answer is free text a person
  // typed. What an auditor needs is that a question was asked, what it was, and
  // whether somebody answered; the words are in the transcript, which is the
  // artefact meant to hold what was said.
  assert.doesNotMatch(JSON.stringify(rows), /the one at Acme/);
});

// ---- additive -----------------------------------------------------------

test("an app that declares no ask hook has no ask verb and the same manifest version", async () => {
  // The additive promise as a number rather than a sentence. Every stored
  // `Manifest.version` out there was computed before this feature, and an
  // upgrade that moved them all would tell every agent its cached manifest had
  // gone stale when nothing about the app had changed.
  const base: MountOptions = {
    app: "Toy",
    visible: (): Snapshot => ({ where: "x", rev: 1 }),
    verbs: [{ name: "look", kind: "read", describe: "look", run: () => {} }],
  };
  const plain = mount(base);
  const asking = mount({ ...base, ask: () => "yes" });

  assert.equal(plain.manifest().verbs.some((v) => v.name === ASK), false);
  assert.equal(plain.manifest().verbs.some((v) => v.kind === "ask"), false);
  assert.equal(asking.manifest().verbs.some((v) => v.kind === "ask"), true);
  // The version MOVES for the app that declared one, because its surface
  // genuinely changed: there is a verb an agent can call that was not there
  // before. It does not move for the app that declared nothing.
  assert.notEqual(plain.manifest().version, asking.manifest().version);
  assert.equal(
    plain.manifest().version,
    mount(base).manifest().version,
    "an app that declares nothing new hashes exactly what it hashed before",
  );

  // And the guidance about asking is only rendered for the app that can.
  assert.doesNotMatch(systemPrompt(plain.manifest()), /ASK INSTEAD OF GUESSING/);
  assert.match(systemPrompt(asking.manifest()), /ASK INSTEAD OF GUESSING/);
  // Including the sentence that stops the misuse, in the cached half, so a
  // model does not learn it from a refusal after interrupting somebody.
  assert.match(systemPrompt(asking.manifest()), /never permission/);
});

test("an app that declares its own ask verb keeps it, and gets none of the core's guarantees", async () => {
  // The `goto` rule: reserved in the weak sense, so the app's meaning wins over
  // ours. What it loses is said out loud at mount, because an author with two
  // ways to ask the same person the same thing has one of them by accident.
  const warned: string[] = [];
  const was = console.warn;
  console.warn = (...parts: unknown[]) => void warned.push(parts.join(" "));
  try {
    const driver = mount({
      app: "Toy",
      visible: (): Snapshot => ({ where: "x", rev: 1 }),
      ask: () => "never called",
      verbs: [{ name: ASK, kind: "read", describe: "my own ask", run: () => {} }],
    });
    assert.equal(driver.manifest().verbs.find((v) => v.name === ASK)!.describe, "my own ask");
    assert.equal((await driver.call(ASK, {})).ok, true, "the app's verb ran, not a question");
    assert.ok(warned.some((w) => /also declares its own verb named `ask`/.test(w)));
  } finally {
    console.warn = was;
  }
});

test("the ask verb is offered no rev and no screen, so a question is never refused stale", async () => {
  // The one exception to hoisting the two claims onto every verb. A question
  // acts on no screen, so there is nothing for it to be stale about -- and the
  // system prompt tells a model to quote the `rev` it is acting on, so a model
  // that has read its instructions WILL pass one. Then the question is refused
  // `stale` because the person clicked a row while it was being composed, which
  // is the likeliest thing in the world when they are sitting right there. A
  // question refused for a reason that has nothing to do with the question is
  // the shape that teaches a model not to ask.
  const { driver } = toy({ answer: () => "yes" });
  const tools = toolsFor(driver.manifest());
  const asking = tools.find((t) => t.name === ASK)!;
  assert.deepEqual(Object.keys(asking.inputSchema.properties), ["question"]);
  assert.deepEqual(asking.inputSchema.required, ["question"]);
  // Every other verb still gets both.
  const look = tools.find((t) => t.name === "look")!;
  assert.ok("rev" in look.inputSchema.properties && "screen" in look.inputSchema.properties);

  // And the loop drops them rather than hoisting them, so a model that sends
  // one anyway is not punished for it.
  const { think } = scripted([
    { calls: [toolCall(ASK, { question: "which one?", rev: 999, screen: "elsewhere" })] },
    { text: "done" },
  ]);
  const out = await drive(driver, { think, task: "ask me something", pace: 0 });
  assert.equal(out.stop, "answered");
  const tool = out.messages.find((m) => m.role === "tool")!;
  assert.match(tool.text, /the person answered/);
});

test("the tool list does not change when a question is open, so the prompt prefix stays cached", async () => {
  // The constraint that outranks elegance, and the reason a panel cannot adopt
  // an ask hook the way it adopts the approval gate: `system` and `tools` are
  // byte-identical on every turn of a run. A verb that appeared when somebody
  // mounted a panel, or while a question was open, would be a tool list
  // changing underneath a running conversation.
  let release: ((a: AskAnswer) => void) | undefined;
  const { driver } = toy({ ask: () => new Promise<AskAnswer>((r) => (release = r)) });
  const before = JSON.stringify(toolsFor(driver.manifest()));
  const asking = driver.call(ASK, { question: "which one?" });
  await Promise.resolve();
  assert.equal(JSON.stringify(toolsFor(driver.manifest())), before);
  release!("yes");
  await asking;
  assert.equal(JSON.stringify(toolsFor(driver.manifest())), before);
});

test("an ask hook is not a declaration of who approves, so it does not make a driver publishable", async () => {
  // `connect()` reads `DriverApproval.declared`, which only `MountOptions
  // .approve` writes. An ask hook is a channel and not a gate, and a library
  // that let one satisfy the other would mean an app became publishable to an
  // outside agent by gaining the ability to ask questions.
  const driver = mount({
    app: "Toy",
    visible: (): Snapshot => ({ where: "x", rev: 1 }),
    ask: () => "yes",
    verbs: [{ name: "accept", kind: "commit", describe: "accept", run: () => {} }],
  });
  assert.equal(driver.approval!.declared, "none");
  assert.equal(driver.approval!.policy, "none");
});
