/**
 * These tests are the specification. Each name states the decision it pins.
 *
 * All of them run against the fake DOM in `fake-dom.ts`, which is possible
 * only because every browser global the widget touches is an option. That is
 * the point: the paths that matter here — Escape while the input has focus, a
 * commit showing up in the trace, unmount while a run is in flight — are
 * exactly the ones nobody re-clicks by hand after a refactor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../src/core/registry.ts";
import type { AuditEvent, Driver, Scalar, Snapshot, VerbContext } from "../src/core/types.ts";
import type { Think, ThinkInput } from "../src/agent/types.ts";
import { runControls } from "../src/agent/control.ts";
import type { RunControlsOptions } from "../src/agent/control.ts";
import type { RunControls } from "../src/agent/types.ts";
import { COMMIT_ASK_ABOVE, PANEL_TITLE, mountWidget, settingsKey, storageKey } from "../src/widget/index.ts";
import { CSS } from "../src/widget/css.ts";
import type { Position, WidgetOptions } from "../src/widget/index.ts";
import { FakeClock, FakeDocument, FakeNode, FakeStorage, FakeWindow, GAP, hide, instant } from "./fake-dom.ts";

/** The same shape as the core's and the agent's fixtures: 3,412 contacts, a
 *  twenty-row window, and a `describe` verb that reports what it selected. The
 *  count is what the confirmation row exists to show, so a fixture that did
 *  not produce one would not test the thing. */
function contacts(
  options: Partial<Parameters<typeof mount>[0]> = {},
): { driver: Driver; accepted: () => number } {
  const all = Array.from({ length: 3412 }, (_, i) => ({ id: `c-${i}`, company: "Acme" }));
  let rev = 1;
  let selected: string[] = [];
  let accepted = 0;
  const visible = (): Snapshot => ({
    where: "contacts",
    rev,
    rows: all.slice(0, 20).map((r) => ({ ...r })),
    page: { index: 0, size: 20, total: all.length },
    ...(selected.length ? { selected: selected.slice(0, 3) } : {}),
  });

  const driver = mount({
    // Spread LAST, so a test can add `onAudit` or `approve` -- the two this
    // fixture exists to exercise now that the panel's dialog is the core's
    // approver rather than a gate alongside it.
    ...options,
    app: "Contacts",
    visible,
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select every contact matching a filter",
        args: {
          where: { type: "string", describe: "e.g. company=Acme" },
          limit: { type: "number", describe: "select at most this many", optional: true },
        },
        run: ({ where, limit }: { where: string; limit?: number }) => {
          const matched = all.filter((r) => r.company === where.split("=")[1]);
          selected = matched.slice(0, limit ?? matched.length).map((r) => r.id);
          rev++;
          return { count: selected.length, note: `${matched.length} matched` };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        refuses: ["nothing-selected"],
        run: (_a: Record<string, Scalar>, ctx: VerbContext) => {
          if (!selected.length) return ctx.refuse("nothing-selected", "select something first");
          const n = selected.length;
          accepted += n;
          selected = [];
          rev++;
          return { count: n };
        },
      },
    ],
  });
  return { driver, accepted: () => accepted };
}

/** A `think` replaying a script, plus the inputs it was handed. */
function scripted(script: unknown[]): { think: Think; seen: ThinkInput[] } {
  const seen: ThinkInput[] = [];
  let i = 0;
  return {
    seen,
    think: async (input) => {
      seen.push(input);
      const step = script[i++];
      if (step === undefined) throw new Error("widget think ran out of script");
      // A step may be a function so a test can act on the panel -- hit Stop,
      // unmount -- in the middle of a run, which is the only way to test the
      // paths that matter here.
      return (typeof step === "function" ? step() : step) as Awaited<ReturnType<Think>>;
    },
  };
}

function setup(script: unknown[] = [{ text: "ok" }]) {
  const doc = new FakeDocument();
  const app = contacts();
  const s = scripted(script);
  const widget = mountWidget(app.driver, {
    think: s.think,
    document: doc,
    clock: instant,
    open: true,
  });
  const host = doc.host();
  return { doc, app, s, widget, host, log: () => host.one("dk-log") };
}

/**
 * The app this whole file's half of the audit trail is about: `mountWidget`
 * and `onAudit`, and nothing else wired up at all.
 *
 * No `approve`, because that is the shape of the defect — an app that mounted
 * the panel, declared no core gate, and got
 * `approval: "not-asked", policy: "none"` out of `onAudit` for a commit a
 * person had clicked Approve on.
 */
function audited(script: unknown[] = [{ text: "ok" }], options: Partial<WidgetOptions> = {}) {
  const doc = new FakeDocument();
  const events: AuditEvent[] = [];
  const app = contacts({ onAudit: (e) => void events.push(e) });
  const s = scripted(script);
  const widget = mountWidget(app.driver, {
    think: s.think,
    document: doc,
    clock: instant,
    open: true,
    ...options,
  });
  return {
    doc,
    app,
    s,
    widget,
    host: doc.host(),
    events,
    /** The record for the last call of a named verb, which is the one every
     *  test below is about: a run emits one per call and the commit is not the
     *  last of them when the model narrates afterwards. */
     recordFor: (verb: string) => [...events].reverse().find((e) => e.verb === verb),
  };
}

/** The script every gated-commit test below replays: count a selection, then
 *  commit it. The count is what makes the question answerable. */
const ACCEPT_SCRIPT = [
  { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 1000 } }] },
  { calls: [{ id: "b", name: "accept-selected", args: {} }] },
  { text: "Done." },
];

// -------------------------------------------------------------------------
// The record of what the person clicked.
//
// The panel's dialog used to gate OUTSIDE `driver.call()` -- hold the lock,
// ask, then call the verb -- so the core never saw the question and wrote
// `not-asked` for a commit somebody had just approved. The dialog is now
// installed as the core's approver (`DriverApproval.adopt`), which is why the
// answer can be written down by the thing that asked it.
// -------------------------------------------------------------------------

test("a person clicks Approve in the panel and the audit record says so", async () => {
  // THE TEST THIS CHANGE EXISTS FOR. An app that wires up nothing but
  // `mountWidget` and `onAudit` is the case the whole library is about -- a
  // person sitting in front of a bulk commit -- and it was the one case whose
  // record said nobody was asked. A record that reads as complete and says the
  // opposite of what happened is the same class of lie as a `rev` that does
  // not move.
  const a = audited(ACCEPT_SCRIPT);
  await ask(a.host, "accept the top thousand Acme contacts");
  // Still the panel's own dialog, with the count the describe reported: the
  // question moved into the core and the wording did not.
  assert.equal(a.host.one("dk-ask-q").textContent, "accept the current selection — 1,000 rows?");
  await allow(a.host);

  const commit = a.recordFor("accept-selected")!;
  assert.equal(a.app.accepted(), 1000);
  assert.equal(commit.approval, "allowed", "a person was asked and said yes");
  assert.equal(commit.policy, "adopted", "by the dialog this panel installed");
  // The count is in the record beside the answer, which is the pair the whole
  // thing exists for: "did a person approve the 1,000 rows that moved".
  assert.equal(commit.count, 1000);
  a.widget.unmount();
});

test("a person clicks Deny and the record says declined, not not-asked", async () => {
  // The twin, and the distinction `AuditEvent.approval` is four values for:
  // `declined` is a person refusing and `not-asked` is a gate that was not
  // there. Both end with no data moving, so the outcome alone cannot tell them
  // apart -- and before this they were the same word for this app.
  const a = audited(ACCEPT_SCRIPT);
  await ask(a.host, "accept them");
  a.host.one("dk-no").dispatch("click");
  await settle();

  const commit = a.recordFor("accept-selected")!;
  assert.equal(a.app.accepted(), 0);
  assert.equal(commit.approval, "declined");
  assert.notEqual(commit.approval, "not-asked");
  assert.equal(commit.refused, "declined-by-user");
  assert.equal(commit.policy, "adopted");
  a.widget.unmount();
});

test("a commit the panel let through unasked records not-asked and never allowed", async () => {
  // The fabricated yes, which would be a worse bug than the one being fixed.
  // With confirmations switched off nobody is asked, so `allowed` -- which
  // claims a person said yes -- must not appear. `policy: "adopted"` is what
  // keeps this from reading like an app with no gate at all: there was a gate,
  // and it decided this commit did not need a question.
  const a = audited(ACCEPT_SCRIPT, { confirmCommits: false });
  await ask(a.host, "accept them");
  await settle();

  const commit = a.recordFor("accept-selected")!;
  assert.equal(a.app.accepted(), 1000, "it ran, as it always did");
  assert.equal(a.host.find("dk-ask-q").length, 0, "and nobody was asked");
  assert.equal(commit.approval, "not-asked");
  assert.equal(commit.policy, "adopted");
  a.widget.unmount();
});

test("unmounting the panel hands the gate back, and the records after it say so", async () => {
  // A gate that lives in a panel is gone when the panel is, and `policy` has
  // to be able to say that -- it is the whole reason `adopted` is a different
  // word from `hook`. Pinned because the alternative is worse than the bug:
  // a driver left pointing at a dead dialog waits forever on every later
  // commit, since `approvalTimeout` is absent by default.
  const a = audited();
  assert.equal(a.app.driver.approval?.policy, "adopted");
  a.widget.unmount();
  assert.equal(a.app.driver.approval?.policy, "none");

  await a.app.driver.call("accept-selected");
  const commit = a.recordFor("accept-selected")!;
  assert.equal(commit.approval, "not-asked");
  assert.equal(commit.policy, "none", "no panel, no gate, and the record is honest about it");
});

test("a question still open when the panel unmounts is answered as timed out, not as declined", async () => {
  // The dead-app case. A commit that arrived from outside the page has no run
  // behind it, so there is no abort signal to answer its question -- and a
  // panel torn down with one open would leave `driver.call()` waiting on a
  // promise only that panel could resolve. Answered as `{ timedOut: true }`,
  // because nobody answering is not somebody refusing: `timed-out` says the
  // verb did not run and no person decided.
  const a = audited();
  const pending = a.app.driver.call("accept-selected");
  await settle();
  assert.equal(a.host.find("dk-yes").length, 1, "the question is on screen");

  a.widget.unmount();
  const out = await pending;
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.refused, "approval-timeout");
  assert.equal(a.app.accepted(), 0);
  const commit = a.recordFor("accept-selected")!;
  assert.equal(commit.approval, "timed-out");
  assert.notEqual(commit.approval, "declined");
});

test("a commit from outside the page is asked about in the panel, and recorded", async () => {
  // What adoption buys beyond the record: the dialog now covers the path it
  // never could. `driver.call()` here stands for a relay frame or an MCP tool
  // call -- a commit with no in-page run behind it, which used to reach the
  // verb with nothing in front of it on an app that declared no `approve`.
  const a = audited();
  // Selected from outside too: a commit verb takes no predicate and acts on
  // the current selection, so there has to be one.
  await a.app.driver.call("select-where", { where: "company=Acme", limit: 1000 });
  const pending = a.app.driver.call("accept-selected");
  await settle();
  // The panel opens itself: a question nobody can see is not a question.
  assert.match(a.host.one("dk-ask-q").textContent!, /accept the current selection/);
  await allow(a.host);

  assert.equal((await pending).ok, true);
  const commit = a.recordFor("accept-selected")!;
  assert.equal(commit.approval, "allowed");
  assert.equal(commit.policy, "adopted");
  a.widget.unmount();
});

test("an app that declared its own approve keeps it, and gets one dialog and not two", async () => {
  // Silently replacing an app's approver would be worse than the bug: the
  // app's own gate would stop running with nothing anywhere saying so. So the
  // declaration wins, the panel installs nothing, and `policy` still reads
  // `hook` -- which is also what keeps `connect()` reading the app's own
  // sentence rather than a panel's presence.
  const doc = new FakeDocument();
  const events: AuditEvent[] = [];
  let asked = 0;
  const app = contacts({
    onAudit: (e) => void events.push(e),
    approve: () => {
      asked++;
      return true;
    },
  });
  const s = scripted(ACCEPT_SCRIPT);
  const widget = mountWidget(app.driver, {
    think: s.think,
    document: doc,
    clock: instant,
    open: true,
  });
  const host = doc.host();
  await ask(host, "accept them");
  await settle();

  assert.equal(app.driver.approval?.policy, "hook", "the app's declaration stands");
  assert.equal(asked, 1, "its hook was asked");
  assert.equal(host.find("dk-ask-q").length, 0, "and the panel put up no second question");
  const commit = [...events].reverse().find((e) => e.verb === "accept-selected")!;
  assert.equal(commit.approval, "allowed");
  assert.equal(commit.policy, "hook");
  widget.unmount();
});

test("`approve: \"unattended\"` is not quietly made interactive by mounting a panel", async () => {
  // `unattended` is the app saying out loud that commits here run with nobody
  // in front of them. A panel that installed a dialog over that would make an
  // unattended driver interactive -- the configuration somebody deliberately
  // chose against -- so the adoption is refused and the panel keeps the in-page
  // gate it has always had.
  //
  // The cost is real and is therefore said out loud rather than papered over:
  // the panel's question is not in the record for this app, because the core
  // was never asked. A truthful warning beats a fabricated `allowed`.
  const doc = new FakeDocument();
  const events: AuditEvent[] = [];
  const app = contacts({ onAudit: (e) => void events.push(e), approve: "unattended" });
  const s = scripted(ACCEPT_SCRIPT);
  const said: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  let widget;
  try {
    widget = mountWidget(app.driver, {
      think: s.think,
      document: doc,
      clock: instant,
      open: true,
    });
  } finally {
    console.warn = real;
  }
  const host = doc.host();

  assert.equal(app.driver.approval?.policy, "unattended", "the declaration is untouched");
  assert.match(said.join("\n"), /NOT in the audit record/);
  assert.match(said.join("\n"), /approve: \(req\) => panel\.approve\(req\)/);

  // And the in-page dialog still asks, which is right: somebody is plainly
  // sitting there.
  await ask(host, "accept them");
  assert.match(host.one("dk-ask-q").textContent!, /1,000 rows/);
  await allow(host);
  assert.equal(app.accepted(), 1000);
  const commit = [...events].reverse().find((e) => e.verb === "accept-selected")!;
  assert.equal(commit.approval, "not-asked", "which is what the warning is about");
  assert.equal(commit.policy, "unattended");
  widget.unmount();
});

test("a host's own onBeforeCommit still replaces the dialog, even when it says yes", async () => {
  // The stacking hazard, from the other side. The panel installs its dialog as
  // the core's approver by default -- so a host that supplied `onBeforeCommit`
  // and got a yes from it would have had the panel's own question asked
  // immediately afterwards, inside `driver.call()`. Two questions about one
  // commit, which is what `onBeforeCommit` is documented NOT to do. So the
  // panel does not adopt when the host supplied one.
  //
  // What that costs is in the record and is said in `onBeforeCommit`'s own
  // docs: the host's gate is outside the core, so the core was never asked and
  // `not-asked` is the honest answer. A host that wants its dialog in the
  // record passes it as `approve`.
  const doc = new FakeDocument();
  const events: AuditEvent[] = [];
  const app = contacts({ onAudit: (e) => void events.push(e) });
  const asked: string[] = [];
  const s = scripted(ACCEPT_SCRIPT);
  const widget = mountWidget(app.driver, {
    document: doc,
    clock: instant,
    open: true,
    think: s.think,
    onBeforeCommit: ({ name }) => {
      asked.push(name);
      return true;
    },
  });
  const host = doc.host();
  await ask(host, "accept them");
  await settle();

  assert.deepEqual(asked, ["accept-selected"], "the host's gate was asked");
  assert.equal(host.find("dk-ask").length, 0, "and the panel asked nothing on top of it");
  assert.equal(app.accepted(), 1000);
  assert.equal(app.driver.approval?.policy, "none", "the panel did not take the gate");
  const commit = [...events].reverse().find((e) => e.verb === "accept-selected")!;
  assert.equal(commit.approval, "not-asked");
  assert.equal(commit.policy, "none", "which is the honest answer for a gate outside the core");
  widget.unmount();
});

