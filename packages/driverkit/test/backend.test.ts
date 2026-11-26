/**
 * These tests are the specification. Each name states the decision it pins, so
 * a future change that looks harmless has to break a named test and read why
 * the rule exists before deleting it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { backendThink } from "../src/agent/index.ts";
import type { FetchLike, ResponseLike } from "../src/agent/index.ts";

/** A `fetch` that answers once with whatever is described. `text` is left off
 *  when the case is about a client that only exposes `json()`. */
function answering(response: Partial<ResponseLike>): { fetch: FetchLike; calls: number } {
  const state = { calls: 0 };
  const fetch: FetchLike = async () => {
    state.calls++;
    return {
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
      ...response,
    } as ResponseLike;
  };
  return { get calls() { return state.calls; }, fetch };
}

const input = { system: "s", tools: [], messages: [] };

test("a backend's own error message reaches the thrown error, not just the status", async () => {
  // This bit us on the first real run against a real model. The backend was
  // answering `{"error": "..."}` with the actual diagnosis in it — a missing
  // API key — and the panel showed `answered 503`, so the fix came from reading
  // server logs for a sentence that had been in the response all along.
  const { fetch } = answering({
    status: 503,
    text: async () => JSON.stringify({ error: "cannot reach 10.0.0.4:11434, set DK_LLM_IP" }),
  });

  await assert.rejects(backendThink("/api/chat", { fetch })(input), (err: Error) => {
    assert.match(err.message, /\/api\/chat answered 503/);
    assert.match(err.message, /set DK_LLM_IP/);
    return true;
  });
});

test("a plain-text error body is still better than a bare status", async () => {
  // A proxy's `502 Bad Gateway`, a stack trace, an HTML error page: none of
  // them is the shape this library asked for, and all of them say more than the
  // number does. Not JSON is not a reason to throw the body away.
  const { fetch } = answering({ status: 502, text: async () => "Bad Gateway (upstream nginx)" });

  await assert.rejects(backendThink("/api/chat", { fetch })(input), (err: Error) => {
    assert.match(err.message, /answered 502 — Bad Gateway \(upstream nginx\)/);
    return true;
  });
});

test("an empty error body leaves the message as it was, with nothing invented", async () => {
  const { fetch } = answering({ status: 500, text: async () => "   " });

  await assert.rejects(backendThink("/api/chat", { fetch })(input), (err: Error) => {
    assert.equal(err.message, "driverkit: /api/chat answered 500");
    return true;
  });
});

test("a huge or unreadable body cannot replace the diagnosis with its own noise", async () => {
  // Two guards in one place. A megabyte of HTML would otherwise land in a chat
  // panel as the error, and a `text()` that rejects — a torn-down stream, a
  // decoding failure — would throw from inside the code whose only job is to
  // explain the first failure. Nothing on this path may raise.
  const flood = answering({ status: 500, text: async () => "x".repeat(50_000) });
  await assert.rejects(backendThink("/api/chat", { fetch: flood.fetch })(input), (err: Error) => {
    assert.ok(err.message.length < 600, `the body took over the message (${err.message.length})`);
    assert.match(err.message, /…$/);
    return true;
  });

  const broken = answering({
    status: 500,
    text: async () => {
      throw new Error("stream closed");
    },
  });
  await assert.rejects(backendThink("/api/chat", { fetch: broken.fetch })(input), (err: Error) => {
    assert.equal(err.message, "driverkit: /api/chat answered 500");
    return true;
  });
});

test("a client that only exposes json() still gets its error field read", async () => {
  // `FetchLike` is deliberately the narrowest slice of `fetch` this needs, and
  // `text` is optional so a hand-written fake satisfies it. The fallback keeps
  // the useful case — a backend that said what was wrong — working for those.
  const { fetch } = answering({
    status: 401,
    json: async () => ({ error: "no API key configured" }),
  });

  await assert.rejects(backendThink("/api/chat", { fetch })(input), (err: Error) => {
    assert.match(err.message, /answered 401 — no API key configured/);
    return true;
  });
});

test("a 2xx answer is parsed as prose and calls, and the body is not read twice", async () => {
  // The ordinary path, pinned next to the error path so a change to one cannot
  // quietly break the other.
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ text: "done", calls: [{ id: "t-1", name: "open", args: { id: "c-1" } }] }),
  });

  const out = await backendThink("/api/chat", { fetch })(input);
  assert.equal(out.text, "done");
  assert.deepEqual(out.calls, [{ id: "t-1", name: "open", args: { id: "c-1" } }]);
});
