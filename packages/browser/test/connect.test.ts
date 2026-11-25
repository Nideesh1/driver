/**
 * These tests are the specification for the page side of PROTOCOL.md.
 *
 * Each one pins a decision that was argued for, so a future change that looks
 * harmless has to break a named test and read why the rule exists before
 * deleting it.
 *
 * The transports are injected (see `fake.ts`), which is what lets the reconnect
 * and the debounce be asserted at all. The companion end-to-end file runs the
 * same `connect()` against a real relay over real HTTP, so neither file can
 * pass on a fiction the other would catch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../../core/src/index.ts";
import { connect } from "../src/index.ts";
import type { Driver, Snapshot } from "../src/frames.ts";
import { eventSources, openAsTheyCome, posts, storage, waitFor } from "./fake.ts";

/** A toy app: two descents, a lane each, a rev that moves when they do. */
function app() {
  const lanes = new Map([["01a2", "pruning"], ["01b7", "doing"]]);
  let rev = 1;
  const visible = (): Snapshot => ({
    where: "descents",
    rev,
    rows: [...lanes].map(([id, lane]) => ({ id, lane })),
  });
  const driver = mount({
    app: "toy",
    visible,
    verbs: [
      {
        name: "set-lane",
        describe: "move a descent to a lane",
        args: {
          id: { type: "string", describe: "descent id" },
          lane: { type: "string", describe: "target lane", oneOf: ["doing", "pruning", "held"] },
        },
        run: ({ id, lane }: { id: string; lane: string }, ctx) => {
          if (!lanes.has(id)) return ctx.refuse("no-such-descent", `no descent \`${id}\``);
          lanes.set(id, lane);
          rev++;
        },
      },
    ],
  });
  return { driver, bump: () => ++rev, rev: () => rev };
}

/** `connect`, wired to fakes. Returns the fakes so a test can drive the relay. */
function wire(driver: Driver, options: Record<string, unknown> = {}) {
  const es = eventSources();
  const http = posts(
    options.failPosts
      ? { fail: true }
      : options.status
        ? { status: options.status as (post: any, attempt: number) => number | undefined }
        : {},
  );
  const store = storage();
  const errors: unknown[] = [];
  const conn = connect(driver, {
    relay: "http://127.0.0.1:9999",
    app: "toy",
    title: "Descents — toy",
    url: "/app/descents",
    EventSource: es.ctor,
    fetch: http.fetch,
    storage: store,
    onError: (err) => errors.push(err),
    ...options,
  } as any);
  return { conn, es, http, store, errors };
}

test("a tab id is minted once and remembered, so a reload resumes the same identity", () => {
  const store = storage();
  const es = eventSources();
  const http = posts();
  const common = { relay: "", EventSource: es.ctor, fetch: http.fetch, storage: store, app: "toy" };

  const first = connect(app().driver, common as any);
  const again = connect(app().driver, common as any);

  // PROTOCOL.md: the id is minted by the tab, not the relay, so a reconnect
  // resumes the same identity. An agent mid-task is holding this string; if a
  // reload produced a new one, every call it had planned would come back
  // `no-such-tab` and it would conclude the human closed the window.
  assert.equal(again.tab, first.tab);
  assert.equal(store.map.get("driverkit:tab:toy"), first.tab);

  // sessionStorage, not localStorage: the id names ONE open tab. A shared
  // store would have two windows claiming one identity, and the second
  // `hello` would quietly steal the first one's stream.
  const other = connect(app().driver, { ...common, storage: null } as any);
  assert.notEqual(other.tab, first.tab, "an unremembered tab reused a remembered id");
  first.disconnect();
  again.disconnect();
  other.disconnect();
});

test("an explicit tab id wins over the remembered one", () => {
  const { conn, store } = wire(app().driver, { tab: "given-by-the-host" });
  assert.equal(conn.tab, "given-by-the-host");
  // Not written back. The host that passed it owns it, and persisting it here
  // would make a one-off override sticky for the rest of the session.
  assert.equal(store.map.size, 0);
  conn.disconnect();
});

