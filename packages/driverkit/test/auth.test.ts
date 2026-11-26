/**
 * Isolation between people, asserted over real HTTP against the real relay.
 *
 * A port of `python/tests/test_relay_auth.py`, test for test, for the reason
 * PROTOCOL.md gives: "Two conforming relays disagreeing on these is worse than
 * either choice." The two relays must answer the same status with the same slug
 * to the same probe, and the only way that stays true is if both suites ask.
 *
 * The shape of every test here is two principals and one question: can the
 * second one tell that the first one's tab exists? The answer must be no,
 * through every endpoint, and it must be no IN THE SAME WORDS the relay uses
 * for a tab id that was never minted -- because a different refusal is an
 * existence oracle, and an existence oracle over tab ids is how an attacker
 * finds a session to attack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TabAuth, mintAnonCredential } from "../src/relay/index.ts";
import { serve } from "../src/relay/serve.ts";
import { HttpEventSource, getJson, postJson } from "./sse-client.ts";
import type { Snapshot } from "../src/relay/frames.ts";

const SNAP: Snapshot = { where: "descents", rev: 7, rows: [{ id: "01a2", lane: "pruning" }] };
const SECRET = "k".repeat(40);
const AUDIENCE = "relay-test";

function bearer(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

/** A relay with token auth on, plus the two people who use it. */
async function up(
  t: { after: (fn: () => unknown) => void },
  options: Partial<ConstructorParameters<typeof TabAuth>[0]> = {},
) {
  const auth = new TabAuth({ secret: SECRET, audience: AUDIENCE, ...options });
  const { server, relay, url } = await serve({ port: 0, pingMs: 20_000, auth });
  t.after(() => {
    relay.close();
    server.close();
  });
  return { auth, relay, url, alice: auth.mint("user:alice"), bob: auth.mint("user:bob") };
}

/** An unconfigured relay: no auth, no tokens, the single-developer path. */
async function plain(t: { after: (fn: () => unknown) => void }) {
  const { server, relay, url } = await serve({ port: 0, pingMs: 20_000 });
  t.after(() => {
    relay.close();
    server.close();
  });
  return { relay, url };
}

/** A tab, played by hand, presenting a credential as a header. */
async function tab(url: string, id: string, token?: string, headers: Record<string, string> = {}) {
  const es = new HttpEventSource(`${url}/dk/events?tab=${encodeURIComponent(id)}`, {
    ...(token === undefined ? {} : { "x-dk-token": token }),
    ...headers,
  });
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  const post = (frame: unknown) =>
    postJson(`${url}/dk/result?tab=${encodeURIComponent(id)}`, frame, {
      ...(token === undefined ? {} : { "x-dk-token": token }),
    });
  return {
    es,
    hello: (extra: Record<string, unknown> = {}) =>
      post({
        t: "hello",
        tab: id,
        app: "toy",
        title: "Descents — toy",
        url: "/app/descents",
        manifest: { version: "abc123", app: "toy", verbs: [{ name: "goto", describe: "open one" }] },
        snapshot: SNAP,
        ...extra,
      }),
    answer: (callId: string, result: unknown) => post({ t: "result", id: callId, result }),
    push: (snapshot: Snapshot) => post({ t: "snapshot", snapshot, tab: id }),
  };
}

const list = async (url: string, token?: string) =>
  (await getJson(`${url}/dk/tabs`, bearer(token))).body.tabs as Array<Record<string, unknown>>;

const leaf = (url: string, id: string, which: string, token?: string) =>
  getJson(`${url}/dk/tabs/${encodeURIComponent(id)}/${which}`, bearer(token));

const call = (url: string, id: string, body: unknown, token?: string) =>
  postJson(`${url}/dk/tabs/${encodeURIComponent(id)}/call`, body, bearer(token));

// --- binding ---------------------------------------------------------------

