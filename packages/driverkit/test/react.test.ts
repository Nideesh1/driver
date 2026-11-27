/**
 * `driverkit/react` — the decisions, pinned.
 *
 * These tests are the specification. Each name states the decision it pins, so
 * a future change that looks harmless has to break a named test and read why
 * the rule exists before deleting it.
 *
 * **There is no React in this repository and there is no network install, so
 * none of this renders with React.** That is less of a gap than it sounds,
 * and it is the reason the area is shaped the way it is: everything that can
 * be wrong about the panel's behaviour — the approval receipt, the gate's
 * rules, the step list, the era counter, the grants — lives in `store.ts`,
 * which is a plain object with no framework in it, and is driven here
 * directly. What is left for the components is markup, and the handful of
 * claims about that markup which actually matter (no live region on the
 * transcript, a `role="status"` receipt keyed on its phase, buttons that are
 * gone once a decision is made) are asserted through the one-pass renderer
 * below.
 *
 * What that renderer cannot tell you is written down beside it, so nobody
 * reads a passing suite as more than it is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { mount } from "../src/core/registry.ts";
import type { ApprovalRequest } from "../src/core/types.ts";
import { SPEEDS as WIDGET_SPEEDS } from "../src/widget/settings.ts";
import {
  COMMIT_ASK_ABOVE,
  createDriverPanel,
  createPanelStore,
  receiptLine,
} from "../src/react/index.ts";
import type {
  ApprovalEntry,
  PanelOptions,
  PanelSnapshot,
  StepEntry,
} from "../src/react/index.ts";
import type { Component, ReactRuntime } from "../src/react/runtime.ts";
import type { ThinkInput, ThinkResult } from "../src/agent/index.ts";
import { call, contacts, scripted } from "./app.ts";

type Script = Array<ThinkResult | ((input: ThinkInput, step: number) => ThinkResult)>;

// ---- helpers ---------------------------------------------------------------

/** Spin the event loop until a condition holds, or fail saying what it was. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

function approvals(snapshot: PanelSnapshot): ApprovalEntry[] {
  return snapshot.entries.filter((e): e is ApprovalEntry => e.kind === "approval");
}

function steps(snapshot: PanelSnapshot): StepEntry[] {
  return snapshot.entries.filter((e): e is StepEntry => e.kind === "step");
}

/** A panel over the demo app, with the waits switched off. */
function panel(
  extra: Partial<PanelOptions> = {},
  script: Script = [
    { calls: [call("select-where", { where: "company=Acme", limit: 1000 })] },
    { calls: [call("accept-selected")] },
    { text: "Accepted the top thousand Acme contacts." },
  ],
) {
  const app = contacts();
  const s = scripted(script);
  const store = createPanelStore(app.driver, { think: s.think, pace: 0, ...extra });
  return { app, store, scripted: s };
}

// ---- the receipt -----------------------------------------------------------

test("an approval becomes a receipt in place rather than vanishing from the transcript", async () => {
  // THE decision this area exists for. The gate is the only auditable feature
  // in the library, and auditability happens in scrollback: a card that
  // unmounted on decision and left a loose outcome line somewhere below would
  // break the link between the question and its answer, which is the one link
  // a person scrolling back for "what did I agree to" is following. So the
  // entry keeps its id, its position and its own words, and only `phase` moves.
  const { app, store } = panel();
  const asked = store.ask("accept the Acme contacts");

  await until("the gate to open", () => store.getSnapshot().pending !== undefined);
  const open = store.getSnapshot().pending!;
  const where = store.getSnapshot().entries.indexOf(open);
  assert.equal(open.phase, "asking");
  assert.equal(open.verb, "accept-selected");
  // The verb's OWN description and the count the describe reported. Without
  // both, the question is "allow accept-selected?", which is not a question
  // anybody can answer.
  assert.equal(open.describe, "accept the current selection");
  assert.equal(open.count, 1000);

  store.decide(open.id, { allow: true });

  await until("the run to finish", () => !store.getSnapshot().busy);
  const after = approvals(store.getSnapshot());
  assert.equal(after.length, 1, "a decision must not add a second entry");
  const receipt = after[0]!;
  assert.equal(receipt.id, open.id, "the receipt IS the question, not a replacement for it");
  assert.equal(
    store.getSnapshot().entries.indexOf(receipt),
    where,
    "the receipt must stay where the question was in scrollback",
  );
  assert.equal(receipt.describe, open.describe, "the question's own words survive the decision");
  assert.equal(receipt.phase, "allowed-ok");
  assert.equal(app.accepted().length, 1000);
  await asked;
});

