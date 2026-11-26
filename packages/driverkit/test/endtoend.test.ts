/**
 * The three parties, all real, in one process.
 *
 * `connect.test.ts` injects fakes so it can drive the awkward edges, and
 * `relay.test.ts` plays the tab by hand so the relay's failures are its own.
 * Both are necessary and neither is sufficient: a test suite where one codebase
 * supplies both ends of a contract passes happily when both ends agree on the
 * wrong thing. So this file wires a real `mount()` to a real `createRelay()`
 * over real chunked HTTP and speaks to it as an agent would -- the only kind of
 * test that would catch a `rev` the page drops or an `event:` name that moved.
 *
 * The only thing standing in for a browser is `EventSource`, backed by
 * `node:http`. It does not auto-reconnect, which the real one does, so every
 * reconnect here exercises driverkit's own backoff rather than the browser's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mount } from "../src/core/index.ts";
import { createRelay } from "../src/relay/index.ts";
import { serve } from "../src/relay/serve.ts";
import { HttpEventSource, getJson, postJson } from "./sse-client.ts";
import { connect } from "../src/browser/index.ts";
import type { Connection, EventSourceCtor, FetchLike } from "../src/browser/index.ts";
import type { Snapshot } from "../src/browser/frames.ts";
import type { VerbContext } from "../src/core/index.ts";

const EventSourceOverHttp = HttpEventSource as unknown as EventSourceCtor;
const realFetch: FetchLike = (url, init) => fetch(url, init);

/** The toy app from the core tests, with a human-driven change available. */
function app(name = "toy") {
  const lanes = new Map([["01a2", "pruning"], ["01b7", "doing"]]);
  let rev = 1;
  let where = "descents";
  const visible = (): Snapshot => ({
    where,
    rev,
    rows: [...lanes].map(([id, lane]) => ({ id, lane })),
  });
  const driver = mount({
    app: name,
    visible,
    verbs: [
      {
        name: "select-matching",
        // A `describe` verb: it resolves the predicate and REPORTS the count,
        // and a separate `commit` verb acts on the selection. Two calls, so a
        // number is always seen before data moves. Declared rather than
        // implied, because `connect()` refuses to publish a manifest with a
        // verb that never said what it does — the core's gate fires on
        // `kind: "commit"` and cannot see a silent verb at all.
        kind: "describe",
        describe: "select every descent in a lane",
        args: { lane: { type: "string", describe: "lane to match" } },
        run: ({ lane }: { lane: string }) => {
          const matched = [...lanes.values()].filter((l) => l === lane).length;
          rev++;
          return { count: matched, note: `${matched} selected of ${lanes.size} rows` };
        },
      },
      {
        name: "set-lane",
        // `commit`, and `reversible` because a lane move is undone by moving
        // it back. The pair is what keeps this fixture publishable with no
        // approver declared, which is what it was doing before either publish
        // check existed: an absent `reversible` makes no claim, so a commit
        // that has not said there is a way back is treated as one without.
        kind: "commit",
        reversible: true,
        describe: "move a descent to a lane",
        args: {
          id: { type: "string", describe: "descent id" },
          lane: { type: "string", describe: "target lane", oneOf: ["doing", "pruning", "held"] },
        },
        refuses: ["no-such-descent", "machine-may-not-leave-pruning"],
        run: ({ id, lane }: { id: string; lane: string }, ctx: VerbContext) => {
          if (!lanes.has(id)) return ctx.refuse("no-such-descent", `no descent \`${id}\``);
          if (lanes.get(id) === "pruning" && lane !== "pruning") {
            return ctx.refuse("machine-may-not-leave-pruning", "pruning is the human gate");
          }
          lanes.set(id, lane);
          rev++;
        },
      },
    ],
  });
  return {
    driver,
    lanes,
    /** A person clicked something. */
    human: (to: string) => {
      where = to;
      rev++;
    },
  };
}