test("hello goes out on open, carrying both halves at once", async () => {
  const { conn, es, http } = wire(app().driver);
  // The stream exists before anything is sent: nothing can call INTO a tab, so
  // the tab dials out first and only then says who it is.
  assert.equal(es.made.length, 1);
  assert.match(es.last().url, /\/dk\/events\?tab=/);
  assert.equal(http.sent.length, 0, "hello was sent before the stream was open");

  es.last().open();
  await waitFor(() => http.of("hello").length === 1);
  const hello = http.of("hello")[0]!.body;

  assert.equal(hello.tab, conn.tab);
  assert.equal(hello.app, "toy");
  // Both halves ride along so the relay can answer /manifest and /snapshot
  // immediately. An agent that had to wait for a first call to learn the verbs
  // could not plan one.
  assert.equal(hello.manifest.app, "toy");
  assert.ok(hello.manifest.verbs.length > 0);
  assert.equal(hello.snapshot.rev, 1);
  // Only so a human can tell two tabs apart when asked "which one?".
  assert.equal(hello.title, "Descents — toy");
  assert.equal(hello.url, "/app/descents");
  conn.disconnect();
});

test("hello is re-sent on every open, because the relay forgot the tab when the stream dropped", async () => {
  const { conn, es, http } = wire(app().driver, { backoffMs: 5 });
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);

  es.last().drop();
  await waitFor(() => es.made.length === 2);
  es.last().open();

  // This is the whole reconnect contract. `EventSource` reconnects by itself,
  // so the stream comes back without driverkit doing anything -- but the relay
  // dropped the registry entry when the old stream closed, so a `hello` sent
  // only once would leave a tab that is connected and unidentifiable, and
  // every call to it would answer `no-such-tab` forever.
  await waitFor(() => http.of("hello").length === 2);
  assert.equal(http.of("hello")[1]!.body.tab, conn.tab, "the reconnect changed identity");
  conn.disconnect();
});

test("only a stream the browser has given up on is restarted", async () => {
  const { conn, es } = wire(app().driver, { backoffMs: 10, maxBackoffMs: 40 });
  es.last().open();

  // `error` fires on every blip, including the ones `EventSource` is about to
  // retry itself. Restarting on those would leave two streams open for one tab
  // id, and the relay treats a second stream as a reconnect -- so the page
  // would race itself and keep hanging up on its own live stream.
  es.last().blip();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(es.made.length, 1, "a blip the browser was handling was restarted anyway");

  es.last().drop();
  await waitFor(() => es.made.length === 2);

  // And the delay grows. A relay that is down comes back when it comes back;
  // a page retrying every 10ms until then is a page melting a laptop fan.
  const started = Date.now();
  es.last().drop();
  await waitFor(() => es.made.length === 3);
  assert.ok(Date.now() - started >= 15, "the backoff did not grow after a second failure");
  conn.disconnect();
});

test("a call is run by the driver and the result is POSTed back under the same id", async () => {
  const { conn, es, http } = wire(app().driver);
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);

  es.last().deliver({ t: "call", id: "c-17", name: "set-lane", args: { id: "01a2", lane: "held" } });
  await waitFor(() => http.of("result").length === 1);

  const frame = http.of("result")[0]!;
  // The id is echoed because it is the only correlation there is: the answer
  // travels back on a different HTTP request than the one that asked.
  assert.equal(frame.body.id, "c-17");
  assert.equal(frame.body.result.ok, true);
  // And the snapshot AFTER the call rides along, so acting and observing are
  // one round trip rather than two.
  assert.equal(frame.body.result.snapshot.rev, 2);
  assert.deepEqual(frame.body.result.snapshot.rows[0], { id: "01a2", lane: "held" });

  // The tab id travels in the query string as well as the body. PROTOCOL.md
  // names the tab only inside `hello`, so a relay that reads one and not the
  // other still works -- belt and braces on the field every correlation
  // depends on.
  assert.match(frame.url, new RegExp(`\\?tab=${conn.tab}$`));
  assert.equal(frame.body.tab, conn.tab);
  conn.disconnect();
});

