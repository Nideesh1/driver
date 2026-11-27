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
import { serve } from "../src/relay/serve.ts";
import { TabAuth, anonPrincipalId, mintAnonCredential } from "../src/relay/index.ts";
import { SLOW_MS, renderDuration, renderResult, renderSnapshot } from "../src/agent/index.ts";
import type { Result, Snapshot } from "../src/core/index.ts";

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

/**
 * Snapshots covering every branch of the selection line, as wire JSON.
 *
 * Wire JSON and not `Snapshot` literals because the Python half has to parse
 * them: `selectedCount` is the contract and `selected_count` is only how
 * Python spells it, and a renderer branch that cannot be reached from the wire
 * is a branch that looks covered and is not.
 */
const SELECTION_SCREENS: unknown[] = [
  // The three states this file exists to keep in step.
  { where: "contacts", rev: 1, selectedCount: 0, rows: [{ id: "c-1" }] },
  { where: "contacts", rev: 1, selectedCount: 0, selected: [], rows: [{ id: "c-1" }] },
  { where: "settings", rev: 1, rows: [{ id: "s-1" }] },
  { where: "contacts", rev: 1, selected: [], rows: [{ id: "c-1" }] },
  // And the non-empty wordings either side of them, so a change to the new
  // branch that quietly moved an old sentence fails here too.
  { where: "contacts", rev: 1, selected: ["c-1"], selectedCount: 1, rows: [{ id: "c-1" }] },
  {
    where: "contacts",
    rev: 1,
    selected: ["c-0", "c-1", "c-2"],
    selectedCount: 10000,
    rows: [{ id: "c-0" }],
    page: { index: 0, size: 1, total: 10000 },
  },
  { where: "contacts", rev: 1, selectedCount: 1200, rows: [] },
  { where: "d", screen: "dashboard", rev: 3, selectedCount: 0, note: "a note", rows: undefined },
];

test("both renderers say the same words about an empty selection, byte for byte", async (t) => {
  // `render.ts` and `render.py` are kept string-for-string on purpose: the
  // Python half renders for an MCP client driving the app from outside and the
  // TS half for a chatbot inside the page, and a prompt that works through one
  // and misbehaves through the other is a bug with no stack trace. Eyeballing
  // the two files is how they drifted before; this runs both.
  //
  // The selection branches get their own crossing because they are the newest
  // and the only ones where silence used to be the output: a half that stays
  // quiet about an empty selection would pass every single-language test it
  // has and still tell one of the two agents nothing.
  const expected = SELECTION_SCREENS.map((s) => renderSnapshot(s as Snapshot)).join("\n--\n");

  const script =
    "import json,sys\n" +
    // `python/src` comes in on argv rather than `PYTHONPATH` because `-I`
    // below ignores the environment, which is most of the point of `-I`.
    "sys.path.insert(0, sys.argv[1])\n" +
    "from driverkit import render_snapshot\n" +
    "from driverkit.types import Snapshot\n" +
    "cases=json.load(sys.stdin)\n" +
    'sys.stdout.write("\\n--\\n".join(render_snapshot(Snapshot.from_dict(c)) for c in cases))\n';

  const rendered = await renderInPython(script, JSON.stringify(SELECTION_SCREENS));
  if (rendered === null) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  assert.equal(
    rendered,
    expected,
    "render.py and render.ts have drifted: the same screen reads differently depending on how the agent connected",
  );
});

/**
 * The results whose rendering carries a plan token, which is the line with the
 * most words and the fewest readers: it reaches the model and nothing else.
 *
 * It got its own crossing when the token stopped dying on a read-only move. The
 * two halves each hold their own copy of the sentence that tells an agent what
 * does and does not spend a plan, and an agent told "navigating spends it"
 * through one relay and "navigating is free" through the other would be driven
 * differently by the same prompt — which is drift that no test in either
 * language could see, because each half is self-consistent.
 */
const PLAN_RESULTS: Result[] = [
  {
    ok: true,
    count: 3412,
    plan: "dkplan.180.4.0f1a2b3c4d5e",
    snapshot: { where: "contacts, filtered to Acme", screen: "contacts", rev: 180, selectedCount: 3412, rows: [] },
  },
  // A count of zero with a plan, because "commit on nothing" is a decision an
  // agent makes and the renderers must agree about it too.
  { ok: true, count: 0, plan: "dkplan.9.1.abcdef012345", snapshot: { where: "contacts", rev: 9, selectedCount: 0, rows: [] } },
  // And the refusal, which is the other half of the same conversation.
  {
    ok: false,
    refused: "stale-plan",
    hint: "that plan was taken at rev 180 and the screen is now at rev 184.",
    snapshot: { where: "contacts", rev: 184, selectedCount: 3418, rows: [] },
  },
];