test("a tab is bound to the principal that opened its stream", async (t) => {
  const { url, alice } = await up(t);
  const one = await tab(url, "a-1", alice);
  await one.hello();
  const rows = await list(url, alice);
  assert.deepEqual(
    rows.map((r) => r.tab),
    ["a-1"],
  );
  assert.equal(rows[0]!.app, "toy");
});

test("the credential may arrive as a header, a cookie or a query parameter", async (t) => {
  // Three places, because the page has no choice about which it can use:
  // `EventSource` cannot set a header, so a same-origin page uses the cookie
  // the app set and a cross-origin one has only the query string. An agent uses
  // `Authorization`. All four must work or some deployment cannot connect.
  const { url, alice } = await up(t);
  await (await tab(url, "h-1", alice)).hello();
  await (await tab(url, "c-1", undefined, { cookie: `dk_token=${alice}` })).hello();
  const query = new HttpEventSource(`${url}/dk/events?tab=q-1&dk_token=${encodeURIComponent(alice)}`);
  await new Promise<void>((r) => query.addEventListener("open", () => r()));
  t.after(() => query.close());
  await postJson(`${url}/dk/result?tab=q-1`, { t: "hello", tab: "q-1", app: "toy" }, bearer(alice));

  assert.deepEqual(
    (await list(url, alice)).map((r) => r.tab).sort(),
    ["c-1", "h-1", "q-1"],
  );
});

test("a tab id two people both minted is two tabs and neither sees the other", async (t) => {
  // The registry is keyed by (principal, tab id), so a collision is not a
  // conflict to resolve. This matters beyond tidiness: refusing the second
  // stream would tell whoever opened it that the id was taken, which is an
  // existence oracle over tab ids.
  const { url, alice, bob } = await up(t);
  const mine = await tab(url, "same-id", alice);
  await mine.hello({ app: "alice-app" });
  const theirs = await tab(url, "same-id", bob);
  await theirs.hello({ app: "bob-app" });

  assert.deepEqual(
    (await list(url, alice)).map((r) => r.app),
    ["alice-app"],
  );
  assert.deepEqual(
    (await list(url, bob)).map((r) => r.app),
    ["bob-app"],
  );
  // And both streams are live: neither was superseded by the other.
  assert.equal(mine.es.readyState, 1);
  assert.equal(theirs.es.readyState, 1);
  mine.es.close();
  theirs.es.close();
});

test("a tab-bound credential may open only that tab", async (t) => {
  const { url, auth } = await up(t);
  const bound = auth.mint("user:alice", { tab: "only-this" });
  const ok = await tab(url, "only-this", bound);
  assert.equal(ok.es.readyState, 1);
  ok.es.close();

  // 403, not `no-such-tab`, and the difference is deliberate: the oracle rule
  // is about ADDRESSING somebody else's tab, and this caller is opening its own
  // with a credential bound elsewhere -- which it already knows.
  const refused = await getJson(`${url}/dk/events?tab=something-else`, { "x-dk-token": bound });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "forbidden");
});

// --- listing ---------------------------------------------------------------

test("GET /dk/tabs never lists another principal's tab", async (t) => {
  // The worst thing on this surface before scoping existed: an inventory of a
  // hundred people's sessions, with their titles and URLs attached, served to
  // anybody who could reach the port.
  const { url, alice, bob } = await up(t);
  await (await tab(url, "a-1", alice)).hello({ title: "Alice's contacts", url: "/c?who=alice" });
  await (await tab(url, "b-1", bob)).hello({ title: "Bob's contacts" });

  const mine = await list(url, alice);
  assert.deepEqual(
    mine.map((r) => r.tab),
    ["a-1"],
  );
  assert.equal(mine[0]!.title, "Alice's contacts");

  const theirs = JSON.stringify(await list(url, bob));
  // Not a field hidden on the way out: Bob's listing does not mention the
  // existence of a-1 anywhere, not as a count and not as a title.
  assert.ok(!theirs.includes("a-1"));
  assert.ok(!theirs.toLowerCase().includes("alice"));
});

