/**
 * The injected browser, for tests.
 *
 * `connect` takes `EventSource` and `fetch` as options so that this file can
 * exist. That is a design requirement rather than a testing convenience: the
 * page side's hard parts are the reconnect and the debounce, and a module that
 * can only run in a browser is a module whose reconnect is tested by hand, by
 * someone who does not have a flaky network that afternoon.
 */

import type { EventSourceLike, FetchLike, ResponseLike, StorageLike } from "../src/index.ts";

type Listener = (event: { data?: string }) => void;

export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  #listeners = new Map<string, Listener[]>();
  readonly url: string;
  // Not a parameter property: `--experimental-strip-types` erases types without
  // emitting code, so `constructor(readonly url)` has nowhere to put the assignment.
  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type);
    if (list) list.push(listener);
    else this.#listeners.set(type, [listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** The browser connected. */
  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }

  /** The relay sent a frame. Takes a string so a malformed one is expressible. */
  deliver(frame: unknown, name = "call"): void {
    this.#emit(name, { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  /** A blip the browser will retry by itself: the stream is still live. */
  blip(): void {
    this.readyState = 1;
    this.#emit("error", {});
  }

  /** The browser gave up. This is the only case driverkit may restart. */
  drop(): void {
    this.readyState = 2;
    this.#emit("error", {});
  }

  #emit(type: string, event: { data?: string }): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
}

export function eventSources() {
  const made: FakeEventSource[] = [];
  class Ctor extends FakeEventSource {
    constructor(url: string) {
      super(url);
      made.push(this);
    }
  }
  return {
    made,
    ctor: Ctor as unknown as { new (url: string): EventSourceLike },
    last: () => made[made.length - 1]!,
  };
}

export interface Post {
  url: string;
  body: any;
  /** So a test can assert the credential goes in a header and not the URL. */
  headers: Record<string, string>;
}

/**
 * The relay's half of `POST /dk/result`, as a status per request.
 *
 * `status` takes the frame and the attempt number so a test can say "409 the
 * first time this result arrives, 202 the second" -- which is the 409 path
 * PROTOCOL.md specifies, and the one `fetch` hides by resolving on a 4xx.
 * Returning a number rather than a `Response` keeps the fake honest about what
 * `connect` is allowed to read: the status, and nothing else.
 */
export function posts(
  options: {
    fail?: boolean;
    status?: (post: Post, attempt: number) => number | undefined;
  } = {},
) {
  const sent: Post[] = [];
  const attempts = new Map<string, number>();
  const fetch: FetchLike = (url, init) => {
    const post: Post = { url, body: JSON.parse(init.body), headers: init.headers ?? {} };
    sent.push(post);
    if (options.fail) return Promise.reject(new Error("offline"));
    if (!options.status) return Promise.resolve({ status: 202 } satisfies ResponseLike);
    // Keyed by frame identity rather than by call count, so "the second time
    // THIS result is sent" is expressible without counting the hellos in
    // between.
    const key = `${post.body?.t}:${post.body?.id ?? post.body?.snapshot?.rev ?? ""}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return Promise.resolve({ status: options.status(post, attempt) ?? 202 } satisfies ResponseLike);
  };
  return {
    sent,
    fetch,
    of: (t: string) => sent.filter((p) => p.body?.t === t),
  };
}

export function storage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

/** Poll instead of sleeping a guessed interval. */
export async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > until) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Open every stream `connect` brings up, as a browser would.
 *
 * The fake deliberately does not connect by itself -- every other test drives
 * `open()` by hand so the reconnect path is the one being asserted. But a test
 * about the 409 retry needs the stream AFTER the reconnect to come up too, and
 * there is no moment in the test to do that by hand: the retry is waiting on
 * exactly that event from inside `connect`. So this plays the one part of the
 * browser those tests cannot: it connects what gets opened, and nothing else.
 */
export function openAsTheyCome(made: FakeEventSource[]): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    for (const source of made) if (source.readyState === 0) source.open();
    const timer = setTimeout(tick, 1);
    (timer as { unref?: () => void }).unref?.();
  };
  tick();
  return () => void (stopped = true);
}
