/**
 * These tests are the specification. Each name states the decision it pins, so
 * a future change that looks harmless has to break a named test and read why
 * the rule exists before deleting it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DECLINED, drive } from "../src/index.ts";
import type { CommitRequest, ToolCall, Turn } from "../src/index.ts";
import { call, contacts, scripted, TOTAL } from "./app.ts";

test("a multi-step run reaches a prose answer and the verbs actually ran", async () => {
  // The motivating case end to end: one describe, one commit, one answer. Note
  // what did NOT happen -- a thousand `select(id)` calls. The predicate was
  // resolved inside the app, where the rows already are, and the agent never
  // learned an id it did not need.
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme", limit: 1000 })] },
    { calls: [call("accept-selected")] },
    { text: "Accepted the top thousand Acme contacts." },
  ]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "find the Acme contacts and accept the top thousand",
  });

  assert.equal(out.stop, "answered");
  assert.equal(out.text, "Accepted the top thousand Acme contacts.");
  assert.equal(out.steps, 3);
  assert.equal(app.accepted().length, 1000);
});

test("the person's words and the screen arrive in one newest message, not in the system prompt", async () => {
  // The screen is the dynamic half. In the system prompt it would re-price the
  // whole cached prefix on every turn; in the newest message it costs what it
  // weighs. Sent with the task because "accept the top thousand" is not even
  // interpretable without knowing what is on screen.
  const app = contacts();
  const s = scripted([{ text: "ok" }]);
  await drive(app.driver, { think: s.think, task: "what am I looking at?" });

  const input = s.seen[0]!;
  assert.ok(!input.system.includes("c-1"), "a row id leaked into the cached half");
  assert.ok(!input.system.includes("rev 1"), "the screen leaked into the cached half");

  const first = input.messages[0]!;
  assert.equal(first.role, "user");
  assert.match((first as { text: string }).text, /what am I looking at\?/);
  assert.match((first as { text: string }).text, /where: contacts \(rev 1\)/);
  assert.match((first as { text: string }).text, /c-0 {3}Acme/);
  // And the window, said in words: the model is told more exists off screen
  // rather than being left to read `of 3412` as "I have all of them".
  assert.match((first as { text: string }).text, /rows 1-20 of 3412/);
  assert.match((first as { text: string }).text, /more rows exist off screen/);
});

test("the system prompt and the tool list are byte-identical on every turn", async () => {
  // The single rule that makes the loop cheap. One per-turn string in the
  // static half -- a clock, a step counter, the screen -- busts the prefix
  // cache on every turn, and nothing breaks, so nothing tells you. This test
  // tells you.
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { calls: [call("open", { id: "c-1" })] },
    { calls: [call("read_screen")] },
    { text: "done" },
  ]);

  await drive(app.driver, { think: s.think, task: "look around", instructions: "Be terse." });

  assert.equal(s.seen.length, 4);
  for (const input of s.seen.slice(1)) {
    assert.equal(input.system, s.seen[0]!.system, "the system prompt moved between turns");
    assert.equal(
      JSON.stringify(input.tools),
      JSON.stringify(s.seen[0]!.tools),
      "the tool list moved between turns",
    );
  }
  // And the app's own static guidance is in there, since that is the one thing
  // a host may add to the cached half.
  assert.match(s.seen[0]!.system, /Be terse\./);
});

test("the tool list is built from the manifest, carrying kind and refuses", async () => {
  const app = contacts();
  const s = scripted([{ text: "ok" }]);
  await drive(app.driver, { think: s.think, task: "hello" });

  const byName = Object.fromEntries(s.seen[0]!.tools.map((t) => [t.name, t]));

  // `commit` is shouted, high in the description, because a model skimming the
  // first two lines must not miss that a verb is irreversible.
  assert.match(byName["accept-selected"]!.description, /COMMIT: THIS CHANGES DATA/);
  assert.match(byName["select-where"]!.description, /DESCRIBE: this changes what is SELECTED/);
  assert.match(byName["open"]!.description, /READ-ONLY: this changes nothing/);

  // The refusals are in the cached half, which is the entire point of the
  // field: a well-briefed agent never makes the call.
  assert.match(byName["accept-selected"]!.description, /May refuse: nothing-selected/);

  // `oneOf`-free args still carry their describe, and `rev` is hoisted in.
  assert.equal(byName["open"]!.inputSchema.properties.id!.type, "string");
  assert.deepEqual(byName["open"]!.inputSchema.required, ["id"]);
  assert.equal(byName["open"]!.inputSchema.properties.rev!.type, "integer");

  // The protocol's own read is offered and is not an app verb.
  assert.ok(byName["read_screen"], "read_screen was not offered");
});

test("the snapshot after a call is fed back as the tool result, with no second read", async () => {
  // `Result` carries the post-call screen so acting and observing are one
  // round trip. A loop that followed each verb with a read would hand that
  // saving straight back, and with ten steps that is ten wasted model turns.
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { text: "two of them" },
  ]);

  let driverReads = 0;
  const counted = {
    ...app.driver,
    snapshot: () => {
      driverReads++;
      return app.driver.snapshot();
    },
  };

  await drive(counted, { think: s.think, task: "how many Acme contacts?" });

  const toolTurn = s.seen[1]!.messages.find((m) => m.role === "tool") as
    | { role: "tool"; text: string }
    | undefined;
  assert.ok(toolTurn, "no tool result was fed back");
  assert.match(toolTurn!.text, /^ok — 3412 matched\n/);
  assert.match(toolTurn!.text, /where: contacts, filtered to Acme \(rev 2\)/);
  // Only what is on screen, even though 3,412 rows are selected. The number
  // selected is not in the snapshot and cannot be -- it comes back as `count`.
  assert.match(toolTurn!.text, /selected: c-0, c-1, c-2/);

  // One read, for the opening user turn. The post-call screen came off the
  // Result, not off a second look.
  assert.equal(driverReads, 1, "the loop read the screen again after a verb");
});

test("a describe verb's count is put in front of the model before any commit", async () => {
  // The motivating failure is accepting fifty thousand rows because a filter
  // was wider than anybody thought. The count is the number a person would
  // have to see before pressing the button, so it is high up and separated out
  // rather than folded into prose.
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme", limit: 1000 })] },
    { text: "1,000 selected of 3,412 matching, which is what you asked for" },
  ]);

  await drive(app.driver, { think: s.think, task: "select the top thousand Acme contacts" });

  const toolTurn = s.seen[1]!.messages.find((m) => m.role === "tool") as { text: string };
  // The count is the verb's own Report, forwarded by the core. It cannot be
  // inferred from the screen: twenty rows are visible and `page.total` is
  // 3,412, which describes the table and not the selection.
  assert.match(toolTurn.text, /\ncount: 1,000 matched\n/);
  assert.match(toolTurn.text, /Check it is the number you expect before committing/);
  assert.match(toolTurn.text, /^ok — 3412 matched\n/);
  assert.equal(app.accepted().length, 0, "nothing irreversible happened during a describe");
});

test("a describe verb that matched nothing reports 0, which is not the same as saying nothing", async () => {
  // The distinction the core keeps and this loop must not flatten. "I looked
  // and found none" says do not commit; "I do not report counts" says ask.
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Globex" })] },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /\ncount: 0 matched\n/);
      return { text: "Nothing matched, so I have not accepted anything." };
    },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "accept the Globex contacts" });
  assert.equal(out.stop, "answered");
  assert.equal(app.accepted().length, 0);
});

test("a read verb reports no count at all, rather than a zero that means nothing", async () => {
  const app = contacts();
  const s = scripted([{ calls: [call("open", { id: "c-0" })] }, { text: "opened" }]);
  await drive(app.driver, { think: s.think, task: "open the first contact" });

  const toolTurn = s.seen[1]!.messages.find((m) => m.role === "tool") as { text: string };
  assert.equal(toolTurn.text.startsWith("ok\n\n"), true);
  assert.ok(!/count:/.test(toolTurn.text), "a verb that does not count was given a count");
});

test("a refusal is fed back as information and the model recovers from it", async () => {
  const app = contacts();
  const s = scripted([
    { calls: [call("accept-selected")] }, // nothing selected yet
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /refused: nothing-selected/);
      assert.match(last.text, /hint: select something first/);
      // Not dressed up as an error. A refusal in alarm language mostly teaches
      // a model to retry the same call.
      assert.ok(!/error/i.test(last.text), "the refusal was rendered as an error");
      return { calls: [call("select-where", { where: "company=Acme" })] };
    },
    { calls: [call("accept-selected")] },
    { text: "done" },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "accept the Acme contacts" });

  assert.equal(out.stop, "answered");
  assert.equal(app.accepted().length, TOTAL);
});

test("the same verb refused the same way three times stops the loop", async () => {
  // A refusal is information to adapt to, but adapting forever is not
  // adapting. Three identical answers means the model has stopped learning,
  // and continuing spends the person's money to watch nothing happen.
  const app = contacts();
  const s = scripted([
    { calls: [call("accept-selected")] },
    { calls: [call("accept-selected")] },
    { calls: [call("accept-selected")] },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "accept them" });

  assert.equal(out.stop, "stuck");
  assert.equal(out.steps, 3);
  assert.equal(s.seen.length, 3, "the loop asked for a fourth turn after giving up");
  // The reason is written into the transcript, so a caller that resumes this
  // conversation later hands the model a history explaining the gap.
  const last = out.messages[out.messages.length - 1] as { text: string };
  assert.match(last.text, /refused `nothing-selected` 3 times/);
});

test("identical refusals are counted across the run, not merely consecutively", async () => {
  // A model that alternates a refused commit with a free read has not learned
  // anything; it has put a cheap call between two expensive mistakes.
  const app = contacts();
  const s = scripted([
    { calls: [call("accept-selected")] },
    { calls: [call("read_screen")] },
    { calls: [call("accept-selected")] },
    { calls: [call("read_screen")] },
    { calls: [call("accept-selected")] },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "accept them" });
  assert.equal(out.stop, "stuck");
});

test("two different refusals from one verb do not count as being stuck", async () => {
  // The limit is per (verb, slug) pair. A verb that refuses for a new reason
  // each time is a model making progress through an app's rules, and stopping
  // it would be stopping the thing refusals exist to enable.
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "nonsense" })] }, // bad-predicate
    { calls: [call("select-where", {})] }, // bad-argument: missing `where`
    { calls: [call("select-where", { where: "company=Acme" })] },
    { text: "selected" },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "select Acme" });
  assert.equal(out.stop, "answered");
});

test("max steps is enforced, because a loop inside someone's page must end", async () => {
  const app = contacts();
  const s = scripted([
    { calls: [call("read_screen")] },
    { calls: [call("read_screen")] },
    { calls: [call("read_screen")] },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "look", maxSteps: 2 });

  assert.equal(out.stop, "max-steps");
  assert.equal(out.steps, 2);
  assert.equal(s.seen.length, 2, "the cap was checked after the model call instead of before");
});

test("aborting mid-run abandons the model's calls unrun", async () => {
  // An abort that still commits is not an abort. `think` is the slow part of a
  // step and exactly where a person hits stop, so the signal is re-checked
  // after it returns and again before each call in a multi-call turn.
  const app = contacts();
  const controller = new AbortController();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    () => {
      controller.abort();
      return { calls: [call("accept-selected")] };
    },
  ]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "accept the Acme contacts",
    signal: controller.signal,
  });

  assert.equal(out.stop, "aborted");
  assert.deepEqual(app.accepted(), [], "a commit ran after the run was aborted");
});

test("the abort signal is handed to think so an in-flight request can be torn down", async () => {
  const app = contacts();
  const controller = new AbortController();
  const s = scripted([{ text: "ok" }]);
  await drive(app.driver, { think: s.think, task: "hi", signal: controller.signal });
  assert.equal(s.seen[0]!.signal, controller.signal);
});

test("an already-aborted run makes no model call at all", async () => {
  const app = contacts();
  const controller = new AbortController();
  controller.abort();
  const s = scripted([{ text: "should not be reached" }]);

  const out = await drive(app.driver, { think: s.think, task: "hi", signal: controller.signal });
  assert.equal(out.stop, "aborted");
  assert.equal(out.steps, 0);
  assert.equal(s.seen.length, 0);
});

test("onBeforeCommit can veto, and the veto reaches the model as a refusal not a crash", async () => {
  const app = contacts();
  const asked: CommitRequest[] = [];
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { calls: [call("accept-selected")] },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, new RegExp(`refused: ${DECLINED}`));
      assert.match(last.text, /declined/);
      // The screen is still there. A vetoed commit is an ordinary Result, so
      // the model is not left guessing what state the app is in.
      assert.match(last.text, /where: contacts, filtered to Acme/);
      return { text: "You declined that. Want me to narrow it first?" };
    },
  ]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "accept the Acme contacts",
    onBeforeCommit: (req) => {
      asked.push(req);
      return false;
    },
  });

  assert.equal(out.stop, "answered");
  assert.deepEqual(app.accepted(), [], "the veto did not actually hold");
  assert.equal(asked.length, 1);
  // The gate is given the manifest entry and the live screen, so a host can
  // word its confirmation in the app's own vocabulary and show the selection
  // the commit is about to act on.
  assert.equal(asked[0]!.verb.describe, "accept the current selection");
  assert.deepEqual(asked[0]!.snapshot.selected, ["c-0", "c-1", "c-2"]);
});

test("a vetoing string becomes the hint the model is told", async () => {
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { calls: [call("accept-selected")] },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /hint: not until finance signs off/);
      return { text: "understood" };
    },
  ]);

  await drive(app.driver, {
    think: s.think,
    task: "accept them",
    onBeforeCommit: () => "not until finance signs off",
  });
  assert.deepEqual(app.accepted(), []);
});

test("a confirmation UI that throws is a no, not consent and not a dead run", async () => {
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { calls: [call("accept-selected")] },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /could not be shown \(modal exploded\)/);
      return { text: "I could not ask you, so I stopped." };
    },
  ]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "accept them",
    onBeforeCommit: () => {
      throw new Error("modal exploded");
    },
  });

  assert.equal(out.stop, "answered");
  assert.deepEqual(app.accepted(), [], "a failed ask was treated as consent");
});

test("the gate is only in front of commit verbs, so a describe is not a prompt storm", async () => {
  const app = contacts();
  let asks = 0;
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { calls: [call("open", { id: "c-1" })] },
    { calls: [call("read_screen")] },
    { text: "done" },
  ]);

  await drive(app.driver, {
    think: s.think,
    task: "look at Acme",
    onBeforeCommit: () => {
      asks++;
      return true;
    },
  });
  assert.equal(asks, 0);
});

test("onBeforeCommit returning true lets the commit through", async () => {
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" })] },
    { calls: [call("accept-selected")] },
    { text: "accepted" },
  ]);
  await drive(app.driver, { think: s.think, task: "accept", onBeforeCommit: () => true });
  assert.equal(app.accepted().length, TOTAL);
});

test("a hoisted rev turns acting on a moved screen into a stale refusal", async () => {
  // In-page this is not the rare case the relay makes it look like: the person
  // is sitting right there, clicking, while the model thinks.
  const app = contacts();
  const s = scripted([
    (input) => {
      // The model read `rev 1` off the opening turn, then the person clicked.
      void input;
      void app.driver.call("open", { id: "c-3" });
      return { calls: [call("accept-selected", { rev: 1 })] };
    },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /refused: stale/);
      assert.match(last.text, /read again/);
      return { text: "the screen moved under me" };
    },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "accept them" });
  assert.equal(out.stop, "answered");
  assert.deepEqual(app.accepted(), []);
});

test("rev is not passed on as an app argument", async () => {
  // It is `CallOptions.rev`, hoisted into the schema because a model has
  // nowhere else to put it. Leaking it into `args` would make every verb's
  // argument check see a field the app never declared.
  const app = contacts();
  const seen: Array<Record<string, unknown>> = [];
  const spy = {
    ...app.driver,
    call: (name: string, args?: Record<string, never>, opts?: { rev?: number }) => {
      seen.push({ name, args, opts });
      return app.driver.call(name, args, opts);
    },
  };
  const s = scripted([{ calls: [call("open", { id: "c-1", rev: 1 })] }, { text: "ok" }]);

  await drive(spy as never, { think: s.think, task: "open c-1" });

  assert.deepEqual(seen[0]!.args, { id: "c-1" });
  assert.deepEqual(seen[0]!.opts, { rev: 1 });
});

test("a tool name the manifest does not have lists the ones that do", async () => {
  // A model may be working from a stale cached manifest, or may have invented
  // a verb. The known names are listed so the fix happens on the next turn
  // rather than after another read.
  const app = contacts();
  const s = scripted([
    { calls: [call("delete-everything")] },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /no such tool `delete-everything`/);
      assert.match(last.text, /accept-selected, open, read_screen, select-where/);
      return { text: "I cannot do that here." };
    },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "delete everything" });
  assert.equal(out.stop, "answered");
});

test("read_screen reads the screen and nothing else", async () => {
  const app = contacts();
  const s = scripted([
    { calls: [call("read_screen")] },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      // The bare screen, with no "ok" banner: nothing happened, so there is no
      // outcome to report.
      assert.match(last.text, /^where: contacts \(rev 1\)/);
      return { text: `${TOTAL} contacts` };
    },
  ]);

  await drive(app.driver, { think: s.think, task: "what is on screen?" });
  assert.equal(app.rev(), 1, "read_screen changed something");
});

test("several calls in one turn run in order and each gets its own tool turn", async () => {
  const app = contacts();
  const s = scripted([
    { calls: [call("select-where", { where: "company=Acme" }), call("accept-selected")] },
    { text: "done" },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "select and accept Acme" });

  assert.equal(out.stop, "answered");
  assert.equal(app.accepted().length, TOTAL);
  const toolTurns = s.seen[1]!.messages.filter((m) => m.role === "tool") as Array<{
    callId: string;
    name: string;
  }>;
  assert.deepEqual(
    toolTurns.map((t) => t.name),
    ["select-where", "accept-selected"],
  );
  // Each tool turn carries the id the model gave that call. Vendors correlate
  // on it and a mismatch is rejected at the API, not noticed here.
  const asked = (out.messages.find((m) => m.role === "assistant" && m.calls) as {
    calls: ToolCall[];
  }).calls;
  assert.deepEqual(
    toolTurns.map((t) => t.callId),
    asked.map((c) => c.id),
  );
});

test("events let a UI render progress without the loop knowing about any UI", async () => {
  const app = contacts();
  const log: string[] = [];
  const s = scripted([
    { text: "selecting", calls: [call("select-where", { where: "company=Acme", limit: 1000 })] },
    { calls: [call("accept-selected")] },
    { text: "done" },
  ]);

  await drive(app.driver, {
    think: s.think,
    task: "accept Acme",
    onStep: (e) => log.push(`step ${e.step}`),
    onSay: (e) => log.push(`say ${e.text}`),
    onCall: (e) => log.push(`call ${e.call.name} ${e.kind}`),
    onResult: (e) => log.push(`result ${e.call.name} ${e.result?.ok}`),
    onStop: (e) => log.push(`stop ${e.stop} after ${e.steps}`),
  });

  assert.deepEqual(log, [
    "step 1",
    "say selecting",
    "call select-where describe",
    "result select-where true",
    "step 2",
    "call accept-selected commit",
    "result accept-selected true",
    "step 3",
    "say done",
    "stop answered after 3",
  ]);
});

test("onStop fires for every ending, including the ones nobody chose", async () => {
  const app = contacts();
  const stops: string[] = [];
  await drive(app.driver, {
    think: scripted([{ calls: [call("read_screen")] }]).think,
    task: "look",
    maxSteps: 1,
    onStop: (e) => stops.push(e.stop),
  });
  assert.deepEqual(stops, ["max-steps"]);
});

test("think returning neither prose nor calls is reported as silent, not as an answer", async () => {
  // A broken adapter, almost always. Calling it `answered` would show the
  // person an empty bubble and tell whoever wrote `think` nothing.
  const app = contacts();
  const out = await drive(app.driver, { think: scripted([{}]).think, task: "hi" });
  assert.equal(out.stop, "silent");
  assert.equal(out.text, undefined);
});

test("the conversation is the caller's array, so a second run continues the first", async () => {
  // The loop keeps no state between runs. That is what lets a widget hold one
  // conversation and a server hold another without this package inventing a
  // session concept.
  const app = contacts();
  const first = await drive(app.driver, {
    think: scripted([{ text: "two Acme contacts" }]).think,
    task: "how many Acme contacts?",
  });

  const s = scripted([{ text: "now accepted" }]);
  const second = await drive(app.driver, {
    think: s.think,
    history: first.messages,
    task: "accept them",
  });

  const roles = s.seen[0]!.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);
  assert.equal(second.messages.length, first.messages.length + 2);
});

test("only the newest user turn carries a screen; older ones say theirs is gone", async () => {
  // Two costs, and the second is the one that worries: old screen blocks are
  // bytes in the uncached half paid for on every turn forever, and a model
  // that reads a four-messages-ago screen as current acts on rows that have
  // moved. The replacement line matters too -- a user turn with no screen at
  // all reads as a turn where the screen was empty.
  const app = contacts();
  const first = await drive(app.driver, {
    think: scripted([{ text: "3,412 of them" }]).think,
    task: "how many Acme contacts?",
  });

  const s = scripted([{ text: "selected" }]);
  const second = await drive(app.driver, {
    think: s.think,
    history: first.messages,
    task: "select the top thousand",
  });

  const users = s.seen[0]!.messages.filter((m) => m.role === "user") as Array<{ text: string }>;
  assert.equal(users.length, 2);
  assert.ok(!users[0]!.text.includes("On screen now:"), "an older screen was still in the tail");
  assert.match(users[0]!.text, /how many Acme contacts\?/);
  assert.match(users[0]!.text, /no longer shown; only the newest screen/);
  assert.match(users[1]!.text, /On screen now:\nwhere: contacts \(rev 1\)/);

  // The messages handed back are already pruned, so a conversation carried
  // across many runs does not re-accumulate what this just removed.
  const kept = second.messages.filter((m) => m.role === "user") as Array<{ text: string }>;
  assert.ok(!kept[0]!.text.includes("On screen now:"));
});

test("pruning cuts only what the loop added, never the person's own words", async () => {
  const app = contacts();
  const s = scripted([{ text: "ok" }]);
  // A person who types the marker text themselves must keep it. The seam is a
  // line this file wrote, matched exactly, rather than a guess at where prose
  // ends.
  await drive(app.driver, {
    think: s.think,
    history: [{ role: "user", text: "tell me what is On screen now: please" }],
    task: "and now?",
  });

  const users = s.seen[0]!.messages.filter((m) => m.role === "user") as Array<{ text: string }>;
  assert.equal(users[0]!.text, "tell me what is On screen now: please");
});

test("a run with no task continues a history that already ends in a user turn", async () => {
  const app = contacts();
  const history: Turn[] = [{ role: "user", text: "accept the Acme contacts" }];
  const s = scripted([{ text: "ok" }]);
  await drive(app.driver, { think: s.think, history });
  assert.deepEqual(s.seen[0]!.messages, history);
  // And the caller's array was not mutated under it.
  assert.equal(history.length, 1);
});

test("think is handed a copy of the messages, not the loop's own array", async () => {
  // A fetch-based `think` serialises and forgets, but a recorder or a
  // middleware keeps the array, and handing out the live one means a later
  // push mutates something the caller believes it owns.
  const app = contacts();
  const kept: Turn[][] = [];
  const out = await drive(app.driver, {
    task: "look",
    think: async ({ messages }) => {
      kept.push(messages);
      return kept.length === 1 ? { calls: [call("read_screen")] } : { text: "done" };
    },
  });

  assert.equal(kept[0]!.length, 1);
  assert.equal(kept[1]!.length, 3);
  assert.notEqual(kept[0], out.messages);
});

test("a verb that throws comes back as a refusal and the run carries on", async () => {
  // The core turns a thrown verb into `threw` rather than letting it
  // propagate. The loop must treat that like any other refusal: an app bug
  // should not take down the panel the person is typing into.
  const { mount } = await import("../../core/src/registry.ts");
  const driver = mount({
    app: "Fragile",
    visible: () => ({ where: "x", rev: 1 }),
    verbs: [
      { name: "boom", kind: "read", describe: "always throws", run: () => { throw new Error("kaboom"); } },
      { name: "fine", kind: "read", describe: "works", run: () => {} },
    ],
  });

  const s = scripted([
    { calls: [call("boom")] },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /refused: threw/);
      assert.match(last.text, /kaboom/);
      return { calls: [call("fine")] };
    },
    { text: "worked around it" },
  ]);

  const out = await drive(driver, { think: s.think, task: "try it" });
  assert.equal(out.stop, "answered");
});

/**
 * Every `tool_use` in `messages` has a tool turn answering it.
 *
 * Not a nicety about transcript tidiness. `DriveOutcome.messages` is documented
 * as the next run's `history`, and every tool-use API — Anthropic's included —
 * rejects a conversation holding a `tool_use` block with no matching result. A
 * run that leaves one behind poisons the caller's conversation permanently.
 */
