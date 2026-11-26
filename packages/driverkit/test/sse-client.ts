/**
 * A test-only `EventSource`, built on `node:http`.
 *
 * Not a shim to make the tests pass -- it is how the tests get to be real. The
 * browser side's hard parts are the frame parsing and the reconnect, and both
 * live on the far side of an `EventSource`. A hand-rolled object that resolves
 * promises would test the plumbing around them and skip the parsing entirely;
 * this speaks actual chunked HTTP to an actual relay, so a missing blank line
 * or a wrong `event:` name fails here rather than in a browser later.
 *
 * It deliberately does NOT auto-reconnect, which the real `EventSource` does.
 * That makes it the stricter client: every reconnect in these tests is
 * driverkit's own backoff path, the one nobody clicks through by hand.
 */

import http from "node:http";

type Listener = (event: { data?: string }) => void;

export class HttpEventSource {
  readyState = 0; // CONNECTING
  readonly url: string;
  /** Every comment line the server sent, so the 20s ping is assertable. */
  readonly comments: string[] = [];
  #listeners = new Map<string, Listener[]>();
  /** Frames that arrived with no `next()` waiting. See `next`. */
  #queued = new Map<string, unknown[]>();
  #waiting = new Map<string, Array<(value: unknown) => void>>();
  #req: http.ClientRequest | null = null;
  #res: http.IncomingMessage | null = null;
  #buffer = "";

  /** The status the stream was answered with, so a refusal is assertable. */
  status = 0;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.#req = http.get(url, { headers }, (res) => {
      this.status = res.statusCode ?? 0;
      this.#res = res;
      if (res.statusCode !== 200) {
        this.#fail();
        res.resume();
        return;
      }
      this.readyState = 1; // OPEN
      res.setEncoding("utf8");
      // `open` is emitted on the next tick so a listener registered right
      // after the constructor still sees it, exactly as the browser behaves.
      setImmediate(() => this.#emit("open", {}));
      res.on("data", (chunk: string) => this.#feed(chunk));
      res.on("end", () => this.#fail());
      res.on("error", () => this.#fail());
    });
    this.#req.on("error", () => this.#fail());
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.#listeners.get(type);
    if (list) list.push(listener);
    else this.#listeners.set(type, [listener]);
  }

  close(): void {
    this.readyState = 2; // CLOSED
    this.#res?.destroy();
    this.#req?.destroy();
  }

  /**
   * Resolves on the next frame of `type`, including one that has already
   * arrived.
   *
   * The queue is not a nicety. A stream that sends something the instant it
   * opens -- `/watch` does, with the current screen -- delivers it before a
   * test awaiting `open` gets to register a listener, so a plain listener-based
   * `next()` waits forever for a frame it already missed. Queueing makes the
   * assertion about what the server SENT rather than about when this process
   * happened to ask.
   */
  next(type: string): Promise<unknown> {
    const queue = this.#queued.get(type);
    if (queue && queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const waiting = this.#waiting.get(type);
      if (waiting) waiting.push(resolve);
      else this.#waiting.set(type, [resolve]);
    });
  }

  #feed(chunk: string): void {
    this.#buffer += chunk;
    let cut: number;
    while ((cut = this.#buffer.indexOf("\n\n")) !== -1) {
      const block = this.#buffer.slice(0, cut);
      this.#buffer = this.#buffer.slice(cut + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) this.comments.push(line.slice(1).trim());
        else if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) this.#emit(name, { data: data.join("\n") });
    }
  }

  #fail(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.#emit("error", {});
  }

  #emit(type: string, event: { data?: string }): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
    if (type === "open" || type === "error") return;
    const value = event.data ? JSON.parse(event.data) : undefined;
    const waiting = this.#waiting.get(type);
    if (waiting && waiting.length) waiting.shift()!(value);
    else {
      const queue = this.#queued.get(type);
      if (queue) queue.push(value);
      else this.#queued.set(type, [value]);
    }
  }
}

/** POST JSON and give back status plus parsed body. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return request("POST", url, JSON.stringify(body), headers);
}

export async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return request("GET", url, undefined, headers);
}

function request(
  method: string,
  url: string,
  payload?: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    /**
     * Why this helper swallows exactly one kind of error, and nothing else.
     *
     * One subtest POSTs 2 MiB at a 1 MiB limit to assert the 413. Writing a
     * body that size takes several socket writes, so depending on scheduling --
     * and it IS scheduling: this passes alone and resets under a loaded suite --
     * the sender can take a reset on its own socket before it has finished
     * writing, after the server has already answered. The assertion is about
     * the status the server SENT. A client that reported a transport failure
     * there would be reporting its own write, not the server's behaviour, and
     * the 2 MiB cannot shrink: a body that fits in one write is what hid the
     * real bug in the first place.
     *
     * So the swallowing is narrow in three ways, and all three matter. It
     * applies only to ECONNRESET and EPIPE -- a connection refused or a DNS
     * failure still fails loudly. It only ever defers: an eligible error waits
     * out a grace period and still rejects if no response turns up, so a server
     * that resets WITHOUT answering is caught, which is the actual failure this
     * test exists to detect. And a response that starts and then dies mid-body
     * rejects too, rather than hanging until the runner's timeout.
     *
     * Do not simplify this into a bare catch or an unconditional ignore. Either
     * one would make "the relay never answered" look identical to "the relay
     * answered and then the socket closed", and those are opposite outcomes.
     */
    const TOLERATED = new Set(["ECONNRESET", "EPIPE"]);
    const GRACE_MS = 250;
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = http.request(
      url,
      { method, headers: { ...(payload ? { "content-type": "application/json" } : {}), ...extra } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* a non-JSON body is itself the assertion in one test */
          }
          done(() => resolve({ status: res.statusCode ?? 0, body: parsed }));
        });
        // A response whose body was cut off is a real failure, not a tolerated
        // one: the status line arrived but the server did not finish saying
        // what it meant.
        const cut = () => done(() => reject(new Error(`response to ${method} ${url} ended early`)));
        res.on("aborted", cut);
        res.on("error", cut);
      },
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (!TOLERATED.has(err.code ?? "")) return done(() => reject(err));
      // Deferred, never dropped. If a response is on its way it will settle
      // this first; if nothing arrives, the reset was the whole story and it is
      // reported as one.
      const grace = setTimeout(() => {
        done(() => reject(new Error(`${err.code} with no response to ${method} ${url}`)));
      }, GRACE_MS);
      grace.unref?.();
    });

    if (payload) req.write(payload);
    req.end();
  });
}