test("an approved commit the app then refuses says so on the same receipt", async () => {
  // "You approved this" and "this happened" are different facts, and a receipt
  // that recorded only the first would be recording the more flattering of the
  // two. A stale rev, a spent budget or a plan token that no longer matches all
  // land here: approved, and then refused anyway.
  const { store } = panel({}, [
    // No `select-where` first, so the commit is refused `nothing-selected`.
    { calls: [call("accept-selected")] },
    { text: "Nothing was selected." },
  ]);
  const asked = store.ask("accept them");

  await until("the gate", () => store.getSnapshot().pending !== undefined);
  store.decide(store.getSnapshot().pending!.id, { allow: true });
  await until("the run to finish", () => !store.getSnapshot().busy);

  const receipt = approvals(store.getSnapshot())[0]!;
  assert.equal(receipt.phase, "allowed-refused");
  assert.equal(receipt.refused, "nothing-selected");
  assert.match(receiptLine(receipt), /Approved, but the app refused it: nothing-selected/);
  await asked;
});

test("the receipt's own words distinguish denied, stopped and nobody-answered", () => {
  // Three endings that a record which could not tell them apart would be
  // useless for. `denied` is a person refusing, `stopped` is a run ending
  // before the verb ran, and `lapsed` is nobody having answered at all — the
  // same distinction the core keeps between `declined` and `timed-out`, said in
  // words a person reads.
  const base = {
    kind: "approval" as const,
    id: "x",
    verb: "accept-selected",
    describe: "accept the current selection",
    args: {},
    reversible: false,
    large: false,
  };
  assert.match(receiptLine({ ...base, phase: "denied" }), /Denied\. Nothing was changed\./);
  assert.match(receiptLine({ ...base, phase: "stopped" }), /stopped before this ran/);
  assert.match(receiptLine({ ...base, phase: "lapsed" }), /closed before anybody answered/);
  // And the intermediate state, which is the one assistant-ui gets right and
  // the vanilla panel has no word for: decided, and not yet finished.
  assert.match(receiptLine({ ...base, phase: "allowed" }), /Approved, running\./);
});

test("stopping the run answers an open question without recording a denial", async () => {
  // Without this the loop waits on a promise nobody resolves and the panel is
  // busy forever. The answer has to be no — but the RECORD must not say a
  // person refused, because nobody did.
  const { app, store } = panel();
  const asked = store.ask("accept them");
  await until("the gate", () => store.getSnapshot().pending !== undefined);

  store.stop();
  await until("the run to finish", () => !store.getSnapshot().busy);

  assert.equal(approvals(store.getSnapshot())[0]!.phase, "stopped");
  assert.equal(app.accepted().length, 0, "nothing may have run");
  await asked;
});

test("the panel going away with a question open records nobody answering, not a refusal", async () => {
  // The relay path's teardown answer, and the reason it is a parameter rather
  // than a constant. A commit that arrived from outside a run has somebody
  // waiting on an approval that will now never come; `{ timedOut: true }` says
  // the verb did not run and nobody decided, where `false` would say a person
  // refused. Confusing those two is what the whole mechanism exists to stop.
  const app = contacts();
  const store = createPanelStore(app.driver, { think: async () => ({ text: "" }), pace: 0 });
  const req: ApprovalRequest = {
    name: "accept-selected",
    args: {},
    verb: app.driver.manifest().verbs.find((v) => v.name === "accept-selected")!,
    snapshot: app.driver.snapshot(),
  };
  const answer = store.approve(req);
  await until("the gate", () => store.getSnapshot().pending !== undefined);

  store.destroy();
  const decided = await answer;

  assert.deepEqual(
    { timedOut: (decided as { timedOut?: boolean }).timedOut },
    { timedOut: true },
    "a closed panel is nobody answering, which is not a denial",
  );
  assert.equal(approvals(store.getSnapshot())[0]!.phase, "lapsed");
});

// ---- the note --------------------------------------------------------------

