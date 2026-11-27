/**
 * Which tab is the person actually looking at.
 *
 * THE GAP. `driverkit-mcp --tab <id>` works, and "omit it when exactly one tab
 * is connected" stops working at two — and nothing in the protocol expressed
 * *"the one I am looking at"*, which is what a person means. The only process
 * that can answer is the document: `document.hasFocus()` is invisible to a
 * relay, to a server, and to the other tab. So the page reports, the relay
 * carries the string and has no opinion, and the client decides.
 *
 * Every browser global is injected, which is a design requirement in this
 * package rather than a testing convenience — and this feature is the case that
 * proves it. The thing being verified happens when a person alt-tabs, and
 * "alt-tab and see whether the right frame went out" is not a check anybody
 * runs twice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../src/core/index.ts";
import { connect, focusOf, urlFromPage } from "../src/browser/connect.ts";
import type { FocusEventsLike, PageLike } from "../src/browser/connect.ts";
import type { Snapshot } from "../src/core/index.ts";
import { eventSources, posts, storage, waitFor } from "./fake.ts";

/** A page, with the two things a document can be asked and the three events
 *  that move the answer. */
function fakePage(initial: { visibilityState?: string; focused?: boolean; title?: string }) {
  const listeners = new Map<string, Array<() => void>>();
  const page = {
    visibilityState: initial.visibilityState,
    title: initial.title,
    focused: initial.focused,
    hasFocus(): boolean {
      return page.focused === true;
    },
    addEventListener(type: string, listener: () => void): void {
      const at = listeners.get(type) ?? [];
      at.push(listener);
      listeners.set(type, at);
    },
    removeEventListener(type: string, listener: () => void): void {
      const at = listeners.get(type) ?? [];
      const i = at.indexOf(listener);
      if (i >= 0) at.splice(i, 1);
    },
    fire(type: string): void {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    count(type: string): number {
      return (listeners.get(type) ?? []).length;
    },
  };
  return page;
}

/**
 * The fake, as a `PageLike`.
 *
 * One cast rather than a `PageLike` whose fields admit an explicit
 * `undefined`. `exactOptionalPropertyTypes` is on, so a stub that sets
 * `title: undefined` is not assignable to `{ title?: string }` -- and widening
 * the library's own type to let it be would be loosening a production type to
 * suit a fixture, which is the wrong direction.
 */
const asPage = (page: ReturnType<typeof fakePage>): PageLike => page as unknown as PageLike;

function tinyApp() {
  let rev = 1;
  const visible = (): Snapshot => ({ where: "contacts", rev, rows: [{ id: "c-1" }] });
  const driver = mount({
    app: "toy",
    visible,
    verbs: [{ name: "look", kind: "read", describe: "read the screen", run: () => {} }],
  });
  return { driver, bump: () => ++rev };
}

test("`focused` is the active tab of the frontmost window and nothing else is", () => {
  // The three states, and the table in `focusOf`'s own comment is the
  // specification. The one that earns the third state is the middle row: the
  // active tab of a window the person is not in front of. A boolean field
  // would have had to call it either focused — and send an agent to a window
  // nobody is watching — or hidden, which loses the only honest answer to
  // "which one was I last in?".
  assert.equal(focusOf(asPage(fakePage({ visibilityState: "visible", focused: true }))), "focused");
  assert.equal(focusOf(asPage(fakePage({ visibilityState: "visible", focused: false }))), "visible");
  assert.equal(focusOf(asPage(fakePage({ visibilityState: "hidden", focused: false }))), "hidden");
  // Hidden wins over `hasFocus`, which a detached document can still answer
  // truthfully-but-uselessly.
  assert.equal(focusOf(asPage(fakePage({ visibilityState: "hidden", focused: true }))), "hidden");
});

test("a state the spec has not invented yet reads as hidden, never as focused", () => {
  // `visibilityState` has had other values ("prerender", "unloaded"). None of
  // them is a tab a person is looking at, and a new one must not be read as the
  // answer to "which tab do I drive".
  assert.equal(focusOf(asPage(fakePage({ visibilityState: "prerender", focused: true }))), "hidden");
});

test("no document and no `hasFocus` report nothing at all, which is not the same as hidden", () => {
  // `TabFocus`: absent is UNKNOWN. A client that read silence as "not the one"
  // would quietly stop being able to drive a tab connected by a hand-written
  // loop, or by a driverkit older than this field.
  assert.equal(focusOf(undefined), undefined);
  assert.equal(focusOf({} as PageLike), undefined);
  // An engine with `visibilityState` and no `hasFocus`: `visible` is the
  // strongest honest answer and `focused` would be a guess.
  assert.equal(focusOf({ visibilityState: "visible" } as PageLike), "visible");
});

test("a `hasFocus` that throws is read as cannot-tell and never as focused", () => {
  // This runs on a timer in a page that may be mid-teardown, and a throwing
  // getter must not take the push with it — nor be read in the permissive
  // direction, which is how an agent ends up driving the wrong window.
  const page: PageLike = {
    visibilityState: "visible",
    hasFocus: () => {
      throw new Error("detached");
    },
  };
  assert.equal(focusOf(page), "visible");
});

test("the url carries the hash, because for a hash-routed app the hash is the route", () => {
  // It used to be dropped, so every tab of such an app reported the same `/` —
  // and `TabInfo.url` is the one field a person is shown to tell two tabs
  // apart. The concern that dropped it was real and about the wrong field: the
  // capability here is the token, and the token travels in a header or a query
  // parameter, never in `location`.
  assert.deepEqual(urlFromPage({ pathname: "/app/", search: "?q=1", hash: "#/contacts/8821" }), {
    url: "/app/?q=1#/contacts/8821",
  });
  // Still path-relative and never the origin, which is the part that was right:
  // a full url in a listing is an inventory of where somebody has been.
  assert.deepEqual(urlFromPage({ pathname: "/app/" }), { url: "/app/" });
  assert.deepEqual(urlFromPage(undefined), {});
});

/** `connect` against fakes, with a page and a window of our own. */
function wire(
  driver: ReturnType<typeof tinyApp>["driver"],
  page: ReturnType<typeof fakePage>,
  extra: Record<string, unknown> = {},
) {
  const es = eventSources();
  const http = posts();
  const conn = connect(driver, {
    relay: "http://127.0.0.1:9999",
    app: "toy",
    EventSource: es.ctor,
    fetch: http.fetch,
    storage: storage(),
    debounceMs: 1,
    document: page as PageLike,
    // The window and the document are separate objects on purpose: `focus` and
    // `blur` do not bubble to the document, and listening for all three in one
    // place is the mistake that makes the case this exists for — the person
    // clicking into this window from another application — go unnoticed.
    window: page as unknown as FocusEventsLike,
    location: { pathname: "/app/", hash: "#/contacts" },
    ...extra,
  } as never);
  return { conn, es, http };
}

test("`hello` reports the focus, so a tab opened and left alone is still answerable", () => {
  // `hello` is the only frame a tab that never moves ever sends. Without the
  // field here, such a tab would have no focus in `GET /dk/tabs` — which is the
  // listing a client reads before it has seen a single push.
  const { driver } = tinyApp();
  const page = fakePage({ visibilityState: "visible", focused: true, title: "Contacts" });
  const { es, http } = wire(driver, page);
  es.last().open();

  const hello = http.of("hello")[0]!;
  assert.equal(hello.body.focus, "focused");
  assert.equal(hello.body.title, "Contacts");
  assert.equal(hello.body.url, "/app/#/contacts");
});

test("a focus change pushes a snapshot frame carrying the new focus and the current url", async () => {
  // THE PROTOCOL GAINS A FIELD, NOT A FRAME. A tab with focus news has a
  // snapshot to send with it, the debounce coalesces the two, and a relay or a
  // client written before this reads the same `snapshot` frame it always read
  // and ignores one field. Carrying the url on it is the nearly-free half of a
  // separate fix: `TabInfo.url` came from `hello` alone, so it was stale from
  // the first client-side route change and had no way back.
  const { driver } = tinyApp();
  const page = fakePage({ visibilityState: "visible", focused: true });
  const { es, http } = wire(driver, page);
  es.last().open();
  assert.equal(http.of("snapshot").length, 0);

  page.focused = false;
  page.fire("blur");
  await waitFor(() => http.of("snapshot").length === 1);

  const push = http.of("snapshot")[0]!;
  assert.equal(push.body.focus, "visible");
  assert.equal(push.body.url, "/app/#/contacts");

  page.visibilityState = "hidden";
  page.fire("visibilitychange");
  await waitFor(() => http.of("snapshot").length === 2);
  assert.equal(http.of("snapshot")[1]!.body.focus, "hidden");
});

test("an event that does not move the focus pushes nothing", async () => {
  // `focus` fires on a window that was already focused and `visibilitychange`
  // fires on its way to a state it was already in, so a person alt-tabbing
  // would otherwise generate a push per keystroke — each of which the relay
  // force-forwards to every watcher, because a `snapshot` frame is the tab
  // SAYING the page moved and the relay does not second-guess that.
  const { driver } = tinyApp();
  const page = fakePage({ visibilityState: "visible", focused: true });
  const { es, http } = wire(driver, page);
  es.last().open();

  page.fire("focus");
  page.fire("visibilitychange");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(http.of("snapshot").length, 0);
});

test("a navigation with no focus change still corrects the url on the next push", async () => {
  // The stale-url half on its own. A single-page app navigates without
  // reconnecting, so `hello` may never come again; the push that was already
  // going out is what makes the listing true.
  const { driver, bump } = tinyApp();
  const page = fakePage({ visibilityState: "visible", focused: true });
  const place = { pathname: "/app/", hash: "#/contacts" };
  const { es, http, conn } = wire(driver, page, { location: place });
  es.last().open();

  place.hash = "#/companies/acme";
  bump();
  conn.changed();
  await waitFor(() => http.of("snapshot").length === 1);
  assert.equal(http.of("snapshot")[0]!.body.url, "/app/#/companies/acme");
});

test("`focus: false` sends no field and installs no listeners, byte for byte as before", async () => {
  // Opting out has to be total. A page that said no and still had three
  // listeners on it would be paying for a feature it declined.
  const { driver } = tinyApp();
  const page = fakePage({ visibilityState: "visible", focused: true });
  const { es, http } = wire(driver, page, { focus: false });
  es.last().open();

  assert.equal(http.of("hello")[0]!.body.focus, undefined);
  assert.equal(page.count("visibilitychange"), 0);
  assert.equal(page.count("focus"), 0);
  assert.equal(page.count("blur"), 0);
});

test("`disconnect` removes the three listeners, so a re-mounting app does not stack them", () => {
  // These live on `document` and on the window, both of which outlive the
  // connection. A client-side route change, or a React effect re-running, would
  // otherwise accumulate one set per connection and push through a closure
  // whose stream is gone.
  const { driver } = tinyApp();
  const page = fakePage({ visibilityState: "visible", focused: true });
  const { es, conn } = wire(driver, page);
  es.last().open();
  assert.equal(page.count("visibilitychange"), 1);
  assert.equal(page.count("focus"), 1);

  conn.disconnect();
  assert.equal(page.count("visibilitychange"), 0);
  assert.equal(page.count("focus"), 0);
  assert.equal(page.count("blur"), 0);
});

test("a page with no document reports no focus, which is why the Node suite sees no change", () => {
  // The byte-identical claim, checked rather than asserted in prose: with no
  // `document` and no `location`, `hello` is exactly the frame it was before
  // any of this existed.
  const { driver } = tinyApp();
  const es = eventSources();
  const http = posts();
  connect(driver, {
    relay: "http://127.0.0.1:9999",
    EventSource: es.ctor,
    fetch: http.fetch,
    storage: storage(),
    document: undefined,
    location: undefined,
  } as never);
  es.last().open();

  const hello = http.of("hello")[0]!;
  assert.equal(hello.body.focus, undefined);
  assert.equal(hello.body.url, undefined);
  assert.equal(hello.body.title, undefined);
});