function unanswered(messages: Turn[]): string[] {
  const answered = new Set(
    messages.filter((m) => m.role === "tool").map((m) => (m as { callId: string }).callId),
  );
  const asked = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (m as { calls?: ToolCall[] }).calls ?? []);
  return asked.filter((c) => !answered.has(c.id)).map((c) => `${c.name}#${c.id}`);
}

test("a stuck run answers the calls it abandoned, so the conversation stays usable", async () => {
  // The fan-out is the dangerous shape: three calls in one assistant turn, the
  // loop stops at the first, and two `tool_use` blocks are left with no result.
  // Before this fix a single `stuck` run meant the widget's own conversation
  // was rejected with a 400 from then on, forever, with nothing on screen to
  // say why.
  const app = contacts();
  const s = scripted([
    {
      calls: [
        call("select-where", { where: "nonsense" }),
        call("accept-selected"),
        call("open", { id: "c-1" }),
      ],
    },
  ]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "accept the Acme contacts",
    refusalLimit: 1,
  });

  assert.equal(out.stop, "stuck");
  assert.deepEqual(unanswered(out.messages), []);
  // And the abandoned calls did not run: the gap is in the transcript, not in
  // the app's data.
  assert.deepEqual(app.accepted(), []);
  const last = out.messages[out.messages.length - 1] as { text: string; name: string };
  assert.equal(last.name, "open");
  assert.match(last.text, /not run/);
  assert.match(last.text, /nothing changed/);
  // Worded as a decision rather than a failure. "error" invites a retry of a
  // call the loop deliberately declined to make.
  assert.match(last.text, /must not be retried/);
});

