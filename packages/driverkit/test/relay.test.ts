/**
 * These tests are the specification for the relay half of PROTOCOL.md.
 *
 * Each one pins a decision that was argued for, so a future change that looks
 * harmless has to break a named test and read why the rule exists before
 * deleting it.
 *
 * They run against a real `node:http` server on an ephemeral port and speak
 * real chunked SSE. A relay whose correctness was asserted by calling its
 * internal functions would pass with a missing blank line between frames, and
 * that blank line is the entire framing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { TabAuth, createRelay } from "../src/relay/index.ts";
import { serve } from "../src/relay/serve.ts";
import { HttpEventSource, getJson, postJson } from "./sse-client.ts";
import type { RelayRefusal, Result, Snapshot } from "../src/relay/frames.ts";

const SNAP: Snapshot = { where: "descents", rev: 7, rows: [{ id: "01a2", lane: "pruning" }] };

/** A key long enough for `TabAuth`, for the tests here that need one. */
const SECRET = "0".repeat(32);

/** Start a relay nobody else will touch. Torn down by the caller's `t.after`. */
async function up(t: { after: (fn: () => unknown) => void }, options = {}) {
  const { server, relay, url } = await serve({ port: 0, pingMs: 20_000, ...options });
  t.after(() => {
    relay.close();
    server.close();
  });
  return { relay, url };
}

/**
 * A tab, played by hand: an SSE stream plus POSTs.
 *
 * Deliberately not `driverkit/browser`. These tests must fail when the relay
 * breaks, and a test that drives both sides of a contract with one codebase
 * passes happily when both ends agree on the wrong thing. The end-to-end file
 * does it the other way on purpose.
 */
async function tab(url: string, id: string) {
  const es = new HttpEventSource(`${url}/dk/events?tab=${encodeURIComponent(id)}`);
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  return {
    es,
    hello: (extra: Record<string, unknown> = {}) =>
      postJson(`${url}/dk/result?tab=${encodeURIComponent(id)}`, {
        t: "hello",
        tab: id,
        app: "toy",
        title: "Descents — toy",
        url: "/app/descents",
        manifest: { version: "abc123", app: "toy", verbs: [{ name: "goto", describe: "open one" }] },
        snapshot: SNAP,
        ...extra,
      }),
    answer: (callId: string, result: Result) =>
      postJson(`${url}/dk/result?tab=${encodeURIComponent(id)}`, { t: "result", id: callId, result }),
    push: (snapshot: Snapshot) =>
      postJson(`${url}/dk/result?tab=${encodeURIComponent(id)}`, { t: "snapshot", snapshot, tab: id }),
  };
}

const call = (url: string, id: string, body: unknown) =>
  postJson(`${url}/dk/tabs/${encodeURIComponent(id)}/call`, body);

test("a call blocks until the matching result arrives, and is answered with it", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();

  // Correlation is the `id` field and nothing else -- not arrival order, not a
  // socket. A tab is free to answer two calls out of order, and must be: the
  // verbs are async and the slow one does not block the fast one.
  const frame = one.es.next("call");
  const pending = call(url, "t1", { name: "goto", args: { id: "01a2" } });

  const got = (await frame) as { t: string; id: string; name: string; args: unknown };
  assert.equal(got.t, "call");
  assert.equal(got.name, "goto");
  assert.deepEqual(got.args, { id: "01a2" });
  assert.match(got.id, /^c-\d+$/);

  const answer: Result = { ok: true, note: "opened", snapshot: { where: "descent 01a2", rev: 8 } };
  assert.equal((await one.answer(got.id, answer)).status, 202);

  const res = await pending;
  // 200 with the Result as the body. The HTTP request did not merely start the
  // call, it IS the call: an agent gets one round trip, not a ticket to poll.
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, answer);
});

test("two tabs are kept distinct: a call reaches the one it was addressed to", async (t) => {
  const { url } = await up(t);
  const a = await tab(url, "tab-a");
  const b = await tab(url, "tab-b");
  await a.hello({ app: "A", title: "A" });
  await b.hello({ app: "B", title: "B" });

  let heardByB = 0;
  b.es.addEventListener("call", () => heardByB++);
  const frame = a.es.next("call");
  const pending = call(url, "tab-a", { name: "goto" });

  const got = (await frame) as { id: string };
  await a.answer(got.id, { ok: true, snapshot: { where: "a", rev: 1 } });
  assert.equal((await pending).body.snapshot.where, "a");

  // The sharp end of "a tab id is a capability". If a call could leak to the
  // wrong stream it would run as a different human, which is the one thing the
  // security model promises cannot happen.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heardByB, 0, "a call addressed to one tab was delivered to another");

  const tabs = (await getJson(`${url}/dk/tabs`)).body.tabs as Array<{ tab: string; app: string }>;
  assert.deepEqual(tabs.map((x) => x.tab).sort(), ["tab-a", "tab-b"]);
  assert.deepEqual(tabs.map((x) => x.app).sort(), ["A", "B"]);
});

