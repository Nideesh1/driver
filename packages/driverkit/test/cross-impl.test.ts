/**
 * The TypeScript test client against the PYTHON relay.
 *
 * This file exists because of one bug that two full suites missed.
 * `python/tests` drives the Python relay with `urllib` and `http.client`;
 * `relay.test.ts` drives the TypeScript relay with `sse-client.ts`. Both were
 * green while the Python relay silently dropped every chunked request body and
 * then corrupted the connection the body was left in — because no test ever
 * crossed over, and the two clients happen to differ in exactly the way that
 * mattered: `postJson` below sets `content-type` and no `content-length`, so
 * Node chunks it, and `urllib` always sends a length.
 *
 * So the client here is `sse-client.ts` unmodified, deliberately. The point is
 * not to test chunking — it is that the helper the TypeScript suite already
 * trusts should get the same answers from either relay, whatever it happens to
 * put on the wire. A helper written for the test is a helper that can be
 * written around.
 *
 * PROTOCOL.md's reason for caring: "Two conforming relays disagreeing on these
 * is worse than either choice." A second implementation is only worth having if
 * something checks it is the same implementation.
 *
 * Skipped, not failed, where there is no usable Python. The TypeScript suite
 * must stay runnable on a machine with no interpreter and no `driverkit`
 * installed; a cross-language test that cannot run is still worth having, and a
 * cross-language test that breaks `npm test` for everyone is not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { HttpEventSource, getJson, postJson } from "./sse-client.ts";
import { TabAuth, anonPrincipalId, mintAnonCredential } from "../src/relay/index.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

interface Running {
  url: string;
  stop: () => void;
}

/**
 * Start `driverkit-relay` out of the source tree, or return null.
 *
 * `--port 0` and then the port is read back off stderr rather than guessed: a
 * fixed port makes this test fail when anything else on the machine happens to
 * hold it, which is the kind of flake that gets a test deleted rather than
 * fixed.
 */
async function pythonRelay(extra: string[] = [], env: Record<string, string> = {}): Promise<Running | null> {
  for (const exe of ["python3", "python"]) {
    const child = await tryStart(exe, extra, env);
    if (child) return child;
  }
  return null;
}

function tryStart(
  exe: string,
  extra: string[] = [],
  env: Record<string, string> = {},
): Promise<Running | null> {
  return new Promise((resolve) => {
    // `stdio: ["ignore", "pipe", "pipe"]` is exactly this type: no stdin, two
    // readable pipes. It used to be cast to `ChildProcessWithoutNullStreams`,
    // which claims a writable `stdin` this child has not got -- nothing here
    // writes to it, so the cast bought nothing and said something false.
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(exe, ["-m", "driverkit.serve_relay", "--port", "0", "--ping", "20", ...extra], {
        cwd: ROOT,
        env: { ...process.env, PYTHONPATH: `${ROOT}python/src`, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return resolve(null);
    }

    let settled = false;
    const done = (value: Running | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === null) child.kill("SIGKILL");
      resolve(value);
    };

    // A missing interpreter, a missing `driverkit`, an ImportError: all of them
    // are "no usable Python here" and all of them are a skip rather than a
    // failure. Only a URL on stderr counts as a relay.
    let noise = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      noise += text;
      const found = /http:\/\/[\d.a-fA-F:\[\]]+:\d+/.exec(noise);
      if (found) done({ url: found[0], stop: () => child.kill("SIGTERM") });
    });
    child.on("error", () => done(null));
    child.on("exit", () => done(null));
    const timer = setTimeout(() => done(null), 10_000);
    timer.unref?.();
  });
}