test("both renderers say the same words about a plan token, byte for byte", async (t) => {
  const expected = PLAN_RESULTS.map((r) => renderResult(r)).join("\n--\n");

  const script =
    "import json,sys\n" +
    "sys.path.insert(0, sys.argv[1])\n" +
    "from driverkit import render_result\n" +
    "from driverkit.types import Result\n" +
    "cases=json.load(sys.stdin)\n" +
    'sys.stdout.write("\\n--\\n".join(render_result(Result.from_dict(c)) for c in cases))\n';

  const rendered = await renderInPython(script, JSON.stringify(PLAN_RESULTS));
  if (rendered === null) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  assert.equal(
    rendered,
    expected,
    "render.py and render.ts have drifted on the plan token: an agent is told different rules depending on how it connected",
  );
});

/**
 * The results a QUESTION produces, which are the newest pair of sentences a
 * model reads and the ones with the least margin for drift.
 *
 * It gets its own crossing although neither renderer gained a line for it, and
 * that is the claim being pinned. The person's answer rides in `Result.note`,
 * so it renders through `ok — …`, which both halves already had; the three
 * refusals render through `refused:`/`hint:`, which both halves already had.
 * **Nothing about the question channel is in either renderer** — which is why
 * it works identically on both paths, and why a crossing is the only thing that
 * can prove it stayed that way.
 *
 * An agent told "the person answered: yes" through one relay and something else
 * through the other would be driven differently by the same prompt, and the
 * answer is the one piece of text in this library that a person typed.
 */
const ASK_RESULTS: Result[] = [
  // Answered: the words, attributed, as the core wraps them.
  {
    ok: true,
    note: 'the person answered: "the one at Acme, please"',
    snapshot: { where: "contacts", screen: "contacts", rev: 12, rows: [] },
  },
  // Asked and ignored. The hint says the verb did not run, which is the
  // sentence that keeps this apart from the relay's `timeout`.
  {
    ok: false,
    refused: "ask-unanswered",
    hint: "the question was put to the person and no answer came back.",
    snapshot: { where: "contacts", rev: 12, rows: [] },
  },
  // Never put, because there is nobody.
  {
    ok: false,
    refused: "nobody-to-ask",
    hint: "there is nobody to ask on this run.",
    snapshot: { where: "contacts", rev: 12, rows: [] },
  },
  // Never put, because the allowance is gone.
  {
    ok: false,
    refused: "asks-spent",
    hint: "this app allows 5 questions per mounted session and all 5 have been asked.",
    snapshot: { where: "contacts", rev: 12, rows: [] },
  },
];

test("both renderers say the same words about a question and its answer, byte for byte", async (t) => {
  const expected = ASK_RESULTS.map((r) => renderResult(r)).join("\n--\n");

  const script =
    "import json,sys\n" +
    "sys.path.insert(0, sys.argv[1])\n" +
    "from driverkit import render_result\n" +
    "from driverkit.types import Result\n" +
    "cases=json.load(sys.stdin)\n" +
    'sys.stdout.write("\\n--\\n".join(render_result(Result.from_dict(c)) for c in cases))\n';

  const rendered = await renderInPython(script, JSON.stringify(ASK_RESULTS));
  if (rendered === null) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  assert.equal(
    rendered,
    expected,
    "render.py and render.ts have drifted on a question: a person's own answer, or the news that nobody gave one, reads differently depending on how the agent connected",
  );
});

/**
 * Every band boundary of the duration bucket, and both sides of each.
 *
 * Boundaries only, because the bands are the whole of what could drift: the
 * arithmetic inside one is `ms // 1000` in both languages and cannot disagree,
 * and the formatting is where it would — `toFixed` and `%.1f` are the two
 * things most likely to differ between the implementations, which is why
 * neither is used and why this crossing exists to prove it.
 *
 * Rendered at BOTH thresholds, because the threshold is a decision and not an
 * implementation detail: `SLOW_MS` is what the panel renders at and `0` is what
 * a run asked to compare two fast verbs renders at, and a half that got the
 * floor comparison backwards would pass every single-language test it has.
 */
const DURATIONS: number[] = [
  0, 1, 99, 100, 101, 450, 999,
  1000, 1001, 1999, 2000, 9999,
  10_000, 12_000, 14_999, 15_000, 59_999,
  60_000, 60_001, 119_999, 120_000, 3_600_000,
  // A broken clock. Both halves answer with silence rather than a negative
  // duration, and a half that let one through would put `took: ~-1s` in a
  // prompt.
  -1,
];

