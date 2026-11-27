/**
 * `focus` and the live `url` through the TypeScript relay.
 *
 * The twin of `python/tests/test_focus.py`'s `FocusOnTheWire`, assertion for
 * assertion, because PROTOCOL.md's whole argument is that two conforming
 * relays must not disagree — and a field added to one of them and not the
 * other is the cheapest possible way to make them disagree.
 *
 * What is being pinned is as much what the relay does NOT do: it carries the
 * string and originates none, exactly as with `rev`. A relay that decided
 * which tab was active would be a second place that decides, beside the page
 * that is the only thing able to see `document.hasFocus()` at all. The rule
 * that turns the field into a choice lives in the client — `pick_tab` — which
 * is how both relays stay behaviourally identical: by neither of them having
 * it.
 *
 * Drives the relay by hand over real SSE, not through `driverkit/browser`, for
 * the reason the main relay file gives: a test that drives both sides of a
 * contract with one codebase passes happily when both ends agree on the wrong
 * thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { serve } from "../src/relay/serve.ts";
import { HttpEventSource, getJson, postJson } from "./sse-client.ts";
import type { Snapshot, TabSummary } from "../src/relay/frames.ts";

const SNAP: Snapshot = { where: "descents", rev: 7, rows: [{ id: "01a2" }] };

async function up(t: { after: (fn: () => unknown) => void }) {
  const { server, relay, url } = await serve({ port: 0, pingMs: 20_000 });
  t.after(() => {
    relay.close();
    server.close();
  });
  return url;
}

async function tab(url: string, id: string) {
  const es = new HttpEventSource(`${url}/dk/events?tab=${encodeURIComponent(id)}`);
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  const post = (body: unknown) =>
    postJson(`${url}/dk/result?tab=${encodeURIComponent(id)}`, body);
  return {
    es,
    hello: (extra: Record<string, unknown> = {}) =>
      post({
        t: "hello",
        tab: id,
        app: "toy",
        title: "Descents — toy",
        url: "/app/descents",
        snapshot: SNAP,
        ...extra,
      }),
    push: (snapshot: Snapshot, extra: Record<string, unknown> = {}) =>
      post({ t: "snapshot", snapshot, tab: id, ...extra }),
  };
}

const rows = async (url: string): Promise<Record<string, TabSummary>> => {
  const { body } = await getJson(`${url}/dk/tabs`);
  return Object.fromEntries(
    (body.tabs as TabSummary[]).map((r) => [r.tab, r] as const),
  );
};

test("`hello` reports focus and `GET /dk/tabs` carries it untouched", async (t) => {
  const url = await up(t);
  const one = await tab(url, "t1");
  t.after(() => one.es.close());
  await one.hello({ focus: "focused" });

  assert.equal((await rows(url))["t1"]!.focus, "focused");
});

test("a push corrects the focus and the url that `hello` alone never could", async (t) => {
  // THE STALE URL, which is the bug that rode along on the focus work.
  // `TabInfo.url` came from `hello` ALONE, so it was wrong from the first
  // client-side route change -- and a single-page app navigates without
  // reconnecting, so `hello` may never come again. A push was already going out
  // whenever the page moved; carrying the url on it costs one short string.
  const url = await up(t);
  const one = await tab(url, "t1");
  t.after(() => one.es.close());
  await one.hello({ focus: "focused", url: "/app/#/contacts" });
  await one.push(
    { where: "companies", rev: 8 },
    { focus: "visible", url: "/app/#/companies/acme" },
  );

  const row = (await rows(url))["t1"]!;
  assert.equal(row.focus, "visible");
  assert.equal(row.url, "/app/#/companies/acme");
  assert.equal(row.rev, 8);
});

test("a push that carries neither leaves both as they were", async (t) => {
  // Absent means "did not say", upserted exactly as `hello` upserts. A tab
  // connected by a hand-written loop, or by a driverkit older than these
  // fields, must read as it always did.
  const url = await up(t);
  const one = await tab(url, "t1");
  t.after(() => one.es.close());
  await one.hello({ focus: "focused", url: "/app/#/contacts" });
  await one.push({ where: "contacts", rev: 9 });

  const row = (await rows(url))["t1"]!;
  assert.equal(row.focus, "focused");
  assert.equal(row.url, "/app/#/contacts");
});

test("a tab that never reports focus has no `focus` key at all", async (t) => {
  // Not `null` and not `"hidden"`. Absence is unknown, and a client that read
  // it as "not the one" would quietly stop being able to drive that tab.
  const url = await up(t);
  const one = await tab(url, "t1");
  t.after(() => one.es.close());
  await one.hello();

  assert.equal("focus" in (await rows(url))["t1"]!, false);
});

test("the relay originates no focus of its own for a tab that did not say", async (t) => {
  // Two tabs, one reporting. The silent one stays silent rather than being
  // inferred to be the hidden one -- the relay cannot see
  // `document.hasFocus()`, and an inference here would be the relay deciding
  // something only the page knows.
  const url = await up(t);
  const a = await tab(url, "tab-a");
  const b = await tab(url, "tab-b");
  t.after(() => {
    a.es.close();
    b.es.close();
  });
  await a.hello({ focus: "focused" });
  await b.hello();

  const listed = await rows(url);
  assert.equal(listed["tab-a"]!.focus, "focused");
  assert.equal("focus" in listed["tab-b"]!, false);
});