test("the TypeScript test client gets the same answers from the Python relay", async (t) => {
  const running = await pythonRelay();
  if (!running) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  t.after(() => running.stop());
  const { url } = running;

  // `postJson` sets content-type and no content-length, so Node sends this
  // chunked. That is not incidental to the test, it IS the test: `http.server`
  // de-chunks nothing, so a handler reading only `Content-Length` sees zero
  // bytes here, answers a `hello` it thinks names no tab, and leaves the chunk
  // framing in the socket for the next request to be parsed out of.
  const es = new HttpEventSource(`${url}/dk/events?tab=xover`);
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  t.after(() => es.close());

  const said = await postJson(`${url}/dk/result?tab=xover`, {
    t: "hello",
    tab: "xover",
    app: "toy",
    manifest: { version: "abc123", app: "toy", verbs: [{ name: "goto", describe: "open one" }] },
    snapshot: { where: "descents", rev: 7, rows: [{ id: "01a2" }] },
  });
  assert.equal(said.status, 202, "the Python relay did not accept a chunked `hello`");

  // The second request on the same connection is the other half of the bug.
  // Node's global agent keeps sockets alive, so this reuses the socket the
  // `hello` went out on -- and an undrained body there is parsed as the start
  // of this request: `Parse Error: Expected HTTP/, RTSP/ or ICE/`.
  const listing = await getJson(`${url}/dk/tabs`);
  assert.equal(listing.status, 200);
  assert.deepEqual(
    listing.body.tabs.map((row: { tab: string; manifestVersion: string }) => [row.tab, row.manifestVersion]),
    [["xover", "abc123"]],
    "the chunked `hello` did not reach the registry",
  );

  // And a whole call round trip, so this asserts the frames agree and not just
  // that a body arrived.
  const answered = postJson(`${url}/dk/tabs/xover/call`, { name: "goto", args: { where: "c-9" }, rev: 7 });
  const frame = (await es.next("call")) as { id: string; name: string; args: Record<string, unknown>; rev: number };
  assert.equal(frame.name, "goto");
  assert.deepEqual(frame.args, { where: "c-9" });
  assert.equal(frame.rev, 7);

  await postJson(`${url}/dk/result?tab=xover`, {
    t: "result",
    id: frame.id,
    result: { ok: true, note: "opened", snapshot: { where: "contact c-9", rev: 8, rows: [] } },
  });
  const result = await answered;
  assert.equal(result.status, 200);
  assert.equal(result.body.note, "opened");
  // 200 with `ok: true`, not a 4xx: the status is a hint and the body is
  // authoritative, in both relays.
  assert.equal(result.body.ok, true);
});

test("a token the TypeScript minter made is accepted by the Python relay", async (t) => {
  // The sharpest form of "two relays that disagree is worse than either": the
  // two token implementations must produce the SAME BYTES, or an app with a
  // Node backend and a Python relay -- or the reverse -- cannot authenticate
  // anybody, and each language's own suite passes while the pair is broken.
  //
  // Nothing here parses a token. One side mints, the other verifies, and what
  // is asserted is the status. A test that compared two token strings would
  // pass with both implementations wrong in the same way.
  const secret = "k".repeat(40);
  const audience = "xover-test";
  const running = await pythonRelay(["--audience", audience], { DK_SECRET: secret });
  if (!running) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  t.after(() => running.stop());
  const { url } = running;

  const auth = new TabAuth({ secret, audience });
  const alice = auth.mint("user:alice");
  const bob = auth.mint("user:bob");

  // Alice's tab, bound by the Python relay to the principal the TypeScript
  // minter named.
  const es = new HttpEventSource(`${url}/dk/events?tab=a-1`, { "x-dk-token": alice });
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  t.after(() => es.close());
  const said = await postJson(
    `${url}/dk/result?tab=a-1`,
    { t: "hello", tab: "a-1", app: "toy", title: "Alice" },
    { "x-dk-token": alice },
  );
  assert.equal(said.status, 202, "the Python relay did not accept a TypeScript-minted token");

  const mine = await getJson(`${url}/dk/tabs`, { authorization: `Bearer ${alice}` });
  assert.deepEqual(
    mine.body.tabs.map((row: { tab: string }) => row.tab),
    ["a-1"],
  );

  // And the isolation rules answer the same statuses and slugs as the
  // TypeScript relay does in `auth.test.ts`.
  const theirs = await getJson(`${url}/dk/tabs`, { authorization: `Bearer ${bob}` });
  assert.deepEqual(theirs.body.tabs, []);
  const probe = await getJson(`${url}/dk/tabs/a-1/snapshot`, { authorization: `Bearer ${bob}` });
  assert.equal(probe.status, 404);
  assert.equal(probe.body.error, "no-such-tab");
  assert.deepEqual(
    probe,
    await getJson(`${url}/dk/tabs/never-minted/snapshot`, { authorization: `Bearer ${bob}` }),
  );

  const refused = await getJson(`${url}/dk/tabs`, { authorization: "Bearer hunter2" });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, "bad-credential");
  assert.equal(refused.body.hint, "present a fresh tab token");
  assert.equal((await getJson(`${url}/dk/tabs`)).body.error, "no-credential");

  // An anonymous credential the TypeScript side minted resolves to the same
  // principal in Python -- the derivation is keyless and must be identical, or
  // a visitor who reloads against the other relay loses their tabs.
  const visitor = mintAnonCredential();
  const anonEs = new HttpEventSource(`${url}/dk/events?tab=v-1`, { "x-dk-token": visitor });
  await new Promise<void>((r) => anonEs.addEventListener("open", () => r()));
  t.after(() => anonEs.close());
  await postJson(`${url}/dk/result?tab=v-1`, { t: "hello", tab: "v-1" }, { "x-dk-token": visitor });
  assert.deepEqual(
    (await getJson(`${url}/dk/tabs`, { authorization: `Bearer ${visitor}` })).body.tabs.map(
      (row: { tab: string }) => row.tab,
    ),
    ["v-1"],
    "the anonymous principal derivation differs between the two implementations",
  );
  assert.equal(anonPrincipalId(visitor).startsWith("anon:"), true);
});