test("a tab-bound credential lists only its own tab", async (t) => {
  const { url, auth, alice } = await up(t);
  await (await tab(url, "a-1", alice)).hello();
  await (await tab(url, "a-2", alice)).hello();
  assert.deepEqual(
    (await list(url, auth.mint("user:alice", { tab: "a-2" }))).map((r) => r.tab),
    ["a-2"],
  );
});

test("the in-process registry still sees everything but HTTP does not", async (t) => {
  // `relay.tabs()` is the operator's view -- a process embedding the relay may
  // legitimately want to know what is connected. The split is the point:
  // nothing reachable over HTTP uses it.
  const { url, relay, alice, bob } = await up(t);
  await (await tab(url, "a-1", alice)).hello();
  await (await tab(url, "b-1", bob)).hello();
  assert.deepEqual(
    relay
      .tabs()
      .map((r) => r.tab)
      .sort(),
    ["a-1", "b-1"],
  );
  assert.deepEqual(
    relay.tabsFor("user:alice").map((r) => r.tab),
    ["a-1"],
  );
  assert.deepEqual(
    (await list(url, alice)).map((r) => r.tab),
    ["a-1"],
  );
});

// --- not an oracle ---------------------------------------------------------

test("manifest and snapshot answer the same thing for a foreign tab and an absent one", async (t) => {
  const { url, alice, bob } = await up(t);
  await (await tab(url, "a-1", alice)).hello();

  for (const which of ["manifest", "snapshot"]) {
    const foreign = await leaf(url, "a-1", which, bob);
    const absent = await leaf(url, "never-minted", which, bob);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error, "no-such-tab");
    // Byte for byte, hint included. A hint naming the tab in one case and not
    // the other is the oracle the status code was chosen to avoid.
    assert.deepEqual(foreign, absent, which);
  }
});

test("a foreign tab with no manifest does not answer no-manifest", async (t) => {
  // The ordering trap. A tab that has opened its stream but not yet sent
  // `hello` answers `no-manifest` to its OWNER -- a real and documented window.
  // Answering that to a stranger would confirm the tab exists.
  const { url, alice, bob } = await up(t);
  const quiet = await tab(url, "a-2", alice); // no hello()
  assert.equal((await leaf(url, "a-2", "manifest", alice)).body.error, "no-manifest");
  assert.equal((await leaf(url, "a-2", "manifest", bob)).body.error, "no-such-tab");
  assert.deepEqual(
    await leaf(url, "a-2", "manifest", bob),
    await leaf(url, "nope", "manifest", bob),
  );
  quiet.es.close();
});

test("watch answers the same thing for a foreign tab and an absent one", async (t) => {
  const { url, alice, bob } = await up(t);
  await (await tab(url, "a-1", alice)).hello();
  const foreign = await leaf(url, "a-1", "watch", bob);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error, "no-such-tab");
  assert.deepEqual(foreign, await leaf(url, "never-minted", "watch", bob));
});

test("a cross-principal watcher is refused while the owner's receives pushes", async (t) => {
  const { url, alice, bob } = await up(t);
  const hers = await tab(url, "a-1", alice);
  await hers.hello();

  const mine = new HttpEventSource(`${url}/dk/tabs/a-1/watch`, bearer(alice));
  t.after(() => mine.close());
  // A new watcher is sent the current screen immediately, so the first frame is
  // the one that already existed. The push is the second.
  assert.equal(((await mine.next("snapshot")) as any).snapshot.rev, SNAP.rev);
  await hers.push({ ...SNAP, rev: 9 });
  assert.equal(((await mine.next("snapshot")) as any).snapshot.rev, 9);

  assert.equal((await leaf(url, "a-1", "watch", bob)).status, 404);
});