test("a refusal is POSTed back like any other answer, not swallowed", async () => {
  const { conn, es, http } = wire(app().driver);
  es.last().open();
  es.last().deliver({ t: "call", id: "c-1", name: "set-lane", args: { id: "nope", lane: "held" } });
  await waitFor(() => http.of("result").length === 1);

  const result = http.of("result")[0]!.body.result;
  // The page does not decide anything -- it did not check that the descent
  // exists, the driver did. A second place that validates is a second set of
  // rules, and the in-page chatbot calling `driver.call()` would get the other.
  assert.equal(result.ok, false);
  assert.equal(result.refused, "no-such-descent");
  conn.disconnect();
});

test("rev is handed to the driver only when the agent claimed one", async () => {
  const toy = app();
  const { conn, es, http } = wire(toy.driver);
  es.last().open();

  // A stale claim must be refused by the driver, through the page, untouched.
  toy.bump(); // a person clicked something; the screen moved to rev 2
  es.last().deliver({ t: "call", id: "c-1", name: "set-lane", args: { id: "01a2", lane: "held" }, rev: 1 });
  await waitFor(() => http.of("result").length === 1);
  const stale = http.of("result")[0]!.body.result;
  assert.equal(stale.refused, "stale");
  assert.match(stale.hint, /read again/);

  // And a frame with no rev opts out of the check, as the core documents. The
  // page must not substitute the rev it can see: that would silently turn
  // "whatever is there now" into "what I last rendered", which is a different
  // question with a different right answer.
  es.last().deliver({ t: "call", id: "c-2", name: "set-lane", args: { id: "01a2", lane: "held" } });
  await waitFor(() => http.of("result").length === 2);
  assert.equal(http.of("result")[1]!.body.result.ok, true);
  conn.disconnect();
});

test("snapshot pushes are debounced into one, and carry the state as of the flush", async () => {
  const toy = app();
  const { conn, es, http } = wire(toy.driver, { debounceMs: 20 });
  const stopOpening = openAsTheyCome(es.made);
  await waitFor(() => http.of("hello").length === 1);

  toy.bump();
  conn.changed();
  toy.bump();
  conn.changed();
  toy.bump();
  conn.changed();

  await waitFor(() => http.of("snapshot").length === 1);
  await new Promise((r) => setTimeout(r, 60));

  // One push, not three. PROTOCOL.md: "sent on a debounce, not on every
  // keystroke". The frame is a courtesy to an agent that is mid-task -- it says
  // the human moved, re-read -- and that is worth one message, not one per
  // character typed into a filter box.
  assert.equal(http.of("snapshot").length, 1);
  // Read at flush time, so what goes out is the final state. Capturing the
  // snapshot when `changed()` was first called would push the state the human
  // has already moved on from, which is worse than not pushing at all: the
  // agent would act on a rev that was stale before it arrived.
  assert.equal(http.of("snapshot")[0]!.body.snapshot.rev, 4);

  // The debounce re-arms rather than latching: the next change still pushes.
  toy.bump();
  conn.changed();
  await waitFor(() => http.of("snapshot").length === 2);
  assert.equal(http.of("snapshot")[1]!.body.snapshot.rev, 5);
  conn.disconnect();
});

test("watch polls rev for an app that cannot call changed(), and never faster than 500ms", async () => {
  const toy = app();
  // Asked for 10ms and floored at 500. `visible()` runs on every tick and the
  // core only promises it is cheap, not free; a 10ms poll would make an opt-in
  // convenience the most expensive thing in the page.
  const { conn, es, http } = wire(toy.driver, { watchMs: 10, debounceMs: 5 });
  const stopOpening = openAsTheyCome(es.made);
  await waitFor(() => http.of("hello").length === 1);

  toy.bump();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(http.of("snapshot").length, 0, "the floor on the poll interval was not applied");

  await waitFor(() => http.of("snapshot").length === 1, 3_000);
  assert.equal(http.of("snapshot")[0]!.body.snapshot.rev, 2);

  // And a rev that has not moved pushes nothing: polling is how this app
  // learns the page changed, not a heartbeat.
  const sent = http.sent.length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(http.sent.length, sent, "the poll pushed a snapshot nothing had changed");
  conn.disconnect();
});