test("a call to a tab that is not connected is refused in the shape of every other answer", async (t) => {
  const { url } = await up(t);
  const res = await call(url, "never-existed", { name: "goto" });

  // 200, not 404, and `{ok:false}` rather than `{error}`. An agent must be able
  // to read "that did not happen" with the same code path whether the reason
  // was a business rule or a closed window; a status-code branch in front of
  // the body is a branch that will be wrong on the rarest path.
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.refused, "no-such-tab");
  assert.match(res.body.hint, /\/dk\/tabs/, "the refusal did not say how to recover");

  // No `snapshot` at all, and its absence is the signal that tells this apart
  // from an app's own refusal. Nothing ran and nobody looked, so there is no
  // screen to report -- and an invented one would be read as "the app has no
  // rows", a lie about the app rather than about the call.
  assert.ok(!("snapshot" in res.body), "the relay invented a screen nobody looked at");
});

test("a tab that never answers times out rather than holding the agent's request open", async (t) => {
  const { url } = await up(t, { timeoutMs: 60 });
  const one = await tab(url, "wedged");
  await one.hello();

  // The stream is open and the tab is listening; it simply never POSTs. That is
  // what a page whose JavaScript died looks like from here, and it is why the
  // timeout cannot be inferred from the socket.
  const res = await call(url, "wedged", { name: "goto" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.refused, "timeout");
  assert.match(res.body.hint, /60ms/);

  // No snapshot, even though the relay HAS the tab's last one. Attaching it
  // would read as "here is the screen after your call", and this is the one
  // case where nobody can say that: the tab may have run the verb and died
  // before answering, so a `commit` that times out has an unknown outcome and
  // the agent must go and look. Handing it a pre-call screen would be the
  // relay guessing, and guessing wrong in the direction of "it didn't happen".
  assert.ok(!("snapshot" in res.body), "a timeout implied a screen it cannot know");
  assert.equal((await getJson(`${url}/dk/tabs/wedged/snapshot`)).body.rev, 7, "the tab's last snapshot is still readable, just not implied");
});

test("a late result is dropped, not delivered to a request that already answered", async (t) => {
  const { url } = await up(t, { timeoutMs: 40 });
  const one = await tab(url, "slow");
  await one.hello();
  const frame = one.es.next("call");
  const res = await call(url, "slow", { name: "goto" });
  assert.equal(res.body.refused, "timeout");

  // Answering now must be a no-op rather than an error: the tab did nothing
  // wrong, it was just slow, and a 500 here would make a slow verb look like a
  // broken one. The relay accepts the frame and says it was not expected.
  const late = await one.answer(((await frame) as { id: string }).id, {
    ok: true,
    snapshot: { where: "late", rev: 9 },
  });
  assert.equal(late.status, 202);
  assert.match(String(late.body.note), /no call/);
});

test("`rev` is forwarded untouched and a `stale` refusal comes back unchanged", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();

  const frame = one.es.next("call");
  const pending = call(url, "t1", { name: "set-lane", args: { id: "01a2", lane: "held" }, rev: 7 });
  const got = (await frame) as { rev?: number; id: string };

  // Forwarded only because the agent sent one. The relay has no opinion about
  // staleness: inventing a rev would opt an agent into a check it did not ask
  // for, dropping one would opt it out of a check it did.
  assert.equal(got.rev, 7);

  const stale: Result = {
    ok: false,
    refused: "stale",
    hint: "you acted on rev 7 but the screen is at rev 9; read again",
    snapshot: { where: "descents", rev: 9, rows: [] },
  };
  await one.answer(got.id, stale);

  // Byte for byte, hint and snapshot included. The hint is the agent's whole
  // instruction -- re-read rather than retry -- and a relay that summarised it
  // into a bare refusal string would cost a round trip to rediscover.
  assert.deepEqual((await pending).body, stale);
});

test("a call with no rev arrives with no rev, so omitting it still opts out of the check", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");
  const frame = one.es.next("call");
  void call(url, "t1", { name: "goto" });
  const got = (await frame) as Record<string, unknown>;
  assert.ok(!("rev" in got), "the relay invented a rev the agent never claimed");
});