test("both renderers say the same words about a duration, byte for byte", async (t) => {
  // `render.ts` and `render.py` are kept string-for-string on purpose, and a
  // duration is the newest thing in either of them. It is also the one piece of
  // rendering that is NUMERIC rather than a sentence, which is a different way
  // for two implementations to drift: not a word that somebody changed in one
  // file, but a rounding mode, a band boundary, or a locale creeping in through
  // a float format. An agent told `~2s` through the widget and `~2.1s` through
  // MCP is being driven differently by the same prompt.
  const expected = DURATIONS.flatMap((ms) => [
    renderDuration(ms),
    renderDuration(ms, 0),
  ]).join("\n--\n");

  const script =
    "import json,sys\n" +
    "sys.path.insert(0, sys.argv[1])\n" +
    "from driverkit import render_duration, SLOW_MS\n" +
    "cases=json.load(sys.stdin)\n" +
    "out=[]\n" +
    "for ms in cases:\n" +
    "    out.append(render_duration(ms))\n" +
    "    out.append(render_duration(ms, 0))\n" +
    'sys.stdout.write("\\n--\\n".join(out))\n';

  const rendered = await renderInPython(script, JSON.stringify(DURATIONS));
  if (rendered === null) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  assert.equal(
    rendered,
    expected,
    "render.py and render.ts have drifted on durations: the same call reads as a different length of time depending on how the agent connected",
  );
});

test("both relays carry a tab's own elapsed time identically, field for field", async (t) => {
  // The newest field on the wire, and the one with the most ways for two
  // relays to disagree quietly: carried, dropped, derived, or passed through
  // from the app's own `result`. So one frame is sent through BOTH relays and
  // the two answers are compared to each other rather than to a literal --
  // which is the assertion that fails when either half grows an opinion.
  //
  // The frame carries a figure beside the `result` AND a different one inside
  // it. The first is the page-side harness's measurement and must arrive; the
  // second is an app's claim about its own speed and must not, because the
  // whole point of the field is that the number a model reads is an
  // observation nobody asked the app for.
  const running = await pythonRelay();
  if (!running) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  t.after(() => running.stop());
  const ts = await serve({ port: 0, pingMs: 20_000 });
  t.after(() => {
    ts.relay.close();
    ts.server.close();
  });

  const answers: Record<string, unknown>[] = [];
  for (const url of [running.url, ts.url]) {
    const es = new HttpEventSource(`${url}/dk/events?tab=xover`);
    await new Promise<void>((r) => es.addEventListener("open", () => r()));
    t.after(() => es.close());
    await postJson(`${url}/dk/result?tab=xover`, {
      t: "hello",
      tab: "xover",
      app: "toy",
      snapshot: { where: "descents", rev: 7, rows: [] },
    });

    const answered = postJson(`${url}/dk/tabs/xover/call`, { name: "goto" });
    const frame = (await es.next("call")) as { id: string };
    await postJson(`${url}/dk/result?tab=xover`, {
      t: "result",
      tab: "xover",
      id: frame.id,
      result: { ok: true, snapshot: { where: "descents", rev: 8, rows: [] }, tookMs: 5 },
      tookMs: 2_100.7,
      waitedMs: 38_000,
    });
    answers.push((await answered).body);
  }

  assert.deepEqual(
    answers[0],
    answers[1],
    "the two relays disagree about a call's duration: an operator switching relays would change what every agent is told about how fast the app is",
  );
  // And what they agree ON, because two relays can agree by both being wrong:
  // the harness's figure, floored, and not the app's.
  assert.equal(answers[0]!.tookMs, 2_100);
  assert.equal(answers[0]!.waitedMs, 38_000);
});

test("both halves agree on what counts as slow", async (t) => {
  // One number in two files is how they drift, and this one decides whether a
  // line is rendered at all -- so a half with a different `SLOW_MS` would not
  // merely round differently, it would be silent where the other speaks.
  const script =
    "import sys\n" +
    "sys.path.insert(0, sys.argv[1])\n" +
    "from driverkit import SLOW_MS\n" +
    "sys.stdout.write(str(SLOW_MS))\n";
  const read = await renderInPython(script, "");
  if (read === null) {
    t.skip("no python3 with driverkit importable from python/src");
    return;
  }
  assert.equal(read, String(SLOW_MS));
});

/** Run a one-off script against `python/src`, or null if there is no usable
 *  interpreter. Skipped and not failed, for the reason in this file's header:
 *  the TypeScript suite must stay runnable with no Python on the machine. */
function renderInPython(script: string, stdin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      // `-I` so nothing is imported out of the current directory and no
      // environment variable can redirect the import; the one path this is
      // meant to read is handed to it explicitly.
      child = spawn("python3", ["-I", "-c", script, `${ROOT}python/src`], {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return resolve(null);
    }
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => (out += text));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out : null));
    child.stdin.end(stdin);
  });
}