test("two panels on one driver share one gate, and the second says which", async () => {
  // Two gates for one commit is two dialogs, which is how people learn to
  // click Yes without reading. The first panel keeps it; the second installs
  // nothing and asks nothing, so its own runs are confirmed in the first
  // panel's transcript. Warned about, because that symptom is otherwise
  // unreadable.
  const first = audited();
  const second = doc2(first.app.driver);
  assert.equal(first.app.driver.approval?.policy, "adopted");
  assert.match(second.said.join("\n"), /second approval dialog tried to adopt `Contacts`/);

  await first.app.driver.call("select-where", { where: "company=Acme", limit: 1000 });
  const pending = first.app.driver.call("accept-selected");
  await settle();
  assert.equal(first.host.find("dk-yes").length, 1, "the first panel asks");
  assert.equal(second.host.find("dk-yes").length, 0, "the second does not");
  await allow(first.host);
  assert.equal((await pending).ok, true);

  first.widget.unmount();
  second.widget.unmount();
});

/** A second panel on an existing driver, for the two-panel decision above. */
function doc2(driver: Driver) {
  const doc = new FakeDocument();
  const s = scripted([{ text: "ok" }]);
  const real = console.warn;
  const said: string[] = [];
  console.warn = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  try {
    const widget = mountWidget(driver, {
      think: s.think,
      document: doc,
      clock: instant,
      open: true,
    });
    return { widget, host: doc.host(), said };
  } finally {
    console.warn = real;
  }
}

test("mounting puts one host element in the container and nothing else", () => {
  const doc = new FakeDocument();
  const app = contacts();
  const widget = mountWidget(app.driver, { think: async () => ({ text: "hi" }), document: doc, clock: instant });

  assert.equal(doc.body.children.length, 1);
  const host = doc.host();
  // Shadow DOM, so the host app's CSS cannot reach in and these rules cannot
  // leak out. A library that silently restyles the page it was added to does
  // not get a second chance.
  assert.ok(host.shadow, "the panel was not put in a shadow root");
  // One word, and not the app's name: see the launcher's own comment. The name
  // is in the panel header and in the button's accessible name.
  assert.equal(host.one("dk-launcher").textContent, "Ask");
  assert.equal(host.one("dk-launcher").attrs.get("aria-label"), "Ask Contacts to do something");
  // Closed by default: a panel that opens itself opens over something the
  // person was reading.
  assert.equal(host.one("dk-wrap").className, "dk-wrap");
  assert.equal(host.one("dk-launcher").attrs.get("aria-expanded"), "false");

  widget.unmount();
});

test("unmount removes the host and is idempotent", () => {
  const { doc, widget, host } = setup();
  widget.unmount();
  widget.unmount();
  assert.equal(doc.body.children.length, 0);
  assert.equal(host.removed, true);
});

test("a typed message reaches think and the answer reaches the transcript", async () => {
  const { s, widget, host, log } = setup([{ text: "There are two Acme contacts." }]);

  const input = host.one("dk-input");
  input.value = "how many Acme contacts?";
  host.one("dk-form").dispatch("submit");
  await settle();

  assert.equal(s.seen.length, 1);
  const first = s.seen[0]!.messages[0] as { role: string; text: string };
  assert.equal(first.role, "user");
  assert.match(first.text, /how many Acme contacts\?/);
  // The screen rides along in that same newest message, which is where the
  // uncached half belongs.
  assert.match(first.text, /where: contacts \(rev 1\)/);

  assert.match(log().text(), /how many Acme contacts\?/);
  assert.match(log().text(), /There are two Acme contacts\./);
  // The input is cleared, because the alternative is sending it twice.
  assert.equal(input.value, "");

  widget.unmount();
});

test("submitting is prevented from navigating, which would reload the host app", async () => {
  const { widget, host } = setup();
  host.one("dk-input").value = "hello";
  const e = host.one("dk-form").dispatch("submit");
  assert.equal(e.defaultPrevented, true);
  await settle();
  widget.unmount();
});

test("an empty message is not sent", async () => {
  const { s, widget, host } = setup([]);
  host.one("dk-input").value = "   ";
  host.one("dk-form").dispatch("submit");
  await settle();
  assert.equal(s.seen.length, 0);
  widget.unmount();
});

test("every verb that ran appears in the trace, with what it did to the world", async () => {
  // A person watching an agent move their own screen needs to see what it did.
  // Silent mutation is alarming even when it is correct, and this is the line
  // somebody scrolls back to when they want to know what changed their data.
  const { app, widget, host, log } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 1000 } }] },
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "Accepted the top thousand." },
  ]);

  await ask(host, "accept the top thousand Acme contacts");
  await allow(host);

  const steps = host.find("dk-step").map((n) => n.textContent);
  assert.deepEqual(steps, [
    "select-where (describe) where=company=Acme limit=1000 · ok · 1,000 matched",
    "accept-selected (commit) · ok · 1,000 matched",
  ]);
  // The commit is marked for the person as well as for the model. The model
  // being told and the person being told are not the same thing.
  assert.ok(host.find("dk-step-commit").length === 1, "the commit was not marked in the trace");
  assert.equal(app.accepted(), 1000);
  assert.match(log().text(), /Accepted the top thousand\./);

  widget.unmount();
});

test("a commit is confirmed with the person by default, with the count in the question", async () => {
  // The widget's default differs from `drive`'s on purpose. A `commit` verb
  // takes no predicate and acts on the whole selection, so this is ONE
  // question for a thousand rows -- the cheapest possible place to put a human
  // in front of the expensive failure.
  const { app, widget, host } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 1000 } }] },
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "Done." },
  ]);

  await ask(host, "accept the top thousand Acme contacts");

  // Nothing has happened yet: the loop is waiting on the person.
  assert.equal(app.accepted(), 0);
  // "accept the current selection?" is a question nobody can answer. The count
  // the preceding describe reported is what makes it answerable, and it is the
  // whole reason the gate exists.
  assert.equal(host.one("dk-ask-q").textContent, "accept the current selection — 1,000 rows?");
  assert.match(host.one("dk-ask-why").textContent!, /changes data and may be irreversible/);
  // The safe answer has focus. Pressing Enter on a dialog that appeared while
  // you were typing must not accept a thousand rows.
  assert.equal(host.one("dk-no").focused, true);

  await allow(host);
  assert.equal(app.accepted(), 1000);
  // The buttons are gone and the answer stays. A live "Yes, do it" beside
  // something that already happened is worse than no record at all.
  assert.equal(host.find("dk-yes").length, 0);
  assert.match(host.one("dk-ask-said").textContent!, /You allowed this/);

  widget.unmount();
});

test("saying no vetoes the commit and the model is told, not crashed", async () => {
  const { app, widget, host } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] },
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "Understood, I have not accepted anything." },
  ]);

  await ask(host, "accept them");
  host.one("dk-no").dispatch("click");
  await settle();

  assert.equal(app.accepted(), 0);
  assert.match(host.one("dk-ask-said").textContent!, /You said no/);
  // A refusal, so it renders in the trace like any other and the model adapts
  // rather than retrying.
  assert.match(host.find("dk-step")[1]!.textContent!, /refused: declined-by-user/);
  assert.match(host.one("dk-log").text(), /I have not accepted anything/);

  widget.unmount();
});

test("a commit with no count says so rather than asking a question nobody can answer", async () => {
  // The honest case. If no `describe` reported a count, the panel does not
  // invent one and does not hide the fact that it cannot say how much this
  // affects -- which is itself a reason to say no.
  const { widget, host } = setup([
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "ok" },
  ]);

  await ask(host, "accept whatever is selected");

  assert.equal(host.one("dk-ask-q").textContent, "accept the current selection?");
  assert.match(host.one("dk-ask-why").textContent!, /No count was reported/);

  host.one("dk-no").dispatch("click");
  await settle();
  widget.unmount();
});

test("the question opens the panel, because a question nobody can see is not a question", async () => {
  const { widget, host } = setup([
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "ok" },
  ]);

  await ask(host, "accept them");
  // The person hit Escape while the model was thinking.
  host.one("dk-input").dispatch("keydown", { key: "Escape" });
  assert.equal(host.one("dk-wrap").className.includes("dk-open"), false);

  host.one("dk-no").dispatch("click");
  await settle();
  widget.unmount();
});

test("confirmCommits false opts out, for an app whose commits are all small", async () => {
  // A question every time, in an app where every commit is one reversible row,
  // is noise that teaches people to click through questions.
  const doc = new FakeDocument();
  const app = contacts();
  const script = [
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 5 } }] },
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "done" },
  ];
  let i = 0;
  const widget = mountWidget(app.driver, {
    document: doc,
    clock: instant,
    open: true,
    confirmCommits: false,
    think: async () => script[i++] as never,
  });
  const host = doc.host();

  await ask(host, "accept five");

  assert.equal(host.find("dk-ask").length, 0, "a question was asked after opting out");
  assert.equal(app.accepted(), 5);
  widget.unmount();
});

/**
 * An app with both kinds of `commit`: `set-page-size`, which declares that it
 * can be undone, and `accept-selected`, which makes no such claim.
 *
 * Two verbs rather than one with a flag flipped, because the pair is the
 * failure `Verb.reversible` was added for: these two were getting the same
 * dialog, and a modal on a page-size change is how somebody learns to click
 * Yes without reading the one about three thousand rows. `selection` is
 * whatever `visible()` should claim is selected, so a test can put the gate's
 * size check on either side of the line.
 */
function undoable(selection: { selectedCount?: number; selected?: string[] } = {}) {
  let rev = 1;
  const ran: string[] = [];
  const driver = mount({
    app: "Contacts",
    visible: (): Snapshot => ({ where: "contacts", rev, rows: [{ id: "c-0" }], ...selection }),
    verbs: [
      {
        name: "set-page-size",
        kind: "commit",
        reversible: true,
        describe: "change how many rows a page shows",
        args: { size: { type: "number", describe: "rows per page" } },
        run: () => {
          ran.push("set-page-size");
          rev++;
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        run: () => {
          ran.push("accept-selected");
          rev++;
        },
      },
    ],
  });
  return { driver, ran };
}

type GateOptions = Omit<Partial<WidgetOptions>, "think" | "document" | "clock">;

/** A panel over an arbitrary driver, with the clock that does not sleep. */
function panel(driver: Driver, script: unknown[], o: GateOptions = {}) {
  const doc = new FakeDocument();
  const s = scripted(script);
  const widget = mountWidget(driver, {
    think: s.think,
    document: doc,
    clock: instant,
    open: true,
    ...o,
  });
  return { widget, host: doc.host(), s };
}

/** One call to the named verb and then a sentence, which is the shape of every
 *  run in the gate tests below. */
function oneCall(name: string, args: Record<string, unknown> = {}): unknown[] {
  return [{ calls: [{ id: "a", name, args }] }, { text: "done" }];
}

test("a commit the app says it can undo runs without a dialog", async () => {
  // The exact failure `Verb.reversible` was added to name. A page-size change
  // and accepting 3,412 contacts were both `commit`, so both stopped to ask a
  // person — and a modal on something trivial is how people learn to click Yes
  // without reading. The next modal they skip is the bulk accept.
  const app = undoable();
  const { widget, host } = panel(app.driver, oneCall("set-page-size", { size: 50 }));

  await ask(host, "show fifty rows a page");

  assert.equal(host.find("dk-ask").length, 0, "a reversible commit was put behind a dialog");
  assert.deepEqual(app.ran, ["set-page-size"]);
  // It is still in the transcript, and still marked as a commit: running
  // without a question is not the same as running unseen. `reversible` means
  // there is a way back, not that nobody minds.
  assert.equal(host.find("dk-step-commit").length, 1);
  widget.unmount();
});

test("a commit that has not said it can be undone is still gated", async () => {
  // Absent `reversible` makes no claim, and the two wrong defaults do not cost
  // the same thing: letting an unclaimed commit through is a bulk accept
  // nobody saw, and the field would be useless if not filling it in were the
  // safe option.
  const app = undoable({ selectedCount: 3 });
  const { widget, host } = panel(app.driver, oneCall("accept-selected"));

  await ask(host, "accept them");

  assert.equal(host.find("dk-ask").length, 1, "an unclaimed commit ran unasked");
  assert.deepEqual(app.ran, []);
  await allow(host);
  assert.deepEqual(app.ran, ["accept-selected"]);
  widget.unmount();
});

test("a reversible commit on a large selection is asked about anyway", async () => {
  // "Undo" over three thousand rows is a promise an app may not be able to
  // keep at that size, whatever it declared — a buffer sized for one row, a
  // half-applied batch, a server that gave up partway. `reversible` is a claim
  // about the kind of change and not about its volume, so the volume is
  // checked separately and the flag does not answer for it.
  const app = undoable({ selectedCount: 3412 });
  const { widget, host } = panel(app.driver, oneCall("set-page-size", { size: 50 }));

  await ask(host, "change the page size");

  assert.equal(host.find("dk-ask").length, 1, "a large reversible commit ran unasked");
  assert.equal(host.one("dk-ask-q").textContent, "change how many rows a page shows — 3,412 rows?");
  assert.deepEqual(app.ran, []);
  await allow(host);
  assert.deepEqual(app.ran, ["set-page-size"]);
  widget.unmount();
});

test("the size that triggers it can be counted from the ids on screen", async () => {
  // `Snapshot.selected` carries only the ids a person can see, so it is the
  // true size of the selection exactly when the whole selection is on screen —
  // which is the case an app with no `selectedCount` leaves as the only
  // evidence there is. Believed as a floor rather than ignored.
  const app = undoable({ selected: Array.from({ length: 40 }, (_, i) => `c-${i}`) });
  const { widget, host } = panel(app.driver, oneCall("set-page-size", { size: 50 }));

  await ask(host, "change the page size");

  assert.equal(host.find("dk-ask").length, 1, "forty selected rows did not reach the gate");
  assert.equal(host.one("dk-ask-q").textContent, "change how many rows a page shows — 40 rows?");
  host.one("dk-no").dispatch("click");
  await settle();
  widget.unmount();
});

test("the two dialogs do not read alike: one says there is a way back and one does not", async () => {
  // Two dialogs that read identically are one dialog as far as a person's
  // attention is concerned — which would reintroduce the exact failure this
  // whole gate change exists to avoid, one level down. So the reversible one
  // says so, and says why it is being asked about at all when the only reason
  // is the size.
  const undo = undoable({ selectedCount: 3412 });
  const a = panel(undo.driver, oneCall("set-page-size", { size: 50 }));
  await ask(a.host, "change the page size");
  const reversible = a.host.one("dk-ask-why").textContent!;
  assert.match(reversible, /this can be undone/);
  assert.doesNotMatch(reversible, /irreversible/);
  // And the reason it was asked at all, because "you said this was undoable
  // and you are asking me anyway" is otherwise a contradiction.
  assert.match(reversible, /a promise an app may not be able to keep/);
  a.host.one("dk-no").dispatch("click");
  await settle();
  a.widget.unmount();

  const plain = undoable({ selectedCount: 3412 });
  const b = panel(plain.driver, oneCall("accept-selected"));
  await ask(b.host, "accept them");
  const irreversible = b.host.one("dk-ask-why").textContent!;
  assert.match(irreversible, /changes data and may be irreversible/);
  assert.doesNotMatch(irreversible, /can be undone/);
  b.host.one("dk-no").dispatch("click");
  await settle();
  b.widget.unmount();
});

test("commitAskAbove moves the line, because the number is a judgement and not a fact", async () => {
  // One number for every app is wrong for some of them: where an app's own
  // undo stops being credible is something its author knows and this library
  // does not. `COMMIT_ASK_ABOVE` is the default and this is the override.
  const strict = undoable({ selectedCount: 2 });
  const a = panel(strict.driver, oneCall("set-page-size", { size: 50 }), { commitAskAbove: 1 });
  await ask(a.host, "change the page size");
  assert.equal(a.host.find("dk-ask").length, 1, "the lowered threshold was not read");
  a.host.one("dk-no").dispatch("click");
  await settle();
  a.widget.unmount();

  // And the other way: an app confident in its undo at any size.
  const loose = undoable({ selectedCount: 3412 });
  const b = panel(loose.driver, oneCall("set-page-size", { size: 50 }), {
    commitAskAbove: Number.POSITIVE_INFINITY,
  });
  await ask(b.host, "change the page size");
  assert.equal(b.host.find("dk-ask").length, 0, "the raised threshold was not read");
  assert.deepEqual(loose.ran, ["set-page-size"]);
  b.widget.unmount();

  // The default is a shipped number and not a private one: a host replacing it
  // should be able to say in its own help text what it replaced.
  assert.equal(COMMIT_ASK_ABOVE, 25);
  const atLine = undoable({ selectedCount: COMMIT_ASK_ABOVE });
  const c = panel(atLine.driver, oneCall("set-page-size", { size: 50 }));
  await ask(c.host, "change the page size");
  // "Above" means above, so a selection exactly on the line goes through.
  assert.equal(c.host.find("dk-ask").length, 0);
  c.widget.unmount();
});

test("confirmEveryCommit brings back the question on every commit, for an app that wants it", async () => {
  // An app whose "undo" is a toast that vanishes in five seconds, or one under
  // a rule that a person signs for every write. Those are decisions about the
  // app and the app gets to make them; what they are not is the right default
  // for everybody.
  const app = undoable();
  const { widget, host } = panel(app.driver, oneCall("set-page-size", { size: 50 }), {
    confirmEveryCommit: true,
  });

  await ask(host, "change the page size");

  assert.equal(host.find("dk-ask").length, 1, "the forced question did not appear");
  // Still the reversible wording: the host asked to be asked, it did not ask
  // to be misled about what the verb does.
  assert.match(host.one("dk-ask-why").textContent!, /this can be undone/);
  // And nothing about the size, because the size is not why this was asked.
  assert.doesNotMatch(host.one("dk-ask-why").textContent!, /a promise an app may not be able/);
  await allow(host);
  assert.deepEqual(app.ran, ["set-page-size"]);
  widget.unmount();
});

test("confirmCommits false still beats everything, reversible or not", async () => {
  // The switch a person reached for in the settings view is about whether they
  // are asked at all, and it is above both of the finer rules.
  const app = undoable({ selectedCount: 3412 });
  const { widget, host } = panel(app.driver, oneCall("accept-selected"), {
    confirmCommits: false,
    confirmEveryCommit: true,
  });

  await ask(host, "accept them");

  assert.equal(host.find("dk-ask").length, 0);
  assert.deepEqual(app.ran, ["accept-selected"]);
  widget.unmount();
});

test("a host onBeforeCommit is called for a reversible commit too, and nothing else is", async () => {
  // It overrides rather than stacks, and that has to hold in the direction the
  // built-in gate now stays quiet in: a host that supplied its own question is
  // asking about every commit, and silently skipping the reversible ones would
  // be the panel overruling a policy it was handed.
  const app = undoable();
  const seen: string[] = [];
  const { widget, host } = panel(app.driver, oneCall("set-page-size", { size: 50 }), {
    onBeforeCommit: ({ name }) => {
      seen.push(name);
      return "the operator has not signed off on this";
    },
  });

  await ask(host, "change the page size");

  assert.deepEqual(seen, ["set-page-size"]);
  assert.deepEqual(app.ran, [], "the host's veto was not obeyed");
  assert.equal(host.find("dk-ask").length, 0, "the built-in question was asked as well");
  assert.match(host.find("dk-step")[0]!.textContent!, /refused: declined-by-user/);
  widget.unmount();
});

test("saying no to a large reversible commit still refuses as declined-by-user", async () => {
  // The veto reaches the model as an ordinary refusal whichever dialog asked,
  // so it adapts rather than retrying — and the slug is the one every client
  // already knows.
  const app = undoable({ selectedCount: 3412 });
  const { widget, host } = panel(app.driver, [
    { calls: [{ id: "a", name: "set-page-size", args: { size: 50 } }] },
    { text: "Understood, I have not changed it." },
  ]);

  await ask(host, "change the page size");
  host.one("dk-no").dispatch("click");
  await settle();

  assert.deepEqual(app.ran, []);
  assert.match(host.one("dk-ask-said").textContent!, /You said no/);
  assert.match(host.find("dk-step")[0]!.textContent!, /refused: declined-by-user/);
  widget.unmount();
});

test("stopping while a question is open answers it, rather than hanging the panel forever", async () => {
  // Without this the loop waits on a promise nobody will resolve and the panel
  // is stuck busy. The abort has to answer the question, and the only safe
  // answer is no.
  const { app, widget, host } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] },
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
  ]);

  await ask(host, "accept them");
  assert.equal(host.find("dk-ask").length, 1);

  host.one("dk-stop").dispatch("click");
  await settle();

  assert.equal(app.accepted(), 0);
  assert.match(host.one("dk-ask-said").textContent!, /Stopped before this ran/);
  // And the panel is usable again rather than stuck busy.
  assert.equal(host.one("dk-wrap").className.includes("dk-busy"), false);

  widget.unmount();
});

