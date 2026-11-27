/**
 * Surviving a page reload. These tests are the specification.
 *
 * A reload is simulated by dropping the panel and mounting a fresh one against
 * the SAME `session` storage, which is exactly what a browser does: the page's
 * JavaScript is gone, `sessionStorage` is not. Nothing here fakes a navigation,
 * and nothing needs to — the whole mechanism is one key in one storage, and the
 * question every test below asks is what the next page load makes of it.
 *
 * The rule under test, in one line: **restore everything, resume nothing.**
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../src/core/registry.ts";
import type { Driver, Snapshot } from "../src/core/types.ts";
import type { Think, ThinkInput, Turn } from "../src/agent/types.ts";
import { mountWidget } from "../src/widget/index.ts";
import type { AskHook } from "../src/core/index.ts";
import type { WidgetOptions } from "../src/widget/index.ts";
import {
  CHAT_VERSION,
  chatKey,
  closeDangling,
  scrubTurns,
  trimTurns,
} from "../src/widget/chat.ts";
import { FakeDocument, FakeNode, FakeStorage, instant } from "./fake-dom.ts";

/**
 * A contacts app with a gated bulk commit and one secret-bearing verb.
 *
 * `sign-off` exists only so there is an `ArgSpec.sensitive` to leak. It is a
 * `read` so it needs no approval and no plan: the test is about what reaches
 * storage, not about the gate.
 */
function contacts(options: Partial<Parameters<typeof mount>[0]> = {}): {
  driver: Driver;
  accepted: () => number;
  stall: (on: boolean) => void;
} {
  let rev = 1;
  let selected = 0;
  let accepted = 0;
  let stalled = false;
  const visible = (): Snapshot => ({
    where: "contacts",
    screen: "contacts",
    rev,
    rows: [{ id: "c-0", company: "Acme" }],
    page: { index: 0, size: 1, total: 3412 },
    selectedCount: selected,
  });
  const driver = mount({
    ...options,
    app: "Contacts",
    visible,
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select every contact matching a filter",
        args: { where: { type: "string", describe: "e.g. company=Acme" } },
        run: () => {
          selected = 3412;
          rev++;
          return { count: 3412 };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept every selected contact",
        run: () => {
          accepted += selected;
          rev++;
          return { note: `${selected} accepted` };
        },
      },
      {
        // The plan-consuming twin, for the one test about what a reload does to
        // a plan token. Kept separate from `accept-selected` so the gate tests
        // above can commit without minting a receipt first.
        name: "accept-planned",
        kind: "commit",
        describe: "accept every selected contact, with a plan",
        consumes: "plan",
        run: () => {
          accepted += selected;
          rev++;
        },
      },
      {
        name: "sign-off",
        kind: "read",
        describe: "record an approval code",
        args: {
          code: { type: "string", describe: "the approval code", sensitive: true },
          note: { type: "string", describe: "anything else", optional: true },
        },
        // A verb that never answers while `stalled`, which is how a test puts
        // a call genuinely in flight when the page "reloads".
        run: async () => {
          if (stalled) await new Promise(() => {});
        },
      },
    ],
  });
  return { driver, accepted: () => accepted, stall: (on) => void (stalled = on) };
}

function scripted(script: unknown[]): { think: Think; seen: ThinkInput[] } {
  const seen: ThinkInput[] = [];
  let i = 0;
  return {
    seen,
    think: async (input) => {
      seen.push(input);
      const step = script[i++];
      if (step === undefined) throw new Error("reload think ran out of script");
      return (typeof step === "function" ? step() : step) as Awaited<ReturnType<Think>>;
    },
  };
}

/** One page load: a fresh document and a fresh panel, over storage that
 *  outlives both. Call it twice with the same `session` and the second call is
 *  a reload. */
function load(
  driver: Driver,
  script: unknown[],
  session: FakeStorage,
  options: Partial<WidgetOptions> & { remember?: boolean } = {},
) {
  const doc = new FakeDocument();
  const s = scripted(script);
  const { remember = true, ...rest } = options;
  const widget = mountWidget(driver, {
    think: s.think,
    document: doc,
    clock: instant,
    open: true,
    // Spread as a key only when it is true, because the opted-out case is the
    // ABSENCE of the field and `exactOptionalPropertyTypes` makes those two
    // different things -- which is the distinction one test below is about.
    ...(remember ? { rememberChat: true } : {}),
    session,
    ...rest,
  });
  return { doc, s, widget, host: doc.host() };
}

