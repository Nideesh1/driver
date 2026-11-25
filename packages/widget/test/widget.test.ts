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

import { mount } from "../../core/src/registry.ts";
import type { Driver, Snapshot } from "../../core/src/types.ts";
import type { Think, ThinkInput } from "../../agent/src/types.ts";
import { mountWidget, storageKey } from "../src/index.ts";
import type { Position, WidgetOptions } from "../src/index.ts";
import { FakeDocument, FakeNode, FakeStorage, FakeWindow, GAP, hide } from "./fake-dom.ts";

/** The same shape as the core's and the agent's fixtures: 3,412 contacts, a
 *  twenty-row window, and a `describe` verb that reports what it selected. The
 *  count is what the confirmation row exists to show, so a fixture that did
 *  not produce one would not test the thing. */
function contacts(): { driver: Driver; accepted: () => number } {
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
        run: ({ where, limit }) => {
          const matched = all.filter((r) => r.company === String(where).split("=")[1]);
          selected = matched.slice(0, (limit as number) ?? matched.length).map((r) => r.id);
          rev++;
          return { count: selected.length, note: `${matched.length} matched` };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        refuses: ["nothing-selected"],
        run: (_a, ctx) => {
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
    open: true,
  });
  const host = doc.host();
  return { doc, app, s, widget, host, log: () => host.one("dk-log") };
}

test("mounting puts one host element in the container and nothing else", () => {
  const doc = new FakeDocument();
  const app = contacts();
  const widget = mountWidget(app.driver, { think: async () => ({ text: "hi" }), document: doc });

  assert.equal(doc.body.children.length, 1);
  const host = doc.host();
  // Shadow DOM, so the host app's CSS cannot reach in and these rules cannot
  // leak out. A library that silently restyles the page it was added to does
  // not get a second chance.
  assert.ok(host.shadow, "the panel was not put in a shadow root");
  assert.equal(host.one("dk-launcher").textContent, "Ask Contacts");
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
  const widget = mountWidget(app.driver, { think: async () => ({ text: "x" }), document: doc });
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
  let release: (() => void) | null = null;
  const doc = new FakeDocument();
  const app = contacts();
  let calls = 0;
  const widget = mountWidget(app.driver, {
    document: doc,
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
  release?.();
  await settle();
  widget.unmount();
});

test("a think that throws is said in the transcript, not only in the console", async () => {
  const errors: unknown[] = [];
  const doc = new FakeDocument();
  const app = contacts();
  const widget = mountWidget(app.driver, {
    document: doc,
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
  const widget = mountWidget(app.driver, { think: async () => ({}), document: doc });

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
  const widget = mountWidget(driver, { think: s.think, document: doc, open: true });
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

test("dragging the header moves the panel", () => {
  const { widget, host, rect } = place();
  dragBy(host.one("dk-head"), -300, -100);
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
    const head = host.one("dk-head");
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
  dragBy(host.one("dk-head"), -40, -30);
  near(rect().left, FAR_X);
  near(rect().top, FAR_Y);
  assert.match(host.className, /dk-snap/);
  widget.unmount();
});

test("a release far from a corner stays exactly where it was dropped", () => {
  // Somebody who dragged the panel into the middle of the screen meant it.
  const { widget, host, rect } = place();
  dragBy(host.one("dk-head"), -300, -100);
  near(rect().left, FAR_X - 300);
  near(rect().top, FAR_Y - 100);
  assert.doesNotMatch(host.className, /dk-snap/);
  widget.unmount();
});

test("snapThreshold 0 switches the magnet off", () => {
  const { widget, host, rect } = place({ snapThreshold: 0 });
  dragBy(host.one("dk-head"), -40, -30);
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
  dragBy(host.one("dk-head"), -40, -30);
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

test("pressing a button inside the header is that button's press, not the start of a drag", () => {
  // The header is the drag handle and it is also where Close lives. A person
  // who presses Close and twitches two pixels still meant Close.
  const { widget, host } = place();
  const close = host.one("dk-x");
  // Bubbles to the header's handler, exactly as it does in a browser.
  dragBy(close, -300, -100);
  assert.equal(host.style.props.size, 0, "a press on Close dragged the panel");
  close.dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap");
  widget.unmount();
});

test("a right-click does not start a drag", () => {
  const { widget, host } = place();
  const head = host.one("dk-head");
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
  const head = host.one("dk-head");
  dragBy(head, -100, -40);
  assert.deepEqual(head.captured, []);
  widget.unmount();
});

test("a cancelled pointer ends the drag rather than sticking the panel to it", () => {
  // The browser took the pointer for a scroll, or the pen left the tablet.
  // Either way it is not coming back.
  const { widget, host, rect } = place();
  const head = host.one("dk-head");
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
  dragBy(host.one("dk-head"), 300, 100);
  near(host.getBoundingClientRect().left, GAP);
  widget.unmount();
});

test("the position survives a remount, per app and per viewer", () => {
  const storage = new FakeStorage();
  const first = place({ storage });
  dragBy(first.host.one("dk-head"), -300, -100);
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
  dragBy(host.one("dk-head"), -300, -100);
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
  dragBy(host.one("dk-head"), -300, -100);
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
  dragBy(host.one("dk-head"), -300, -100);
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
  // would do to somebody who had just dragged the panel somewhere.
  const { widget, host, rect } = place();
  dragBy(host.one("dk-head"), -600, -150);
  host.one("dk-move").dispatch("click");
  near(rect().left, GAP);
  near(rect().top, GAP);
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
    window: win,
    open: true,
    position: "top-left",
  });
  const host = doc.host();

  assert.equal(host.find("dk-launcher").length, 1, "nothing rendered");
  dragBy(host.one("dk-head"), -300, -100);
  widget.unmount();
});

test("a drag of the header does not swallow the next click somewhere else", () => {
  // The suppression is per handle for this reason. Dragging the header fires a
  // click on the HEADER, which nothing listens for, so one shared flag would
  // still be set when the person's next real click landed on a button.
  const { widget, host } = place();
  dragBy(host.one("dk-head"), -300, -100);
  host.one("dk-x").dispatch("click");
  assert.equal(host.one("dk-wrap").className, "dk-wrap", "a stale drag flag ate the Close click");
  widget.unmount();
});