test("`screen` is forwarded untouched, on exactly the same terms as `rev`", async (t) => {
  // The relay does not know which screen a tab is on, does not compare one, and
  // does not refuse one. `screen` is the agent's claim and the driver's check,
  // and a relay that had an opinion about it would be a second set of rules
  // beside the core's -- which is the one thing this file's header says a relay
  // must never grow.
  const { url } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();

  const frame = one.es.next("call");
  const pending = call(url, "t1", { name: "next-page", screen: "contacts" });
  const got = (await frame) as { screen?: string; id: string };
  assert.equal(got.screen, "contacts");

  const refused: Result = {
    ok: false,
    refused: "wrong-screen",
    hint: "you believed you were on the `contacts` screen but the app is on `settings`",
    snapshot: { where: "settings", screen: "settings", rev: 9 },
  };
  await one.answer(got.id, refused);
  // Byte for byte again, `snapshot.screen` included: the screen the agent is
  // actually on is the whole fix, and a hop that dropped it would cost a round
  // trip to rediscover.
  assert.deepEqual((await pending).body, refused);
});

test("a call with no screen, or an empty one, arrives with none", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");

  const first = one.es.next("call");
  void call(url, "t1", { name: "goto" });
  assert.ok(
    !("screen" in ((await first) as Record<string, unknown>)),
    "the relay invented a screen the agent never claimed",
  );

  // An empty string is dropped rather than forwarded: it is the id of no
  // screen, and no app should be asked to refuse a call over a field a caller
  // left blank.
  const second = one.es.next("call");
  void call(url, "t1", { name: "goto", screen: "" });
  assert.ok(!("screen" in ((await second) as Record<string, unknown>)));
});

test("a tab leaves the registry when its stream closes", async (t) => {
  const { url, relay } = await up(t);
  const one = await tab(url, "going");
  await one.hello();
  assert.equal(relay.tabs().length, 1);

  one.es.close();
  await waitFor(() => relay.tabs().length === 0);

  // And the next call is a clean "no such tab" rather than a timeout. The
  // protocol has no queue on purpose: a call landing against a screen nobody
  // is looking at is worse than a failure the agent can act on now.
  assert.equal((await call(url, "going", { name: "goto" })).body.refused, "no-such-tab");
});

test("calls in flight fail at once when the stream drops, instead of waiting out the timeout", async (t) => {
  const { url } = await up(t, { timeoutMs: 10_000 });
  const one = await tab(url, "dropping");
  await one.hello();

  const started = Date.now();
  const pending = call(url, "dropping", { name: "goto" });
  await one.es.next("call");
  one.es.close();

  const res = await pending;
  assert.equal(res.body.ok, false);
  assert.equal(res.body.refused, "tab-went-away");
  assert.ok(!("snapshot" in res.body));
  // The answer was already knowable, so making the agent wait ten seconds for
  // it would spend its context on a question nobody was going to answer.
  assert.ok(Date.now() - started < 2_000, "the call sat out its timeout anyway");
});

test("a second stream for one tab id is a reconnect, not a second tab", async (t) => {
  const { url, relay } = await up(t);
  const first = await tab(url, "same-id");
  await first.hello({ title: "before" });

  const second = await tab(url, "same-id");
  await second.hello({ title: "after" });
  await waitFor(() => relay.tabs().length === 1);

  // The id is minted by the tab precisely so a reconnect resumes the identity:
  // an agent holding this id across a blip must not be told the window closed.
  // `hello` upserts, so the later one wins -- the app may have navigated.
  assert.equal(relay.tabs()[0]!.title, "after");

  // And the old stream's `close` must not take the live record with it.
  const frame = second.es.next("call");
  void call(url, "same-id", { name: "goto" });
  assert.equal(((await frame) as { name: string }).name, "goto");
});

test("GET /dk/tabs reports the manifest version, not the manifest", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();

  const { body } = await getJson(`${url}/dk/tabs`);
  const row = body.tabs[0];
  assert.deepEqual(Object.keys(row).sort(), ["app", "manifestVersion", "rev", "since", "tab", "title", "url"].sort());
  assert.equal(row.manifestVersion, "abc123");
  assert.equal(row.rev, 7);
  // The id key is `tab`, spelled as in the `hello` frame -- not `id`, which
  // would collide in a reader's head with a call id and a row id.
  assert.equal(row.tab, "t1");
  assert.equal(row.id, undefined, "the id key was spelled two ways");
  // ISO 8601, not epoch millis: a human reads this in a "which tab?" prompt,
  // and it crosses into clients whose JSON numbers are floats.
  assert.match(row.since, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  // Listing tabs is the cheap call an agent makes often. Inlining every
  // manifest would make the frequent call the expensive one, and the version
  // is all a cache needs to know its copy is still current.
  assert.ok(!JSON.stringify(row).includes("verbs"), "the whole manifest rode along on the list");
});