test("a refusal shows in the trace as a refusal, not as a silent nothing", async () => {
  const { widget, host } = setup([
    { calls: [{ id: "a", name: "accept-selected", args: {} }] },
    { text: "Nothing was selected." },
  ]);

  await ask(host, "accept them");
  // Allowed by the person, and refused by the app anyway. Those are different
  // answers from different parties and both have to be visible.
  await allow(host);

  assert.match(host.one("dk-step").textContent!, /accept-selected \(commit\) · refused: nothing-selected/);
  assert.equal(host.find("dk-step-refused").length, 1);

  widget.unmount();
});

test("Escape closes the panel from inside it, where the person's focus actually is", async () => {
  // The handler is on the wrapper and the keypress happens in the input, so
  // this only works if the event bubbles — which is why the fake DOM models
  // bubbling rather than dispatching to the target alone.
  const { widget, host } = setup();
  const wrap = host.one("dk-wrap");
  assert.equal(wrap.className, "dk-wrap dk-open");

  const e = host.one("dk-input").dispatch("keydown", { key: "Escape" });

  assert.equal(host.one("dk-wrap").className, "dk-wrap");
  assert.equal(host.one("dk-launcher").attrs.get("aria-expanded"), "false");
  assert.equal(e.defaultPrevented, true);
  // Focus goes back to the launcher: a keyboard user who closes a panel and is
  // left nowhere has lost their place in the app entirely.
  assert.equal(host.one("dk-launcher").focused, true);

  widget.unmount();
});

test("other keys are left alone, including inside the input", () => {
  const { widget, host } = setup();
  host.one("dk-input").dispatch("keydown", { key: "e" });
  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open");
  widget.unmount();
});

test("the launcher opens the panel and moves focus into it", () => {
  const doc = new FakeDocument();
  const app = contacts();
  const widget = mountWidget(app.driver, { think: async () => ({ text: "x" }), document: doc, clock: instant });
  const host = doc.host();

  host.one("dk-launcher").dispatch("click");

  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open");
  assert.equal(host.one("dk-launcher").attrs.get("aria-expanded"), "true");
  // Opening a panel and leaving the keyboard on the launcher means tabbing
  // through the whole host app to reach the input.
  assert.equal(host.one("dk-input").focused, true);

  widget.unmount();
});

test("the panel is keyboard reachable and announces itself", () => {
  const { widget, host } = setup();
  assert.equal(host.one("dk-panel").attrs.get("role"), "dialog");
  assert.match(host.one("dk-panel").attrs.get("aria-label")!, /Contacts/);
  // Not aria-modal: the person is meant to keep using the app while this is
  // open, and claiming modality would tell a screen reader to hide the page
  // this panel exists to drive.
  assert.equal(host.one("dk-panel").attrs.has?.("aria-modal") ?? false, false);
  assert.equal(host.one("dk-log").attrs.get("aria-live"), "polite");
  assert.equal(host.one("dk-log").attrs.get("role"), "log");
  assert.match(host.one("dk-input").attrs.get("aria-label")!, /Ask Contacts/);
  assert.equal(host.one("dk-launcher").attrs.get("type"), "button");
  widget.unmount();
});

test("the stop button aborts the run in flight", async () => {
  const { app, widget, host } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] },
    () => {
      host.one("dk-stop").dispatch("click");
      return { calls: [{ id: "b", name: "accept-selected", args: {} }] };
    },
  ]);

  await ask(host, "accept them");

  // An abort that still commits is not an abort.
  assert.equal(app.accepted(), 0);
  assert.match(host.one("dk-log").text(), /Stopped\./);

  widget.unmount();
});

test("a second message while a run is in flight is dropped rather than interleaved", async () => {
  // Assigned inside the `new Promise` executor below, which flow analysis
  // cannot see: declared `(() => void) | null` it stayed narrowed to its `null`
  // initializer all the way down, and `release?.()` then filtered `null` out
  // and left `never`. A no-op default is the honest shape -- there is always
  // something to call, and calling it before the think has started does the
  // same nothing the optional call did.
  let release: () => void = () => {};
  const doc = new FakeDocument();
  const app = contacts();
  let calls = 0;
  const widget = mountWidget(app.driver, {
    document: doc,
    clock: instant,
    open: true,
    think: async () => {
      calls++;
      await new Promise<void>((r) => (release = r));
      return { text: "done" };
    },
  });
  const host = doc.host();

  host.one("dk-input").value = "first";
  host.one("dk-form").dispatch("submit");
  await settle();
  host.one("dk-input").value = "second";
  host.one("dk-form").dispatch("submit");
  await settle();

  // Two runs at once would interleave verbs against one screen, and the second
  // run's history would be missing the first run's turns.
  assert.equal(calls, 1);
  release();
  await settle();
  widget.unmount();
});

test("a think that throws is said in the transcript, not only in the console", async () => {
  const errors: unknown[] = [];
  const doc = new FakeDocument();
  const app = contacts();
  const widget = mountWidget(app.driver, {
    document: doc,
    clock: instant,
    open: true,
    think: async () => {
      throw new Error("502 from /api/chat");
    },
    onError: (e) => errors.push(e),
  });
  const host = doc.host();

  await ask(host, "do something");

  // The person is looking at a panel that just went quiet; the console is not
  // where they are looking.
  assert.match(host.one("dk-log").text(), /502 from \/api\/chat/);
  assert.equal(errors.length, 1);
  // And the panel is usable again.
  assert.equal(host.one("dk-send").attrs.has?.("disabled") ?? false, false);

  widget.unmount();
});

test("the conversation continues across messages", async () => {
  const { s, widget, host } = setup([{ text: "two" }, { text: "accepted" }]);

  await ask(host, "how many Acme contacts?");
  await ask(host, "accept them");

  assert.deepEqual(
    s.seen[1]!.messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  widget.unmount();
});

test("a host onBeforeCommit replaces the built-in question instead of stacking with it", async () => {
  const doc = new FakeDocument();
  const app = contacts();
  const asked: string[] = [];
  const widget = mountWidget(app.driver, {
    document: doc,
    clock: instant,
    open: true,
    onBeforeCommit: ({ name }) => {
      asked.push(name);
      return false;
    },
    think: (() => {
      const script = [
        { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] },
        { calls: [{ id: "b", name: "accept-selected", args: {} }] },
        { text: "You declined." },
      ];
      let i = 0;
      return async () => script[i++] as never;
    })(),
  });
  const host = doc.host();

  await ask(host, "accept them");

  assert.deepEqual(asked, ["accept-selected"]);
  assert.equal(app.accepted(), 0);
  // It OVERRIDES the built-in row rather than stacking with it. A host dialog
  // and then the panel's own question would be two questions about one commit,
  // which is how people learn to click yes without reading.
  assert.equal(host.find("dk-ask").length, 0, "the built-in question was asked as well");
  // The veto is a refusal, so it renders in the trace like any other.
  assert.match(host.find("dk-step")[1]!.textContent!, /refused: declined-by-user/);

  widget.unmount();
});

test("ask() drives a message without a DOM event, for a host app with its own launcher", async () => {
  const { s, widget } = setup([{ text: "ok" }]);
  await widget.ask("do the thing");
  assert.match((s.seen[0]!.messages[0] as { text: string }).text, /do the thing/);
  widget.unmount();
});

test("unmount aborts a run in flight rather than leaving it driving a dead panel", async () => {
  const { app, widget, host } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] },
    () => {
      widget.unmount();
      return { calls: [{ id: "b", name: "accept-selected", args: {} }] };
    },
  ]);

  await ask(host, "accept them");
  assert.equal(app.accepted(), 0, "a commit ran after the panel was torn down");
});

test("a missing document is a loud failure at mount, not a null at the first click", () => {
  const app = contacts();
  assert.throws(
    () => mountWidget(app.driver, { think: async () => ({}), document: undefined as never }),
    /no document/,
  );
});

test("the panel degrades rather than refusing to mount without shadow DOM", () => {
  // Without a shadow tree the host app's CSS can reach these elements, so the
  // panel may look wrong. Refusing to mount would be worse: a chat panel is
  // not worth failing an app's boot over.
  const doc = new FakeDocument(false);
  const app = contacts();
  const widget = mountWidget(app.driver, { think: async () => ({}), document: doc, clock: instant });

  const host = doc.host();
  assert.equal(host.shadow, null);
  assert.equal(host.find("dk-launcher").length, 1, "nothing was rendered");
  widget.unmount();
});

// ---- helpers --------------------------------------------------------------

async function ask(host: FakeNode, text: string): Promise<void> {
  host.one("dk-input").value = text;
  host.one("dk-form").dispatch("submit");
  await settle();
}

/** Answer the built-in confirmation with yes, and let the run finish. */
async function allow(host: FakeNode): Promise<void> {
  host.one("dk-yes").dispatch("click");
  await settle();
}

/** Let the loop's microtasks run. The submit handler is deliberately not
 *  async — a DOM event handler that returns a promise is a promise nobody
 *  awaits — so the tests drain the queue instead. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a selection the person made themselves is counted in the question, from selectedCount", async () => {
  // The commit gate's whole value is turning "accept the current selection?"
  // into a question somebody can answer. `lastCount` only covers a selection
  // the MODEL made in this run, and the two cases it misses are ordinary: the
  // person selected the rows by hand, or did it in an earlier run. A commit
  // verb takes no predicate and acts on the current selection, so the size of
  // that selection is what this question is about either way — and
  // `Snapshot.selectedCount` is the only field that can say it, because
  // `selected` deliberately carries the visible ids only.
  const doc = new FakeDocument();
  let accepted = 0;
  const driver = mount({
    app: "Contacts",
    visible: () => ({
      where: "contacts",
      rev: 1,
      rows: [{ id: "c-0" }, { id: "c-1" }],
      page: { index: 0, size: 2, total: 10000 },
      selected: ["c-0", "c-1"],
      selectedCount: 7400,
    }),
    verbs: [
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        run: () => {
          accepted++;
        },
      },
    ],
  });

  const s = scripted([
    { calls: [{ id: "a", name: "accept-selected", args: {} }] },
    { text: "accepted" },
  ]);
  const widget = mountWidget(driver, { think: s.think, document: doc, clock: instant, open: true });
  const host = doc.host();

  await ask(host, "accept what I picked");

  assert.equal(host.one("dk-ask-q").textContent, "accept the current selection — 7,400 rows?");
  assert.doesNotMatch(host.one("dk-ask-why").textContent!, /No count was reported/);

  host.one("dk-no").dispatch("click");
  await settle();
  assert.equal(accepted, 0);
  widget.unmount();
});

// ---- where the panel sits -------------------------------------------------
//
// This half of the suite is about one thing: the widget drives the app
// UNDERNEATH itself, so the panel ends up sitting on top of the rows somebody
// just asked it to select. Moving it is not a preference, it is how they see
// the result — which makes "the panel cannot be reached any more" a far worse
// bug here than a misplaced pixel, and most of what follows is about that.
//
// The assertions are about the measured box wherever they can be, not about
// which custom property was written, because "the panel is on the screen" is a
// claim about geometry. See `FakeWindow` in `fake-dom.ts`.

const BOX = { width: 380, height: 520 };
const VIEW = { width: 1200, height: 800 };
/** The left and top of the far corner, at this viewport and this panel. */
const FAR_X = VIEW.width - GAP - BOX.width;
const FAR_Y = VIEW.height - GAP - BOX.height;