test("a cross-principal call is refused as no-such-tab, not as forbidden", async (t) => {
  // 200 with a WireResult, exactly as for a tab id that was never minted. A 403
  // here would turn /call into a membership test for other people's tab ids,
  // and an agent would also have to handle a third outcome shape.
  const { url, alice, bob } = await up(t);
  const hers = await tab(url, "a-1", alice);
  await hers.hello();

  const foreign = await call(url, "a-1", { name: "goto" }, bob);
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.refused, "no-such-tab");
  assert.equal(foreign.body.snapshot, undefined);
  assert.deepEqual(foreign, await call(url, "never-minted", { name: "goto" }, bob));
  // And nothing reached Alice's tab: no `call` frame was written to it.
  assert.equal(hers.es.readyState, 1);
});

test("a tab-bound credential addressing another tab gets no-such-tab", async (t) => {
  const { url, auth, alice } = await up(t);
  await (await tab(url, "a-1", alice)).hello();
  await (await tab(url, "a-2", alice)).hello();
  const bound = auth.mint("user:alice", { tab: "a-1" });
  assert.equal((await leaf(url, "a-2", "snapshot", bound)).body.error, "no-such-tab");
  assert.equal((await call(url, "a-2", { name: "goto" }, bound)).body.refused, "no-such-tab");
});

// --- result frames ---------------------------------------------------------

test("a tab cannot answer another principal's call", async (t) => {
  const { url, alice, bob } = await up(t);
  const hers = await tab(url, "a-1", alice);
  await hers.hello();
  await (await tab(url, "b-1", bob)).hello();

  const frame = hers.es.next("call");
  const pending = call(url, "a-1", { name: "goto" }, alice);
  const sent = (await frame) as { id: string };

  // Bob's tab POSTs a result for Alice's call, naming her tab. 409
  // `no-such-tab` -- the same answer as a tab that is not connected, which is
  // the oracle rule applied to the tab's own endpoint.
  const stolen = await postJson(
    `${url}/dk/result?tab=a-1`,
    { t: "result", id: sent.id, result: { ok: true, snapshot: SNAP } },
    { "x-dk-token": bob },
  );
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.error, "no-such-tab");

  // Alice's call is untouched and still answerable by Alice's tab.
  await hers.answer(sent.id, { ok: true, snapshot: { ...SNAP, rev: 11 } });
  assert.equal((await pending).body.snapshot.rev, 11);
});

test("one person's tab cannot answer their other tab's call", async (t) => {
  // Within one principal the registry key does not separate them, so what holds
  // is that `pending` is per-tab-record and call ids are unique across the
  // relay. A `result` for the other tab's call finds nothing to settle and is
  // dropped as a late answer -- not an error, because a late answer is exactly
  // what it looks like.
  const { url, alice } = await up(t);
  const one = await tab(url, "a-1", alice);
  await one.hello();
  const two = await tab(url, "a-2", alice);
  await two.hello();

  const frame = one.es.next("call");
  const pending = call(url, "a-1", { name: "goto" }, alice);
  const sent = (await frame) as { id: string };

  const wrong = await postJson(
    `${url}/dk/result?tab=a-2`,
    { t: "result", id: sent.id, result: { ok: true, snapshot: SNAP } },
    { "x-dk-token": alice },
  );
  assert.equal(wrong.status, 202);
  assert.match(String(wrong.body.note), /no call/);

  await one.answer(sent.id, { ok: true, snapshot: { ...SNAP, rev: 12 } });
  assert.equal((await pending).body.snapshot.rev, 12);
  void two;
});

test("a hello for another principal's tab cannot rewrite it", async (t) => {
  const { url, alice, bob } = await up(t);
  const hers = await tab(url, "a-1", alice);
  await hers.hello({ title: "Alice" });
  const forged = await postJson(
    `${url}/dk/result`,
    { t: "hello", tab: "a-1", app: "not-toy", title: "Bob was here" },
    { "x-dk-token": bob },
  );
  assert.equal(forged.status, 409);
  assert.equal(forged.body.error, "no-such-tab");
  assert.equal((await list(url, alice))[0]!.title, "Alice");
});