async function ask(host: FakeNode, text: string): Promise<void> {
  host.one("dk-input").value = text;
  host.one("dk-form").dispatch("submit");
  await settle();
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every line of the transcript, as text. */
function transcript(host: FakeNode): string {
  return host
    .one("dk-log")
    .children.map((c) => c.textContent ?? "")
    .join("\n");
}

function stored(session: FakeStorage): {
  messages: Turn[];
  inFlight?: { verb: string; phase: string };
  conversed: boolean;
} {
  return JSON.parse(session.items.get(chatKey("Contacts")) ?? "null");
}

// -------------------------------------------------------------------------
// The two the brief names, first.
// -------------------------------------------------------------------------

test("a reload with a commit in flight comes back saying so, naming the verb, and resumes nothing", async () => {
  // THE CASE THE WHOLE FEATURE IS SHAPED BY. Storage can record that a call
  // was STARTED. It cannot record whether it LANDED -- that answer is on the
  // server, and the page waiting for it is gone. So the one thing the panel
  // must not do is guess, in either direction: a run that auto-resumed would
  // either repeat a commit that already happened or skip one that did not, and
  // both are what the plan token exists to prevent.
  const app = contacts();
  const session = new FakeStorage();

  // A call that goes out and never answers, which is a page dying mid-commit
  // as far as everything above `driver.call()` can tell.
  app.stall(true);
  const first = load(
    app.driver,
    [{ calls: [{ id: "a", name: "sign-off", args: { code: "hunter2" } }] }],
    session,
  );
  await ask(first.host, "sign this off");
  await settle();

  // The record says a call is in flight, by name and in the `sent` phase.
  assert.equal(stored(session).inFlight?.verb, "sign-off");
  assert.equal(stored(session).inFlight?.phase, "sent");

  // The page goes away mid-call. No unmount: a reload does not run cleanup,
  // which is exactly why the record has to be written as it goes rather than
  // at teardown.
  const back = load(app.driver, [{ text: "never asked" }], session);
  const text = transcript(back.host);

  // Named, because "a call was in flight" sends somebody to look at the whole
  // app and "`sign-off` was in flight" sends them to one screen.
  assert.match(text, /The page reloaded while `sign-off` was running\./);
  assert.match(text, /cannot tell whether it took effect/);
  assert.match(text, /Check the app before doing anything else\./);
  // And the half that says nothing is happening now.
  assert.match(text, /Nothing has been resumed/);

  // RESUMES NOTHING: the model was never called, so the script's one step is
  // untouched. This is the assertion that would fail if "restore" ever grew
  // into "continue".
  assert.equal(back.s.seen.length, 0, "a reload must not re-enter the loop");

  // The person's own question came back too, which is the half a notice on its
  // own would have lost: a mid-run reload used to restore the alarming part and
  // not the useful part. See `liveTurns` in the widget.
  assert.match(text, /sign this off/);

  // And the record is rewritten with the flag cleared, so a second reload does
  // not send somebody to check the same verb again.
  assert.equal(stored(session).inFlight, undefined);
  assert.doesNotMatch(transcript(load(app.driver, [], session).host), /was running/);
});

test("a cleared conversation is not resurrected by a reload", async () => {
  // `era` already stops a dying run's words landing in the transcript that
  // replaced it. A stored record is the same hazard with a longer fuse: clear
  // the panel, reload, and the conversation comes back off disk. The
  // destructive option has to be destructive all the way down.
  const app = contacts();
  const session = new FakeStorage();
  const first = load(app.driver, [{ text: "I did the thing." }], session);
  await ask(first.host, "do the thing");
  assert.match(transcript(first.host), /I did the thing\./);
  assert.ok(session.items.get(chatKey("Contacts")), "the conversation was stored");

  first.host.one("dk-gear").dispatch("click");
  first.host.one("dk-clear").dispatch("click");

  const back = load(app.driver, [], session);
  const text = transcript(back.host);
  assert.doesNotMatch(text, /do the thing/, "a cleared question came back");
  assert.doesNotMatch(text, /I did the thing/, "a cleared answer came back");
  assert.doesNotMatch(text, /from before the reload/, "the panel claimed to restore nothing");
});

test("a run that is cleared mid-flight cannot write its transcript back to storage", async () => {
  // The other half of the clear, and the one a `forgetChat` on its own would
  // miss. An abort resolves at the loop's next await, so the run is still
  // speaking after the clear -- and a write from it would go to DISK, where a
  // reload brings back exactly what the person threw away. `rememberNow`
  // carries the run's `era` for this and nothing else.
  const app = contacts();
  const session = new FakeStorage();
  const first = load(
    app.driver,
    [
      () => {
        // Cleared from inside the model's turn, so everything the loop does
        // from here belongs to a conversation that no longer exists.
        first.host.one("dk-gear").dispatch("click");
        first.host.one("dk-clear").dispatch("click");
        return { text: "words from a dead run" };
      },
    ],
    session,
  );
  await ask(first.host, "say something");
  await settle();

  const back = load(app.driver, [], session);
  assert.doesNotMatch(transcript(back.host), /dead run/);
  assert.doesNotMatch(transcript(back.host), /say something/);
});

// -------------------------------------------------------------------------
// What comes back, and what is deliberately left behind.
// -------------------------------------------------------------------------

test("the conversation comes back and the model is handed it, so the next message carries on", async () => {
  // Persisting the RENDERED LINES would have given the person their history
  // and left the model with amnesia: the panel reads "I accepted 1,000
  // contacts" above an input box where "undo that" is unanswerable, which is a
  // worse lie than an empty panel because it looks like it worked. So the
  // model turns are what is stored, and the transcript is drawn from them.
  const app = contacts();
  const session = new FakeStorage();
  const first = load(app.driver, [{ text: "There are 3,412 Acme contacts." }], session);
  await ask(first.host, "how many Acme contacts are there?");

  const back = load(app.driver, [{ text: "Still 3,412." }], session);
  assert.match(transcript(back.host), /how many Acme contacts are there\?/);
  assert.match(transcript(back.host), /There are 3,412 Acme contacts\./);

  await ask(back.host, "and now?");
  // The history the model was handed on the first turn after the reload. Three
  // turns of the old conversation, not one: this is the difference between a
  // panel that remembers and a panel that merely looks like it does.
  const history = back.s.seen[0]!.messages.map((m) => m.role);
  assert.deepEqual(history, ["user", "assistant", "user"]);
  assert.match(back.s.seen[0]!.messages[0]!.text ?? "", /how many Acme contacts/);
});

test("an app that opts into nothing writes nothing and restores nothing", async () => {
  // The backward-compatibility assertion, and it is about STORAGE and not only
  // about behaviour: a library must not start writing its users' business
  // prose to disk because somebody upgraded. `rememberChat` defaults off, and
  // an app that left it off must not touch the key even to read it.
  const app = contacts();
  const session = new FakeStorage();
  const first = load(app.driver, [{ text: "done" }], session, { remember: false });
  await ask(first.host, "a question nobody should keep");
  assert.equal(session.items.size, 0, "a transcript was stored by an app that opted out");
  assert.equal(session.writes, 0);

  const back = load(app.driver, [], session, { remember: false });
  assert.doesNotMatch(transcript(back.host), /nobody should keep/);
});

test("the viewer can switch it off, and switching it off forgets what is already stored", async () => {
  // The weaker of the two keys, and it acts on the DISK rather than only on
  // what happens next. Somebody turning this off on a shared machine means
  // "and get rid of it"; a panel that waited until its next write to honour
  // that would have kept the transcript through the one moment they asked for
  // it to be gone.
  const app = contacts();
  const session = new FakeStorage();
  const first = load(app.driver, [{ text: "kept" }], session);
  await ask(first.host, "remember this");
  assert.ok(session.items.get(chatKey("Contacts")));

  first.host.one("dk-gear").dispatch("click");
  first.host.one("dk-t-remember").dispatch("click");
  assert.equal(session.items.get(chatKey("Contacts")), "", "the stored conversation survived");

  const back = load(app.driver, [], session);
  assert.doesNotMatch(transcript(back.host), /remember this/);
});

test("two tabs of one app keep two conversations, because the store is per tab", async () => {
  // `sessionStorage` is per tab by definition, which is why the transcript
  // lives there and the budget does not. A `localStorage` key would have had
  // two tabs stomping each other, and a per-tab key IN `localStorage` would
  // have needed a tab id and left a key behind for every tab ever opened --
  // which nothing can sweep up, because `StorageLike` cannot enumerate.
  const app = contacts();
  const tabA = new FakeStorage();
  const tabB = new FakeStorage();
  const a = load(app.driver, [{ text: "answer for A" }], tabA);
  const b = load(app.driver, [{ text: "answer for B" }], tabB);
  await ask(a.host, "question from A");
  await ask(b.host, "question from B");

  assert.match(transcript(load(app.driver, [], tabA).host), /question from A/);
  assert.doesNotMatch(transcript(load(app.driver, [], tabA).host), /question from B/);
  assert.match(transcript(load(app.driver, [], tabB).host), /question from B/);
});

test("a storage that throws on every write does not break the run", async () => {
  // A transcript that cannot be stored costs a conversation. A throw out of an
  // `onResult` handler costs the run that is moving somebody's screen. The
  // budget fails the other way on purpose -- see `budget.test.ts` -- and the
  // asymmetry is the whole of both designs.
  const app = contacts();
  const session = new FakeStorage();
  session.throwOnWrite = true;
  const first = load(app.driver, [{ text: "the run finished anyway" }], session);
  await ask(first.host, "go");
  assert.match(transcript(first.host), /the run finished anyway/);
});

test("a storage that throws on every read restores nothing and still mounts", async () => {
  const app = contacts();
  const session = new FakeStorage();
  session.throwOnRead = true;
  const back = load(app.driver, [{ text: "fine" }], session);
  assert.doesNotMatch(transcript(back.host), /from before the reload/);
  await ask(back.host, "still works");
  assert.match(transcript(back.host), /fine/);
});

test("a stored record from another schema version is dropped whole, not folded", async () => {
  // `settings.ts` folds a partial record over the defaults, because a missing
  // pace is a readable record with a gap in it. A `Turn[]` with a gap in it is
  // a provider error on the person's next message, so this one is a gate.
  const app = contacts();
  const session = new FakeStorage();
  session.items.set(
    chatKey("Contacts"),
    JSON.stringify({ v: CHAT_VERSION + 1, app: "Contacts", at: 1, messages: [{ role: "user", text: "old" }], conversed: true }),
  );
  assert.doesNotMatch(transcript(load(app.driver, [], session).host), /old/);
});

test("a record stored under another app's name is not shown in this panel", async () => {
  // One origin can serve two driverkit apps, and a conversation about
  // somebody's contacts does not belong in the admin panel's transcript.
  const app = contacts();
  const session = new FakeStorage();
  session.items.set(
    chatKey("Contacts"),
    JSON.stringify({ v: CHAT_VERSION, app: "Admin", at: 1, messages: [{ role: "user", text: "not ours" }], conversed: true }),
  );
  assert.doesNotMatch(transcript(load(app.driver, [], session).host), /not ours/);
});

// -------------------------------------------------------------------------
// The gate, the plan and the secret.
// -------------------------------------------------------------------------

test("an approval that was open when the page died comes back saying it never ran", async () => {
  // The one in-flight state that IS knowable, and saying so flatly matters:
  // the core asks before it runs, so a question still on screen is a verb that
  // provably did not happen. An agent told "unknown" about that would go and
  // check for nothing, and might decide not to do what the person asked.
  const app = contacts();
  const session = new FakeStorage();
  const first = load(
    app.driver,
    [
      { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] },
      { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    ],
    session,
  );
  await ask(first.host, "accept the Acme contacts");
  await settle();
  await settle();
  // The question is up and nobody has answered it.
  assert.match(first.host.one("dk-ask-q").textContent ?? "", /3,412/);
  assert.equal(stored(session).inFlight?.phase, "asked");
  assert.equal(stored(session).inFlight?.verb, "accept-selected");

  const back = load(app.driver, [{ text: "idle" }], session);
  const text = transcript(back.host);
  assert.match(text, /you were being asked to approve `accept-selected`/);
  assert.match(text, /You never answered, so it did not run and nothing changed\./);
  assert.equal(app.accepted(), 0, "a commit ran that nobody approved");
  assert.equal(back.s.seen.length, 0);
});

test("a reload with a QUESTION open says it was a question and never that it was a confirmation", async () => {
  // The same mechanism one case over, and the wording is the whole test. A
  // question and a confirmation are both `phase: "asked"` in the record,
  // because both are "somebody was being asked something and nothing had run"
  // -- but a restored panel that said "you were being asked to approve `ask`"
  // would be describing a commit that never existed, and the person reading it
  // would go looking for the rows it named.
  //
  // It matters to the MODEL more than to the person. The dangling tool turn is
  // what the model reads on the next turn, and telling it that its question was
  // a confirmation request invites exactly the inference this channel exists to
  // make impossible: that the answer would have been a yes.
  // The panel is the ask hook, through the forward reference the library
  // documents: `mount()` happens before the panel that answers for it exists,
  // and the `ask` verb has to be in the manifest from `mount()` because the
  // tool list must not change when a panel appears.
  let live: { question: AskHook } | undefined;
  const app = contacts({ ask: (q) => live!.question(q) });
  const session = new FakeStorage();
  const first = load(
    app.driver,
    [{ calls: [{ id: "q", name: "ask", args: { question: "which Ada Duarte did you mean?" } }] }],
    session,
  );
  live = first.widget;
  await ask(first.host, "select Ada Duarte");
  await settle();
  await settle();

  assert.match(first.host.one("dk-ask-q").textContent ?? "", /which Ada Duarte/);
  assert.equal(stored(session).inFlight?.phase, "asked");
  assert.equal(stored(session).inFlight?.verb, "ask");

  const back = load(app.driver, [{ text: "idle" }], session);
  live = back.widget;
  const text = transcript(back.host);
  assert.match(text, /the agent was asking you a question/);
  assert.match(text, /it was not told anything and nothing in the app changed/);
  assert.doesNotMatch(text, /asked to approve/);
  assert.equal(back.s.seen.length, 0);

  // And the dangling tool turn the MODEL would read on the next turn, which is
  // the half that matters more and is not in the DOM. It has to say that no
  // answer was recorded, because the alternative wording -- "the person was
  // being asked to confirm this" -- invites the model to conclude the answer
  // would have been a yes.
  const closed = closeDangling(
    [
      { role: "user", text: "select Ada Duarte" },
      { role: "assistant", calls: [{ id: "q", name: "ask", args: { question: "which one?" } }] },
    ],
    { verb: "ask", phase: "asked" },
  );
  const dangling = closed.find((t) => t.role === "tool")!;
  assert.match(dangling.text, /No answer was recorded/);
  assert.match(dangling.text, /not an error and it is not a yes/);
  assert.doesNotMatch(dangling.text, /asked to confirm/);
});

test("a plan token does not survive a reload, and spending a dead one is a clean stale-plan", async () => {
  // Plan tokens are in memory and die with the page, which is correct and is
  // not something storage should fix: a receipt for a count taken before a
  // reload is a receipt for a selection nobody has looked at since. What this
  // pins is that the failure is the ORDINARY refusal and not something worse
  // -- the core must not treat an unrecognised token as absent, which would
  // read as "opt out of the check".
  const app = contacts();
  await app.driver.call("select-where", { where: "company=Acme" });
  const counted = await app.driver.call("select-where", { where: "company=Acme" });
  const plan = counted.ok ? counted.plan : undefined;
  assert.ok(plan, "the describe minted one");

  // A fresh mount is what the next page load has: the same app, a driver that
  // has never heard of this token.
  const next = contacts();
  const refused = await next.driver.call("accept-planned", {}, { plan });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.refused, "stale-plan");
  assert.equal(next.accepted(), 0);
});