interface PlaceOptions {
  position?: Position;
  persist?: boolean;
  draggable?: boolean;
  snapThreshold?: number;
  storage?: FakeStorage;
  win?: FakeWindow;
  open?: boolean;
  box?: { width: number; height: number };
}

function place(o: PlaceOptions = {}) {
  const win = o.win ?? new FakeWindow(VIEW.width, VIEW.height);
  const doc = new FakeDocument(true, win, o.box ?? BOX);
  const app = contacts();
  const storage = o.storage ?? new FakeStorage();
  const options: WidgetOptions = {
    think: async () => ({ text: "ok" }),
    document: doc,
    clock: instant,
    window: win,
    storage,
    open: o.open !== false,
  };
  if (o.position !== undefined) options.position = o.position;
  if (o.persist !== undefined) options.persist = o.persist;
  if (o.draggable !== undefined) options.draggable = o.draggable;
  if (o.snapThreshold !== undefined) options.snapThreshold = o.snapThreshold;
  const widget = mountWidget(app.driver, options);
  const host = doc.host();
  return { win, doc, storage, widget, host, rect: () => host.getBoundingClientRect() };
}

/** One pointer gesture: press, move, release. Pointer Events throughout, so
 *  mouse, touch and pen are one code path rather than three chances to get the
 *  clamping wrong in only one of them. */
function dragBy(on: FakeNode, dx: number, dy: number): void {
  press(on);
  on.dispatch("pointermove", { pointerId: 7, clientX: 500 + dx, clientY: 500 + dy });
  on.dispatch("pointerup", { pointerId: 7, clientX: 500 + dx, clientY: 500 + dy });
}

function press(on: FakeNode, x = 500, y = 500): void {
  on.dispatch("pointerdown", { pointerId: 7, button: 0, clientX: x, clientY: y });
}

/** Pixels are the product of a float multiplication here, so they are compared
 *  with a tolerance smaller than anything a person could see. */
function near(actual: number, expected: number, within = 0.5): void {
  assert.ok(
    Math.abs(actual - expected) <= within,
    `expected ${actual} to be within ${within} of ${expected}`,
  );
}

function arrow(node: FakeNode, key: string, alt = false): { defaultPrevented: boolean } {
  return node.dispatch("keydown", { key, altKey: alt });
}

test("the default position is left to the stylesheet, so a host app can place the panel in CSS", () => {
  // The one hook that crosses a shadow boundary is a custom property, and the
  // widget writing one inline would outrank the host app's own stylesheet
  // forever. So with no `position` option and nothing remembered, it writes
  // nothing at all and `:host` decides — which is bottom-right.
  const { widget, host, rect } = place();
  assert.equal(host.style.props.size, 0, "the widget wrote a position nobody asked it to");
  near(rect().left, FAR_X);
  near(rect().top, FAR_Y);
  widget.unmount();
});

test("each corner preset puts the panel in that corner", () => {
  const corners: Array<[Position, number, number]> = [
    ["top-left", GAP, GAP],
    ["top-right", FAR_X, GAP],
    ["bottom-left", GAP, FAR_Y],
    ["bottom-right", FAR_X, FAR_Y],
  ];
  for (const [position, left, top] of corners) {
    const { widget, rect } = place({ position });
    near(rect().left, left);
    near(rect().top, top);
    widget.unmount();
  }
});

test("an explicit x and y is honoured in pixels and kept as a fraction", () => {
  // Pixels are what a host app has on hand, so they are accepted — and
  // converted once, against the viewport they were measured in. Nothing is
  // STORED in pixels, because a remembered pixel offset describes an
  // off-screen panel the moment the window narrows and an off-screen panel has
  // no header to grab.
  const { widget, host, rect } = place({ position: { x: 400, y: 100 } });
  near(rect().left, 400);
  near(rect().top, 100);
  const at = widget.position()!;
  near(at.fx, (400 - GAP) / (VIEW.width - GAP * 2 - BOX.width), 0.001);
  assert.ok(host.style.props.has("--dk-x"));
  widget.unmount();
});

test("dragging the grip moves the panel", () => {
  const { widget, host, rect } = place();
  dragBy(host.one("dk-move"), -300, -100);
  near(rect().left, FAR_X - 300);
  near(rect().top, FAR_Y - 100);
  widget.unmount();
});

test("a drag is clamped at every edge, during the drag and not only on release", () => {
  // Clamped per move, because a panel that spends even one frame with its
  // header under the edge of the window is a panel somebody has to chase.
  const far = 5000;
  const pulls: Array<[number, number, number, number]> = [
    [-far, 0, GAP, FAR_Y],
    [far, 0, FAR_X, FAR_Y],
    [0, -far, FAR_X, GAP],
    [0, far, FAR_X, FAR_Y],
    [-far, -far, GAP, GAP],
  ];
  for (const [dx, dy, left, top] of pulls) {
    const { widget, host, rect } = place();
    const head = host.one("dk-move");
    press(head);
    head.dispatch("pointermove", { pointerId: 7, clientX: 500 + dx, clientY: 500 + dy });
    near(rect().left, left);
    near(rect().top, top);
    head.dispatch("pointerup", { pointerId: 7, clientX: 500 + dx, clientY: 500 + dy });
    widget.unmount();
  }
});

test("a release near a corner snaps into it", () => {
  // Corners are where a panel belongs nearly all the time, because the middle
  // of the screen is where the app's content is. A magnet is cheaper than
  // asking somebody to be precise with a 380px panel.
  const { widget, host, rect } = place();
  dragBy(host.one("dk-move"), -40, -30);
  near(rect().left, FAR_X);
  near(rect().top, FAR_Y);
  assert.match(host.className, /dk-snap/);
  widget.unmount();
});

test("a release far from a corner stays exactly where it was dropped", () => {
  // Somebody who dragged the panel into the middle of the screen meant it.
  const { widget, host, rect } = place();
  dragBy(host.one("dk-move"), -300, -100);
  near(rect().left, FAR_X - 300);
  near(rect().top, FAR_Y - 100);
  assert.doesNotMatch(host.className, /dk-snap/);
  widget.unmount();
});

test("snapThreshold 0 switches the magnet off", () => {
  const { widget, host, rect } = place({ snapThreshold: 0 });
  dragBy(host.one("dk-move"), -40, -30);
  near(rect().left, FAR_X - 40);
  near(rect().top, FAR_Y - 30);
  widget.unmount();
});

test("a snap does not animate for somebody who asked for no animation", () => {
  // Checked in JavaScript as well as in the media query in `css.ts`: a host
  // app can override a stylesheet and cannot override this.
  const win = new FakeWindow(VIEW.width, VIEW.height);
  win.reducedMotion = true;
  const { widget, host } = place({ win });
  dragBy(host.one("dk-move"), -40, -30);
  assert.doesNotMatch(host.className, /dk-snap/);
  widget.unmount();
});

test("a drag of the launcher does not fire its click", () => {
  // Shoving the collapsed launcher off the rows somebody wants to read must
  // not then open the panel back over them.
  const { widget, host } = place({ open: false });
  const launcher = host.one("dk-launcher");
  dragBy(launcher, -200, -60);
  launcher.dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap", "the drag opened the panel");
  widget.unmount();
});

test("a press that barely moves is still a click, told apart by distance and not by time", () => {
  // Time is wrong in both directions: a slow deliberate click is not a drag,
  // and a fast flick across the screen is not a click. Fingers also wobble a
  // pixel or two on a tap that meant nothing.
  const { widget, host } = place({ open: false });
  const launcher = host.one("dk-launcher");
  press(launcher);
  launcher.dispatch("pointermove", { pointerId: 7, clientX: 502, clientY: 501 });
  launcher.dispatch("pointerup", { pointerId: 7, clientX: 502, clientY: 501 });
  launcher.dispatch("click");

  assert.match(host.one("dk-wrap").className, /dk-open/, "a two-pixel wobble swallowed the click");
  // And nothing moved by those two pixels either.
  assert.equal(host.style.props.size, 0);
  widget.unmount();
});

test("the header is not a drag surface, so nothing in it can start a drag", () => {
  // The header WAS the handle, and that is why an imprecise press near a
  // button could move the panel: "ignore the controls" is a rule about the
  // pixels a button covers, and a header is also the gap between two of them
  // and the padding a pointer lands on when somebody aims at the gear and
  // misses. The grip is the handle now and the strip is inert, so the failure
  // has nowhere left to happen. Every press below bubbles to the header
  // exactly as it does in a browser.
  for (const where of ["dk-head", "dk-title", "dk-gear", "dk-min"]) {
    const { widget, host } = place();
    dragBy(host.one(where), -300, -100);
    assert.equal(host.style.props.size, 0, `a drag from .${where} moved the panel`);
    assert.doesNotMatch(host.className, /dk-dragging/);
    widget.unmount();
  }

  // And the two buttons in it still do their own jobs after a press that
  // wandered, which is what the old `controls: "ignore"` guard was for.
  const { widget, host } = place();
  dragBy(host.one("dk-gear"), -300, -100);
  host.one("dk-gear").dispatch("click");
  assert.match(host.one("dk-wrap").className, /dk-set-open/);
  dragBy(host.one("dk-min"), -300, -100);
  host.one("dk-min").dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap");
  widget.unmount();
});

test("a right-click does not start a drag", () => {
  const { widget, host } = place();
  const head = host.one("dk-move");
  head.dispatch("pointerdown", { pointerId: 7, button: 2, clientX: 500, clientY: 500 });
  head.dispatch("pointermove", { pointerId: 7, clientX: 200, clientY: 200 });
  assert.equal(host.style.props.size, 0);
  widget.unmount();
});

test("a drag releases the pointer capture it took", () => {
  // Capture is what keeps the moves coming once the pointer has left the
  // handle — which it does immediately, since the handle is what is being
  // moved out from under it. A capture that leaks is a handle that goes on
  // eating the page's pointer events.
  const { widget, host } = place();
  const head = host.one("dk-move");
  dragBy(head, -100, -40);
  assert.deepEqual(head.captured, []);
  widget.unmount();
});

test("a cancelled pointer ends the drag rather than sticking the panel to it", () => {
  // The browser took the pointer for a scroll, or the pen left the tablet.
  // Either way it is not coming back.
  const { widget, host, rect } = place();
  const head = host.one("dk-move");
  press(head);
  head.dispatch("pointermove", { pointerId: 7, clientX: 200, clientY: 400 });
  head.dispatch("pointercancel", { pointerId: 7 });
  const left = rect().left;
  head.dispatch("pointermove", { pointerId: 7, clientX: 100, clientY: 100 });
  near(rect().left, left, 0.01);
  widget.unmount();
});

test("draggable false nails the panel down", () => {
  const { widget, host } = place({ draggable: false, position: "top-left" });
  dragBy(host.one("dk-move"), 300, 100);
  near(host.getBoundingClientRect().left, GAP);
  widget.unmount();
});

test("the position survives a remount, per app and per viewer", () => {
  const storage = new FakeStorage();
  const first = place({ storage });
  dragBy(first.host.one("dk-move"), -300, -100);
  const was = first.widget.position()!;
  first.widget.unmount();

  // Namespaced by the app name, so two driverkit apps on one origin do not
  // fight over one remembered position.
  assert.ok(storage.items.has(storageKey("Contacts")));

  const again = place({ storage });
  assert.deepEqual(again.widget.position(), was);
  near(again.rect().left, FAR_X - 300);
  near(again.rect().top, FAR_Y - 100);
  again.widget.unmount();
});

test("a remembered position beats the position option", () => {
  // The option is the author's idea of where the panel goes; the remembered
  // one is where this particular person put it, while looking at their own
  // screen. The person wins.
  const storage = new FakeStorage();
  storage.items.set(storageKey("Contacts"), JSON.stringify({ fx: 0, fy: 0 }));
  const { widget, rect } = place({ storage, position: "bottom-right" });
  near(rect().left, GAP);
  near(rect().top, GAP);
  widget.unmount();
});

test("the position option is not written back to storage", () => {
  // Saving the author's default would turn this person's storage into a copy
  // of it, and the day the author changed the option nobody would see it.
  const storage = new FakeStorage();
  const { widget } = place({ storage, position: "top-left" });
  assert.equal(storage.writes, 0);
  widget.unmount();
});

test("storage that throws on read degrades to the default instead of breaking the widget", () => {
  // A private window, or a person who blocked site data. A chat panel that
  // fails to render because it could not remember where it was is a far worse
  // bug than one that opens in the default corner.
  const storage = new FakeStorage();
  storage.items.set(storageKey("Contacts"), JSON.stringify({ fx: 0, fy: 0 }));
  storage.throwOnRead = true;
  const { widget, host, rect } = place({ storage });
  assert.equal(host.find("dk-launcher").length, 1, "nothing rendered");
  assert.equal(widget.position(), null);
  near(rect().left, FAR_X);
  widget.unmount();
});

test("storage that throws on write leaves the panel where it was dragged", () => {
  // A full quota, inside a pointerup handler. Throwing there would wedge the
  // drag state and leave the panel stuck to a pointer that is gone.
  const storage = new FakeStorage();
  storage.throwOnWrite = true;
  const { widget, host, rect } = place({ storage });
  dragBy(host.one("dk-move"), -300, -100);
  near(rect().left, FAR_X - 300);
  assert.equal(storage.items.size, 0);
  widget.unmount();
});

test("a malformed remembered position is ignored rather than trusted", () => {
  // Storage comes back as whatever is in it, including something another
  // version of this widget wrote, or something a person typed into devtools.
  for (const raw of ["", "{", "null", '{"fx":"left","fy":1}', '{"fx":null}']) {
    const storage = new FakeStorage();
    storage.items.set(storageKey("Contacts"), raw);
    const { widget, rect } = place({ storage });
    assert.equal(widget.position(), null, `trusted ${JSON.stringify(raw)}`);
    near(rect().left, FAR_X);
    widget.unmount();
  }
});

test("an out-of-range remembered position is clamped, not obeyed", () => {
  const storage = new FakeStorage();
  storage.items.set(storageKey("Contacts"), JSON.stringify({ fx: 14, fy: -3 }));
  const { widget, rect } = place({ storage });
  near(rect().left, FAR_X);
  near(rect().top, GAP);
  widget.unmount();
});

