/**
 * The default deployment story, in thirty lines.
 *
 * A browser cannot hold an API key. So the shape that actually ships is: the
 * page posts the conversation to the app's own backend, the backend — which
 * already authenticates this person and already holds the key — calls whatever
 * model it likes and answers with prose or tool calls. This is that post.
 *
 * It is a convenience and not a layer. `Think` is a function; if your backend
 * speaks a different shape, write the fetch yourself and do not use this. The
 * reason it is here at all is that the first thing anybody asks of a package
 * with no model client in it is "so what do I pass", and the answer should be
 * code rather than a paragraph.
 *
 * **What the backend should do with the two static fields.** `system` and
 * `tools` are byte-identical on every request within a run, and across runs
 * and across users for as long as the app's verbs do not change. A backend
 * that forwards them with its provider's caching marker on (Anthropic's
 * `cache_control`, or whatever the equivalent is wherever you are sending it)
 * pays for the app's whole capability list once instead of once per turn. A
 * backend that appends its own per-request string to `system` before
 * forwarding — a user id, a clock — gives that saving back and will not notice,
 * because nothing breaks. It just costs more.
 *
 * **What the backend must not do.** Trust the verb names. The page tells the
 * model what the app can do, and the model's reply comes back through here and
 * is executed against the driver mounted in *this* page, under *this* person's
 * session — which is the same authority model the relay has and PROTOCOL.md's
 * "Who is allowed to do this" applies unchanged. But a backend that stores or
 * replays these messages is storing the app's row data, because the snapshots
 * are in them.
 */

import type { Think, ThinkResult, ToolCall } from "./types.ts";

/** The slice of `fetch` this needs. Narrow so a test can satisfy it and so
 *  this file does not depend on DOM lib types. */
export interface FetchLike {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
    },
  ): Promise<ResponseLike>;
}

/** The slice of `Response` this reads. `text` is optional so a hand-written
 *  fake that only answers `json()` still satisfies the type; see `detailOf`. */
export interface ResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export interface BackendThinkOptions {
  /** Extra headers — a CSRF token, usually. */
  headers?: Record<string, string>;
  /** Injected, defaulting to the global. Same reason as everywhere else in
   *  this repository: a module that can only run in a browser is a module
   *  whose error path is tested by hand. */
  fetch?: FetchLike;
}

/**
 * `Think` over one HTTP endpoint.
 *
 * Posts `{ system, tools, messages }` and expects `{ text?, calls? }` back.
 * Credentials ride on the request the way the rest of the app's requests do —
 * `same-origin` is the browser default for a same-origin URL, so a session
 * cookie is already attached and there is nothing to configure.
 */
export function backendThink(url: string, options: BackendThinkOptions = {}): Think {
  const doFetch =
    options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);

  return async ({ system, tools, messages, signal }) => {
    if (!doFetch) throw new Error("driverkit: no fetch available; pass one");

    const response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify({ system, tools, messages }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      // Thrown, not returned as empty prose. A 500 from your own backend is
      // not the model declining to act, and swallowing it would surface as an
      // agent that silently stops having opinions. The loop lets it propagate
      // to the caller of `drive`, which is where a retry or a visible error
      // belongs.
      // With the body, because the body is where the diagnosis is. A backend
      // that answers `{"error": "no API key configured"}` has already told you
      // what is wrong; a panel that renders `answered 503` sends somebody to
      // read server logs for a sentence that was in the response all along.
      const detail = await detailOf(response);
      throw new Error(
        `driverkit: ${url} answered ${response.status}` + (detail ? ` — ${detail}` : ""),
      );
    }

    const body = (await response.json()) as { text?: unknown; calls?: unknown };
    const calls = Array.isArray(body.calls) ? (body.calls as ToolCall[]) : undefined;
    const result: ThinkResult = {
      ...(typeof body.text === "string" && body.text ? { text: body.text } : {}),
      ...(calls && calls.length ? { calls } : {}),
    };
    return result;
  };
}

/** How much of an error body may reach the thrown message. Enough for a
 *  sentence, short enough that an HTML error page or a stack trace cannot turn
 *  an exception into a wall of text in somebody's chat panel. */
const DETAIL_LIMIT = 400;

/**
 * The most useful sentence an error response has to offer, or `""`.
 *
 * Three shapes, in the order they are worth having. A JSON body with an
 * `error` string is a backend speaking on purpose and is used verbatim. Plain
 * text — a proxy's `502 Bad Gateway`, a stack trace — is still better than a
 * bare status, so a trimmed snippet of it goes in. An empty body yields
 * nothing, and the message stays as it was.
 *
 * Nothing in here may throw. This runs on the failure path, and an exception
 * raised while explaining an exception replaces the diagnosis with its own —
 * the one failure mode worse than the bug being fixed. So the body read, the
 * JSON parse and the field read are each allowed to fail quietly.
 */
async function detailOf(response: ResponseLike): Promise<string> {
  let raw: string;
  try {
    if (typeof response.text === "function") {
      raw = await response.text();
    } else {
      // A fake, or a client that only exposes `json()`. Re-serialising is not
      // the prettiest route to a string but it is the only one available, and
      // the `error` field survives it.
      raw = JSON.stringify(await response.json());
    }
  } catch {
    return "";
  }

  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text) return "";

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.trim()) return clip(error.trim());
    }
  } catch {
    // Not JSON. Fall through: the raw text is still the best thing to hand on.
  }

  return clip(text);
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_LIMIT ? flat.slice(0, DETAIL_LIMIT) + "…" : flat;
}