test("an argument the app declared sensitive is not written to storage", async () => {
  // `ArgSpec.sensitive` exists so a value never crosses the `onAudit`
  // boundary. Persisting the raw model turns would write the same value to
  // disk, where it outlives the call, the run and the page -- under a feature
  // nobody would think to check. Scrubbed at the one boundary every byte goes
  // through, which is the repo's rule and the reason it is a whole-transcript
  // function rather than one argument.
  const app = contacts();
  const session = new FakeStorage();
  const first = load(
    app.driver,
    [
      {
        calls: [{ id: "a", name: "sign-off", args: { code: "hunter2", note: "for Alice" } }],
      },
      { text: "signed" },
    ],
    session,
  );
  // The person does not type the secret; the MODEL puts it in an argument,
  // which is the shape `ArgSpec.sensitive` is about. A transcript cannot
  // redact what somebody typed themselves, and claiming otherwise would be
  // the worse bug.
  await ask(first.host, "sign it off with the code I gave you");

  const raw = session.items.get(chatKey("Contacts"))!;
  assert.doesNotMatch(raw, /hunter2/, "a sensitive argument reached storage");
  assert.match(raw, /\[redacted\]/);
  // Only the declared field. An argument the app did not call sensitive is
  // ordinary data and redacting it would be the panel deciding what is secret.
  assert.match(raw, /for Alice/);
});