test("a frame the page cannot read is dropped rather than taking the stream down", async () => {
  const { conn, es, http, errors } = wire(app().driver);
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);

  es.last().deliver("{not json");
  es.last().deliver({ t: "something-from-a-newer-relay", id: "c-1" });

  // Dropped, surfaced on onError, stream untouched. PROTOCOL.md allows fields
  // and frames to be added without a version bump, so a page that threw on an
  // unknown one would turn a forward-compatible addition into an outage for
  // every tab running last week's bundle.
  assert.equal(errors.length, 2);
  es.last().deliver({ t: "call", id: "c-2", name: "set-lane", args: { id: "01a2", lane: "held" } });
  await waitFor(() => http.of("result").length === 1);
  assert.equal(http.of("result")[0]!.body.id, "c-2");
  conn.disconnect();
});

test("a driver that throws still answers, because an agent is holding a request open", async () => {
  const broken: Driver = {
    manifest: () => ({ version: "x", app: "broken", verbs: [] }),
    snapshot: () => ({ where: "nowhere", rev: 3 }),
    call: () => Promise.reject(new Error("kaboom")),
    unmount: () => {},
  };
  const { conn, es, http, errors } = wire(broken);
  es.last().open();
  es.last().deliver({ t: "call", id: "c-1", name: "anything" });
  await waitFor(() => http.of("result").length === 1);

  // `mount()` never throws, so this is only reachable for a hand-written
  // driver -- and it is still answered rather than dropped. Silence would cost
  // the agent the relay's full timeout to learn what is already known.
  const result = http.of("result")[0]!.body.result;
  assert.equal(result.refused, "threw");
  assert.match(result.hint, /kaboom/);
  assert.equal(result.snapshot.rev, 3);
  assert.equal(errors.length, 1, "the bug was hidden from the app as well as answered");
  conn.disconnect();
});

test("a failed POST is reported, not thrown into an unhandled rejection", async () => {
  const { conn, es, errors } = wire(app().driver, { failPosts: true });
  es.last().open();
  await waitFor(() => errors.length >= 1);
  // The network dropping mid-session is normal. An unhandled rejection here
  // would be an error in the app's console that the app did not cause and
  // cannot act on; onError is where it belongs.
  assert.match(String((errors[0] as Error).message), /offline/);
  conn.disconnect();
});

test("disconnect() stops the stream, the debounce and the poll, and is idempotent", async () => {
  const toy = app();
  const { conn, es, http } = wire(toy.driver, { debounceMs: 10, watchMs: 500, backoffMs: 5 });
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);

  conn.changed();
  conn.disconnect();
  conn.disconnect(); // idempotent: a teardown that throws twice gets wrapped everywhere

  assert.equal(es.last().closed, true);
  toy.bump();
  await new Promise((r) => setTimeout(r, 120));
  // Nothing in flight outlives the call. A pending debounce that fired after
  // disconnect would re-register a tab the app has deliberately detached, and
  // the next `drop` would restart a stream nobody asked for.
  assert.equal(http.of("snapshot").length, 0);

  es.last().drop();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(es.made.length, 1, "a disconnected page reconnected itself");
});

test("a missing transport fails at connect, not at the first call", () => {
  // The browser globals are absent in Node, which is exactly the situation a
  // bundler-misconfigured page is in. Failing now names the problem; failing
  // later names a frame that never arrived.
  assert.throws(() => connect(app().driver, { relay: "", storage: null } as any), /EventSource/);

  // Node has a global `fetch`, so it has to be taken away to reach the other
  // branch. Worth doing: an insecure origin or an old WebView has neither
  // global, and "no fetch" is a far better message than a TypeError inside the
  // first POST, where the app author is looking at a frame, not at wiring.
  const real = globalThis.fetch;
  try {
    (globalThis as { fetch?: unknown }).fetch = undefined;
    assert.throws(
      () => connect(app().driver, { relay: "", storage: null, EventSource: eventSources().ctor } as any),
      /fetch/,
    );
  } finally {
    globalThis.fetch = real;
  }
});