async function relayOn(t: { after: (fn: () => unknown) => void }, port = 0, options = {}) {
  const { server, relay, url } = await serve({ port, ...options });
  const stop = async () => {
    relay.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  t.after(stop);
  return { url, relay, stop, port: Number(new URL(url).port) };
}

function page(driver: ReturnType<typeof app>["driver"], url: string, tab: string, extra = {}): Connection {
  return connect(driver, {
    relay: url,
    tab,
    app: "toy",
    title: "Descents — toy",
    url: "/app/descents",
    storage: null,
    EventSource: EventSourceOverHttp,
    fetch: realFetch,
    ...extra,
  });
}

const callAs = (url: string, tab: string, body: unknown) =>
  postJson(`${url}/dk/tabs/${encodeURIComponent(tab)}/call`, body);

/** Poll instead of sleeping a guessed interval. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("an agent drives a mounted app end to end and gets the screen the call produced", async (t) => {
  const { url, relay } = await relayOn(t);
  const toy = app();
  const conn = page(toy.driver, url, "e2e-1");
  t.after(() => conn.disconnect());
  await waitFor(() => relay.tabs().length === 1 && relay.tabs()[0]!.rev === 1);

  const res = await callAs(url, "e2e-1", { name: "set-lane", args: { id: "01b7", lane: "held" } });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // The app really changed -- this is the whole point, and the thing a
  // screenshot-and-click driver cannot promise.
  assert.equal(toy.lanes.get("01b7"), "held");
  // And the snapshot is the one AFTER the call: one round trip to act and
  // observe, which over ten steps is ten model turns not spent re-reading.
  assert.equal(res.body.snapshot.rev, 2);
  assert.deepEqual(res.body.snapshot.rows.find((r: { id: string }) => r.id === "01b7"), {
    id: "01b7",
    lane: "held",
  });
});

test("the human gate survives the trip: the app's refusal reaches the agent as written", async (t) => {
  const { url, relay } = await relayOn(t);
  const toy = app();
  const conn = page(toy.driver, url, "e2e-2");
  t.after(() => conn.disconnect());
  await waitFor(() => relay.tabs().length === 1);

  const res = await callAs(url, "e2e-2", { name: "set-lane", args: { id: "01a2", lane: "held" } });

  // Nothing in the relay or the page knows what pruning is, and that is the
  // design: the app declared the rule, the driver enforced it, and both
  // intermediaries moved bytes. A refusal invented anywhere else would be a
  // rule in two places.
  assert.equal(res.body.refused, "machine-may-not-leave-pruning");
  assert.equal(res.body.hint, "pruning is the human gate");
  assert.equal(toy.lanes.get("01a2"), "pruning", "the refusal did not actually hold");

  // It was declared up front in the cacheable half, so a briefed agent never
  // had to make this call to learn the answer.
  const manifest = await getJson(`${url}/dk/tabs/e2e-2/manifest`);
  const declared = manifest.body.verbs.find((v: { name: string }) => v.name === "set-lane");
  assert.ok(
    declared.refuses.includes("machine-may-not-leave-pruning"),
    "the refusal was not advertised in the manifest",
  );
  assert.ok(!JSON.stringify(manifest.body).includes("01a2"), "live data leaked into the cached half");
});

test("a stale rev is refused by the driver and surfaces through the relay unchanged", async (t) => {
  const { url, relay } = await relayOn(t);
  const toy = app();
  const conn = page(toy.driver, url, "e2e-3");
  t.after(() => conn.disconnect());
  await waitFor(() => relay.tabs().length === 1);

  // The agent read rev 1, then a person moved the screen while it was thinking.
  toy.human("descent 01a2");
  const res = await callAs(url, "e2e-3", { name: "set-lane", args: { id: "01b7", lane: "held" }, rev: 1 });

  assert.equal(res.body.ok, false);
  assert.equal(res.body.refused, "stale");
  // The hint is the instruction, and it has to arrive intact through two hops:
  // the agent needs to know to re-read rather than retry the same dead rev.
  assert.match(res.body.hint, /rev 1 .* rev 2.*read again/);
  // And the refusal carries the CURRENT screen, so the re-read it asks for has
  // already happened.
  assert.equal(res.body.snapshot.rev, 2);
  assert.equal(res.body.snapshot.where, "descent 01a2");
  assert.equal(toy.lanes.get("01b7"), "doing", "a stale call was applied anyway");
});

test("two tabs of the same app in one relay stay separate screens", async (t) => {
  const { url, relay } = await relayOn(t);
  const left = app();
  const right = app();
  const a = page(left.driver, url, "left");
  const b = page(right.driver, url, "right");
  t.after(() => {
    a.disconnect();
    b.disconnect();
  });
  await waitFor(() => relay.tabs().length === 2);

  await callAs(url, "left", { name: "set-lane", args: { id: "01b7", lane: "held" } });

  // One id, one screen. This is what "a tab id is a capability" means in
  // practice: addressing the wrong one would act as a different human.
  assert.equal(left.lanes.get("01b7"), "held");
  assert.equal(right.lanes.get("01b7"), "doing", "a call reached the wrong tab");

  // Both are listed, both share a manifest version -- same verbs, so the agent
  // caches the static half once for every tab of this app, across users.
  const tabs = (await getJson(`${url}/dk/tabs`)).body.tabs as Array<{ tab: string; manifestVersion: string }>;
  assert.deepEqual(tabs.map((x) => x.tab).sort(), ["left", "right"]);
  assert.equal(tabs[0]!.manifestVersion, tabs[1]!.manifestVersion);
});

test("a change a person made is pushed, so an agent mid-task learns the screen moved", async (t) => {
  const { url, relay } = await relayOn(t);
  const toy = app();
  const conn = page(toy.driver, url, "e2e-4", { debounceMs: 20 });
  t.after(() => conn.disconnect());
  await waitFor(() => relay.tabs().length === 1);

  toy.human("descents, filtered to pruning");
  conn.changed();

  // Without this frame the agent's next call is refused as stale, which is
  // safe but costs a turn. With it, the agent can re-read before it acts --
  // this is what makes two parties watching one screen workable.
  await waitFor(async () => (await getJson(`${url}/dk/tabs/e2e-4/snapshot`)).body.rev === 2);
  const snap = (await getJson(`${url}/dk/tabs/e2e-4/snapshot`)).body;
  assert.equal(snap.where, "descents, filtered to pruning");
});

test("a page whose relay restarted reconnects, re-says hello, and is drivable again", async (t) => {
  const first = await relayOn(t);
  const toy = app();
  const conn = page(toy.driver, first.url, "survivor", { backoffMs: 20, maxBackoffMs: 100 });
  t.after(() => conn.disconnect());
  await waitFor(() => first.relay.tabs().length === 1);

  // The relay goes away entirely: every stream ends and the registry is gone.
  await first.stop();

  // ...and comes back on the same address, knowing nothing.
  const { server, relay, url } = await serve({ port: first.port });
  t.after(async () => {
    relay.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  assert.equal(relay.tabs().length, 0);

  // Nobody told the page to do anything. It noticed, backed off, reconnected,
  // and re-sent `hello` -- which is the reconnect contract, because the tab id
  // is minted by the tab so exactly this can work.
  // Waited on `app`, not on the tab count: the registry entry appears when the
  // stream opens and `hello` lands a moment later on a separate POST. That gap
  // is real and visible to an agent, which is why /manifest 404s rather than
  // serving an empty verb list in it.
  await waitFor(() => relay.tabs()[0]?.app === "toy", 5_000);
  assert.equal(relay.tabs().length, 1);
  assert.equal(relay.tabs()[0]!.tab, "survivor", "the page came back under a different identity");

  // And the agent's id still works: it never had to learn a new one.
  const res = await callAs(url, "survivor", { name: "set-lane", args: { id: "01b7", lane: "held" } });
  assert.equal(res.body.ok, true);
  assert.equal(toy.lanes.get("01b7"), "held");
});

test("a count a verb reported survives every hop to the agent", async (t) => {
  const { url, relay } = await relayOn(t);
  const toy = app();
  const conn = page(toy.driver, url, "counting");
  t.after(() => conn.disconnect());
  await waitFor(() => relay.tabs()[0]?.app === "toy");

  const res = await callAs(url, "counting", { name: "select-matching", args: { lane: "doing" } });

  // The number a human would have to see before pressing a bulk button. It is
  // produced by the app, wrapped by the core, posted by the page and forwarded
  // by the relay -- four hops, and any one of them rebuilding the result from
  // the fields it happened to know about would drop it silently. Which is why
  // every hop stores and forwards the result WHOLE.
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 1);
  assert.match(res.body.note, /1 selected of 2 rows/);
  assert.equal(res.body.snapshot.rev, 2);
});

test("shared presence works end to end: a human clicks, a watching agent is told", async (t) => {
  const { url, relay } = await relayOn(t);
  const toy = app();
  const conn = page(toy.driver, url, "shared", { debounceMs: 20 });
  t.after(() => conn.disconnect());
  await waitFor(() => relay.tabs()[0]?.app === "toy");

  // The agent subscribes rather than polling. Polling /snapshot is fine for a
  // scripted client that acts and stops; an agent sitting beside a human would
  // have to poll fast to feel live and then pay for every poll.
  const watching = new HttpEventSource(`${url}/dk/tabs/shared/watch`);
  await new Promise<void>((r) => watching.addEventListener("open", () => r()));
  t.after(() => watching.close());
  assert.equal(((await watching.next("snapshot")) as any).snapshot.rev, 1);

  const moved = watching.next("snapshot");
  toy.human("descents, filtered to pruning");
  conn.changed();

  // Four real hops: the app's own change, the page's debounce, the tab's POST,
  // the relay's fan-out. Every one of them is a place the frame could have died
  // silently, and before /watch existed the last one is exactly where it did.
  const frame = (await moved) as { t: string; tab: string; snapshot: Snapshot };
  assert.equal(frame.t, "snapshot");
  assert.equal(frame.tab, "shared");
  assert.equal(frame.snapshot.rev, 2);
  assert.equal(frame.snapshot.where, "descents, filtered to pruning");
});

test("the relay can live inside a server that owns the rest of the URL space", async (t) => {
  // PROTOCOL.md's first argument for SSE: the relay belongs in a server you
  // already run. If embedding meant losing the app's own routes, the argument
  // would be hollow and everyone would run the standalone process instead.
  const { createServer } = await import("node:http");
  const relay = createRelay();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("the app answered");
  });
  relay.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const toy = app();
  const conn = page(toy.driver, url, "embedded");
  t.after(async () => {
    conn.disconnect();
    relay.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  await waitFor(() => relay.tabs().length === 1);
  assert.equal((await callAs(url, "embedded", { name: "set-lane", args: { id: "01b7", lane: "doing" } })).body.ok, true);
  // The app still owns everything that is not /dk/*.
  assert.equal((await getJson(`${url}/app/descents`)).body, "the app answered");
});