test("persist false remembers nothing and reads nothing", () => {
  const storage = new FakeStorage();
  storage.items.set(storageKey("Contacts"), JSON.stringify({ fx: 0, fy: 0 }));
  const { widget, host, rect } = place({ storage, persist: false });
  // The remembered position is not read, so the default stands.
  near(rect().left, FAR_X);
  dragBy(host.one("dk-move"), -300, -100);
  near(rect().left, FAR_X - 300, 0.5);
  assert.equal(storage.writes, 0, "a position was remembered after opting out");
  widget.unmount();
});

test("a window too narrow for the panel pulls it back to the near edge", () => {
  // The case that makes this whole file worth writing. `:host` says flush
  // right; in a window narrower than the panel that means off the LEFT edge,
  // header first, and no stylesheet can notice. Nobody clears site data to
  // recover a chat panel, so the clamp has to be in JavaScript.
  const win = new FakeWindow(VIEW.width, VIEW.height);
  const { widget, rect } = place({ win });
  near(rect().left, FAR_X);

  win.resize(300, 300);
  near(rect().left, GAP);
  near(rect().top, GAP);

  // And the person's position is not overwritten by the accommodation: it is
  // still flush right when there is room for it again.
  win.resize(VIEW.width, VIEW.height);
  near(rect().left, FAR_X);
  widget.unmount();
});

test("a dragged position survives a resize and comes back when there is room", () => {
  const win = new FakeWindow(VIEW.width, VIEW.height);
  const { widget, host, rect } = place({ win });
  dragBy(host.one("dk-move"), -300, -100);
  const was = widget.position()!;

  win.resize(300, 300);
  near(rect().left, GAP);
  assert.deepEqual(widget.position(), was, "the clamp overwrote the person's choice");

  win.resize(VIEW.width, VIEW.height);
  near(rect().left, FAR_X - 300);
  widget.unmount();
});

test("mounting into a window too narrow for the panel still leaves it reachable", () => {
  const { widget, host, rect } = place({ win: new FakeWindow(300, 300) });
  assert.equal(host.find("dk-head").length, 1);
  near(rect().left, GAP);
  near(rect().top, GAP);
  widget.unmount();
});

test("unmount takes the resize listener with it", () => {
  // A resize handler that outlives its panel goes on clamping a detached
  // element for the life of the page.
  const win = new FakeWindow(VIEW.width, VIEW.height);
  const { widget } = place({ win });
  assert.equal(win.listeners("resize"), 1);
  widget.unmount();
  assert.equal(win.listeners("resize"), 0);
});

test("Alt and an arrow throws the panel to that edge, from anywhere inside the widget", () => {
  // Dragging is pointer-only, and a feature that needs a mouse does not exist
  // for the people most likely to be stuck behind the panel. Alt is the
  // modifier because the bare arrows in here belong to the text input and the
  // transcript: a positioning shortcut that eats Left in a text field has
  // broken typing to gain a convenience.
  const { widget, host, rect } = place();
  const e = arrow(host.one("dk-input"), "ArrowLeft", true);

  near(rect().left, GAP);
  // The other axis is left alone, so one keystroke is one decision.
  near(rect().top, FAR_Y);
  assert.equal(e.defaultPrevented, true);
  widget.unmount();
});

test("Alt and an arrow works from the collapsed launcher too", () => {
  // The quickest way to see what the agent just did should not require
  // opening anything first.
  const { widget, host, rect } = place({ open: false });
  arrow(host.one("dk-launcher"), "ArrowUp", true);
  near(rect().top, GAP);
  near(rect().left, FAR_X);
  widget.unmount();
});

test("a bare arrow in the input types, it does not move the panel", () => {
  const { widget, host } = place();
  const e = arrow(host.one("dk-input"), "ArrowLeft");
  assert.equal(host.style.props.size, 0);
  assert.equal(e.defaultPrevented, false);
  widget.unmount();
});

test("the move button nudges with bare arrows, because that is where the arrows are its own", () => {
  const { widget, host, rect } = place();
  arrow(host.one("dk-move"), "ArrowLeft");
  const free = VIEW.width - GAP * 2 - BOX.width;
  near(rect().left, GAP + 0.9 * free);
  widget.unmount();
});

test("the move button cycles the corners when activated", () => {
  // A shortcut nobody can see is a shortcut nobody uses, and a drag handle
  // with no focusable element in it is a feature only a mouse can reach. One
  // button is both.
  const { widget, host, rect } = place();
  const move = host.one("dk-move");
  assert.equal(move.tag, "button");
  assert.match(move.attrs.get("aria-label")!, /Move panel/);

  move.dispatch("click");
  near(rect().left, GAP);
  near(rect().top, FAR_Y);

  move.dispatch("click");
  near(rect().left, GAP);
  near(rect().top, GAP);
  widget.unmount();
});

test("a drag of the move button does not cycle the corners", () => {
  const { widget, host, rect } = place();
  const move = host.one("dk-move");
  dragBy(move, -300, -100);
  move.dispatch("click");
  near(rect().left, FAR_X - 300);
  widget.unmount();
});

test("from between corners the first cycle press lands on the nearest one", () => {
  // Rather than jumping across the screen, which is what a strict rotation
  // would do to somebody who had just put the panel somewhere.
  //
  // Placed by the option rather than by a drag, now that the grip is the only
  // handle: a drag of the grip swallows the grip's own next click, which is
  // the point of the test above this one and would hide the one being made
  // here.
  const { widget, host, rect } = place({ position: { x: 300, y: 200 } });
  host.one("dk-move").dispatch("click");
  near(rect().left, GAP);
  near(rect().top, FAR_Y);
  widget.unmount();
});

test("every move is announced, and from outside the panel so a collapsed widget is announced too", () => {
  // A live region inside a `display: none` panel is not announced at all, and
  // a panel that moves silently has moved only for the people who can see it.
  const { widget, host } = place({ open: false });
  const status = host.one("dk-status");
  assert.equal(status.attrs.get("aria-live"), "polite");
  assert.equal(status.attrs.get("role"), "status");
  assert.equal(status.parent, host.one("dk-wrap"));

  arrow(host.one("dk-launcher"), "ArrowLeft", true);
  assert.equal(status.textContent, "Panel moved to bottom left");

  arrow(host.one("dk-launcher"), "ArrowUp", true);
  assert.equal(status.textContent, "Panel moved to top left");

  widget.moveTo({ x: 500, y: 300 });
  assert.match(status.textContent!, /% across, \d+% down/);
  widget.unmount();
});

test("a keyboard move is remembered like a dragged one", () => {
  const storage = new FakeStorage();
  const first = place({ storage });
  arrow(first.host.one("dk-input"), "ArrowLeft", true);
  first.widget.unmount();

  const again = place({ storage });
  near(again.rect().left, GAP);
  near(again.rect().top, FAR_Y);
  again.widget.unmount();
});

test("moveTo places the panel from the host app's own launcher", () => {
  const { widget, rect } = place();
  widget.moveTo("top-right");
  near(rect().left, FAR_X);
  near(rect().top, GAP);
  widget.moveTo({ x: 100, y: 200 });
  near(rect().left, 100);
  near(rect().top, 200);
  widget.unmount();
});

test("positioning survives an element with no style, rect or pointer capture", () => {
  // Everything positioning needs is optional in `dom.ts`, and this is why: a
  // host that hands in a minimal element, or a browser without
  // `setPointerCapture`, gets a panel that mounts and renders in its default
  // corner. Dragging is worth a lot and it is not worth failing an app's boot
  // over.
  const win = new FakeWindow(VIEW.width, VIEW.height);
  const doc = new FakeDocument(true, win, BOX);
  const bare = doc.createElement.bind(doc);
  doc.createElement = (tag: string) => {
    const node = bare(tag) as FakeNode;
    hide(node, "style", "getBoundingClientRect", "setPointerCapture");
    return node;
  };
  const app = contacts();
  const widget = mountWidget(app.driver, {
    think: async () => ({ text: "ok" }),
    document: doc,
    clock: instant,
    window: win,
    open: true,
    position: "top-left",
  });
  const host = doc.host();

  assert.equal(host.find("dk-launcher").length, 1, "nothing rendered");
  dragBy(host.one("dk-move"), -300, -100);
  widget.unmount();
});

test("a drag of the grip does not swallow the next click somewhere else", () => {
  // The suppression is per handle for this reason. Dragging the header fires a
  // click on the HEADER, which nothing listens for, so one shared flag would
  // still be set when the person's next real click landed on a button.
  const { widget, host } = place();
  dragBy(host.one("dk-move"), -300, -100);
  host.one("dk-min").dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap", "a stale drag flag ate the minimise click");
  widget.unmount();
});

// ---------------------------------------------------------------------------
// The step list, the run controls, and the settings view.
//
// All three exist for one sentence of requirement: the agent drives the screen
// the person is looking at, so it should walk the UI slowly enough to watch,
// and the person should be able to see each step, slow it down, pause it, or
// stop it.
// ---------------------------------------------------------------------------

/** A recording wrapper around the real control surface, so a test can assert
 *  that a button reached it AND that the run actually held. A stub that only
 *  recorded would pass against a panel whose buttons were wired to nothing
 *  that `drive` consults. */
function watcher(): {
  seen: string[];
  controls: (options: RunControlsOptions) => RunControls;
} {
  const seen: string[] = [];
  return {
    seen,
    controls: (options) => {
      seen.push(options.stepMode ? "new(stepMode)" : "new");
      const base = runControls(options);
      return {
        get state() {
          return base.state;
        },
        get permits() {
          return base.permits;
        },
        get paceMs() {
          return base.paceMs;
        },
        pause: () => (seen.push("pause"), base.pause()),
        resume: () => (seen.push("resume"), base.resume()),
        step: () => (seen.push("step"), base.step()),
        pace: (ms) => (seen.push(`pace(${ms})`), base.pace(ms)),
        subscribe: (listener) => base.subscribe(listener),
        gate: (what, signal) => base.gate(what, signal),
      };
    },
  };
}

interface WatchedOptions {
  storage?: FakeStorage;
  clock?: FakeClock;
  doc?: FakeDocument;
  pace?: number;
  confirmCommits?: boolean;
}

/** A panel with a watched control surface and a clock that does not sleep. */
function watched(script: unknown[], o: WatchedOptions = {}) {
  const doc = o.doc ?? new FakeDocument();
  const app = contacts();
  const s = scripted(script);
  const w = watcher();
  const clock = o.clock ?? new FakeClock();
  const widget = mountWidget(app.driver, {
    think: s.think,
    document: doc,
    clock,
    controls: w.controls,
    open: true,
    ...(o.storage === undefined ? {} : { storage: o.storage }),
    ...(o.pace === undefined ? {} : { pace: o.pace }),
    ...(o.confirmCommits === undefined ? {} : { confirmCommits: o.confirmCommits }),
  });
  const host = doc.host();
  return { doc, app, s, w, clock, widget, host, step: () => host.one("dk-step") };
}

test("a step is on screen as pending before its verb runs, and only then becomes done", async () => {
  // The whole point. `onBeforeCall` fires before the pace wait and before any
  // hold, so the row describing a call is on screen while the person still has
  // time to stop it; a panel built on `onCall` alone could only ever report
  // what was already happening.
  const { widget, host } = watched([
    () => {
      // Pressed while the model is still thinking, so the run holds at the
      // gate with the row already rendered.
      host.one("dk-pause").dispatch("click");
      return { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] };
    },
    { text: "done" },
  ]);

  await ask(host, "select the Acme contacts");

  const row = host.one("dk-step");
  assert.match(row.className, /dk-step-pending/, "the row was not rendered before the call");
  // Pending means pending: no outcome yet, and nothing has touched the app.
  assert.equal(row.textContent, "select-where (describe) where=company=Acme");
  assert.equal(host.one("dk-run-note").textContent, "Paused");

  host.one("dk-pause").dispatch("click");
  await settle();

  assert.match(host.one("dk-step").className, /dk-step-done/);
  assert.equal(
    host.one("dk-step").textContent,
    "select-where (describe) where=company=Acme · ok · 3,412 matched",
  );
  widget.unmount();
});

test("a refusal finishes a step as an outcome, not as an error", async () => {
  // The app said no, on purpose, in its own vocabulary, and the model is about
  // to adapt to it. Rendering that as a failure would teach a person to read a
  // working app as a broken one -- so it is a step state like any other, and
  // nothing is said in the transcript about anything going wrong.
  const { widget, host } = watched([
    { calls: [{ id: "a", name: "accept-selected", args: {} }] },
    { text: "Nothing was selected." },
  ]);

  await ask(host, "accept them");
  await allow(host);

  const row = host.one("dk-step");
  assert.match(row.className, /dk-step-refused/);
  assert.doesNotMatch(row.className, /dk-step-running|dk-step-pending/);
  assert.match(row.textContent!, /refused: nothing-selected$/);
  assert.doesNotMatch(host.one("dk-log").text(), /went wrong/);
  widget.unmount();
});

test("a commit step is marked as one at every stage, not only once it has run", async () => {
  // This is the row somebody scrolls back to when they want to know what
  // changed their data, and it is also the row they are deciding about while
  // it is still pending. The mark cannot be something the outcome adds.
  const { widget, host } = watched([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 5 } }] },
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "Accepted." },
  ]);

  await ask(host, "accept five Acme contacts");
  // Mid-run: the commit is in flight at the confirmation, and already marked.
  const commit = host.find("dk-step-commit");
  assert.equal(commit.length, 1);
  assert.match(commit[0]!.className, /dk-step-running/);
  assert.equal(commit[0]!.attrs.get("title"), "Changes data, and may be irreversible.");

  await allow(host);
  // And still marked once it is done, because the class is not rewritten by
  // the outcome.
  assert.equal(host.find("dk-step-commit").length, 1);
  assert.match(host.find("dk-step-commit")[0]!.className, /dk-step-done/);
  widget.unmount();
});

test("twenty steps are twenty rows, each one line, in the order they happened", async () => {
  // Legibility at length is the difference between a step list and a wall. The
  // arguments are truncated and the CSS keeps each row to one line; what this
  // pins is that nothing is dropped, nothing is merged, and the order is the
  // order of the run.
  const calls = Array.from({ length: 20 }, (_, i) => ({
    id: `c-${i}`,
    name: "select-where",
    args: { where: `company=Acme-${i}` },
  }));
  const { widget, host } = watched([{ calls }, { text: "done" }]);

  await ask(host, "do twenty things");

  const rows = host.find("dk-step");
  assert.equal(rows.length, 20);
  assert.equal(rows.filter((r) => r.className.includes("dk-step-done")).length, 20);
  assert.match(rows[0]!.textContent!, /company=Acme-0 /);
  assert.match(rows[19]!.textContent!, /company=Acme-19 /);
  widget.unmount();
});

test("pause holds the run, resume lets it go, and both reach the control surface", async () => {
  const { w, widget, host, app } = watched([
    () => {
      host.one("dk-pause").dispatch("click");
      return { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] };
    },
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "done" },
  ]);

  await ask(host, "select and accept");
  // Held: the verb has not run, so nothing is selected and nothing is
  // accepted. The `pace` in the middle is `drive` reconciling the run's pace
  // with the controls at the top of the run, not the panel.
  assert.deepEqual(w.seen, ["new", "pace(600)", "pause"]);
  assert.equal(host.one("dk-pause").textContent, "Resume");

  host.one("dk-pause").dispatch("click");
  await settle();
  await allow(host);

  assert.deepEqual(w.seen, ["new", "pace(600)", "pause", "resume"]);
  assert.equal(app.accepted(), 3412);
  assert.equal(host.one("dk-pause").textContent, "Pause");
  widget.unmount();
});