test("an abort mid-fan-out answers the calls it abandoned, before and during the turn", async () => {
  // Two abort seams, and both used to leave `tool_use` blocks hanging: the
  // check after `think` returns (all the calls abandoned) and the check inside
  // the fan-out (the rest of them abandoned). A person hitting stop must not
  // break the conversation they are going to carry on using.
  const app = contacts();
  const controller = new AbortController();
  const s = scripted([
    () => {
      // Aborts while the model is "thinking": the assistant turn with three
      // calls still lands in `messages`, and none of them will run.
      controller.abort();
      return {
        calls: [
          call("select-where", { where: "company=Acme" }),
          call("accept-selected"),
          call("open", { id: "c-1" }),
        ],
      };
    },
  ]);

  const out = await drive(app.driver, {
    think: s.think,
    task: "accept them",
    signal: controller.signal,
  });

  assert.equal(out.stop, "aborted");
  assert.deepEqual(unanswered(out.messages), []);
  assert.deepEqual(app.accepted(), [], "a commit ran after the run was aborted");
  for (const turn of out.messages.filter((m) => m.role === "tool")) {
    assert.match((turn as { text: string }).text, /the person stopped this run/);
  }

  // The other seam: the first call runs, the person stops, the rest are
  // abandoned part way through the same turn.
  const app2 = contacts();
  const c2 = new AbortController();
  const s2 = scripted([
    {
      calls: [
        call("select-where", { where: "company=Acme" }),
        call("accept-selected"),
        call("open", { id: "c-1" }),
      ],
    },
  ]);
  const out2 = await drive(app2.driver, {
    think: s2.think,
    task: "accept them",
    signal: c2.signal,
    onResult: () => c2.abort(),
  });

  assert.equal(out2.stop, "aborted");
  assert.deepEqual(unanswered(out2.messages), []);
  assert.deepEqual(app2.accepted(), [], "the commit ran after the stop button");
});