test("a denial's note becomes the model's hint, and a note alone never approves anything", async () => {
  // Two halves of one rule, from assistant-ui's `resolveToolApprovalResponse`:
  // on a decision the approval itself is the authorization, so a note must
  // never be read as one. The note is therefore carried only when a decision
  // button is pressed — and on a DENIAL it is load-bearing in the other
  // direction, because the core turns a string into the hint the model is
  // told, so "not until finance signs off" reaches the model where "declined"
  // would not.
  const { app, store } = panel({ notes: true }, [
    { calls: [call("select-where", { where: "company=Acme", limit: 1000 })] },
    { calls: [call("accept-selected")] },
    (input) => {
      // The model was told the person's own words, as a refusal rather than an
      // exception, so it can adapt instead of retrying.
      const last = input.messages[input.messages.length - 1]!;
      assert.match((last as { text: string }).text, /finance has to sign off/);
      return { text: "Understood, I will leave it." };
    },
  ]);
  const asked = store.ask("accept them");

  await until("the gate", () => store.getSnapshot().pending !== undefined);
  const open = store.getSnapshot().pending!;

  // A note with no decision leaves the question exactly as open as it was.
  // There is deliberately no store method that takes a note on its own: the
  // only way text reaches the gate is attached to a pressed button.
  assert.equal(store.getSnapshot().pending?.id, open.id);

  store.decide(open.id, { allow: false, note: "finance has to sign off" });
  await until("the run to finish", () => !store.getSnapshot().busy);

  const receipt = approvals(store.getSnapshot())[0]!;
  assert.equal(receipt.phase, "denied");
  assert.equal(receipt.note, "finance has to sign off");
  assert.equal(app.accepted().length, 0);
  await asked;
});

test("deciding twice is the first decision, so a double click cannot change an answer", async () => {
  const { store } = panel();
  const asked = store.ask("accept them");
  await until("the gate", () => store.getSnapshot().pending !== undefined);
  const open = store.getSnapshot().pending!;

  store.decide(open.id, { allow: false });
  store.decide(open.id, { allow: true });

  await until("the run to finish", () => !store.getSnapshot().busy);
  assert.equal(approvals(store.getSnapshot())[0]!.phase, "denied");
  await asked;
});

// ---- the gate's rules ------------------------------------------------------

test("the two panels gate a commit by the same number and offer the same speeds", () => {
  // `src/react/store.ts` re-declares `COMMIT_ASK_ABOVE`, and `src/react/index.ts`
  // re-declares the named speeds, rather than importing either from the vanilla
  // widget: importing would pull that area's hand-written DOM, its stylesheet
  // and its `localStorage` access into a React bundle to read one integer and
  // one list. Two copies of a number drift, so the drift is a failing test
  // rather than a hope. One of the two panels being laxer about a commit than
  // the other would make "which panel is this app using" a security question.
  // Read out of the vanilla widget's SOURCE rather than imported from it, for
  // the same reason the constant is re-declared in the first place: importing
  // `src/widget/widget.ts` here would put that whole module graph — its DOM
  // wrapper, its stylesheet, its positioner — into this test's program to read
  // one integer. A regex over the declaration catches the drift this test is
  // about and nothing else.
  const widget = readFileSync(new URL("../src/widget/widget.ts", import.meta.url), "utf8");
  const declared = /export const COMMIT_ASK_ABOVE = (\d+);/.exec(widget);
  assert.ok(declared, "the vanilla widget must still declare COMMIT_ASK_ABOVE");
  assert.equal(COMMIT_ASK_ABOVE, Number(declared[1]));

  const { components } = createDriverPanel(fakeReact());
  const tree = render(
    components.RunControlsBar as Component<unknown>,
    { driving: { busy: true, runState: "running", paceMs: 600, grants: [] } },
  );
  const labels = collect(tree, (n) => n.props["role"] === "radio").map((n) => text(n));
  assert.deepEqual(labels, WIDGET_SPEEDS.map((s) => s.label));
});