test("a result the relay 409s is re-sent after a reconnect, not dropped on the floor", async () => {
  // PROTOCOL.md: "a tab that gets 409 may reasonably reconnect and retry", and
  // this is the one window where that matters. The relay dropped this tab
  // between sending the `call` and the `result` coming back -- the stream
  // blinked -- so the agent is holding a request open on `c-17` for an answer
  // that exists and has nowhere to go. `fetch` resolves on 409, so a page that
  // does not read the status loses it silently and the agent waits out the
  // relay's full 15-second deadline for it.
  const toy = app();
  const { conn, es, http, errors } = wire(toy.driver, {
    backoffMs: 5,
    // 409 the first time this result is sent, 202 the second. Every other
    // frame -- the hellos either side of the reconnect -- is accepted.
    status: (post: any, attempt: number) => (post.body?.t === "result" && attempt === 1 ? 409 : 202),
  });
  // The browser's own job, played by the fake: a reconnect is only a reconnect
  // if the new stream comes up, and the retry is waiting inside `connect` for
  // exactly that event, so there is no moment in the test to do it by hand.
  const stopOpening = openAsTheyCome(es.made);
  await waitFor(() => http.of("hello").length === 1);

  es.last().deliver({ t: "call", id: "c-17", name: "set-lane", args: { id: "01a2", lane: "held" } });
  // Two POSTs of the same result: the 409'd one and the accepted one.
  await waitFor(() => http.of("result").length === 2);

  // A second stream, because reconnecting IS the fix. The 409 says the relay
  // has no stream for this tab, so re-POSTing down the same dead pipe could
  // only be refused again.
  assert.equal(es.made.length, 2, "the 409 did not bring up a new stream");
  await waitFor(() => http.of("hello").length === 2);

  const frames = http.sent.map((p) => p.body.t);
  // The ordering that matters, and the reason the outbox is a queue: the second
  // `hello` must come BEFORE the re-sent result. A retry that races ahead of
  // the `hello` arrives at a registry that still has no tab and 409s again, so
  // the bounded retry budget is spent on a reconnect that had not happened yet.
  assert.deepEqual(frames, ["hello", "result", "hello", "result"]);
  assert.equal(http.of("result")[0]!.body.id, "c-17");
  assert.equal(http.of("result")[1]!.body.id, "c-17");
  // Same answer both times, not re-derived. The driver ran once; running
  // `set-lane` again on the retry would move the lane twice for one call.
  assert.equal(http.of("result")[1]!.body.result.snapshot.rev, toy.rev());
  assert.deepEqual(errors, [], "a 409 that recovered is not an error the app should see");
  stopOpening();
  conn.disconnect();
});

test("a 409 is retried a bounded number of times and then reported, not forever", async () => {
  // The failure this guards is symmetrical with the dropped result. A relay
  // that is simply gone would otherwise have the tab reconnect-and-retry in a
  // loop that never ends and never answers anything -- worse than the lost
  // result, because it also costs every later frame behind it.
  const { conn, es, http, errors } = wire(app().driver, {
    backoffMs: 5,
    status: (post: any) => (post.body?.t === "result" ? 409 : 202),
  });
  const stopOpening = openAsTheyCome(es.made);
  await waitFor(() => http.of("hello").length === 1);

  es.last().deliver({ t: "call", id: "c-17", name: "set-lane", args: { id: "01a2", lane: "held" } });
  await waitFor(() => errors.length >= 1, 4_000);

  // Three attempts: the first, plus RESULT_RETRIES more. Pinned as a number
  // because "bounded" with no bound in a test is a bound nobody would notice
  // the removal of.
  assert.equal(http.of("result").length, 3);
  // Loud at the end. A result this tab could not deliver is one the agent will
  // see as a `timeout`, and the app is the only party that can log why.
  assert.match(String((errors[0] as Error).message), /409s result `c-17` after 2 reconnects/);
  stopOpening();
  conn.disconnect();
});