test("the messages a stuck run hands back are a conversation a second run can continue", async () => {
  // The promise `DriveOutcome.messages` makes, exercised rather than assumed.
  // The second run is handed the first run's transcript as `history`, and the
  // model must find the abandoned calls answered — which is also the only way
  // it learns that its own third call never happened.
  const app = contacts();
  const first = await drive(app.driver, {
    think: scripted([
      {
        calls: [
          call("select-where", { where: "nonsense" }),
          call("accept-selected"),
          call("open", { id: "c-1" }),
        ],
      },
    ]).think,
    task: "accept the Acme contacts",
    refusalLimit: 1,
  });
  assert.equal(first.stop, "stuck");

  const s = scripted([
    (input) => {
      assert.deepEqual(unanswered(input.messages), []);
      const texts = input.messages
        .filter((m) => m.role === "tool")
        .map((m) => (m as { text: string }).text);
      assert.equal(texts.length, 3, "the model was not told what became of every call");
      assert.ok(
        texts.some((t) => /not run/.test(t)),
        "the model was not told that two of its calls never ran",
      );
      return { calls: [call("select-where", { where: "company=Acme" })] };
    },
    { text: "Selected the Acme contacts." },
  ]);

  const second = await drive(app.driver, {
    think: s.think,
    task: "try the predicate the app actually understands",
    history: first.messages,
  });

  assert.equal(second.stop, "answered");
  assert.deepEqual(unanswered(second.messages), []);
});