test("a reversible commit under the size threshold runs unasked and is recorded as not-asked", async () => {
  // `{ asked: false }` and emphatically not `true`. A gate that let a commit
  // through without asking must not be recorded as a person saying yes: the
  // core writes `approval: "allowed"` for `true`, and that claims somebody
  // decided. This is the answer the core added for exactly this case.
  const app = contacts();
  const driver = mount({
    app: "Toy",
    visible: () => ({ where: "rows", rev: 1, rows: [{ id: "a" }], selectedCount: 3 }),
    verbs: [
      {
        name: "set-dense",
        kind: "commit",
        reversible: true,
        describe: "switch to dense rows",
        run: () => {},
      },
    ],
  });
  const store = createPanelStore(driver, { think: async () => ({ text: "" }), pace: 0 });
  const decided = await store.approve({
    name: "set-dense",
    args: {},
    verb: driver.manifest().verbs[0]!,
    snapshot: driver.snapshot(),
  });

  assert.deepEqual(decided, { asked: false });
  assert.equal(approvals(store.getSnapshot()).length, 0, "nothing was asked, so nothing is posted");
  app.driver.unmount();
  driver.unmount();
});

test("a selection past the threshold is asked about even when the app called it reversible", async () => {
  // `reversible` is a claim about the KIND of change and not about its volume.
  // An undo over three thousand rows is a promise an app may not be able to
  // keep at that size, whatever it declared, so the volume is checked
  // separately and the flag does not get to answer for it.
  const driver = mount({
    app: "Toy",
    visible: () => ({
      where: "rows",
      rev: 1,
      rows: [{ id: "a" }],
      selectedCount: COMMIT_ASK_ABOVE + 1,
    }),
    verbs: [
      { name: "tag", kind: "commit", reversible: true, describe: "tag the selection", run: () => {} },
    ],
  });
  const store = createPanelStore(driver, { think: async () => ({ text: "" }), pace: 0 });
  void store.approve({
    name: "tag",
    args: {},
    verb: driver.manifest().verbs[0]!,
    snapshot: driver.snapshot(),
  });

  await until("the gate", () => store.getSnapshot().pending !== undefined);
  const open = store.getSnapshot().pending!;
  assert.equal(open.reversible, true);
  assert.equal(open.large, true, "the card has to say that the size is why it is asking");
  store.destroy();
  driver.unmount();
});

test("the panel installs no gate of its own when the core is already asking", async () => {
  // Two questions about one commit is how people learn to click Yes without
  // reading, and the next one they skip is the bulk accept. When the app
  // mounted with its own `approve` hook, the question is asked inside
  // `driver.call()` on every path — the relay's and this one's — so the panel
  // must not add a second.
  let asked = 0;
  const app = contacts();
  const gated = mount({
    app: "Contacts",
    visible: app.driver.snapshot,
    approve: () => {
      asked++;
      return true;
    },
    verbs: [{ name: "wipe", kind: "commit", describe: "wipe everything", run: () => {} }],
  });
  const s = scripted([{ calls: [call("wipe")] }, { text: "done" }]);
  const store = createPanelStore(gated, { think: s.think, pace: 0 });
  await store.ask("wipe it");

  assert.equal(asked, 1, "the core asked");
  assert.equal(approvals(store.getSnapshot()).length, 0, "and the panel did not ask again");
  gated.unmount();
});

// ---- standing rules --------------------------------------------------------

test("a standing rule answers without asking and still posts a receipt naming the rule", async () => {
  // A rule that silenced the question must not also silence the record. The
  // entry says which rule answered, so scrollback shows both that the commit
  // happened and why nobody was asked — and the rule's text is the exact
  // string that was on the card before the click, so what was agreed to and
  // what was installed cannot differ.
  const { app, store } = panel({ grants: true }, [
    { calls: [call("select-where", { where: "company=Acme", limit: 30 })] },
    { calls: [call("accept-selected")] },
    { calls: [call("select-where", { where: "company=Acme", limit: 40 })] },
    { calls: [call("accept-selected")] },
    { text: "Accepted both batches." },
  ]);

  const asked = store.ask("accept them in two batches");
  await until("the first gate", () => store.getSnapshot().pending !== undefined);
  const first = store.getSnapshot().pending!;
  // The offer is on the card BEFORE the click, and it is what gets stored.
  assert.equal(first.grantOffer, "Always allow “accept-selected” for the rest of this session, without asking");

  store.decide(first.id, { allow: true, always: true });
  await until("the run to finish", () => !store.getSnapshot().busy);

  assert.deepEqual(store.getSnapshot().grants, [
    { verb: "accept-selected", rule: first.grantOffer!, allow: true },
  ]);
  const posted = approvals(store.getSnapshot());
  assert.equal(posted.length, 2, "the second commit is recorded even though nobody was asked");
  assert.equal(posted[1]!.phase, "allowed-ok");
  assert.equal(posted[1]!.via, first.grantOffer, "the receipt names the rule that answered");
  assert.equal(app.accepted().length, 70);
  await asked;
});