test("a single step runs exactly one more call and then holds again", async () => {
  // Step is how somebody walks a run by hand. One press, one call -- and the
  // panel says "Paused" afterwards because the loop says so, not because the
  // panel assumed it.
  const { w, widget, host } = watched([
    () => {
      host.one("dk-pause").dispatch("click");
      return {
        calls: [
          { id: "a", name: "select-where", args: { where: "company=Acme" } },
          { id: "b", name: "select-where", args: { where: "company=None" } },
        ],
      };
    },
    { text: "done" },
  ]);

  await ask(host, "two selections");
  // One row ahead, not one turn ahead: the loop announces each call as it
  // reaches it, so the row for the second call appears once the first is done.
  assert.equal(host.find("dk-step-pending").length, 1);

  host.one("dk-once").dispatch("click");
  await settle();

  assert.deepEqual(w.seen, ["new", "pace(600)", "pause", "step"]);
  assert.equal(host.find("dk-step-done").length, 1, "a step ran more than one call");
  assert.equal(host.find("dk-step-pending").length, 1, "the next call was not announced");
  assert.equal(host.one("dk-run-note").textContent, "Paused");
  widget.unmount();
});

test("stop ends a held run, and the steps that never ran say so", async () => {
  // Abort outranks a pause -- a held run is stoppable and never wedged -- and
  // a call abandoned at the gate gets no result, so a panel that left its row
  // pending would be claiming something is about to happen after the run is
  // over.
  const { widget, host, app } = watched([
    () => {
      host.one("dk-pause").dispatch("click");
      return { calls: [{ id: "a", name: "accept-selected", args: {} }] };
    },
  ]);

  await ask(host, "accept them");
  assert.match(host.one("dk-step").className, /dk-step-pending/);

  host.one("dk-stop").dispatch("click");
  await settle();

  assert.match(host.one("dk-step").className, /dk-step-skipped/);
  assert.match(host.one("dk-step").textContent!, /· not run$/);
  assert.equal(app.accepted(), 0);
  assert.equal(host.one("dk-wrap").className.includes("dk-busy"), false);
  widget.unmount();
});

test("the panel says it is waiting for the person while a commit question is open", async () => {
  // A run parked in front of a confirmation is not running and is not paused.
  // Saying "running" there would be telling the person to wait for the thing
  // that is waiting for them.
  const { widget, host } = watched([
    { calls: [{ id: "a", name: "accept-selected", args: {} }] },
    { text: "ok" },
  ]);

  await ask(host, "accept them");
  assert.equal(host.one("dk-run-note").textContent, "Waiting for you");

  host.one("dk-no").dispatch("click");
  await settle();
  widget.unmount();
});

test("step mode starts the run held, so every call needs a press", async () => {
  const storage = new FakeStorage();
  const first = watched([{ text: "ok" }], { storage });
  first.host.one("dk-gear").dispatch("click");
  first.host.one("dk-t-stepmode").dispatch("click");
  first.widget.unmount();

  // A fresh panel, the remembered setting, and therefore controls built with
  // `stepMode` -- which is all step mode is: paused, and stepped one call at a
  // time. There is deliberately no second flag that could disagree.
  const { w, widget, host } = watched(
    [{ calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] }, { text: "ok" }],
    { storage },
  );
  await ask(host, "select them");

  assert.deepEqual(w.seen, ["new(stepMode)", "pace(600)"]);
  // Held before the first model turn, so not even a round trip has been
  // spent, let alone a verb. Nothing has been announced because nothing has
  // been asked for yet.
  assert.equal(host.find("dk-step").length, 0);
  assert.equal(host.one("dk-run-note").textContent, "Paused");

  host.one("dk-once").dispatch("click");
  await settle();
  assert.equal(host.find("dk-step-done").length, 1);
  widget.unmount();
});

test("the pace the person chose is the pace that is waited, and it is live mid-run", async () => {
  // Pacing is what makes the UI watchable, so this asserts the number and not
  // merely that a wait happened. Live, because somebody reaching for a speed
  // control while watching a run is asking about THIS run.
  const clock = new FakeClock();
  const { widget, host } = watched(
    [
      { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme" } }] },
      () => {
        host.one("dk-gear").dispatch("click");
        host.find("dk-speed")[0]!.dispatch("click");
        return { calls: [{ id: "b", name: "select-where", args: { where: "company=None" } }] };
      },
      { text: "done" },
    ],
    { clock },
  );

  await ask(host, "two selections");

  // 600ms for the first call -- the default, which is the agent package's own
  // WATCHABLE_PACE -- then 250 for the second, because the person moved the
  // slider to Fast in between.
  assert.deepEqual(clock.waits, [600, 250]);
  widget.unmount();
});

test("the settings view opens from the header, closes again, and leaves the panel open", async () => {
  const { widget, host } = watched([{ text: "ok" }]);
  const gear = host.one("dk-gear");

  gear.dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open dk-set-open");
  assert.equal(gear.attrs.get("aria-expanded"), "true");
  // Focus lands on the first thing worth changing rather than on a container.
  assert.equal(host.find("dk-speed")[0]!.focused, true);

  gear.dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open");
  assert.equal(gear.attrs.get("aria-expanded"), "false");

  // And Done, which is the other way out of it.
  gear.dispatch("click");
  host.one("dk-done").dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open");
  widget.unmount();
});

test("Escape closes the whole panel from inside the settings view", async () => {
  // The panel's one escape hatch keeps working wherever focus is. It also
  // leaves the settings view closed, so reopening the panel lands somebody
  // back in the conversation they were having rather than in a preferences
  // screen they had finished with.
  const { widget, host } = watched([{ text: "ok" }]);
  host.one("dk-gear").dispatch("click");

  host.one("dk-t-highlight").dispatch("keydown", { key: "Escape" });
  assert.equal(host.one("dk-wrap").className, "dk-wrap");

  host.one("dk-launcher").dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open");
  widget.unmount();
});

test("closing the panel while a settings change is unsaved is not a thing: each change is saved at once", () => {
  // There is no Save button, so there is no half-finished state to lose. Every
  // switch writes on the press.
  const storage = new FakeStorage();
  const { widget, host } = watched([{ text: "ok" }], { storage });
  host.one("dk-gear").dispatch("click");
  host.one("dk-t-stepmode").dispatch("click");
  assert.ok(storage.items.get(settingsKey("Contacts")), "nothing was written");
  widget.unmount();
});

test("every setting is remembered per viewer and read back on the next mount", () => {
  // Per viewer and not per app: a pace is a statement about how fast this
  // particular person reads. Remembered the same way, in the same storage,
  // through the same wrapped read as the panel's position.
  const storage = new FakeStorage();
  const first = watched([{ text: "ok" }], { storage });
  first.host.one("dk-gear").dispatch("click");
  first.host.find("dk-speed")[2]!.dispatch("click");
  first.host.one("dk-t-highlight").dispatch("click");
  first.host.one("dk-t-stepmode").dispatch("click");
  first.host.one("dk-t-commits").dispatch("click");
  first.widget.unmount();

  const { widget, host } = watched([{ text: "ok" }], { storage });
  host.one("dk-gear").dispatch("click");
  assert.equal(host.find("dk-speed")[2]!.attrs.get("aria-checked"), "true");
  assert.equal(host.find("dk-speed")[1]!.attrs.get("aria-checked"), "false");
  assert.equal(host.one("dk-t-highlight").attrs.get("aria-checked"), "false");
  assert.equal(host.one("dk-t-stepmode").attrs.get("aria-checked"), "true");
  assert.equal(host.one("dk-t-commits").attrs.get("aria-checked"), "false");
  // And the remembered confirmCommits is the one that is obeyed, not the
  // option's default.
  assert.equal(host.one("dk-run-note").textContent, "Slow · 1500 ms a step");
  widget.unmount();
});

test("a remembered confirmCommits of false really does skip the question", async () => {
  const storage = new FakeStorage();
  const first = watched([{ text: "ok" }], { storage });
  first.host.one("dk-gear").dispatch("click");
  first.host.one("dk-t-commits").dispatch("click");
  first.widget.unmount();

  const { widget, host, app } = watched(
    [{ calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 7 } }] },
     { calls: [{ id: "b", name: "accept-selected", args: {} }] },
     { text: "done" }],
    { storage },
  );
  await ask(host, "accept seven");
  assert.equal(host.find("dk-ask").length, 0, "a question was asked anyway");
  assert.equal(app.accepted(), 7);
  widget.unmount();
});

test("turning confirmations back on mid-run takes effect on the next commit", async () => {
  // Somebody who has just watched a commit go past unasked reaches for this
  // switch about the run in front of them, not about the next one.
  const { widget, host, app } = watched(
    [
      { calls: [{ id: "a", name: "accept-selected", args: {} }] },
      () => {
        host.one("dk-gear").dispatch("click");
        host.one("dk-t-commits").dispatch("click");
        host.one("dk-done").dispatch("click");
        return { calls: [{ id: "b", name: "accept-selected", args: {} }] };
      },
      { text: "done" },
    ],
    { confirmCommits: false },
  );

  await ask(host, "accept, twice");
  // The first went through unasked; the second is waiting for an answer.
  assert.equal(host.find("dk-ask").length, 1);
  host.one("dk-no").dispatch("click");
  await settle();
  assert.equal(app.accepted(), 0, "nothing was selected, so nothing should have been accepted");
  widget.unmount();
});

test("storage that throws on read leaves the panel rendering at its defaults", () => {
  // A private window, or a person who blocked site data. A chat panel that
  // failed to render because it could not remember a slider position would be
  // a much worse bug than one that opens at the default speed.
  const storage = new FakeStorage();
  storage.throwOnRead = true;
  const { widget, host } = watched([{ text: "ok" }], { storage });

  host.one("dk-gear").dispatch("click");
  assert.equal(host.find("dk-speed")[1]!.attrs.get("aria-checked"), "true");
  assert.equal(host.one("dk-t-highlight").attrs.get("aria-checked"), "true");
  assert.equal(host.one("dk-run-note").textContent, "Steady · 600 ms a step");
  widget.unmount();
});

test("storage that throws on write still changes the setting for this session", () => {
  // A full quota is not a reason to refuse a preference. It is a reason not to
  // remember it.
  const storage = new FakeStorage();
  storage.throwOnWrite = true;
  const { widget, host } = watched([{ text: "ok" }], { storage });

  host.one("dk-gear").dispatch("click");
  host.one("dk-t-stepmode").dispatch("click");
  assert.equal(host.one("dk-t-stepmode").attrs.get("aria-checked"), "true");
  assert.equal(storage.items.size, 0, "it should not have been remembered");
  widget.unmount();
});

test("a press on the gear never drags, however far the hand moves after it", () => {
  // The press lands on the gear and the moves arrive at the header, which is
  // what a browser does with a pointer that wandered out of the button it
  // started in. Nothing is a handle along that whole path any more, so there
  // is no drag to swallow the click at the end of it.
  const { widget, host } = place();
  const before = host.getBoundingClientRect();
  const gear = host.one("dk-gear");

  gear.dispatch("pointerdown", { pointerId: 7, button: 0, clientX: 500, clientY: 500 });
  host.one("dk-head").dispatch("pointermove", { pointerId: 7, clientX: 200, clientY: 200 });
  host.one("dk-head").dispatch("pointerup", { pointerId: 7, clientX: 200, clientY: 200 });

  assert.equal(host.getBoundingClientRect().left, before.left, "the gear dragged the panel");
  assert.doesNotMatch(host.className, /dk-dragging/);
  // And the click that follows still opens the settings view.
  gear.dispatch("click");
  assert.match(host.one("dk-wrap").className, /dk-set-open/);
  widget.unmount();
});

// ---------------------------------------------------------------------------
// The highlight.
//
// `Verb.at` is PRESENTATIONAL. The widget may outline what it names and may do
// nothing else with it: never resolve it to decide what to call, never click
// it, never let its absence change what runs. A selector in the execution path
// is the failure mode this library exists to avoid, so most of what follows is
// about the ways `at` is allowed to be useless.
// ---------------------------------------------------------------------------

/** An app whose verbs point at things on screen -- and one that does not,
 *  which is the common case. */
function pointed(): Driver {
  return mount({
    app: "Rows",
    visible: () => ({ where: "rows", rev: 1, rows: [{ id: "r-7" }] }),
    verbs: [
      { name: "focus", kind: "read", describe: "look at row seven", at: "#row-7", run: () => ({}) },
      { name: "plain", kind: "read", describe: "no element in particular", run: () => ({}) },
      { name: "missing", kind: "read", describe: "points at nothing", at: "#gone", run: () => ({}) },
      { name: "nonsense", kind: "read", describe: "points at rubbish", at: ":::", run: () => ({}) },
    ],
  });
}

function pointing(script: unknown[]) {
  const doc = new FakeDocument();
  const s = scripted(script);
  const widget = mountWidget(pointed(), {
    think: s.think,
    document: doc,
    clock: instant,
    open: true,
  });
  const host = doc.host();
  const outline = (): FakeNode | null => {
    const hits = doc.body.all().filter((n) => n.className.split(" ").includes("dk-spot"));
    return hits[0] ?? null;
  };
  return { doc, s, widget, host, outline };
}

const AT_RUN = [
  { calls: [{ id: "a", name: "focus", args: {} }] },
  { text: "looked" },
];

test("the element a step is about to touch is outlined, as an overlay at its own box", async () => {
  const { doc, widget, host, outline } = pointing(AT_RUN);
  doc.at("#row-7", { left: 120, top: 240, width: 300, height: 48 });

  await ask(host, "look at row seven");

  const box = outline()!;
  assert.ok(box, "nothing was outlined");
  // The numbers are the element's own rectangle, written as custom properties
  // on an overlay in a shadow root of its own.
  assert.equal(box.style.props.get("--dk-spot-x"), "120px");
  assert.equal(box.style.props.get("--dk-spot-y"), "240px");
  assert.equal(box.style.props.get("--dk-spot-w"), "300px");
  assert.equal(box.style.props.get("--dk-spot-h"), "48px");
  // And nothing at all was written to the host app's element. A border on
  // somebody's row reflows their layout; an agent that nudges the page
  // sideways every time it names an element is not a passive observer of it.
  const target = doc.elements.get("#row-7")!;
  assert.equal(target.className, "");
  assert.equal(target.style.props.size, 0);
  assert.equal(target.attrs.size, 0);
  widget.unmount();
});

test("the outline is gone the moment the step finishes", async () => {
  // An outline left behind is an outline about nothing.
  const { doc, widget, host, outline } = pointing(AT_RUN);
  doc.at("#row-7", { left: 10, top: 10, width: 100, height: 20 });

  await ask(host, "look at row seven");
  assert.doesNotMatch(outline()!.className, /dk-spot-on/);
  widget.unmount();
});

test("a verb with no `at` is not outlined, and nothing is added to the page for it", async () => {
  // The common case by a long way. An app whose verbs name nothing should not
  // pay an element and two listeners for a feature it never reaches.
  const { doc, widget, host, outline } = pointing([
    { calls: [{ id: "a", name: "plain", args: {} }] },
    { text: "looked" },
  ]);

  await ask(host, "do the plain thing");

  assert.equal(outline(), null, "an overlay was created for a verb with no at");
  assert.equal(doc.body.children.length, 1, "something else was added to the page");
  widget.unmount();
});

test("an `at` that matches nothing, or is not valid CSS, draws nothing and changes nothing", async () => {
  // Both are ordinary: an app's markup moved, or somebody typed a selector
  // wrong. A wrong or stale `at` must cost nothing but an outline that is not
  // drawn -- never a verb that stops working.
  const { widget, host, outline } = pointing([
    { calls: [{ id: "a", name: "missing", args: {} }] },
    { calls: [{ id: "b", name: "nonsense", args: {} }] },
    { text: "both ran" },
  ]);

  await ask(host, "try both");

  assert.equal(outline(), null);
  const rows = host.find("dk-step");
  assert.equal(rows.length, 2);
  // The point: the calls ran anyway, and ran normally.
  assert.ok(rows.every((r) => r.className.includes("dk-step-done")), "a bad at broke a call");
  widget.unmount();
});

