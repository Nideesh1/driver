/**
 * `driverkit/react`, rendered by React.
 *
 * WHY THIS FILE IS SEPARATE FROM `react.test.ts`. That file is the area's
 * specification and it is deliberately framework-free: the behaviour lives in
 * `store.ts`, which is a plain object, and the markup claims are checked
 * against a sixty-line React stand-in. It was written when there was no
 * network install in this repository, and it says plainly what it could not
 * tell you — nothing re-rendered, `setState` was recorded and discarded,
 * `useEffect` ran synchronously and its cleanups never ran, and `ref` was a
 * prop rather than a bound node, so the focus move was not exercised at all.
 *
 * This file is those gaps, closed with the real thing: `react` and
 * `react-dom/client` as DEV DEPENDENCIES of the workspace, rendering into
 * jsdom. The published package's dependency surface is unchanged and
 * `test/packaging.test.ts` still proves it — React is an optional peer, no
 * emitted file names it, and `dist/react/` is unreachable from
 * `dist/core/index.js`. A test-time renderer is not a shipped dependency.
 *
 * Two of the claims checked here were FALSE before this file existed, and both
 * were invisible without a real React:
 *
 *   1. `useDriver` destroyed its own store during mount under `StrictMode`,
 *      which is how every React app runs in development. The panel rendered
 *      and then did nothing at all.
 *   2. The receipt moved focus on EVERY phase change rather than once, because
 *      the keyed status region remounted and took the "already moved" flag
 *      with it — the exact behaviour the code's comment promised would not
 *      happen.
 *
 * WHAT THIS STILL CANNOT TELL YOU. jsdom is not a browser: it does not lay
 * anything out, it has no screen reader, and its focus model is an
 * approximation. So "the announcement is made" is not asserted here and
 * cannot be — what is asserted is the structure that makes it possible (a
 * region that stays in the document, a line inside it that is replaced).
 * `e2e/` is where the vanilla panel's equivalent claims meet a real browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";
import * as React from "react";

import { createDriverPanel } from "../src/react/index.ts";
import type { ApprovalEntry, Driving, PanelOptions, PanelStore } from "../src/react/index.ts";
import type { Component, ReactRuntime } from "../src/react/runtime.ts";
import type { Driver } from "../src/core/types.ts";
import { call, contacts, scripted } from "./app.ts";
import type { ThinkInput, ThinkResult } from "../src/agent/index.ts";

// ---- jsdom, before react-dom is loaded -------------------------------------
//
// `react-dom/client` reads the document while it is being loaded, so the
// globals have to be in place first — which static imports cannot guarantee,
// since every import in a module is evaluated before the module's own body.
// Hence one dynamic import, after the window exists.

const jsdom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const win = jsdom.window as unknown as Window & typeof globalThis;
const anyGlobal = globalThis as unknown as Record<string, unknown>;
anyGlobal["window"] = win;
anyGlobal["document"] = win.document;
anyGlobal["HTMLElement"] = win.HTMLElement;
anyGlobal["Element"] = win.Element;
anyGlobal["Node"] = win.Node;
anyGlobal["Event"] = win.Event;
// `navigator` is a getter on Node's global object, so it is defined rather
// than assigned.
Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
// React's own flag for "there is an `act` around every update in this
// program". Without it React warns, correctly, on the first state change.
anyGlobal["IS_REACT_ACT_ENVIRONMENT"] = true;

const { createRoot } = await import("react-dom/client");

/**
 * React's module namespace satisfies the structural runtime type.
 *
 * Checked by `tsc` rather than at runtime, which is the point: `runtime.ts`
 * claims to be "satisfied BY React's own types, not to re-describe them", and
 * until there was a React in the repository that claim was an assertion about
 * a package nobody could resolve. This line is the whole test, and it fails
 * the typecheck rather than the suite if the shapes ever drift.
 */
const runtime: ReactRuntime = React;