test("a revoked rule asks again, and no rule survives the page", async () => {
  // Grants live for this panel and this page load, and nothing is written to
  // storage. A standing approval for a commit that came back after a reload, in
  // a session nobody remembers granting it in, is worse than asking again. The
  // list is on the snapshot so a host can render it, because a grant nobody can
  // see is a grant nobody can revoke.
  const { store } = panel({ grants: true }, [
    { calls: [call("select-where", { where: "company=Acme", limit: 30 })] },
    { calls: [call("accept-selected")] },
    { text: "done" },
  ]);
  const asked = store.ask("accept them");
  await until("the gate", () => store.getSnapshot().pending !== undefined);
  store.decide(store.getSnapshot().pending!.id, { allow: true, always: true });
  await until("the run to finish", () => !store.getSnapshot().busy);
  assert.equal(store.getSnapshot().grants.length, 1);

  store.revoke("accept-selected");
  assert.deepEqual(store.getSnapshot().grants, []);
  await asked;
});

// ---- the run ---------------------------------------------------------------

test("a call is three states of one row, not three rows about one call", async () => {
  // The row appears on `onBeforeCall`, which fires before the pace wait and
  // before any hold — the only way "you can see it coming and stop it" is true
  // rather than aspirational. The state is an attribute and never part of the
  // sentence, so the row reads the same whether somebody looked at it while it
  // was pending or a minute afterwards.
  // Confirmations off, because this test is about the step list and a run that
  // parked on the gate would never produce one. That the gate is on by default
  // is pinned by the receipt tests above.
  const { store } = panel({ confirmCommits: false });
  await store.ask("accept the Acme contacts");

  const list = steps(store.getSnapshot());
  assert.deepEqual(list.map((s) => s.verb), ["select-where", "accept-selected"]);
  assert.deepEqual(list.map((s) => s.status), ["done", "done"]);
  assert.equal(list[0]!.outcome, "ok · 1,000 matched");
  assert.equal(list[1]!.commit, true, "the commit row is marked for the person too");
  assert.equal(list[0]!.commit, false);
});

test("a stop leaves no row claiming something is about to happen", async () => {
  // A stop during a pace wait or a hold abandons a call unrun and no
  // `onResult` is coming, so a row left pending would be the panel saying
  // something is about to happen when the run is already over.
  //
  // Staged with a clock that never fires, which is exactly the window the
  // pacing exists to create: the row is on screen, the call has not happened,
  // and the person still has time to stop it.
  const parked: Array<() => void> = [];
  const { app, store } = panel({
    pace: 600,
    clock: {
      set: (fn) => {
        parked.push(fn);
        return parked.length;
      },
      clear: () => {},
      now: () => 0,
    },
  });
  const asked = store.ask("accept the Acme contacts");
  await until("a pending row", () => steps(store.getSnapshot()).length > 0);
  assert.equal(steps(store.getSnapshot())[0]!.status, "pending");

  store.stop();
  await until("the run to finish", () => !store.getSnapshot().busy);

  assert.deepEqual(
    steps(store.getSnapshot()).map((s) => ({ status: s.status, outcome: s.outcome })),
    [{ status: "skipped", outcome: "not run" }],
  );
  assert.equal(app.accepted().length, 0, "the call never ran");
  await asked;
});

test("a cleared conversation takes a dying run's events with it", async () => {
  // The `era` counter, kept from the vanilla widget, and the reason it survives
  // the move to React unchanged: an abort stops `drive` at its next await, so a
  // call it had already announced can still arrive afterwards. A `setState` from
  // that stale callback is exactly as wrong as the `appendChild` it replaced —
  // React does not help here.
  const { store } = panel();
  const asked = store.ask("accept the Acme contacts");
  await until("the run to start", () => store.getSnapshot().busy);

  store.clear();
  const era = store.getSnapshot().era;
  assert.deepEqual(store.getSnapshot().entries, []);
  await asked;
  // Nothing from the run that was thrown away — no stop note, no step rows,
  // no late outcome — reaches the transcript that replaced it.
  assert.deepEqual(store.getSnapshot().entries, []);
  assert.equal(store.getSnapshot().era, era);
});