test("the manifest and snapshot halves are served separately, and say so when absent", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");

  // Before `hello` there is nothing to serve, and the honest answer is a 404.
  // Returning an empty manifest would be a claim that the app has no verbs.
  assert.equal((await getJson(`${url}/dk/tabs/t1/manifest`)).status, 404);

  await one.hello();
  const manifest = await getJson(`${url}/dk/tabs/t1/manifest`);
  assert.equal(manifest.body.version, "abc123");
  assert.ok(!JSON.stringify(manifest.body).includes("01a2"), "live data leaked into the cacheable half");

  // The dynamic half tracks the pushes a person's clicking produces.
  assert.equal((await getJson(`${url}/dk/tabs/t1/snapshot`)).body.rev, 7);
  await one.push({ where: "descent 01a2", rev: 8 });
  await waitFor(async () => (await getJson(`${url}/dk/tabs/t1/snapshot`)).body.rev === 8);

  // A missing tab here is NOT Result-shaped, unlike /call. A `Result` is the
  // outcome of a call; wrapping "no such tab" in one would hand the agent a
  // snapshot that describes nothing.
  const missing = await getJson(`${url}/dk/tabs/nope/snapshot`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "no-such-tab");
});

test("the stream opens with a comment and keeps sending them, so an idle proxy holds it", async (t) => {
  const { url } = await up(t, { pingMs: 25 });
  const one = await tab(url, "t1");
  // The first comment is what makes the browser fire `open` now rather than
  // when the first real frame happens to arrive -- and `open` is where the page
  // sends `hello`, so without it a loaded tab is connected and unidentifiable.
  assert.ok(one.es.comments.length >= 1);

  await waitFor(() => one.es.comments.filter((c) => c === "ping").length >= 2);
  // A comment, not a frame: a client that has never heard of `ping` ignores it
  // for free, which is what lets the keep-alive be added without a version bump.
  assert.ok(one.es.comments.includes("ping"));
});

test("every relay refusal is one of the closed set, and none of them carries a screen", async (t) => {
  const { url } = await up(t, { timeoutMs: 40 });
  const closed: RelayRefusal[] = ["no-such-tab", "tab-went-away", "timeout"];
  const seen: string[] = [];

  seen.push((await call(url, "nobody-home", { name: "goto" })).body.refused);

  const wedged = await tab(url, "wedged");
  await wedged.hello();
  seen.push((await call(url, "wedged", { name: "goto" })).body.refused);

  const leaving = await tab(url, "leaving");
  await leaving.hello();
  const inflight = call(url, "leaving", { name: "goto" });
  await leaving.es.next("call");
  leaving.es.close();
  seen.push((await inflight).body.refused);

  // A closed set is what lets a client tell "your app said no" -- rephrase and
  // retry -- from "your call never landed" -- reconnect, or pick another tab.
  // If the relay could mint a new slug, every client would have to treat the
  // unknown ones as one or the other, and both guesses are wrong half the time.
  assert.deepEqual(seen.sort(), [...closed].sort());
});

test("watch delivers a tab's snapshot pushes to every watcher", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "watched");
  await one.hello();

  // Two watchers, because an agent beside a human beside another agent is the
  // case this endpoint exists for. A single-slot registry would make the second
  // one silently blind rather than refuse it, which is the worse failure.
  const a = new HttpEventSource(`${url}/dk/tabs/watched/watch`);
  const b = new HttpEventSource(`${url}/dk/tabs/watched/watch`);
  await Promise.all([a, b].map((es) => new Promise<void>((r) => es.addEventListener("open", () => r()))));
  t.after(() => {
    a.close();
    b.close();
  });

  // The current screen arrives at once. A watcher that attached to an idle page
  // would otherwise know nothing until the next click, and would have to fetch
  // /snapshot anyway -- which is the poll this endpoint exists to remove.
  for (const es of [a, b]) {
    const first = (await es.next("snapshot")) as { tab: string; snapshot: Snapshot };
    assert.equal(first.tab, "watched");
    assert.equal(first.snapshot.rev, 7, "a watcher was not told what is on screen now");
  }

  const nextA = a.next("snapshot");
  const nextB = b.next("snapshot");
  await one.push({ where: "descent 01a2", rev: 8 });

  // Without this the `snapshot` push reaches the relay and stops there, and
  // the shared-presence case the frame exists for is unreachable through the
  // documented surface.
  for (const got of [await nextA, await nextB]) {
    assert.equal((got as { t: string }).t, "snapshot");
    assert.equal((got as { snapshot: Snapshot }).snapshot.rev, 8);
    assert.equal((got as { tab: string }).tab, "watched", "a watch frame did not say which tab moved");
  }
});