test("a 400 reaches onError and is never retried, because the bug is in this tab", async () => {
  // PROTOCOL.md's split, and the reason the two statuses cannot share a path:
  // "400 means the frame could never have been accepted by anyone; 409 means
  // the frame was fine and the relay's state is what made it unacceptable." So
  // a 400 is this page's bug. Re-sending it is a loop with no exit, and
  // swallowing it means the bug is invisible in the only console that could
  // show it.
  const { conn, es, http, errors } = wire(app().driver, {
    backoffMs: 5,
    status: (post: any) => (post.body?.t === "result" ? 400 : 202),
  });
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);

  es.last().deliver({ t: "call", id: "c-17", name: "set-lane", args: { id: "01a2", lane: "held" } });
  await waitFor(() => errors.length >= 1);

  assert.equal(http.of("result").length, 1, "a 400 must not be retried");
  assert.match(String((errors[0] as Error).message), /relay answered 400 to a `result` frame/);
  // And no reconnect: the stream was never the problem, so taking it down
  // would turn a frame-shaped bug into an outage.
  assert.equal(es.made.length, 1);
  conn.disconnect();
});

test("results stay in order across a retry, so an agent never reads a later answer first", async () => {
  // The ordering hazard that arrives WITH the retry. Two calls in flight, the
  // first one 409s and has to go round again; without a single-file outbox its
  // retry races the second answer and `c-18` can land before `c-17`. An agent
  // that reads them in that order acts on a screen that has already moved,
  // which is the exact failure `rev` exists to prevent and would be caused
  // here by the fix for a different bug.
  const toy = app();
  const { conn, es, http } = wire(toy.driver, {
    backoffMs: 5,
    status: (post: any, attempt: number) =>
      post.body?.t === "result" && post.body.id === "c-17" && attempt === 1 ? 409 : 202,
  });
  const stopOpening = openAsTheyCome(es.made);
  await waitFor(() => http.of("hello").length === 1);

  es.last().deliver({ t: "call", id: "c-17", name: "set-lane", args: { id: "01a2", lane: "held" } });
  es.last().deliver({ t: "call", id: "c-18", name: "set-lane", args: { id: "01b7", lane: "held" } });

  await waitFor(() => http.of("result").filter((p) => p.body.id === "c-18").length === 1, 4_000);
  const ids = http.of("result").map((p) => p.body.id);
  // `c-17` twice and `c-18` once, and `c-18` last. Not "c-17, c-18, c-17".
  assert.deepEqual(ids, ["c-17", "c-17", "c-18"]);
  stopOpening();
  conn.disconnect();
});

test("a stale snapshot that 409s is not re-sent, because the reconnect carries a newer one", async () => {
  // The asymmetry worth stating: a `result` is irreplaceable and a `snapshot`
  // is not. Reconnecting sends a `hello` whose snapshot is read at that moment,
  // so re-sending the one that 409'd would push an OLDER rev after a newer one
  // -- and PROTOCOL.md's `/watch` dedup is on `rev`, so a watcher told the
  // screen went backwards has no way to recover. The reconnect still happens:
  // the 409 means the relay has dropped this tab either way.
  const toy = app();
  const { conn, es, http, errors } = wire(toy.driver, {
    debounceMs: 5,
    backoffMs: 5,
    status: (post: any) => (post.body?.t === "snapshot" ? 409 : 202),
  });
  const stopOpening = openAsTheyCome(es.made);
  await waitFor(() => http.of("hello").length === 1);

  toy.bump();
  conn.changed();
  await waitFor(() => es.made.length === 2, 4_000);
  await waitFor(() => http.of("hello").length === 2);

  assert.equal(http.of("snapshot").length, 1, "a 409'd snapshot must not be re-sent");
  // Quiet, too: nothing was lost, so nothing for the app to act on.
  assert.deepEqual(errors, []);
  stopOpening();
  conn.disconnect();
});

// --- credentials -----------------------------------------------------------
//
// A relay serving more than one person needs to know which person this tab
// belongs to. These pin the page's half of that: where the credential goes, and
// what happens when it lapses while the tab is still open and still being
// driven. The relay's half is `packages/relay/test/auth.test.ts`.

test("no credential is sent when none was configured, so a dev relay still works", () => {
  // The unconfigured loopback relay one developer runs needs nothing, and a
  // library that made that case configure keys first is one people route
  // around. `connect` does not invent a credential it was not given.
  const { conn, es, store } = wire(app().driver);
  assert.ok(!es.last().url.includes("dk_token"));
  assert.ok(!/anon/.test([...store.map.keys()].join(",")));
  conn.disconnect();
});