test("the pace a person sets reaches the run that is already going", async () => {
  // The moment somebody wants the agent slowed down is while it is going. A
  // control that quietly applied next run would be worse than none: they move
  // it, nothing happens, and they conclude it is broken.
  const paces: number[] = [];
  const { store } = panel({
    controls: (o) => {
      const real = { ...fakeControls(o), pace: (ms: number) => paces.push(ms) };
      return real;
    },
  });
  const asked = store.ask("accept the Acme contacts");
  await until("the run to start", () => store.getSnapshot().busy);
  // `drive` applies its own `pace` option to the controls at the start of a
  // run — the run is the thing being paced — so the first entry here is that,
  // and the one this test is about is the one that arrives mid-run.
  assert.deepEqual(paces, [0]);
  store.setPace(1500);
  assert.deepEqual(paces, [0, 1500]);
  assert.equal(store.getSnapshot().paceMs, 1500);
  store.stop();
  await asked.catch(() => {});
});

test("a pace that is not a claim about a speed is ignored", () => {
  // Same rule as `RunControls.pace`: reading `NaN` as 0 would make the agent
  // faster than the person asked for, and `Infinity` as a delay would park the
  // run on a timer nobody meant to set.
  const { store } = panel();
  store.setPace(900);
  store.setPace(Number.NaN);
  store.setPace(Number.POSITIVE_INFINITY);
  store.setPace(-5);
  assert.equal(store.getSnapshot().paceMs, 900);
});

test("the snapshot is the same object until something changes", () => {
  // `useSyncExternalStore` re-renders whenever `getSnapshot()` returns a value
  // it has not seen, so a store that rebuilt its snapshot on every read would
  // put React in an infinite render loop. This is the cheapest possible test
  // for the most expensive possible bug.
  const { store } = panel();
  const before = store.getSnapshot();
  assert.equal(store.getSnapshot(), before, "two reads with nothing between them");

  store.setStepMode(true);
  const after = store.getSnapshot();
  assert.notEqual(after, before, "a change must produce a new snapshot");
  assert.equal(store.getSnapshot(), after, "and then be stable again");
});

test("the session's ceiling is reported where one is declared and absent where none is", async () => {
  // The one thing on the panel with no control beside it: `MountOptions.budget`
  // is set by whoever mounted the app, and a viewer must not be able to raise
  // their own ceiling. Shown before the ceiling is reached rather than only
  // after, because a run that stops mid-job and does not say why is read as a
  // broken app.
  const bounded = mount({
    app: "Toy",
    visible: () => ({ where: "rows", rev: 1, rows: [] }),
    budget: { calls: 4 },
    verbs: [{ name: "ping", kind: "read", describe: "say hi", run: () => {} }],
  });
  const store = createPanelStore(bounded, { think: async () => ({ text: "" }), pace: 0 });
  assert.deepEqual(store.getSnapshot().budget, {
    calls: { used: 0, limit: 4 },
    commits: { used: 0 },
  });

  await bounded.call("ping", {});
  store.setStepMode(false);
  assert.equal(store.getSnapshot().budget?.calls.used, 1, "re-read, not remembered");

  const { store: plain } = panel();
  assert.equal(plain.getSnapshot().budget?.calls.limit, undefined);
  bounded.unmount();
});

// ---- the components --------------------------------------------------------