test("watch also reports a change an agent caused, so a second watcher is not blind", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "watched");
  await one.hello();
  const es = new HttpEventSource(`${url}/dk/tabs/watched/watch`);
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  t.after(() => es.close());
  await es.next("snapshot"); // the opening state

  const moved = es.next("snapshot");
  const frame = one.es.next("call");
  const pending = call(url, "watched", { name: "set-lane" });
  await one.answer(((await frame) as { id: string }).id, {
    ok: true,
    snapshot: { where: "descents", rev: 9 },
  });
  await pending;

  // A watcher that learned only about human-caused moves would still have to
  // poll for the rest, which is the cost the endpoint was added to remove.
  assert.equal(((await moved) as { snapshot: Snapshot }).snapshot.rev, 9);

  // But a refusal that moved nothing stays quiet: the rev did not change, so
  // there is nothing to tell anyone. A heartbeat on every call would make the
  // stream noisier than the polling it replaced.
  let after = 0;
  es.addEventListener("snapshot", () => after++);
  const again = one.es.next("call");
  const refusing = call(url, "watched", { name: "set-lane" });
  await one.answer(((await again) as { id: string }).id, {
    ok: false,
    refused: "machine-may-not-leave-pruning",
    snapshot: { where: "descents", rev: 9 },
  });
  await refusing;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(after, 0, "an unchanged screen was broadcast anyway");
});

test("watch is the tab's own SSE shape, pings included, and 404s for a tab nobody has", async (t) => {
  const { url } = await up(t, { pingMs: 25 });
  const one = await tab(url, "watched");
  await one.hello();
  const es = new HttpEventSource(`${url}/dk/tabs/watched/watch`);
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  t.after(() => es.close());

  // Same opening comment, same `: ping` comment lines, same named events as
  // /dk/events. One parser serves both directions rather than two that drift.
  await waitFor(() => es.comments.filter((c) => c === "ping").length >= 2);

  // A subscription to a screen that does not exist is answered, not held open:
  // 404 tells the client to re-read /dk/tabs instead of waiting on a stream
  // that may never carry anything.
  assert.equal((await getJson(`${url}/dk/tabs/ghost/watch`)).status, 404);
});

test("a field the relay has never heard of reaches the agent anyway", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");
  // `kind` on a verb and `count` on a result are both newer than this relay's
  // first draft, and PROTOCOL.md promises a field can be added without a
  // version bump. That promise is only kept if every hop forwards what it does
  // not understand -- so the relay stores and serves frames whole rather than
  // rebuilding them from the fields it knows.
  await one.hello({
    manifest: {
      version: "v2",
      app: "toy",
      verbs: [{ name: "select-matching", describe: "select rows", kind: "describe" }],
    },
  });
  const manifest = await getJson(`${url}/dk/tabs/t1/manifest`);
  assert.equal(manifest.body.verbs[0].kind, "describe");

  const frame = one.es.next("call");
  const pending = call(url, "t1", { name: "select-matching" });
  await one.answer(((await frame) as { id: string }).id, {
    ok: true,
    count: 1000,
    note: "1,000 selected of 3,412 matching",
    snapshot: { where: "descents", rev: 8 },
  } as Result);

  const res = await pending;
  // The number a human would have to see before pressing a bulk button, and
  // the reason `describe` and `commit` are separate verbs. Dropping it here
  // would be dropping the safety check itself.
  assert.equal(res.body.count, 1000);
  assert.match(res.body.note, /3,412/);
});