test("a rev sent as a numeric string is the same claim as the number", async () => {
  // Models answer `{"rev": "9"}`, and that is ordinary behaviour rather than a
  // mistake. Dropping it left `rev` undefined, which the core reads as "opt out
  // of the staleness check" — so the one case the check exists for, a person
  // clicking while the model thinks, came back `ok` instead of `stale`.
  const app = contacts();
  const s = scripted([
    () => {
      void app.driver.call("open", { id: "c-3" });
      return { calls: [call("accept-selected", { rev: "1" })] };
    },
    (input) => {
      const last = input.messages[input.messages.length - 1] as { text: string };
      assert.match(last.text, /refused: stale/);
      return { text: "the screen moved under me" };
    },
  ]);

  const out = await drive(app.driver, { think: s.think, task: "accept them" });
  assert.equal(out.stop, "answered");
  assert.deepEqual(app.accepted(), [], "a string rev silently turned the staleness check off");
});

test("a rev that is not a whole number is refused, never silently dropped", async () => {
  // A safety check that disables itself on a type coercion is worse than no
  // check: the transcript says `ok` for a call that acted on a screen the model
  // never saw. `""` and `true` matter most here, because `Number("")` is `0`
  // and `Number(true)` is `1` — a permissive coercion turns "I did not read a
  // rev" into a confident claim about a screen that never existed.
  for (const junk of ["abc", "3.7", "", " ", true, 3.7]) {
    const app = contacts();
    const s = scripted([
      { calls: [call("accept-selected", { rev: junk as never })] },
      (input) => {
        const last = input.messages[input.messages.length - 1] as { text: string };
        assert.match(last.text, /refused: bad-argument/, `rev ${JSON.stringify(junk)} got through`);
        assert.match(last.text, /whole number/);
        return { text: "I will read the screen again." };
      },
    ]);

    const out = await drive(app.driver, { think: s.think, task: "accept them" });
    assert.equal(out.stop, "answered");
    assert.deepEqual(app.accepted(), [], `rev ${JSON.stringify(junk)} let a commit through`);
  }
});

test("an absent rev still opts out of the staleness check, and null counts as absent", async () => {
  // The other half of the rule, pinned so a stricter reading of the fix above
  // cannot quietly make `rev` mandatory. Omitting it is a documented choice; a
  // vendor serialising an omitted optional field as `null` has said nothing,
  // not something wrong.
  for (const rev of [undefined, null]) {
    const app = contacts();
    const s = scripted([
      () => {
        void app.driver.call("open", { id: "c-3" });
        return {
          calls: [
            call("select-where", { where: "company=Acme", limit: 2 }),
            call("accept-selected", rev === undefined ? {} : { rev }),
          ],
        };
      },
      { text: "done" },
    ]);

    const out = await drive(app.driver, { think: s.think, task: "accept two" });
    assert.equal(out.stop, "answered");
    assert.equal(app.accepted().length, 2, `rev ${String(rev)} was treated as a claim`);
  }
});