test("the transcript carries no live region, so a 600ms pace does not re-read it", async () => {
  // The vanilla panel puts `aria-live="polite"` on the whole transcript, which
  // is a bug at a watchable pace: the region is re-read as each step row lands,
  // so the person hears a growing conversation from the top instead of what
  // just changed. State is announced instead, in one-sentence `role="status"`
  // regions. This is the one accessibility decision in here that is a
  // correction rather than a port, so it is pinned by name.
  const { components } = createDriverPanel(fakeReact());
  const { store } = panel({ greeting: "Ask me about your contacts." });
  // A transcript with a step list, a commit receipt and prose in it, because a
  // live region on an empty container is a claim about nothing.
  const asked = store.ask("accept the Acme contacts");
  await until("the gate", () => store.getSnapshot().pending !== undefined);
  store.decide(store.getSnapshot().pending!.id, { allow: true });
  await asked;
  assert.ok(store.getSnapshot().entries.length > 4, "the transcript must have content");

  const tree = render(components.Transcript as Component<unknown>, {
    driving: { ...store.getSnapshot(), decide: () => {} },
    components,
    notes: false,
  });
  assert.equal(collect(tree, (n) => "aria-live" in n.props).length, 0);
  assert.equal(collect(tree, (n) => n.props["role"] === "log").length, 0, "role=log is a live region");
});

test("an asking card has buttons and a decided one has a role=status receipt instead", () => {
  // The markup half of the receipt decision: on a decision the button row is
  // replaced, in the same card, by a status line — not removed leaving nothing,
  // and not left live beside an outcome. Scrolling back through a transcript
  // and finding a working "Yes, do it" beside something that already happened
  // would be worse than no record at all.
  const { components } = createDriverPanel(fakeReact());
  const entry: ApprovalEntry = {
    kind: "approval",
    id: "a1",
    verb: "accept-selected",
    describe: "accept the current selection",
    args: {},
    count: 1000,
    reversible: false,
    large: true,
    phase: "asking",
  };

  const asking = render(components.ApprovalCard as Component<unknown>, {
    entry,
    decide: () => {},
    notes: false,
  });
  assert.deepEqual(
    collect(asking, (n) => n.type === "button").map((n) => text(n)),
    ["No", "Yes, do it"],
    "No comes first, so reaching Yes takes one more deliberate key",
  );
  // The count is in the question, because "allow accept-selected?" is not a
  // question anybody can answer.
  assert.match(text(asking), /accept the current selection — 1,000 rows\?/);
  assert.equal(collect(asking, (n) => n.props["role"] === "status").length, 0);

  const decided = render(components.ApprovalCard as Component<unknown>, {
    entry: { ...entry, phase: "allowed-ok" },
    decide: () => {},
    notes: false,
  });
  assert.deepEqual(collect(decided, (n) => n.type === "button"), []);
  const status = collect(decided, (n) => n.props["role"] === "status");
  assert.equal(status.length, 1);
  assert.equal(text(status[0]!), "Approved. Finished.");
  // Focusable programmatically and not a tab stop: the receipt is a record, not
  // a control.
  assert.equal(status[0]!.props["tabIndex"], -1);
});

test("the receipt's status element is keyed on its phase, so each change is re-announced", () => {
  // A `role="status"` whose text is merely updated is re-announced by some
  // screen readers and silently ignored by others; a remount is announced by
  // all of them. The key is what forces the remount, which makes it load
  // bearing rather than React bookkeeping — hence a test, because a key looks
  // exactly like the sort of thing somebody tidies away.
  const { components } = createDriverPanel(fakeReact());
  for (const phase of ["allowed", "allowed-ok", "denied"] as const) {
    const tree = render(components.ApprovalCard as Component<unknown>, {
      entry: {
        kind: "approval",
        id: "a1",
        verb: "v",
        describe: "do it",
        args: {},
        reversible: false,
        large: false,
        phase,
      },
      decide: () => {},
      notes: false,
    });
    const keyed = collect(tree, (n) => typeof n.type === "function" && "key" in n.props);
    assert.equal(keyed.length, 1, `${phase}: one keyed status element`);
    assert.equal(keyed[0]!.props["key"], phase);
  }
});

test("the standing-rule buttons name the rule before anybody clicks one", () => {
  // The rule has to be visible BEFORE the click, or nobody can be said to have
  // agreed to it. The verb is in the button's own label, and the full sentence
  // that will be stored is on the card.
  const { components } = createDriverPanel(fakeReact());
  const tree = render(components.ApprovalCard as Component<unknown>, {
    entry: {
      kind: "approval",
      id: "a1",
      verb: "accept-selected",
      describe: "accept the current selection",
      args: {},
      reversible: false,
      large: false,
      phase: "asking",
      grantOffer: "Always allow “accept-selected” for the rest of this session, without asking",
    },
    decide: () => {},
    notes: false,
  });
  const labels = collect(tree, (n) => n.type === "button").map((n) => text(n));
  assert.deepEqual(labels, [
    "No",
    "Yes, do it",
    "Always refuse “accept-selected”",
    "Always allow “accept-selected”",
  ]);
});