test("a result that is not an object is rejected, and never answered to the agent", async (t) => {
  const { url } = await up(t, { timeoutMs: 120 });
  const one = await tab(url, "t1");
  await one.hello();

  const frame = one.es.next("call");
  const pending = call(url, "t1", { name: "goto" });
  const callId = ((await frame) as { id: string }).id;

  // A tab that answers `{"t":"result","id":"c-1","result":"done"}` -- a string,
  // a number, null, an array -- must not be able to make the relay answer the
  // agent something that is not a `WireResult`. Settling with the value would
  // put `undefined` through `JSON.stringify` and send a body no client can
  // parse, which is the one promise this endpoint makes.
  for (const garbage of ["done", 7, null, [{ ok: true }], true]) {
    const sent = await postJson(`${url}/dk/result?tab=t1`, { t: "result", id: callId, result: garbage });
    assert.equal(sent.status, 400, `a \`result\` of ${JSON.stringify(garbage)} was accepted`);
    assert.equal(sent.body.error, "bad-frame");
  }

  // And the call was LEFT PENDING rather than settled with garbage, so it ends
  // as a documented unknown outcome. `timeout` is a far better thing to hand an
  // agent than a body it cannot read: it is in the closed set, it is in the
  // spec, and it tells the agent to go and look at the screen.
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.body.refused, "timeout");
  assert.ok(!("snapshot" in res.body));
});

test("a frame that arrives after the call was answered still cannot corrupt it", async (t) => {
  const { url } = await up(t, { timeoutMs: 40 });
  const one = await tab(url, "t1");
  await one.hello();
  const frame = one.es.next("call");
  const res = await call(url, "t1", { name: "goto" });
  assert.equal(res.body.refused, "timeout");

  // Validated before the pending lookup, so a malformed late frame is still a
  // 400 and not a silently-ignored 202. The tab's bug gets reported to the tab
  // either way, which is the only place it can be fixed.
  const late = await postJson(`${url}/dk/result?tab=t1`, {
    t: "result",
    id: ((await frame) as { id: string }).id,
    result: "done",
  });
  assert.equal(late.status, 400);
  assert.equal(late.body.error, "bad-frame");
});

test("every status and slug is the one the table pins, so two relays agree", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");

  // Pre-`hello`: connected, but with nothing to serve. The slugs name WHICH
  // half is missing, so a client knows whether to wait or to re-read /dk/tabs.
  const noManifest = await getJson(`${url}/dk/tabs/t1/manifest`);
  assert.equal(noManifest.status, 404);
  assert.equal(noManifest.body.error, "no-manifest");
  const noSnapshot = await getJson(`${url}/dk/tabs/t1/snapshot`);
  assert.equal(noSnapshot.status, 404);
  assert.equal(noSnapshot.body.error, "no-snapshot");

  await one.hello();
  // Accepted, and nothing more: the answer to a call travels to the agent, not
  // back up this POST.
  assert.deepEqual(await postJson(`${url}/dk/result?tab=t1`, { t: "snapshot", snapshot: SNAP }), {
    status: 202,
    body: { ok: true },
  });

  // An unknown /dk/* path is a routing failure, not a bad request: the sender
  // did nothing wrong with the bytes, it asked for something that is not here.
  const noRoute = await getJson(`${url}/dk/nothing-here`);
  assert.equal(noRoute.status, 404);
  assert.equal(noRoute.body.error, "no-route");

  const watchGhost = await getJson(`${url}/dk/tabs/ghost/watch`);
  assert.equal(watchGhost.status, 404);
  assert.equal(watchGhost.body.error, "no-such-tab");

  // Over 1 MiB: 413, distinguished from a parse failure because they are
  // different problems for the sender -- send less, versus send JSON.
  const huge = { t: "snapshot", snapshot: { where: "x", rev: 1, note: "z".repeat(1 << 21) } };
  const tooBig = await postJson(`${url}/dk/result?tab=t1`, huge);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error, "too-large");
  // A snapshot that size is a bug in the app's `visible()`, not a limit to
  // raise: the whole design says an agent sees a screenful.
  const tooBigCall = await postJson(`${url}/dk/tabs/t1/call`, { name: "goto", args: { id: "z".repeat(1 << 21) } });
  assert.equal(tooBigCall.status, 413);
  assert.equal(tooBigCall.body.error, "too-large");

  // Unparseable, same endpoints, different answer.
  const noName = await call(url, "t1", { args: {} });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error, "bad-request");
});