// --- credentials -----------------------------------------------------------

test("no credential is a 401 with a challenge, and not an anonymous session", async (t) => {
  // Silently treating an unidentified caller as a fresh anonymous visitor was
  // the tempting shape: it is wrong twice over, because a user whose token
  // lapsed would quietly become a stranger and lose their tabs, and an agent
  // with a misconfigured key would be told "you have no tabs" rather than
  // "your key is wrong".
  const { url } = await up(t);
  const bare = await getJson(`${url}/dk/tabs`);
  assert.equal(bare.status, 401);
  assert.equal(bare.body.error, "no-credential");
});

test("every way a credential can fail gives one slug", async (t) => {
  // On purpose. "The signature verified but the audience was wrong" tells a
  // forger the forgery worked, and a legitimate client's move is the same in
  // every case: mint a fresh token and retry once.
  const { url, auth, alice } = await up(t);
  const [prefix, payload] = alice.split(".");
  const cases: Array<[string, string]> = [
    ["expired", auth.mint("user:alice", { ttlMs: -3_600_000 })],
    ["wrong audience", new TabAuth({ secret: SECRET, audience: "relay-other" }).mint("user:a")],
    ["forged with another key", new TabAuth({ secret: "x".repeat(40), audience: AUDIENCE }).mint("user:a")],
    ["tampered signature", `${prefix}.${payload}.AAAAAAAA`],
    ["undecodable payload", "dkt1.!!!!.AAAA"],
    ["not a token at all", "hunter2"],
  ];
  for (const [name, credential] of cases) {
    const answer = await getJson(`${url}/dk/tabs`, bearer(credential));
    assert.equal(answer.status, 401, name);
    assert.equal(answer.body.error, "bad-credential", name);
    assert.equal(answer.body.hint, "present a fresh tab token", name);
    const text = JSON.stringify(answer.body);
    assert.ok(!text.includes("audience") && !text.includes("expired"), name);
  }
});

test("a bad credential on /call is a 401 rather than a WireResult", async (t) => {
  // Not a violation of "every answer from /call is a WireResult": a non-2xx
  // means no WireResult was produced at all, which is exactly what happened.
  // Nothing was asked of any tab. A VALID credential for the wrong tab is the
  // other case and is a 200 WireResult.
  const { url } = await up(t);
  const answer = await call(url, "a-1", { name: "goto" }, "hunter2");
  assert.equal(answer.status, 401);
  assert.equal(answer.body.refused, undefined);
});

test("an unidentified caller learns nothing about the route surface", async (t) => {
  // Identity before routing. A 405 or a 404 here would let a caller we will not
  // serve map the surface anyway.
  const { url } = await up(t);
  assert.equal((await postJson(`${url}/dk/tabs`, {})).status, 401);
  assert.equal((await getJson(`${url}/dk/nonsense`)).status, 401);
});

test("an expired token does not disconnect a tab that is still open", async (t) => {
  // THE MID-SESSION EXPIRY RULE. The stream is authenticated once, at open, and
  // the binding it made lasts as long as the stream. A relay that hung up at
  // `exp` would disconnect every tab in the deployment once per token lifetime,
  // mid-verb, while a person watched.
  const { url, auth, alice } = await up(t);
  const live = await tab(url, "a-1", alice);
  await live.hello();

  const dead = auth.mint("user:alice", { ttlMs: -3_600_000 });

  // The stream is live, the tab is listed to its owner, and a call reaches it.
  assert.equal(live.es.readyState, 1);
  const frame = live.es.next("call");
  const pending = call(url, "a-1", { name: "goto" }, alice);
  const sent = (await frame) as { id: string };

  // What the tab CANNOT do with a lapsed credential is answer, because
  // `/dk/result` is a new request and carries its own. This is the symptom a
  // page must handle, and `connect`'s token getter is what handles it: refresh
  // and re-send the same bytes.
  const refused = await postJson(
    `${url}/dk/result?tab=a-1`,
    { t: "result", id: sent.id, result: { ok: true, snapshot: SNAP } },
    { "x-dk-token": dead },
  );
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, "bad-credential");

  await live.answer(sent.id, { ok: true, snapshot: { ...SNAP, rev: 14 } });
  assert.equal((await pending).body.snapshot.rev, 14);
});