test("a document with no querySelector gets no outlines and no errors", async () => {
  // `DocumentLike.querySelector` is optional, and this is why: a host that
  // hands in a minimal document, like a fake, simply gets no outlines. It is
  // the same no-op path every verb without an `at` already takes.
  const doc = new FakeDocument();
  hide(doc as unknown as FakeNode, "querySelector");
  const s = scripted(AT_RUN);
  const widget = mountWidget(pointed(), { think: s.think, document: doc, clock: instant, open: true });
  const host = doc.host();

  await ask(host, "look at row seven");

  assert.match(host.one("dk-step").className, /dk-step-done/);
  assert.equal(doc.body.children.length, 1);
  widget.unmount();
});

test("an element with no measurable box is not outlined", async () => {
  // A hidden row, a display:none cell, an element the layout has not reached
  // yet. Outlining a zero-sized box draws a dot in the corner of the screen,
  // which reads as a bug in the panel rather than as nothing.
  const { doc, widget, host, outline } = pointing(AT_RUN);
  doc.at("#row-7", { left: 0, top: 0, width: 0, height: 0 });

  await ask(host, "look at row seven");
  assert.equal(outline(), null);
  widget.unmount();
});

test("highlighting off means no outline at all, and switching it off clears the one on screen", async () => {
  const { doc, widget, host, outline } = pointing([
    () => {
      host.one("dk-gear").dispatch("click");
      host.one("dk-t-highlight").dispatch("click");
      host.one("dk-done").dispatch("click");
      return { calls: [{ id: "a", name: "focus", args: {} }] };
    },
    { text: "looked" },
  ]);
  doc.at("#row-7", { left: 10, top: 10, width: 100, height: 20 });

  await ask(host, "look at row seven");
  assert.equal(outline(), null, "the setting was ignored");
  widget.unmount();
});

test("unmount takes the outline, its host element and its listeners with it", async () => {
  const win = new FakeWindow(VIEW.width, VIEW.height);
  const doc = new FakeDocument(true, win, BOX);
  doc.at("#row-7", { left: 10, top: 10, width: 100, height: 20 });
  const s = scripted(AT_RUN);
  const widget = mountWidget(pointed(), {
    think: s.think,
    document: doc,
    clock: instant,
    window: win,
    open: true,
  });
  const host = doc.host();

  await ask(host, "look at row seven");
  assert.equal(doc.body.children.length, 2, "the overlay host should be in the page by now");
  // One for the panel's clamp, one for the outline's reflow.
  assert.equal(win.listeners("resize"), 2);

  widget.unmount();

  assert.equal(doc.body.children.length, 0);
  assert.equal(win.listeners("resize"), 0);
  assert.equal(win.listeners("scroll"), 0);
});

test("an outline follows the element when the page scrolls under it", async () => {
  // The verb being announced is quite often the one that scrolls the row into
  // view, so a box measured once and left there would be an outline around the
  // wrong row for the rest of the step.
  const win = new FakeWindow(VIEW.width, VIEW.height);
  const doc = new FakeDocument(true, win, BOX);
  const s = scripted([
    () => {
      // Paused so the outline is still up while the test scrolls.
      doc.host().one("dk-pause").dispatch("click");
      return { calls: [{ id: "a", name: "focus", args: {} }] };
    },
    { text: "looked" },
  ]);
  const w = watcher();
  const widget = mountWidget(pointed(), {
    think: s.think,
    document: doc,
    clock: instant,
    window: win,
    controls: w.controls,
    open: true,
  });
  const host = doc.host();
  const target = doc.at("#row-7", { left: 10, top: 400, width: 100, height: 20 });

  await ask(host, "look at row seven");
  const box = doc.body.all().find((n) => n.className.split(" ").includes("dk-spot"))!;
  assert.equal(box.style.props.get("--dk-spot-y"), "400px");

  target.rect = { left: 10, top: 120, width: 100, height: 20 };
  win.resize(VIEW.width, VIEW.height);
  assert.equal(box.style.props.get("--dk-spot-y"), "120px");

  host.one("dk-stop").dispatch("click");
  await settle();
  widget.unmount();
});

// =========================================================================
// The panel's dialog as an implementation of `MountOptions.approve`.
//
// The decision these pin: this dialog stops being the only gate in the system
// and becomes one implementation of the core's hook. Every option above still
// decides whether it asks and what it says; what changes is who can call it.
// An app wires `approve: (req) => panel.approve(req)` and a commit arriving
// over the relay or MCP renders the same question, with the same count, and a
// "No" becomes the same `declined-by-user` refusal the in-page loop produces.
// =========================================================================

/** The forward reference an app has to write, because `mount()` happens before
 *  the panel that will answer for it exists. This IS the documented wiring. */
function gatedByPanel(options: Partial<WidgetOptions> = {}, script?: unknown[]) {
  const doc = new FakeDocument();
  let turn = 0;
  let accepted = 0;
  let rev = 1;
  let panel: { approve: (req: never) => Promise<unknown> } | undefined;
  const driver = mount({
    app: "Contacts",
    visible: (): Snapshot => ({
      where: "contacts",
      rev,
      rows: [{ id: "c-0" }],
      selected: ["c-0"],
      selectedCount: 1000,
    }),
    verbs: [
      { name: "look", kind: "read", describe: "look at the rows", run: () => {} },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        run: () => {
          accepted += 1000;
          rev++;
        },
      },
    ],
    approve: (req) => panel!.approve(req as never) as never,
  });
  const widget = mountWidget(driver, {
    think: async () => (script ? (script[turn++] as never) : { text: "hi" }),
    document: doc,
    clock: instant,
    ...options,
  } as WidgetOptions);
  panel = widget;
  return { doc, host: doc.host(), driver, widget, accepted: () => accepted };
}

test("a commit over the relay renders the panel's own question, with the count off the screen", async () => {
  // `driver.call()` with no run around it is exactly what a relay frame
  // becomes. Before the gate moved into the core this ran with nothing in the
  // way — a live tab, driven from a shell, 425 rows and no question.
  const { host, driver, accepted } = gatedByPanel();

  const call = driver.call("accept-selected");
  await settle();

  // The panel opened itself, because a question nobody can see is not a
  // question — and nobody is at the panel when the agent is in another
  // process.
  assert.ok(host.one("dk-wrap").className.includes("dk-open"));
  // The count comes from `Snapshot.selectedCount`, because there is no run
  // whose last `describe` could have reported one. That is the one difference
  // between the two paths and it is unavoidable.
  assert.match(host.one("dk-ask-q").textContent!, /1,000 rows/);

  host.one("dk-yes").dispatch("click");
  const out = await call;
  assert.equal(out.ok, true);
  assert.equal(accepted(), 1000);
});

test("saying no to a relay commit refuses it declined-by-user, the slug the outside path could never emit", async () => {
  const { host, driver, accepted } = gatedByPanel();

  const call = driver.call("accept-selected");
  await settle();
  host.one("dk-no").dispatch("click");

  const out = await call;
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.refused, "declined-by-user");
  assert.equal(accepted(), 0);
  assert.match(host.one("dk-ask-said").textContent!, /You said no/);
});

test("a call that arrives while the panel is asking is refused rather than pressing the Yes", async () => {
  // The core's lock, end to end through the panel. A second agent — or the
  // same one — reaching for anything while the question sits in the transcript
  // is refused `approval-pending`. This is the layer that needs nobody to
  // remember an attribute: it is true of any approval UI, including a host's
  // own in the light DOM where `press` could otherwise reach the button.
  const { host, driver } = gatedByPanel();

  const call = driver.call("accept-selected");
  await settle();
  const sneak = await driver.call("look");

  assert.equal(sneak.ok === false && sneak.refused, "approval-pending");
  host.one("dk-no").dispatch("click");
  await call;
  // And released, so one question does not wedge the tab.
  assert.equal((await driver.call("look")).ok, true);
});

test("the panel does not ask twice when it is already the core's hook", async () => {
  // Two questions about one commit is how people learn to click Yes without
  // reading, which is the failure this panel's own documentation is built
  // around. So when the driver was mounted with an `approve` hook, the panel
  // installs no `onBeforeCommit` of its own: the hook is called inside
  // `driver.call()` for every path, the in-page loop's included. One run, one
  // commit, one dialog.
  const { host, widget, accepted } = gatedByPanel({ open: true }, [
    { calls: [{ id: "b", name: "accept-selected", args: {} }] },
    { text: "done" },
  ]);

  await ask(host, "accept them");
  assert.equal(host.find("dk-ask").length, 1, "one commit produced two questions");

  await allow(host);
  assert.equal(accepted(), 1000);
  assert.match(host.find("dk-step")[0]!.textContent!, / · ok/);
  widget.unmount();
});

test("confirmCommits false opts the relay path out too, because it is one dialog and one switch", async () => {
  // The options did not fork. `confirmCommits`, `commitAskAbove` and
  // `confirmEveryCommit` decide whether this dialog appears, and they decide
  // it the same way whichever path asked — which is the whole reason the
  // dialog became an implementation of the hook rather than a second gate
  // beside it.
  const { host, driver, accepted } = gatedByPanel({ confirmCommits: false });

  const out = await driver.call("accept-selected");

  assert.equal(host.find("dk-ask").length, 0, "a question was asked after opting out");
  assert.equal(out.ok, true);
  assert.equal(accepted(), 1000);
});

// =========================================================================
// The launcher.
// =========================================================================

test("the launcher is one short word, whatever the app is called", async () => {
  // `Ask Northwind CRM` grew with the app, so the button was a different size
  // in every app that used it, and it read as an instruction to the person
  // rather than as a label on a control. The app's name is in the panel header
  // and in the accessible name, which are the two places it helps.
  const doc = new FakeDocument();
  const app = contacts();
  const widget = mountWidget(app.driver, {
    think: async () => ({ text: "hi" }),
    document: doc,
    clock: instant,
    title: "A Very Long Application Name Indeed",
  });
  const host = doc.host();

  // `title` still overrides it: a host that wants its own word gets it.
  assert.equal(host.one("dk-launcher").textContent, "A Very Long Application Name Indeed");
  // And it is ellipsised rather than allowed to stretch the pill, which is the
  // stylesheet's job below.
  assert.match(host.one("dk-launcher").attrs.get("aria-label")!, /to do something/);
  widget.unmount();
});

test("nothing in the stylesheet can resize the launcher, so no state changes its shape", async () => {
  // The user's words: "why is the shape changing? make the size and shape
  // constant oval". A content-sized button changed dimensions with its label
  // and with the state, and it also MOVED itself — the remembered position is
  // a fraction of the free space, and the free space is the viewport less the
  // element's own measured width, so a launcher that grew by thirty pixels
  // slid by thirty pixels times x.
  //
  // Asserted against the stylesheet rather than a layout, because the fake DOM
  // has no layout: what is pinned is that exactly one rule sizes the launcher
  // and that the box is fixed, so a later `.dk-busy .dk-launcher { padding: … }`
  // has to break a named test.
  // Comments stripped first: one of them quotes `* { box-sizing: content-box }`
  // and a naive split on `}` would cut the rule in half there.
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map((block) => block + "}")
    .filter((block) => block.includes(".dk-launcher"));

  const sizing = rules.filter((r) => /\b(width|height|padding|font-size|font:)\s*:/.test(r));
  assert.equal(sizing.length, 1, `more than one rule sizes the launcher:\n${sizing.join("\n")}`);
  assert.match(sizing[0]!, /width: var\(--dk-launcher-w\)/);
  assert.match(sizing[0]!, /height: var\(--dk-launcher-h\)/);
  // Half the height, so it is a true pill at whatever size a host picks and
  // never a rounded rectangle at one size and a circle at another.
  assert.match(sizing[0]!, /border-radius: calc\(var\(--dk-launcher-h\) \/ 2\)/);
  // The label is clipped rather than allowed to grow the box.
  assert.match(sizing[0]!, /overflow: hidden/);
  assert.match(sizing[0]!, /white-space: nowrap/);
  // And `box-sizing`, because the fixed width must be the whole width: a host
  // app's inherited `content-box` would otherwise add the padding back on.
  assert.match(sizing[0]!, /box-sizing: border-box/);

  // The one other rule that mentions it only hides it, which is a state
  // change that cannot be a size change.
  const others = rules.filter((r) => r !== sizing[0]);
  for (const rule of others) assert.match(rule, /display: none/);
});

// =========================================================================
// The header: minimise, the grip, and the title.
// =========================================================================

test("the header button minimises and says so, instead of saying Close", async () => {
  // The user read "Close" as destroying the conversation and stopped pressing
  // it, which left them with a panel sitting on top of the rows they had just
  // asked about. The behaviour was always right; the word was the bug.
  const { widget, host } = setup();
  const button = host.one("dk-min");

  assert.notEqual(button.textContent, "Close");
  assert.match(button.attrs.get("aria-label")!, /minimise/i);
  // And the label says what survives, because that is the fact the old one
  // got wrong.
  assert.match(button.attrs.get("aria-label")!, /conversation is kept/i);
  assert.match(button.attrs.get("title")!, /reopen/i);
  // A real button, not a styled glyph with a click handler on it.
  assert.equal(button.attrs.get("type"), "button");

  button.dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap");
  // Focus comes back to the launcher, as it does for Escape: a keyboard user
  // who puts the panel away and is left nowhere has lost their place.
  assert.equal(host.one("dk-launcher").focused, true);
  widget.unmount();
});

test("minimising keeps the transcript and the steps, and reopening is the same conversation", async () => {
  const { s, widget, host, log } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 3 } }] },
    { text: "Three of them." },
    { text: "Still three." },
  ]);

  await ask(host, "how many Acme contacts?");
  assert.match(log().text(), /Three of them\./);

  host.one("dk-min").dispatch("click");
  // Hidden by a class and nothing else. The alternative — tearing the
  // transcript down and rebuilding it — is how "minimise" quietly becomes
  // "close", which is the whole complaint.
  assert.match(log().text(), /how many Acme contacts\?/);
  assert.match(log().text(), /Three of them\./);
  assert.equal(host.find("dk-step").length, 1);

  host.one("dk-launcher").dispatch("click");
  await ask(host, "and now?");
  // The model is told what was already said, so reopening lands in the
  // conversation rather than in a new one that looks like it.
  const second = s.seen[2]!.messages.map((m) => (m as { text: string }).text).join("\n");
  assert.match(second, /how many Acme contacts\?/);
  assert.match(second, /Three of them\./);
  widget.unmount();
});

test("a minimised launcher says a conversation is waiting, inside its own 96x40 box", async () => {
  // Somebody who minimised mid-run has no other signal: the pill looks exactly
  // like a pill nobody has ever pressed. The indicator therefore lives INSIDE
  // the pill — a badge on the corner would be an element of a different size,
  // and the launcher's size is the one thing nothing here may change.
  const { widget, host } = setup([{ text: "ok" }]);
  const launcher = host.one("dk-launcher");
  const dot = host.one("dk-dot");
  assert.equal(dot.parent, launcher, "the indicator is not inside the launcher");

  // Nothing has been asked, so there is nothing waiting.
  host.one("dk-min").dispatch("click");
  assert.equal(host.one("dk-dot").className, "dk-dot");
  assert.equal(launcher.attrs.get("aria-label"), "Ask Contacts to do something");

  host.one("dk-launcher").dispatch("click");
  await ask(host, "anything");
  host.one("dk-min").dispatch("click");
  assert.match(host.one("dk-dot").className, /dk-dot-on/);
  // And in words as well as in a dot: a dot is not a thing a screen reader can
  // read, and the dot itself is `aria-hidden` for exactly that reason.
  assert.match(launcher.attrs.get("aria-label")!, /conversation is still here/i);
  assert.equal(dot.attrs.get("aria-hidden"), "true");

  // Gone again once the panel is open, where the transcript is the thing the
  // person is already looking at.
  host.one("dk-launcher").dispatch("click");
  assert.equal(host.one("dk-dot").className, "dk-dot");
  widget.unmount();
});