// -------------------------------------------------------------------------
// The pieces, on their own, where the edges are.
// -------------------------------------------------------------------------

test("trimming for size cuts only at a user turn, so no tool_use is left unanswered", async () => {
  // The bug this exists to not have: every tool-use API rejects a conversation
  // in which a `tool_use` block has no matching result, and one missing tool
  // turn is a dead panel -- a 400 on every later message, forever, with a
  // transcript on screen that looks fine. A `slice` at an arbitrary index is
  // how that happens.
  const turns: Turn[] = [
    { role: "user", text: "x".repeat(400) },
    { role: "assistant", calls: [{ id: "1", name: "go", args: {} }] },
    { role: "tool", callId: "1", name: "go", text: "ok" },
    { role: "user", text: "second" },
    { role: "assistant", calls: [{ id: "2", name: "go", args: {} }] },
    { role: "tool", callId: "2", name: "go", text: "ok" },
  ];
  const { messages, trimmed } = trimTurns(turns, 200);
  assert.equal(trimmed, 3, "the cut was not at the user boundary");
  assert.equal(messages[0]!.role, "user");
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.callId));
  for (const turn of messages) {
    if (turn.role !== "assistant") continue;
    for (const call of turn.calls ?? []) {
      assert.ok(answered.has(call.id), `call ${call.id} was left unanswered by the trim`);
    }
  }
});