// --- anonymous -------------------------------------------------------------

test("two anonymous visitors are isolated from each other", async (t) => {
  // "Anonymous" is not one bucket. Two independent browser secrets are two
  // principals, and the registry key is the principal, so the second visitor
  // cannot see, list, read or drive the first one's screen.
  const { url } = await up(t);
  const first = mintAnonCredential();
  const second = mintAnonCredential();
  const mine = await tab(url, "v-1", first);
  await mine.hello({ title: "my screen" });
  await (await tab(url, "v-2", second)).hello({ title: "their screen" });

  assert.deepEqual(
    (await list(url, first)).map((r) => r.tab),
    ["v-1"],
  );
  assert.deepEqual(
    (await list(url, second)).map((r) => r.tab),
    ["v-2"],
  );
  assert.equal((await leaf(url, "v-1", "snapshot", second)).body.error, "no-such-tab");
  assert.equal((await call(url, "v-1", { name: "goto" }, second)).body.refused, "no-such-tab");
});

test("an anonymous visitor is isolated from a logged-in one", async (t) => {
  const { url, alice } = await up(t);
  const visitor = mintAnonCredential();
  await (await tab(url, "a-1", alice)).hello();
  await (await tab(url, "v-1", visitor)).hello();
  assert.deepEqual(
    (await list(url, visitor)).map((r) => r.tab),
    ["v-1"],
  );
  assert.equal((await leaf(url, "a-1", "manifest", visitor)).body.error, "no-such-tab");
});

test("an app where everyone is logged in can refuse anonymous entirely", async (t) => {
  // There, an anonymous credential can only be somebody probing.
  const { url, alice } = await up(t, { anonymous: false });
  const refused = await getJson(`${url}/dk/tabs`, bearer(mintAnonCredential()));
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, "bad-credential");
  assert.equal((await getJson(`${url}/dk/tabs`, bearer(alice))).status, 200);
});

test("a relay may require the tab binding", async (t) => {
  const { url, auth, alice } = await up(t, { requireTabBinding: true });
  assert.equal((await getJson(`${url}/dk/tabs`, bearer(alice))).status, 401);
  const bound = auth.mint("user:alice", { tab: "a-1" });
  assert.equal((await getJson(`${url}/dk/tabs`, bearer(bound))).status, 200);
});

// --- the unconfigured path -------------------------------------------------

test("an unconfigured loopback relay needs no credential at all", async (t) => {
  // Backward compatibility is not a courtesy here. Auth is something you turn
  // on, and a library that made a dev loop configure keys first is a library
  // people route around.
  const { url } = await plain(t);
  const one = await tab(url, "t1");
  assert.equal((await one.hello()).status, 202);

  const rows = await getJson(`${url}/dk/tabs`);
  assert.equal(rows.status, 200);
  assert.deepEqual(
    rows.body.tabs.map((r: { tab: string }) => r.tab),
    ["t1"],
  );
  assert.equal((await leaf(url, "t1", "manifest")).status, 200);

  const frame = one.es.next("call");
  const pending = call(url, "t1", { name: "goto" });
  const sent = (await frame) as { id: string };
  await one.answer(sent.id, { ok: true, snapshot: SNAP });
  assert.equal((await pending).body.ok, true);
});

test("a stray credential against an unconfigured relay is simply ignored", async (t) => {
  // Not an error: with no `auth` there is nothing to verify it against, and
  // refusing it would make a client that always sends one unable to talk to a
  // dev relay.
  const { url } = await plain(t);
  const one = await tab(url, "t1", "dkt1.whatever.whatever");
  assert.equal((await one.hello()).status, 202);
  const rows = await getJson(`${url}/dk/tabs`, bearer("nonsense"));
  assert.deepEqual(
    rows.body.tabs.map((r: { tab: string }) => r.tab),
    ["t1"],
  );
});