test("a caller that is not on loopback is refused unless the relay was told to allow it", () => {
  // Checked per request rather than by binding, because `attach()` means the
  // relay usually does not own the listening socket and cannot choose the
  // interface. A tab's own session is the only authority there is, so a
  // reachable relay is someone else driving a logged-in browser.
  const closed = createRelay();
  const remote = fakeRequest("10.0.0.5", "GET", "/dk/tabs");
  assert.equal(closed.handler(remote.req, remote.res), true);
  assert.equal(remote.res.status, 403);
  assert.equal(remote.res.json.error, "forbidden");

  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const local = fakeRequest(address, "GET", "/dk/tabs");
    closed.handler(local.req, local.res);
    assert.equal(local.res.status, 200, `${address} should count as loopback`);
  }

  // And turning it on now REQUIRES saying how callers are identified. The old
  // one-flag version of this test is the combination the flag exists to
  // prevent: an exposed relay that cannot tell its callers apart hands every
  // connected tab to every one of them.
  assert.throws(() => createRelay({ allowRemote: true }), /auth or resolvePrincipal/);
  assert.throws(() => createRelay({ allowRemote: true }), /PROTOCOL\.md/);

  const auth = new TabAuth({ secret: SECRET, audience: "test" });
  const open = createRelay({ allowRemote: true, auth });
  // Remote and identified: the peer check passes and the credential check is
  // what answers now. No credential is a 401, not a 200.
  const bare = fakeRequest("10.0.0.5", "GET", "/dk/tabs");
  open.handler(bare.req, bare.res);
  assert.equal(bare.res.status, 401);
  assert.equal(bare.res.json.error, "no-credential");

  const allowed = fakeRequest("10.0.0.5", "GET", "/dk/tabs", {
    authorization: `Bearer ${auth.mint("u1")}`,
  });
  open.handler(allowed.req, allowed.res);
  assert.equal(allowed.res.status, 200);
  closed.close();
  open.close();
});

test("serve() will not bind a public interface on its own", () => {
  // Two deliberate acts, not one. Binding 0.0.0.0 is something people do by
  // reflex to reach a dev server from a phone; here it publishes the ability to
  // drive whoever has a tab open, so reflex must not be enough.
  // Thrown synchronously, before any socket exists. A misconfiguration that
  // surfaced as a rejected promise would be a misconfiguration someone forgot
  // to await, and the failure mode of forgetting is a listening public port.
  assert.throws(() => serve({ host: "0.0.0.0", port: 0 }), /allowRemote/);
  assert.throws(() => serve({ host: "0.0.0.0", port: 0 }), /PROTOCOL\.md/);

  // allowRemote alone is no longer enough either: the relay refuses to exist
  // without a way to tell callers apart, so the insecure-but-exposed
  // combination cannot be reached by adding one flag at a time.
  assert.throws(
    () => serve({ host: "0.0.0.0", port: 0, allowRemote: true }),
    /auth or resolvePrincipal/,
  );
});

test("the handler declines paths it does not own, so it can sit in front of an app", () => {
  // Returning false rather than 404ing is what makes `attach()` possible: an
  // embedded relay that answered every unknown path would shadow the app it
  // was embedded in.
  const relay = createRelay();
  const app = fakeRequest("127.0.0.1", "GET", "/app/descents");
  assert.equal(relay.handler(app.req, app.res), false);
  assert.equal(app.res.status, 0, "the relay answered a request that was not its own");

  // But a /dk path with the wrong method is ours and is answered.
  const wrong = fakeRequest("127.0.0.1", "GET", "/dk/result");
  assert.equal(relay.handler(wrong.req, wrong.res), true);
  assert.equal(wrong.res.status, 405);
  relay.close();
});

test("a frame the relay cannot place is rejected without taking anything else down", async (t) => {
  const { url, relay } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();

  const unknownFrame = await postJson(`${url}/dk/result?tab=t1`, { t: "nonsense" });
  assert.equal(unknownFrame.status, 400);
  assert.equal(unknownFrame.body.error, "bad-frame");

  // A frame that names no tab at all, by field or query: 400, because there is
  // no state of the relay in which it could have been accepted -- which is
  // exactly what 400 says and 409 does not.
  const unplaceable = await postJson(`${url}/dk/result`, { t: "snapshot", snapshot: SNAP });
  assert.equal(unplaceable.status, 400);
  assert.equal(unplaceable.body.error, "unplaceable");

  // Named a tab, but not one that is here: 409, because the frame was fine and
  // the relay's state is what made it unacceptable.
  assert.equal((await postJson(`${url}/dk/result?tab=ghost`, { t: "snapshot", snapshot: SNAP })).status, 409);
  assert.equal((await getJson(`${url}/dk/events`)).status, 400, "a stream with no ?tab= is unroutable");

  // Still serving. In a relay this is the difference between one malformed POST
  // and every open tab losing its stream.
  assert.equal(relay.tabs().length, 1);
  const frame = one.es.next("call");
  void call(url, "t1", { name: "goto" });
  assert.equal(((await frame) as { name: string }).name, "goto");
});