test("a conversation with no small-enough boundary stores nothing rather than storing a broken one", async () => {
  // Storing a conversation that cannot be used is worse than storing none: the
  // first breaks the panel permanently and the second loses a transcript.
  const turns: Turn[] = [
    { role: "user", text: "y".repeat(5000) },
    { role: "assistant", calls: [{ id: "1", name: "go", args: {} }] },
    { role: "tool", callId: "1", name: "go", text: "ok" },
  ];
  const { messages, trimmed } = trimTurns(turns, 100);
  assert.deepEqual(messages, []);
  assert.equal(trimmed, 3);
});

test("every dangling tool call gets an answer, and only the asked one is told it did not run", async () => {
  // Two different facts and the restored history must not confuse them. The
  // call a question was open on provably did not run; any other dangling call
  // has an unknown outcome, which is the safe direction and also the true one.
  const turns: Turn[] = [
    { role: "user", text: "do both" },
    {
      role: "assistant",
      calls: [
        { id: "1", name: "accept-selected", args: {} },
        { id: "2", name: "sign-off", args: {} },
      ],
    },
  ];
  const closed = closeDangling(turns, { verb: "accept-selected", phase: "asked" });
  const answers = closed.filter((t) => t.role === "tool");
  assert.equal(answers.length, 2, "a tool_use was left with no result");
  const asked = answers.find((t) => t.name === "accept-selected")!;
  const other = answers.find((t) => t.name === "sign-off")!;
  assert.match(asked.text, /did not run and nothing changed/);
  assert.match(other.text, /outcome is UNKNOWN/);
  assert.match(other.text, /DO NOT retry/);
});

test("scrubbing leaves a conversation alone when no verb declared a secret", async () => {
  // The common case, and it must be free rather than merely cheap: the same
  // array back, not a deep copy of every turn in every conversation.
  const manifest = contacts().driver.manifest();
  const bare: typeof manifest = {
    ...manifest,
    // The args stripped off rather than set to `undefined`, because
    // `exactOptionalPropertyTypes` makes those two different things and the
    // case under test is a verb that declared none at all.
    verbs: manifest.verbs.map(({ args: _args, ...rest }) => rest),
  };
  const turns: Turn[] = [{ role: "user", text: "hello" }];
  assert.equal(scrubTurns(turns, bare), turns);
});