test("a token rides on the stream URL and in a header on the POSTs", async () => {
  const { conn, es, http } = wire(app().driver, { token: "dkt1.aaa.bbb" });
  // `EventSource` cannot set a header, so the stream URL is the only place a
  // cross-origin page can put it -- and that is why the option exists to turn
  // it off in favour of a cookie.
  assert.match(es.last().url, /&dk_token=dkt1\.aaa\.bbb$/);

  es.last().open();
  await waitFor(() => http.of("hello").length === 1);
  const hello = http.of("hello")[0]!;
  // `fetch` CAN set a header, so there is no reason for a token to be written
  // into an access log here. The query string stays exactly `?tab=`.
  assert.equal(hello.headers["x-dk-token"], "dkt1.aaa.bbb");
  assert.ok(!hello.url.includes("dk_token"));
  assert.match(hello.url, new RegExp(`\\?tab=${conn.tab}$`));
  conn.disconnect();
});

test("tokenIn cookie keeps the token out of every URL", async () => {
  // The best option a same-origin page has: the app sets `__Host-dk_token` and
  // the browser attaches it to the stream request by itself, so no token
  // appears in a URL and therefore in no proxy's access log.
  const { conn, es, http } = wire(app().driver, { token: "dkt1.aaa.bbb", tokenIn: "cookie" });
  assert.ok(!es.last().url.includes("dk_token"));
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);
  // The POSTs still carry it: `fetch` is not an `EventSource` and does not get
  // the cookie for free on a cross-origin relay.
  assert.equal(http.of("hello")[0]!.headers["x-dk-token"], "dkt1.aaa.bbb");
  conn.disconnect();
});

test("a token getter is called again before every hello, which is every reconnect", async () => {
  // The mid-session expiry answer, first half. A token expires -- deliberately,
  // because a short life is what substitutes for the revocation a stateless
  // token cannot have -- so a string captured at page load is the one shape
  // that cannot survive a session. The getter is the shape that can.
  let minted = 0;
  const { conn, es, http } = wire(app().driver, {
    backoffMs: 5,
    token: () => `dkt1.t${++minted}.sig`,
  });

  await waitFor(() => es.made.length === 1);
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);
  assert.equal(http.of("hello")[0]!.headers["x-dk-token"], "dkt1.t1.sig");

  es.last().drop();
  await waitFor(() => es.made.length === 2);
  es.last().open();
  await waitFor(() => http.of("hello").length === 2);
  // A fresh credential, not the one the page loaded with.
  await waitFor(() => minted >= 2);
  conn.disconnect();
});

test("a 401 on a result refreshes the credential and re-sends the same bytes", async () => {
  // The mid-session expiry answer, second half, and the case people get wrong.
  //
  // The relay authenticates the stream once, at open, and the binding it made
  // lasts as long as the stream -- so a lapsed token does not disconnect this
  // tab and does not lose the calls in flight. But `/dk/result` is a new
  // request and carries its own credential, so the symptom of expiry is exactly
  // this: a tab that still receives `call` frames and cannot answer them. A
  // result dropped here costs the agent the relay's whole 15-second deadline
  // waiting for an answer that already exists.
  let minted = 0;
  const { conn, es, http, errors } = wire(app().driver, {
    token: () => `dkt1.t${++minted}.sig`,
    // 401 the first time this result arrives, 202 the second -- the shape the
    // relay produces when the credential lapsed between the stream opening and
    // this POST.
    status: (post: any, attempt: number) =>
      post.body?.t === "result" && attempt === 1 ? 401 : 202,
  });
  const stop = openAsTheyCome(es.made);

  await waitFor(() => http.of("hello").length === 1);
  es.last().deliver({ t: "call", id: "c-17", name: "set-lane", args: { id: "01a2", lane: "held" } });

  // Two POSTs of the same result: the first with the dead token, the second
  // with a fresh one. The frame is identical, because the frame was never the
  // problem.
  await waitFor(() => http.of("result").length === 2);
  const [first, second] = http.of("result");
  // A fresh credential on the retry, and the SAME frame: the frame was never
  // the problem, so re-sending it unchanged is the whole of the fix.
  assert.notEqual(second!.headers["x-dk-token"], first!.headers["x-dk-token"]);
  assert.deepEqual(first!.body, second!.body);
  assert.equal(second!.body.id, "c-17");
  stop();
  conn.disconnect();
  void errors;
});