const { useDriver, DriverPanel, components } = createDriverPanel(runtime);

// ---- helpers ---------------------------------------------------------------

/** `createElement` for this area's components, whose return type is `unknown`
 *  by design — see `runtime.ts`. The cast is in one place rather than at every
 *  call site in the file. */
function el<P extends object>(component: Component<P>, props: P): React.ReactElement {
  return React.createElement(
    component as unknown as React.FunctionComponent<P>,
    props as P & React.Attributes,
  );
}

interface Mounted {
  root: HTMLElement;
  render: (node: React.ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

function mount(): Mounted {
  const root = win.document.createElement("div");
  win.document.body.appendChild(root);
  const reactRoot = createRoot(root);
  return {
    root,
    render: async (node) => {
      await React.act(async () => {
        reactRoot.render(node);
      });
    },
    unmount: async () => {
      await React.act(async () => {
        reactRoot.unmount();
      });
      root.remove();
    },
  };
}

/** Let the panel's own timers and promises run, inside `act` so every state
 *  change React makes is flushed before the assertions. */
async function settle(ms = 40): Promise<void> {
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Type into a controlled input the way a person does. React installs its own
 *  value tracker, so assigning `.value` directly is not seen; the prototype's
 *  setter is. */
async function type(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter, "jsdom must expose the value setter");
  await React.act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

async function click(target: Element | null, what: string): Promise<void> {
  assert.ok(target, `expected to find ${what}`);
  await React.act(async () => {
    (target as HTMLElement).click();
  });
}

function query(root: HTMLElement, selector: string): Element | null {
  return root.querySelector(selector);
}

function all(root: HTMLElement, selector: string): Element[] {
  return [...root.querySelectorAll(selector)];
}

type Script = Array<ThinkResult | ((input: ThinkInput, step: number) => ThinkResult)>;

const ACCEPT_ACME: Script = [
  { calls: [call("select-where", { where: "company=Acme", limit: 1000 })] },
  { calls: [call("accept-selected")] },
  { text: "Accepted the top thousand Acme contacts." },
];

/** The demo app, a scripted model, and the options the panel takes. */
function toy(script: Script = ACCEPT_ACME, extra: Partial<PanelOptions> = {}) {
  const app = contacts();
  const s = scripted(script);
  const options: PanelOptions = { think: s.think, pace: 0, ...extra };
  return { app, options, seen: s.seen };
}

/** A component that hands the hook's return value out to the test, so a test
 *  can watch what the hook does across renders without going through the DOM. */
function probe(seen: Driving[]): Component<{ driver: Driver; options: PanelOptions }> {
  return ({ driver, options }) => {
    const driving = useDriver(driver, options);
    seen.push(driving);
    return null;
  };
}

/** Collect what React writes to `console.error` — which is where it puts every
 *  warning — for a test that is about there being none. */
async function withoutWarnings<T>(body: () => Promise<T>): Promise<[T, string[]]> {
  const said: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => {
    said.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return [await body(), said];
  } finally {
    console.error = real;
  }
}

// ---- the hook under a real dispatcher --------------------------------------

test("StrictMode builds one store and leaves it alive, so the panel works in development", async () => {
  // THE bug this file was written to find, and the one an adopter would have
  // hit on their first `npm run dev`. StrictMode runs a mount effect's
  // cleanup and then mounts the effect again, and `destroy` is final: the
  // hook's `return () => store.destroy()` therefore tore the store down
  // DURING mount, leaving a panel that rendered correctly and then ignored
  // every instruction typed into it — `ask` returns immediately on a
  // destroyed store. Nothing in a framework-free suite can see this, because
  // nothing in one runs an effect twice.
  //
  // Two claims, and both matter: the double-invoked render builds ONE store
  // (the ref's lazy initialisation is shared between the two passes), and the
  // store it builds is still usable afterwards.
  const { app, options } = toy();
  const seen: Driving[] = [];
  const Probe = probe(seen);
  const ui = mount();

  await ui.render(React.createElement(React.StrictMode, null, el(Probe, { driver: app.driver, options })));

  assert.ok(seen.length >= 2, "StrictMode must have double-invoked the component");
  const stores = new Set(seen.map((d) => d.store));
  assert.equal(stores.size, 1, "one driver, one store — two would mean two gates");
  const store = seen[seen.length - 1]!.store;
  assert.equal(store.destroyed(), false, "the store must survive StrictMode's remount");

  await React.act(async () => {
    void store.ask("accept the Acme contacts");
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.ok(
    store.getSnapshot().entries.length > 0,
    "a store the hook has killed accepts no instruction, and the panel looks broken",
  );
  assert.ok(store.getSnapshot().pending, "the gate must still open under StrictMode");

  await ui.unmount();
  app.driver.unmount();
});

test("the store outlives a re-render and is torn down once the panel is gone", async () => {
  // The other half of the lifecycle. A re-render must not rebuild the store —
  // that would restart the conversation under somebody — and an unmount must
  // tear it down, because the alternative is an aborted-nothing run holding a
  // driver after its panel has left the page.
  const { app, options } = toy();
  const seen: Driving[] = [];
  const Probe = probe(seen);
  const ui = mount();

  await ui.render(el(Probe, { driver: app.driver, options }));
  await ui.render(el(Probe, { driver: app.driver, options: { ...options } }));
  const stores = new Set(seen.map((d) => d.store));
  assert.equal(stores.size, 1, "a new options object is not a new store");
  const store = seen[0]!.store;

  await ui.unmount();
  // The teardown is deferred by one microtask, which is what makes
  // StrictMode's remount survivable; so it is awaited rather than assumed.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.destroyed(), true);
  app.driver.unmount();
});

test("a changed driver tears down the store it replaced and not the one it built", async () => {
  // `useDriver` keys its store on `driver` identity. The teardown of the
  // outgoing one moved out of render and into the effect when this file was
  // written: a render may be double-invoked or thrown away, and destroying a
  // live store speculatively would abort a run that is still on screen.
  const first = toy();
  const second = toy();
  const seen: Driving[] = [];
  const Probe = probe(seen);
  const ui = mount();

  await ui.render(el(Probe, { driver: first.app.driver, options: first.options }));
  const one = seen[seen.length - 1]!.store;
  await ui.render(el(Probe, { driver: second.app.driver, options: second.options }));
  const two = seen[seen.length - 1]!.store;

  assert.notEqual(one, two, "a different driver is a different store");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(one.destroyed(), true, "the store for the old driver is released");
  assert.equal(two.destroyed(), false, "the store for the new driver is not");

  await ui.unmount();
  first.app.driver.unmount();
  second.app.driver.unmount();
});

test("an unmount mid-run lapses the open question and warns about nothing", async () => {
  // `drive` fires its callbacks from inside awaits, so a call can land after
  // the panel has gone. The store's `era` counter is what makes that harmless
  // on a Clear; this is the unmount case, which React is the only thing that
  // could have told us about. Two claims: the record says `lapsed` — nobody
  // refused this, and a record that could not tell "a person said no" from
  // "nobody was there" is the record this mechanism exists to stop writing —
  // and React says nothing on the console, because a warning in an adopter's
  // dev tools is a bug report they will file.
  const { app, options } = toy();
  const seen: Driving[] = [];
  const Probe = probe(seen);
  const ui = mount();

  const [, warnings] = await withoutWarnings(async () => {
    await ui.render(el(Probe, { driver: app.driver, options }));
    const store = seen[seen.length - 1]!.store;
    // Inside `act`, because a store notification IS a React update: a run
    // started outside one would make React warn about the test rather than
    // about the thing under test.
    let asked!: Promise<void>;
    await React.act(async () => {
      asked = store.ask("accept the Acme contacts");
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.ok(store.getSnapshot().pending, "the gate must be open before the unmount");

    await ui.unmount();
    await asked;
    await new Promise((r) => setTimeout(r, 10));

    const approval = store
      .getSnapshot()
      .entries.find((e): e is ApprovalEntry => e.kind === "approval");
    assert.equal(approval?.phase, "lapsed");
    assert.equal(app.accepted().length, 0, "a lapsed question commits nothing");
  });

  assert.deepEqual(warnings, [], "React must have nothing to say about the unmount");
  app.driver.unmount();
});

// ---- the receipt, with a real ref and a real focus -------------------------

test("focus moves to the receipt once and stays there when the app's verdict arrives", async () => {
  // Untested until this file existed, and wrong. `ReceiptStatus` is supposed
  // to move focus to the receipt on the transition out of `asking`, so
  // somebody who pressed a button lands on the answer rather than on whatever
  // followed the buttons that have just gone — and never again, because a
  // receipt that stole focus when the verdict arrived a moment later would
  // yank somebody out of the message they had started typing.
  //
  // The keyed status region made that promise false twice over: the "already
  // moved" ref died with the remounted node so the move ran on every phase,
  // and had it not, the node holding focus would have been removed from the
  // document and the focus dropped to `<body>`. The region is now mounted once
  // and the LINE inside it is what carries the key.
  const moves: string[] = [];
  const realFocus = win.HTMLElement.prototype.focus;
  win.HTMLElement.prototype.focus = function (this: HTMLElement, ...args: unknown[]) {
    moves.push(this.getAttribute("data-phase") ?? this.tagName);
    return realFocus.apply(this, args as []);
  };

  try {
    const ui = mount();
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
    const show = (phase: ApprovalEntry["phase"]) =>
      ui.render(
        el(components.ApprovalCard, { entry: { ...entry, phase }, decide: () => {}, notes: false }),
      );

    await show("asking");
    assert.equal(query(ui.root, "[data-dk=receipt]"), null, "an asking card has no receipt");
    assert.deepEqual(moves, [], "nothing is focused while the buttons are live");

    await show("allowed");
    const region = query(ui.root, "[data-dk=receipt]");
    assert.equal(win.document.activeElement, region, "the decision lands on the receipt");
    assert.deepEqual(moves, ["allowed"]);
    const line = query(ui.root, ".dk-ask-line");

    // The app's verdict, a moment later. The phase moves and the words change.
    await show("allowed-ok");
    assert.equal(query(ui.root, "[data-dk=receipt]"), region, "the region is not remounted");
    assert.equal(
      win.document.activeElement,
      region,
      "focus stays where the person was put, through the change",
    );
    assert.deepEqual(moves, ["allowed"], "focus is moved once, never again");
    // The key on the line is what makes this a replaced node rather than an
    // updated one, which is the form a live region is reliably announced in.
    assert.notEqual(query(ui.root, ".dk-ask-line"), line, "the line itself IS replaced");
    assert.equal(region?.textContent, "Approved. Finished.");

    // A re-render that changes nothing must not move focus either: the effect
    // is keyed on the decision, not on the render.
    await show("allowed-ok");
    assert.deepEqual(moves, ["allowed"]);
    assert.equal(win.document.activeElement, region);

    await ui.unmount();
  } finally {
    win.HTMLElement.prototype.focus = realFocus;
  }
});

test("the receipt is focusable programmatically and is not a tab stop", async () => {
  // `tabIndex={-1}` is the whole mechanism, and it reads like bookkeeping, so
  // it is pinned against a real element rather than against a props object: a
  // receipt is a record and must not be in the tab order, but it has to be
  // focusable or the move above cannot happen at all.
  const ui = mount();
  await ui.render(
    el(components.ApprovalCard, {
      entry: {
        kind: "approval",
        id: "a1",
        verb: "v",
        describe: "do it",
        args: {},
        reversible: false,
        large: false,
        phase: "denied",
      },
      decide: () => {},
      notes: false,
    }),
  );
  const region = query(ui.root, "[data-dk=receipt]") as HTMLElement;
  assert.equal(region.tabIndex, -1);
  assert.equal(region.getAttribute("role"), "status");
  assert.equal(all(ui.root, "button").length, 0, "a decided card has no live buttons");
  await ui.unmount();
});

// ---- the whole panel, driven through the DOM -------------------------------

test("a question answered by clicking Yes in the DOM is the commit the app performs", async () => {
  // The panel end to end, through the events a person actually generates: a
  // typed instruction, a submitted form, a clicked button. Everything between
  // them — the subscription, the re-renders, the gate's promise — is React's
  // and the store's, and this is the first test in the repository in which
  // either is real.
  const { app, options } = toy();
  const ui = mount();
  await ui.render(el(DriverPanel, { driver: app.driver, options, placeholder: "Ask" }));

  const input = query(ui.root, "input.dk-input") as HTMLInputElement;
  await type(input, "accept the Acme contacts");
  assert.equal(input.value, "accept the Acme contacts", "the composer is controlled");
  await click(query(ui.root, "button.dk-send"), "the Send button");
  await settle();

  const card = query(ui.root, "[data-dk=approval]");
  assert.equal(card?.getAttribute("data-phase"), "asking");
  assert.match(card?.textContent ?? "", /accept the current selection — 1,000 rows\?/);
  // No count is not the case here, and the card says why it is asking at all.
  assert.match(card?.textContent ?? "", /may be irreversible/);
  assert.equal(app.accepted().length, 0, "nothing has happened yet");

  await click(query(ui.root, "button.dk-yes"), "the Yes button");
  await settle();

  assert.equal(app.accepted().length, 1000, "the click is what performed the commit");
  const receipt = query(ui.root, "[data-dk=approval]");
  assert.equal(receipt?.getAttribute("data-phase"), "allowed-ok");
  assert.match(receipt?.textContent ?? "", /accept the current selection — 1,000 rows\?/);
  assert.match(receipt?.textContent ?? "", /Approved\. Finished\./);
  assert.equal(all(ui.root, "button.dk-yes").length, 0, "the question is answered and gone");
  assert.equal(
    all(ui.root, "[data-dk=approval]").length,
    1,
    "the receipt IS the question: one entry, not a question and a verdict",
  );

  await ui.unmount();
  app.driver.unmount();
});

test("No in the DOM refuses the commit and the card says so in place", async () => {
  // The other button, because "the decision reached the core" is a different
  // claim for each answer and the refusing one is the one that matters.
  const { app, options } = toy();
  const ui = mount();
  await ui.render(el(DriverPanel, { driver: app.driver, options }));

  await type(query(ui.root, "input.dk-input") as HTMLInputElement, "accept them");
  await click(query(ui.root, "button.dk-send"), "the Send button");
  await settle();
  await click(query(ui.root, "button.dk-no"), "the No button");
  await settle();

  assert.equal(app.accepted().length, 0);
  const receipt = query(ui.root, "[data-dk=approval]");
  assert.equal(receipt?.getAttribute("data-phase"), "denied");
  assert.match(receipt?.textContent ?? "", /Denied\. Nothing was changed\./);

  await ui.unmount();
  app.driver.unmount();
});

test("two commits in one turn are one dialog at a time, never two live Yes buttons", async () => {
  // The core holds no other calls while a question is open, and React's
  // batching does not get a vote: a commit cannot be announced until the
  // previous question has been answered, so a render in which two cards are
  // asking is a render that cannot be produced. Worth pinning here rather than
  // only in the store's own suite, because "two live Yes buttons for one
  // commit" is a thing a host can cause by rendering `pending` a second time,
  // and this is the test that would notice if the default panel started doing
  // it too.
  const { app, options } = toy([
    { calls: [call("select-where", { where: "company=Acme", limit: 3 })] },
    { calls: [call("accept-selected"), call("accept-selected")] },
    { text: "Done." },
  ]);
  const ui = mount();
  await ui.render(el(DriverPanel, { driver: app.driver, options }));

  await type(query(ui.root, "input.dk-input") as HTMLInputElement, "accept them twice");
  await click(query(ui.root, "button.dk-send"), "the Send button");
  await settle();

  const asking = () => all(ui.root, "[data-dk=approval][data-phase=asking]");
  assert.equal(asking().length, 1, "the first commit is asked about alone");
  assert.equal(all(ui.root, "button.dk-yes").length, 1);

  await click(query(ui.root, "button.dk-yes"), "the first Yes");
  await settle();
  // The second commit is now asking — and the first is a receipt beside it,
  // not a second live question.
  assert.equal(asking().length, 1, "one question at a time, through the whole turn");
  assert.equal(all(ui.root, "button.dk-yes").length, 1);
  assert.equal(all(ui.root, "[data-dk=approval]").length, 2);

  await click(query(ui.root, "button.dk-yes"), "the second Yes");
  await settle();
  assert.equal(asking().length, 0);
  assert.deepEqual(
    all(ui.root, "[data-dk=approval]").map((n) => n.getAttribute("data-phase")),
    ["allowed-ok", "allowed-refused"],
    "the second commit was approved and then refused by the app: both facts, on their own receipts",
  );

  await ui.unmount();
  app.driver.unmount();
});

test("the transcript the panel renders carries no live region", async () => {
  // Already pinned against the stand-in; re-pinned against the DOM because
  // this is the one accessibility decision in the area that is a correction
  // rather than a port, and an `aria-live` reintroduced by a wrapper is
  // invisible in a props tree.
  const { app, options } = toy();
  const ui = mount();
  await ui.render(el(DriverPanel, { driver: app.driver, options: { ...options, greeting: "Hi." } }));
  await type(query(ui.root, "input.dk-input") as HTMLInputElement, "accept the Acme contacts");
  await click(query(ui.root, "button.dk-send"), "the Send button");
  await settle();
  await click(query(ui.root, "button.dk-yes"), "the Yes button");
  await settle();

  const log = query(ui.root, "[data-dk=transcript]") as HTMLElement;
  assert.ok(log.children.length > 3, "the transcript must have content");
  assert.equal(log.getAttribute("aria-live"), null);
  assert.equal(all(log, "[aria-live]").length, 0);
  assert.equal(all(log, "[role=log]").length, 0, "role=log is a live region");
  // The receipt's own region is a `role="status"` and is the only live thing
  // in there.
  assert.deepEqual(
    all(log, "[role=status]").map((n) => n.getAttribute("data-dk")),
    ["receipt"],
  );
  // Nothing in this area injects HTML; the model's text is text.
  assert.ok(!log.innerHTML.includes("<script"));

  await ui.unmount();
  app.driver.unmount();
});

test("a panel rendered twice for one driver is the host's bug and not a second gate", async () => {
  // `REACT.md` tells an adopter not to call `useDriver` twice for one driver,
  // because two stores means two gates and the second one's question is a
  // second question about one commit. The hook cannot stop them — the stores
  // are per component instance by construction — so what is pinned is that the
  // rule is REAL: two hooks over one driver really do build two stores, which
  // is why the documentation says to lift it.
  const { app, options } = toy();
  const seen: Driving[] = [];
  const Probe = probe(seen);
  const Twice: Component<Record<string, never>> = () =>
    React.createElement(
      React.Fragment,
      null,
      el(Probe, { driver: app.driver, options }),
      el(Probe, { driver: app.driver, options }),
    );
  const ui = mount();
  await ui.render(el(Twice, {}));

  const stores = new Set<PanelStore>(seen.map((d) => d.store));
  assert.equal(stores.size, 2, "one store per hook, as documented — lift it, do not call it twice");

  await ui.unmount();
  app.driver.unmount();
});