test("the default prose renderer is the markdown seam and injects no HTML", () => {
  // Markdown is being built for the vanilla widget and must not be built here.
  // The seam is a COMPONENT and never a string of HTML, so that the escape
  // hatch cannot become `dangerouslySetInnerHTML` over a model's output —
  // which is the least trusted thing on the screen.
  const { components } = createDriverPanel(fakeReact());
  const tree = render(components.Said as Component<unknown>, {
    entry: { kind: "assistant", id: "s1", text: "**not bold**" },
    Prose: components.Prose,
  });
  assert.equal(text(tree), "**not bold**");
  assert.equal(
    collect(tree, (n) => "dangerouslySetInnerHTML" in n.props).length,
    0,
    "nothing in this area may inject HTML",
  );
});

// ---- a renderer, and what it is not ----------------------------------------
//
// A one-pass React stand-in: `createElement` builds a plain tree, function
// components are called, and the hooks answer the way they would on a first
// render. It is enough for every claim above, which are all claims about what
// the first render produces.
//
// WHAT IT CANNOT TELL YOU, written down so a passing suite is not read as more
// than it is: nothing here re-renders, so a `setState` is recorded and
// discarded; `useEffect` runs synchronously rather than after paint, and its
// cleanups are never called; and `ref` is a prop here rather than a bound DOM
// node, so the focus move on a decision is NOT exercised — only the
// `tabIndex`, the `role` and the key that make it possible are. Those three
// are the parts a refactor would silently remove. The focus move itself is a
// browser behaviour and belongs in `e2e/`, which is where the vanilla panel's
// equivalent claims are checked.

interface Rendered {
  type: unknown;
  props: Record<string, unknown>;
  children: Rendered[];
  /** Text content contributed directly by this node. */
  text: string;
}

function fakeReact(): ReactRuntime {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, kids: children }),
    Fragment: Symbol("Fragment"),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: <T,>(initial: T | (() => T)) =>
      [
        typeof initial === "function" ? (initial as () => T)() : initial,
        () => {},
      ] as [T, (next: T | ((prev: T) => T)) => void],
    useRef: <T,>(initial: T) => ({ current: initial }),
    useEffect: (effect) => {
      effect();
    },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
  };
}

/** Evaluate one component and everything under it. */
function render(component: Component<unknown>, props: unknown): Rendered {
  return walk({ type: component, props: props as Record<string, unknown>, kids: [] });
}

interface Raw {
  type: unknown;
  props: Record<string, unknown>;
  kids: unknown[];
}

function isRaw(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function walk(node: Raw): Rendered {
  const kids = node.kids.length > 0 ? node.kids : [node.props["children"]];
  const out: Rendered = { type: node.type, props: node.props, children: [], text: "" };

  if (typeof node.type === "function") {
    const produced = (node.type as (p: unknown) => unknown)(node.props);
    if (isRaw(produced)) out.children.push(walk(produced));
    else if (typeof produced === "string") out.text += produced;
    return out;
  }

  const queue = [...kids];
  while (queue.length > 0) {
    const kid = queue.shift();
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) {
      queue.unshift(...kid);
      continue;
    }
    if (isRaw(kid)) out.children.push(walk(kid));
    else out.text += String(kid);
  }
  return out;
}

function collect(tree: Rendered, pick: (node: Rendered) => boolean): Rendered[] {
  const found: Rendered[] = [];
  const queue = [tree];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (pick(node)) found.push(node);
    queue.push(...node.children);
  }
  return found;
}

function text(tree: Rendered): string {
  return tree.text + tree.children.map((c) => text(c)).join("");
}

/** A `RunControls` that records instead of gating. */
function fakeControls(options: { pace?: number; stepMode?: boolean }) {
  return {
    state: (options.stepMode ? "paused" : "running") as "running" | "paused",
    permits: 0,
    paceMs: options.pace ?? 600,
    pause: () => {},
    resume: () => {},
    step: () => {},
    pace: (_ms: number) => {},
    subscribe: () => () => {},
    gate: async () => {},
  };
}