test("a 401 that a refresh cannot fix is bounded and loud", async () => {
  // A token endpoint answering with a credential the relay will not accept --
  // a wrong audience, a key the relay does not have -- is a misconfiguration,
  // and retrying it forever is a page that never answers anything while making
  // a request per attempt. So it stops and says so, with the one thing a
  // developer needs to check.
  const { conn, es, http, errors } = wire(app().driver, {
    token: () => "dkt1.always-wrong.sig",
    status: (post: any) => (post.body?.t === "result" ? 401 : 202),
  });
  const stop = openAsTheyCome(es.made);
  await waitFor(() => http.of("hello").length === 1);
  es.last().deliver({ t: "call", id: "c-1", name: "set-lane", args: { id: "01a2", lane: "held" } });

  await waitFor(() => errors.length > 0, 3_000);
  assert.match(String(errors[0]), /credential/);
  assert.match(String(errors[0]), /audience/);
  // Bounded: the original plus one refreshed retry, and no more.
  assert.equal(http.of("result").length, 2);
  stop();
  conn.disconnect();
});

test("a 401 with no token option says so rather than retrying nothing", async () => {
  // Refreshing a credential the page was never given is a loop with no exit.
  // The message names the missing option, because that is the fix.
  const { conn, es, http, errors } = wire(app().driver, {
    status: (post: any) => (post.body?.t === "result" ? 401 : 202),
  });
  es.last().open();
  await waitFor(() => http.of("hello").length === 1);
  es.last().deliver({ t: "call", id: "c-1", name: "set-lane", args: { id: "01a2", lane: "held" } });

  await waitFor(() => errors.length > 0, 3_000);
  assert.match(String(errors[0]), /no `token` option/);
  assert.equal(http.of("result").length, 1, "a result was retried with nothing new to present");
  conn.disconnect();
});

test("anonymous mints one secret per tab and remembers it across reconnects", async () => {
  // Two anonymous visitors must be two principals -- "anonymous" is not one
  // bucket -- and that is what the per-tab secret buys. Remembered, because a
  // reconnect that minted a new one would be a new visitor every time the
  // network blinked, and the tabs the agent was holding would vanish.
  const { conn, es, http, store } = wire(app().driver, { anonymous: true, backoffMs: 5 });
  const credential = store.map.get("driverkit:anon:toy");
  assert.match(String(credential), /^anon1\.[A-Za-z0-9_-]{43}$/);
  assert.ok(es.last().url.includes(`dk_token=${encodeURIComponent(String(credential))}`));

  es.last().open();
  await waitFor(() => http.of("hello").length === 1);
  es.last().drop();
  await waitFor(() => es.made.length === 2);
  assert.ok(es.last().url.includes(`dk_token=${encodeURIComponent(String(credential))}`));
  conn.disconnect();
});

test("two anonymous pages in two stores are two different principals", () => {
  // The isolation requirement at the page level: nothing is shared between two
  // visitors, so the relay derives two principals and keeps their tabs apart.
  const one = wire(app().driver, { anonymous: true });
  const two = wire(app().driver, { anonymous: true });
  assert.notEqual(
    one.store.map.get("driverkit:anon:toy"),
    two.store.map.get("driverkit:anon:toy"),
  );
  one.conn.disconnect();
  two.conn.disconnect();
});

test("anonymous is off by default, so a page that forgot its token gets a 401 not a stranger", () => {
  // The interesting default. On, a page whose author forgot to wire `token`
  // would quietly work: every user would become their own anonymous stranger,
  // everything would look fine, and their agent -- which has a real token --
  // would see zero tabs. Off, that author gets a 401 and an answer.
  const { conn, es, store } = wire(app().driver);
  assert.equal(store.map.get("driverkit:anon:toy"), undefined);
  assert.ok(!es.last().url.includes("dk_token"));
  conn.disconnect();
});