test("the indicator is positioned inside the pill and sizes nothing", async () => {
  // Asserted against the stylesheet, because the fake DOM has no layout. The
  // test above this pins that only one rule sizes the launcher; this pins that
  // the dot cannot become the exception to it — it is absolutely positioned
  // inside a box the launcher itself establishes.
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map((block) => block + "}");
  const dot = rules.filter((r) => r.includes(".dk-dot") && r.includes("{"));
  assert.ok(dot.length >= 1, "the indicator has no rules");
  assert.match(dot[0]!, /position: absolute/);
  for (const rule of dot) assert.doesNotMatch(rule, /\.dk-launcher/);
  const launcher = rules.find((r) => /^\s*\.dk-launcher \{/.test(r))!;
  assert.match(launcher, /position: relative/);
});

test("the drag handle is a visible grip glyph, and it is a real button", async () => {
  // A drag handle has to LOOK like one: six dots is the thing people already
  // read as "pick this up", where the word "Move" read as a button that
  // teleports the panel. A real button because it is also the keyboard
  // control — a handle with nothing focusable in it is a feature only people
  // with a mouse have.
  const { widget, host } = setup();
  const grip = host.one("dk-move");
  assert.equal(grip.textContent, "⠿");
  assert.equal(grip.attrs.get("type"), "button");
  assert.match(grip.attrs.get("aria-label")!, /Move panel/);
  assert.match(grip.attrs.get("title")!, /Alt \(Option\)/);
  // First in the strip, so the thing that drags is as far as a 380px header
  // allows from the things that must not.
  const head = host.one("dk-head");
  assert.equal(head.children[0], grip);
  assert.deepEqual(
    head.children.map((c) => c.className),
    ["dk-move", "dk-title", "dk-gear", "dk-min"],
  );
  widget.unmount();
});

test("the panel title is a short word, not the app's name", async () => {
  // "Northwind CRM" filled the header before the three controls beside it got
  // a place, and told the person nothing: the app they are looking at is the
  // whole screen behind the panel. A title says what the panel IS.
  const { widget, host } = setup();
  assert.equal(host.one("dk-title").textContent, PANEL_TITLE);
  assert.equal(PANEL_TITLE, "Assistant");
  // The app's name is still answerable for, on hover, where it cannot size
  // anything.
  assert.equal(host.one("dk-title").attrs.get("title"), "Contacts assistant");
  widget.unmount();
});

test("options.title still overrides the header word, as it always did", async () => {
  const doc = new FakeDocument();
  const app = contacts();
  const widget = mountWidget(app.driver, {
    think: async () => ({ text: "hi" }),
    document: doc,
    clock: instant,
    title: "Copilot",
  });
  const host = doc.host();
  assert.equal(host.one("dk-title").textContent, "Copilot");
  widget.unmount();
});

test("a generic title does not take the app's name out of the accessible names", async () => {
  // The visual title is a word in a box with a width; a screen-reader label is
  // read in isolation, with none of the context a sighted person gets from the
  // app around it. So the name goes where it answers a question — what is this
  // thing reading my screen — and not where it would set a size.
  const { widget, host, log } = setup();
  assert.equal(host.one("dk-panel").attrs.get("aria-label"), "Contacts assistant");
  assert.match(host.one("dk-input").attrs.get("aria-label")!, /Ask Contacts/);
  assert.match(host.one("dk-input").attrs.get("placeholder")!, /Ask Contacts/);
  assert.match(host.one("dk-launcher").attrs.get("aria-label")!, /Ask Contacts/);
  assert.match(log().text(), /things in Contacts/);
  widget.unmount();
});

// =========================================================================
// Clearing the conversation.
// =========================================================================

test("clear conversation empties the transcript and the step list and starts fresh", async () => {
  const { s, widget, host, log } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 3 } }] },
    { text: "Three." },
    { text: "Nothing has been said yet." },
  ]);

  await ask(host, "how many?");
  assert.equal(host.find("dk-step").length, 1);

  host.one("dk-gear").dispatch("click");
  host.one("dk-clear").dispatch("click");

  assert.equal(host.find("dk-step").length, 0, "the step list survived");
  assert.doesNotMatch(log().text(), /how many\?/);
  assert.doesNotMatch(log().text(), /Three\./);
  // The greeting comes back, because an empty panel with nothing in it looks
  // broken and "fresh" is what clearing promises.
  assert.match(log().text(), /Ask me to do things in Contacts/);
  // Out of the settings view and back in the conversation, which is the thing
  // that just changed.
  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open");
  assert.equal(host.one("dk-input").focused, true);
  // Said out loud too: a panel going empty is a change somebody who cannot see
  // it has no other way to notice.
  assert.equal(host.one("dk-status").textContent, "Conversation cleared");

  await ask(host, "what did I just ask?");
  // And the model is told nothing about the cleared conversation, which is the
  // only reading of "clear" that is not a lie.
  assert.equal(s.seen[2]!.messages.length, 1);
  widget.unmount();
});

test("clearing abandons a run in flight, through the run's own abort and not a second stop path", async () => {
  // Clearing the visible history while the loop still holds `messages` would
  // leave the panel and the model disagreeing about what has been said — and
  // the model would win, so the next answer would refer to a conversation the
  // person is looking at the absence of. The existing `AbortController` is
  // what stops it, because a second stop path could disagree with the first.
  const { app, s, widget, host, log } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 5 } }] },
    () => {
      host.one("dk-gear").dispatch("click");
      host.one("dk-clear").dispatch("click");
      return { calls: [{ id: "b", name: "accept-selected", args: {} }] };
    },
    { text: "fresh" },
  ]);

  await ask(host, "select then accept");

  // The verb after the clear never ran.
  assert.equal(app.accepted(), 0);
  // And nothing from the abandoned run landed in the conversation that
  // replaced it: no steps, no stop note, no history.
  assert.equal(host.find("dk-step").length, 0);
  assert.doesNotMatch(log().text(), /Stopped/);
  assert.doesNotMatch(log().text(), /select then accept/);

  await ask(host, "hello again");
  assert.equal(s.seen[2]!.messages.length, 1);
  // The panel is not left busy by the run it abandoned.
  assert.equal(host.one("dk-wrap").className, "dk-wrap dk-open");
  widget.unmount();
});

test("clear conversation asks nothing first, because a lost chat costs one sentence", async () => {
  // Deliberately not symmetrical with the commit dialog. A confirmation is
  // worth a click when the thing behind it cannot be undone and cost somebody
  // something; this one is recoverable by asking again, and a dialog on the
  // cheap thing is how people learn to click through the dialog on the
  // expensive one.
  const { app, widget, host, log } = setup([
    { calls: [{ id: "a", name: "select-where", args: { where: "company=Acme", limit: 3 } }] },
    { text: "Three." },
  ]);
  await ask(host, "how many?");

  host.one("dk-gear").dispatch("click");
  host.one("dk-clear").dispatch("click");

  assert.equal(host.find("dk-ask").length, 0, "clearing asked a question");
  assert.doesNotMatch(log().text(), /how many\?/);
  // And nothing in the app changed, which is why it is cheap: the steps that
  // ran stay run.
  assert.equal(app.accepted(), 0);
  widget.unmount();
});

test("clear conversation is the destructive item at the bottom of the settings list", async () => {
  // Last, below four preferences, because a destructive action next to a
  // speed radio is one somebody hits while reaching for something else. And
  // marked in the commit colour, which already means "this changes something
  // you cannot take back" everywhere else in this panel — a second vocabulary
  // for danger would weaken the first.
  const { widget, host } = setup();
  const rows = host.one("dk-settings").children.map((c) => c.className);
  assert.deepEqual(rows[rows.length - 1], "dk-done");
  assert.match(rows[rows.length - 2]!, /dk-set-row/);
  assert.equal(host.one("dk-clear").parent, host.one("dk-settings").children[rows.length - 2]);
  assert.match(host.one("dk-clear").textContent!, /Clear conversation/);

  const rule = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map((block) => block + "}")
    .find((block) => /^\s*\.dk-clear \{/.test(block))!;
  assert.match(rule, /var\(--dk-commit\)/);
  widget.unmount();
});

test("clearing twice over, and clearing an empty panel, are both nothing to worry about", async () => {
  // The era counter has to be a counter and not a flag: two clears during one
  // run both have to invalidate it, and the second must not resurrect what the
  // first threw away.
  const { widget, host, log } = setup([{ text: "one" }, { text: "two" }]);
  host.one("dk-gear").dispatch("click");
  host.one("dk-clear").dispatch("click");
  host.one("dk-gear").dispatch("click");
  host.one("dk-clear").dispatch("click");
  assert.equal(host.find("dk-note").length, 1, "the greeting is in there more than once");

  await ask(host, "still working?");
  assert.match(log().text(), /one/);
  widget.unmount();
});

test("Escape still closes the panel from inside the settings view, clear button and all", async () => {
  // The panel's one escape hatch keeps working wherever focus is, including
  // from the row that was added below everything else.
  const { widget, host } = setup();
  host.one("dk-gear").dispatch("click");
  const e = host.one("dk-clear").dispatch("keydown", { key: "Escape" });
  assert.equal(host.one("dk-wrap").className, "dk-wrap");
  assert.equal(e.defaultPrevented, true);
  assert.equal(host.one("dk-launcher").focused, true);
  widget.unmount();
});

test("prose the model had already produced does not land in the conversation that replaced it", async () => {
  // An abort stops the loop at its next await, so a turn that was already on
  // its way back can still arrive after the clear. The panel is fresh by then
  // and an answer to a question nobody can see is worse than no answer.
  const { widget, host, log } = setup([
    () => {
      host.one("dk-gear").dispatch("click");
      host.one("dk-clear").dispatch("click");
      return { text: "late words about a conversation that is gone" };
    },
    { text: "ok" },
  ]);

  await ask(host, "say something");
  assert.doesNotMatch(log().text(), /late words/);
  assert.equal(host.find("dk-me").length, 0);
  widget.unmount();
});

// ---- the question box --------------------------------------------------
//
// The other direction from the confirmation above. `approve` lets the person
// stop the agent; this lets the agent ask the person something, and the panel
// is where a question is seen on both of driverkit's paths -- an agent
// arriving over the relay asks through the same hook and the person answers in
// the same transcript.

/** The same fixture, with the panel wired as the driver's `ask` hook.
 *
 *  A forward reference, because `mount()` has to happen before the panel that
 *  will answer for it exists -- and wired rather than adopted, because the
 *  `ask` verb has to be in the manifest from `mount()` or the tool list would
 *  change when a panel appeared. That is the documented wiring, so it is the
 *  wiring the tests use. */
function asking(script: unknown[] = [{ text: "ok" }], options: Partial<WidgetOptions> = {}) {
  const doc = new FakeDocument();
  let widget: ReturnType<typeof mountWidget> | undefined;
  const app = contacts({ ask: (q) => widget!.question(q) });
  const s = scripted(script);
  widget = mountWidget(app.driver, {
    think: s.think,
    document: doc,
    clock: instant,
    open: true,
    ...options,
  });
  return { doc, app, s, widget, host: doc.host() };
}

test("a question the agent asks appears in the panel with a box, and what is typed goes back", async () => {
  // The whole feature, end to end, through the DOM the person actually sees.
  // The answer is the ask's own RESULT -- not a side channel -- so the tool
  // turn the model reads carries the person's sentence.
  const { app, host } = asking();
  const call = app.driver.call("ask", { question: "which Ada Duarte did you mean?" });
  await Promise.resolve();

  assert.equal(host.one("dk-ask-q").textContent, "which Ada Duarte did you mean?");
  // The box has the focus and not the safe button, which is the opposite of
  // the confirmation dialog: there, Enter must not accept a thousand rows, and
  // here the only thing Enter can do is send what was typed.
  const box = host.one("dk-ask-box");
  assert.equal(box.focused, true);
  // And it does NOT read like the confirmation. A question changes nothing, so
  // it gives back the commit colour the confirmation is allowed to be loud in;
  // two dialogs that look alike are one dialog as far as attention goes.
  assert.ok(host.one("dk-q"), "a question carries its own class");
  assert.match(host.one("dk-ask-why").textContent!, /answering is not approving/);

  box.value = "the one at Acme";
  host.one("dk-yes").dispatch("click");
  const out = await call;
  assert.equal(out.ok, true);
  assert.match(String((out as { note?: string }).note), /the one at Acme/);
  // The controls go and the answer stays: scrolling back and finding a live box
  // beside a question answered twenty turns ago is worse than no record.
  assert.equal(host.find("dk-ask-box").length, 0);
  assert.match(host.one("dk-ask-said").textContent!, /You answered: the one at Acme/);
});

test("Enter in the box sends the answer, and an empty box sends nothing at all", async () => {
  // An empty box is not an answer and must not be sent as one: the question
  // stays open, because they have not answered yet. "Not now" is how somebody
  // declines to answer, and it says so -- which is the distinction the core
  // keeps `ask-unanswered` for.
  const { app, host } = asking();
  const call = app.driver.call("ask", { question: "which one?" });
  await Promise.resolve();

  const box = host.one("dk-ask-box");
  box.dispatch("keydown", { key: "Enter" });
  await Promise.resolve();
  assert.equal(host.find("dk-ask-box").length, 1, "still open, because nothing was typed");

  box.value = "the first";
  box.dispatch("keydown", { key: "Enter" });
  const out = await call;
  assert.match(String((out as { note?: string }).note), /the first/);
});

test("Not now is an unanswered question and never an answer the model can act on", async () => {
  // THE DECISION: a person who declines to answer has not said anything, so the
  // refusal is `ask-unanswered` and the model is told nothing changed. A panel
  // that answered "" or "no" here would be putting a word in somebody's mouth,
  // and the model would act on it.
  const { app, host } = asking();
  const call = app.driver.call("ask", { question: "which one?" });
  await Promise.resolve();
  host.one("dk-no").dispatch("click");
  const out = await call;
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.refused, "ask-unanswered");
  assert.match(host.one("dk-ask-said").textContent!, /did not answer/);
});

test("unmounting the panel with a question open answers it unanswered rather than wedging the app", async () => {
  // The same hazard the approval dialog's teardown exists for, and one step
  // worse: a question asked over the relay has no run behind it and therefore
  // no abort signal, so a panel torn down with one open would leave
  // `driver.call()` waiting on a promise nobody can resolve. The core's 45
  // second deadline would eventually answer, but a dead panel for 45 seconds
  // is still a dead app, caused by closing a chat panel.
  const { app, widget } = asking();
  const call = app.driver.call("ask", { question: "which one?" });
  await Promise.resolve();
  widget.unmount();
  const out = await call;
  assert.equal(out.ok === false && out.refused, "ask-unanswered");
});

test("the panel never claims there is nobody to ask, because a mounted panel is somewhere a question is seen", async () => {
  // `{ nobody: true }` is a claim about the DEPLOYMENT -- a cron run, a tab
  // with no panel -- and it tells an agent to stop asking for the rest of the
  // run. A panel that is mounted is a place a question can be seen even if
  // nobody is looking this minute, so it is not the panel's claim to make. Its
  // only two answers are the person's words and `{ answered: false }`.
  const { widget } = asking();
  const answers: unknown[] = [];
  const open = widget.question({ question: "which one?" }).then((a) => answers.push(a));
  await Promise.resolve();
  widget.unmount();
  await open;
  assert.deepEqual(answers, [{ answered: false }]);
});