test("a malformed call is a transport failure, not a refusal", async (t) => {
  const { url } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();

  // No `name`, so there is no verb to have said no. Answering `{ok:false}`
  // would teach an agent to look for a slug the closed set does not contain,
  // and would make it rephrase a request that never reached an app. A non-2xx
  // is the honest answer: no `WireResult` was produced at all.
  const res = await call(url, "t1", { args: { id: "01a2" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, undefined, "a malformed request was dressed as a refusal");
  assert.equal(res.body.error, "bad-request");

  // And the tab was never bothered with it.
  assert.equal((await getJson(`${url}/dk/tabs/t1/snapshot`)).body.rev, 7);
});

test("close() hangs up every stream and fails everything in flight", async (t) => {
  const { url, relay } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();
  const pending = call(url, "t1", { name: "goto" });
  await one.es.next("call");

  relay.close();
  const res = await pending;
  assert.equal(res.body.refused, "tab-went-away");
  assert.match(res.body.hint, /shutting down/);
  assert.equal(relay.tabs().length, 0);
  // Idempotent: a shutdown path that throws on a second call is a shutdown
  // path that gets wrapped in try/catch everywhere it is used.
  relay.close();
});

/** A request/response pair with no socket, for the checks that are about the
 *  peer address rather than the bytes. */
function fakeRequest(
  remoteAddress: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const res = {
    status: 0,
    json: undefined as any,
    headersSent: false,
    writeHead(status: number) {
      this.status = status;
      return this;
    },
    write() {
      return true;
    },
    end(body?: string) {
      if (body) {
        try {
          this.json = JSON.parse(body);
        } catch {
          this.json = body;
        }
      }
    },
    on() {
      return this;
    },
  };
  // `resume` is what the relay calls to drain a body it is not going to parse,
  // and `headers` is where a credential arrives.
  const req = {
    url: path,
    method,
    headers,
    socket: { remoteAddress },
    on: () => req,
    resume: () => req,
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse & typeof res };
}

/** Poll a condition instead of sleeping a guessed interval. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("`plan` is forwarded untouched, and the minted token comes back untouched", async (t) => {
  // The relay's restraint about `rev` and `screen`, except that here it is not
  // even a choice: a plan token is opaque to everything but the core that
  // minted it, so a relay has nothing to compare it against and could only ever
  // get the comparison wrong. Both directions are pinned, because a token is
  // useless unless BOTH survive: the describe's `Result.plan` on the way out,
  // and the commit's claim on the way in.
  const { url } = await up(t);
  const one = await tab(url, "t1");
  await one.hello();

  const described = one.es.next("call");
  const counting = call(url, "t1", { name: "select-where", args: { company: "Acme" } });
  const first = (await described) as { id: string };
  const counted: Result = {
    ok: true,
    count: 3412,
    plan: "dkp1.7.1.4c1f8a20b3de",
    snapshot: { where: "contacts", rev: 7, selectionId: "2jm-9f1a0c3b4d5e6f70" },
  };
  await one.answer(first.id, counted);
  // Byte for byte on the way back, `plan` and `selectionId` included. A hop
  // that stripped either would leave the commit permanently uncallable, and the
  // only symptom would be a `stale-plan` nobody could explain.
  assert.deepEqual((await counting).body, counted);

  const committed = one.es.next("call");
  const pending = call(url, "t1", { name: "accept-selected", plan: "dkp1.7.1.4c1f8a20b3de" });
  const got = (await committed) as { plan?: string; id: string };
  assert.equal(got.plan, "dkp1.7.1.4c1f8a20b3de");
  await one.answer(got.id, { ok: true, snapshot: { where: "contacts", rev: 8 } });
  await pending;
});

test("a call with no plan, or an empty one, arrives with none", async (t) => {
  // The same rule as `screen`: defaulting it would opt an agent into a claim it
  // did not make, and an empty string is not a token — so the core's refusal
  // names the field the agent actually left out rather than complaining about
  // a blank one.
  const { url } = await up(t);
  const one = await tab(url, "t1");

  const first = one.es.next("call");
  void call(url, "t1", { name: "goto" });
  assert.ok(
    !("plan" in ((await first) as Record<string, unknown>)),
    "the relay invented a plan the agent never presented",
  );

  const second = one.es.next("call");
  void call(url, "t1", { name: "goto", plan: "" });
  assert.ok(!("plan" in ((await second) as Record<string, unknown>)));
});