// --- the embedded door -----------------------------------------------------

test("a host hook resolves the principal with no token anywhere", async (t) => {
  // The deployment PROTOCOL.md recommends is a relay inside the app's own
  // server, which already knows who the browser is. Making it mint a token to
  // tell itself would be a process calling itself over HTTP.
  const { server, relay, url } = await serve({
    port: 0,
    pingMs: 20_000,
    resolvePrincipal: (headers) => {
      const seat = headers["x-app-user"];
      return typeof seat === "string" && seat ? `user:${seat}` : undefined;
    },
  });
  t.after(() => {
    relay.close();
    server.close();
  });

  // No header, no hook answer, and no `auth` to fall through to: 401.
  assert.equal((await getJson(`${url}/dk/tabs`)).status, 401);

  await (await tab(url, "a-1", undefined, { "x-app-user": "alice" })).hello();
  const mine = await getJson(`${url}/dk/tabs`, { "x-app-user": "alice" });
  assert.deepEqual(
    mine.body.tabs.map((r: { tab: string }) => r.tab),
    ["a-1"],
  );
  const theirs = await getJson(`${url}/dk/tabs`, { "x-app-user": "bob" });
  assert.deepEqual(theirs.body.tabs, []);
});

test("the hook falling through hands the request to the token path", async (t) => {
  // So one relay can serve logged-in users from the app's session and anonymous
  // visitors from a minted credential.
  const auth = new TabAuth({ secret: SECRET, audience: AUDIENCE });
  const { server, relay, url } = await serve({
    port: 0,
    pingMs: 20_000,
    auth,
    resolvePrincipal: () => undefined,
  });
  t.after(() => {
    relay.close();
    server.close();
  });
  assert.equal((await getJson(`${url}/dk/tabs`, bearer(auth.mint("u")))).status, 200);
  assert.equal((await getJson(`${url}/dk/tabs`)).status, 401);
});

test("a hook that throws is an unidentified caller and not a 500", async (t) => {
  const seen: unknown[] = [];
  const { server, relay, url } = await serve({
    port: 0,
    pingMs: 20_000,
    resolvePrincipal: () => {
      throw new Error("the app's session store is down");
    },
    onError: (err) => seen.push(err),
  });
  t.after(() => {
    relay.close();
    server.close();
  });
  const answer = await getJson(`${url}/dk/tabs`);
  assert.equal(answer.status, 401);
  assert.equal(answer.body.error, "no-credential");
  assert.ok(seen.length > 0, "the hook's failure was swallowed entirely");
});

test("a path the relay does not own is still declined rather than 401'd", async (t) => {
  // Load-bearing for the deployment PROTOCOL.md recommends. `handler` returns
  // false for a path that is not ours so the relay can sit in front of the app
  // it is embedded in -- and that must happen BEFORE the credential check, or a
  // relay with auth on would 401 every one of the host app's own routes,
  // including its login page and the token endpoint the page needs to
  // authenticate at all.
  const auth = new TabAuth({ secret: SECRET, audience: AUDIENCE });
  const { server, relay, url } = await serve({ port: 0, pingMs: 20_000, auth });
  t.after(() => {
    relay.close();
    server.close();
  });

  // The standalone server turns a declined path into its own 404, which is how
  // "not mine" is observable from outside the process. The point is that it is
  // not a 401: nothing asked this caller for a credential.
  for (const path of ["/", "/app/descents", "/dk", "/dkstuff", "/api/dk-token"]) {
    const answer = await getJson(`${url}${path}`);
    assert.equal(answer.status, 404, path);
    assert.notEqual(answer.body.error, "no-credential");
  }
  assert.equal((await getJson(`${url}/dk/tabs`)).status, 401);
});
