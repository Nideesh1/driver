/**
 * driverkit/browser — the page side.
 *
 * One function. It holds an `EventSource` open, answers `call` frames by
 * handing them to the driver `mount()` returned, and POSTs the `Result` back.
 * It makes no decisions: it does not validate args, does not check `rev`, does
 * not refuse. The driver owns all of that, and PROTOCOL.md's reason is the one
 * that matters -- a second place that validates is a second set of rules, and
 * the in-page chatbot calling `driver.call()` directly would get the other one.
 *
 * No dependencies and no framework. `EventSource` and `fetch` are built in,
 * which is half of why the protocol is SSE in the first place.
 */

import type { Driver, Result } from "./frames.ts";
import type { CallFrame, HelloFrame, ResultFrame, SnapshotFrame } from "./frames.ts";

/**
 * The browser pieces, as structural types.
 *
 * Narrow on purpose: these describe only what `connect` actually touches, so
 * the real `EventSource` satisfies them and so does a thirty-line fake. That
 * is the point -- see `ConnectOptions.EventSource`.
 */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
}

export interface EventSourceCtor {
  new (url: string): EventSourceLike;
}

/**
 * The part of a `Response` the page side reads: the status, and nothing else.
 *
 * Narrow for the same reason `EventSourceLike` is -- the real `Response`
 * satisfies it, and so does `{ status: 409 }` in a test. The body is never
 * read: PROTOCOL.md pins `POST /dk/result` to `202 {"ok":true}` on acceptance
 * and says a payload there "would be an invitation to build a second,
 * divergent return path". The answer to a call travels to the agent, not back
 * up this POST.
 */
export interface ResponseLike {
  /**
   * Optional only so an injected stub that returns nothing still typechecks.
   * An absent status is read as acceptance: there is nothing to read it as
   * instead, and the real `fetch` always carries one.
   */
  readonly status?: number;
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<ResponseLike>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `EventSource.CLOSED`. Spelled out because the fake need not define statics. */
const CLOSED = 2;

/**
 * How many times one `result` is re-sent after a 409 before it is given up on.
 *
 * Bounded, because the failure this guards against is symmetrical. A result
 * dropped on the floor costs the agent the relay's whole deadline waiting for
 * an answer that already exists; a result re-sent forever costs it a tab that
 * reconnects in a loop and never answers anything. Two is enough for the case
 * this is for -- the relay dropped the tab between the `call` going out and the
 * `result` coming back, and one reconnect fixes that -- and anything more is a
 * relay that is not coming back.
 */
const RESULT_RETRIES = 2;

/**
 * How long a 409 retry waits for the new stream to open before going anyway.
 *
 * It has to be bounded. Everything queued behind the retried result waits on
 * this, so an unbounded wait on a stream that never opens is a tab that never
 * answers anything again -- a worse failure than the dropped result this is
 * fixing. On expiry the retry goes out regardless, takes another 409, and
 * spends one of its `RESULT_RETRIES`.
 */
const RECONNECT_WAIT_MS = 3_000;

/**
 * How many times one frame is re-sent after a 401 with a fresh credential.
 *
 * One, because the case this is for is a token that lapsed between the stream
 * opening and this POST, and one refresh fixes that. A second attempt would
 * only help if the FIRST refresh also produced a dead token, which is a
 * misconfiguration -- a wrong audience, a key the relay does not have -- and a
 * misconfiguration retried in a loop is a page making a request per attempt
 * and never answering anything.
 */
const AUTH_RETRIES = 1;

/**
 * The `sessionStorage` key the anonymous secret lives under.
 *
 * Separate from the tab id's key: an explicitly passed `tab` is deliberately
 * NOT written back, and an anonymous credential still has to be remembered
 * across the page's own reconnects or every reconnect would be a new visitor.
 */
const ANON_KEY = "driverkit:anon";

export interface ConnectOptions {
  /** Where the relay lives: an origin, or "" for same-origin. No trailing slash. */
  relay: string;
  /**
   * This tab's id. Omit and one is minted and remembered.
   *
   * PROTOCOL.md: minted by the tab, not the relay, so a reconnect resumes the
   * same identity. An agent mid-task holds this id; if a dropped stream came
   * back under a new one, every call it had queued up would answer
   * `no-such-tab` and the agent would conclude the window had closed.
   */
  tab?: string;
  app?: string;
  /** Only so a human can tell two tabs apart when asked "which one?". */
  title?: string;
  url?: string;
  /**
   * How long to coalesce `changed()` calls. PROTOCOL.md: "sent on a debounce,
   * not on every keystroke". A snapshot push is a courtesy to an agent that is
   * mid-task -- it says "the human moved, re-read" -- and one per keystroke
   * would cost more than the information is worth.
   */
  debounceMs?: number;
  /**
   * Poll `driver.snapshot().rev` this often and push when it moves.
   *
   * Off unless asked for: an app that calls `changed()` where it changes needs
   * no polling, and that is the better shape. This is the escape hatch for a
   * codebase where the mutations are too scattered to instrument, and it is
   * floored at 500ms because `visible()` runs on every tick and the core
   * documents it as "must be cheap", not free.
   */
  watchMs?: number;
  /** First reconnect delay; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;

  /**
   * Injected transports, defaulting to the globals.
   *
   * These are a design requirement, not a testing shim. A page side that can
   * only run inside a browser can only be verified inside a browser, which in
   * practice means it is verified by hand, which means the reconnect path --
   * the one that matters and the one nobody clicks through -- is the untested
   * one. Taking both as options costs two lines and makes `hello` on reconnect
   * and snapshot debouncing assertable in-process.
   */
  EventSource?: EventSourceCtor;
  fetch?: FetchLike;
  /**
   * The tab token this page presents, or a function that produces one.
   *
   * A relay serving more than one person needs to know which person this tab
   * belongs to, and the only thing that knows is the app's own backend. So the
   * backend mints a short-lived signed token (see `TabAuth` in
   * `@driverkit/relay`) and the page hands it over. The relay reads the
   * principal out of it and scopes everything to that person: `/dk/tabs` lists
   * their tabs and nobody else's, and another person's tab id is
   * indistinguishable from one that was never minted.
   *
   * PASS A FUNCTION, NOT A STRING, unless the page is short-lived. A token
   * expires -- deliberately, because a stateless token's short life is what
   * substitutes for the revocation it cannot have -- and a string captured at
   * page load is the one shape that cannot survive that. The function is
   * called before every `hello`, which means before every reconnect, and again
   * when a `POST /dk/result` comes back 401. That is the whole of the
   * mid-session expiry handling and it is why the option is a getter.
   *
   * It may be async: a getter that fetches `/api/dk-token` is the expected
   * implementation. The first stream then opens a tick later than it otherwise
   * would, which nothing depends on.
   *
   * Omit it against an unconfigured relay -- a loopback dev relay with no auth
   * -- which needs no credential at all.
   */
  token?: string | (() => string | Promise<string>);
  /**
   * Mint an anonymous credential when there is no `token`.
   *
   * For an app whose visitors are not logged in. The page mints 256 random
   * bits, keeps them in `sessionStorage` beside the tab id, and presents them;
   * the relay derives a principal from them, so two anonymous visitors are two
   * principals and are isolated from each other. "Anonymous" is not one
   * bucket.
   *
   * OFF by default, and the default is the interesting part. On, a page whose
   * author forgot to wire `token` would quietly work: every user would become
   * their own anonymous stranger, everything would look fine, and their agent
   * -- which has a real token -- would see zero tabs. Off, that author gets a
   * 401 and an answer. An app that really is anonymous says so in one flag.
   *
   * The credential is a bearer capability and not an identity: whoever holds
   * the string is that visitor. It dies with the tab, by design.
   */
  anonymous?: boolean;
  /**
   * Where the tab token rides on the `/dk/events` URL.
   *
   * `EventSource` cannot set a header, so a page's only two options for the
   * stream are a cookie the app set (same-origin: nothing in any URL, and the
   * best choice available) or a query parameter.
   *
   * `"query"` is the default because it works cross-origin, and it is a
   * liability: A QUERY PARAMETER ENDS UP IN EVERY REVERSE PROXY'S ACCESS LOG.
   * Pass `"cookie"` when the app sets a `__Host-dk_token` cookie and the relay
   * is same-origin, and no token appears in a URL at all. The `/dk/result`
   * POSTs always use a header regardless, because `fetch` can set one.
   */
  tokenIn?: "query" | "cookie";
  /** Where the tab id is remembered. Pass null to not remember it. */
  storage?: StorageLike | null;
  randomUUID?: () => string;
  /** A failed POST or a malformed frame lands here. Default: ignore it. */
  onError?: (err: unknown) => void;
}

export interface Connection {
  /** The id the relay knows this tab by. A capability: do not log it. */
  readonly tab: string;
  /** Tell the relay the page moved on its own. Debounced; cheap to over-call. */
  changed: () => void;
  /** Stop. Idempotent. Does not unmount the driver. */
  disconnect: () => void;
}

export function connect(driver: Driver, options: ConnectOptions): Connection {
  const relay = options.relay.replace(/\/+$/, "");
  const debounceMs = options.debounceMs ?? 250;
  const backoffMs = options.backoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 10_000;
  const onError = options.onError ?? (() => {});
  const ES = options.EventSource ?? (globalThis as { EventSource?: EventSourceCtor }).EventSource;
  const post = options.fetch ?? ((globalThis.fetch?.bind(globalThis) as FetchLike | undefined));
  const storage =
    options.storage === null
      ? null
      : (options.storage ?? (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null);

  if (!ES) throw new Error("driverkit: no EventSource. Pass options.EventSource.");
  if (!post) throw new Error("driverkit: no fetch. Pass options.fetch.");

  // Before anything is opened, for the reason a relay with remote access and
  // no way to identify callers refuses to start rather than serving: this is
  // the moment the app becomes drivable by something that is not in the room.
  //
  // Kinds first, and the order is an argument rather than a style: the commit
  // check reads `kind`, so a manifest with silent verbs cannot be assessed by
  // it at all. "Declare your kinds" and then "now say who approves these
  // three commits" is two true sentences in the order they can be acted on;
  // the other order asks about a list that is not yet known to be complete.
  requireDeclaredKinds(driver);
  requireApprovalPolicy(driver);

  const tab = options.tab ?? remembered(storage, options.app, options.randomUUID, onError);
  const tokenIn = options.tokenIn ?? "query";
  const mintToken =
    typeof options.token === "function"
      ? options.token
      : options.token !== undefined
        ? () => options.token as string
        : options.anonymous
          ? () => anonCredential(storage, options.app, onError)
          : null;

  let live = true;
  /**
   * The credential in hand, refreshed by `refresh()`.
   *
   * Kept rather than fetched per request so that the common case -- a static
   * string, or no credential at all -- opens its stream synchronously inside
   * the `connect()` call that asked for it, exactly as it did before tokens
   * existed.
   */
  let credential: string | undefined =
    // Synchronous only: an async getter is awaited by `open()` instead. The
    // cast is safe because the two synchronous branches of `mintToken` above
    // are the only ones reachable here.
    mintToken && typeof options.token !== "function" ? (mintToken() as string) : undefined;
  let opening = false;
  let source: EventSourceLike | null = null;
  let delay = backoffMs;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let reopen: ReturnType<typeof setTimeout> | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;

  const url = (path: string) => `${relay}${path}?tab=${encodeURIComponent(tab)}`;

  /**
   * The `/dk/events` URL, with the credential if it travels in the query.
   *
   * Only the stream URL ever carries it. The `/dk/result` POSTs put it in
   * `X-DK-Token`, where no access log will write it down.
   */
  const streamUrl = () =>
    credential !== undefined && tokenIn === "query"
      ? `${url("/dk/events")}&dk_token=${encodeURIComponent(credential)}`
      : url("/dk/events");

  /** Fetch a fresh credential. Resolves even on failure; see the comment. */
  async function refresh(): Promise<void> {
    if (!mintToken) return;
    try {
      credential = await mintToken();
    } catch (err) {
      // Reported and then ignored, keeping whatever we had. A token endpoint
      // that is briefly down must not take the tab down with it: the stream we
      // already hold is still bound to this principal in the relay, and a
      // slightly stale token is a better bet than no attempt at all. The relay
      // answers 401 if it has really lapsed, and that path retries.
      onError(err);
    }
  }

  /**
   * The frames waiting to go up, oldest first, one POST in flight at a time.
   *
   * A queue rather than a POST per frame, and the reason is ordering under
   * retry. The moment one `result` can be re-sent, two results can be in
   * flight at once with the second one's POST started first, and an agent that
   * reads a `c-18` answer before a `c-17` answer is an agent acting on a screen
   * that has already moved. Serialising also makes "never twice" structural:
   * there is one entry per frame and it is removed when the relay has taken it,
   * so a retry cannot race a first attempt that was still in the air.
   *
   * The cost is that a slow POST holds up the next frame. That is the right
   * way round -- this is a handful of frames a minute, and PROTOCOL.md's "no
   * queue" rule is about the relay not holding CALLS for a tab that is gone,
   * not about a tab pipelining its own answers.
   */
  interface Outbound {
    frame: HelloFrame | ResultFrame | SnapshotFrame;
    tries: number;
    /** 401 retries spent on this frame. See `AUTH_RETRIES`. */
    stale: number;
  }
  const outbox: Outbound[] = [];
  let draining = false;
  /** Resolved by the stream's `open` listener. See `reconnect`. */
  let openWaiters: Array<() => void> = [];

  function up(frame: HelloFrame | ResultFrame | SnapshotFrame): void {
    if (!live) return;
    const entry: Outbound = { frame, tries: 0, stale: 0 };
    // `hello` jumps the queue, and only `hello` does. It is the frame that
    // makes this tab exist in the relay's registry -- `ingest` 409s every frame
    // for a tab it has no stream for, `hello` included -- so everything already
    // waiting needs it to have landed first. Appending it would mean a `result`
    // that took a 409 gets re-sent against the same empty registry it was just
    // refused by, which is a retry that cannot succeed.
    if (frame.t === "hello") outbox.unshift(entry);
    else outbox.push(entry);
    if (!draining) void drain();
  }

  /**
   * Send what is queued, oldest first, until it is empty.
   *
   * `drain` runs synchronously as far as the first POST, so the common case --
   * an idle outbox -- still issues its request inside the `up()` call that
   * queued it, exactly as the old one-POST-per-frame code did.
   */
  async function drain(): Promise<void> {
    draining = true;
    try {
      while (live && outbox.length) {
        const entry = outbox[0]!;
        // Removal is by identity, not `shift()`. A `hello` may have been
        // unshifted ahead of this entry while its POST was in the air, and
        // `shift()` would then drop the wrong frame.
        const forget = () => {
          const at = outbox.indexOf(entry);
          if (at !== -1) outbox.splice(at, 1);
        };

        let status: number | undefined;
        try {
          // `?tab=` as well as the body field: PROTOCOL.md's frame shapes name
          // the tab only in `hello`, so a relay that reads one and not the
          // other still works. Belt and braces on the field the whole
          // correlation depends on.
          const answer = await post!(url("/dk/result"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // A HEADER, never the query string. `fetch` can set one, so
              // there is no reason for a token to be written into an access
              // log here -- unlike the `EventSource` URL, which has no choice.
              ...(credential === undefined ? {} : { "x-dk-token": credential }),
            },
            body: JSON.stringify(entry.frame),
          });
          status = answer?.status;
        } catch (err) {
          // The POST never completed: offline, DNS, a relay that is not
          // listening. Not retried here -- there is no status to tell a
          // transient failure from a permanent one, and `EventSource` is about
          // to notice the same outage and run the reconnect path anyway.
          forget();
          onError(err);
          continue;
        }

        if (status === undefined || status < 400) {
          forget();
          continue;
        }

        if (status === 401) {
          // THE MID-SESSION EXPIRY PATH, and the reason `token` is a getter.
          //
          // The relay authenticates the stream once, at open, and the binding
          // it made lasts as long as the stream -- so a lapsed token does not
          // disconnect this tab and does not lose the calls in flight. But
          // `/dk/result` is a new request and carries its own credential, so
          // the symptom of expiry is exactly this: a tab that still receives
          // `call` frames and cannot answer them.
          //
          // Mint a fresh one and send the same bytes again. Bounded, because a
          // token endpoint answering with a credential the relay will not
          // accept -- a wrong audience, a key the relay does not have -- is a
          // misconfiguration, and retrying it forever is a page that never
          // answers anything while making a request per attempt.
          if (!mintToken || entry.stale >= AUTH_RETRIES) {
            forget();
            onError(
              new Error(
                `driverkit: the relay rejected this tab's credential on a \`${entry.frame.t}\` ` +
                  (mintToken
                    ? `frame after ${entry.stale} refreshes. Check the token's audience and key.`
                    : "frame, and no `token` option was given to refresh it."),
              ),
            );
            continue;
          }
          entry.stale += 1;
          await refresh();
          continue;
        }

        if (status === 409) {
          // PROTOCOL.md: "409 means the frame was fine and the relay's state is
          // what made it unacceptable. A tab that gets 409 may reasonably
          // reconnect and retry." The relay has dropped this tab -- its stream
          // closed and the registry entry went with it -- so reconnecting is
          // the whole of the fix, and it is the one status where re-sending the
          // same bytes can work.
          //
          // `fetch` resolves on 409, which is why ignoring the status was not a
          // missing nicety: the answer the agent is holding a request open for
          // was lost here silently, and the agent waited out the relay's full
          // 15-second deadline for a result that already existed.
          const again = entry.frame.t === "result" && entry.tries < RESULT_RETRIES;
          if (again) {
            entry.tries += 1;
          } else {
            forget();
            // Only a `result` is worth a noise. A `hello` or a `snapshot` is
            // superseded by the `hello` the reconnect below sends, which
            // carries a newer snapshot than the one that just 409'd -- re-
            // sending the stale one would push an older `rev` after a newer
            // one, which is the one thing a watcher cannot recover from.
            if (entry.frame.t === "result") {
              onError(
                new Error(
                  `driverkit: relay still 409s result \`${entry.frame.id}\` after ${entry.tries} reconnects; ` +
                    `the agent will see it as a timeout`,
                ),
              );
            }
          }
          await reconnect();
          continue;
        }

        // 400 and anything else. PROTOCOL.md: "400 means the frame could never
        // have been accepted by anyone... a tab that gets 400 has a bug." So it
        // is loud and it is never retried: re-sending a frame the relay has
        // already judged malformed is a loop with no exit, and the bug is here.
        forget();
        onError(
          new Error(
            `driverkit: relay answered ${status} to a \`${entry.frame.t}\` frame. ` +
              `A 4xx on /dk/result that is not a 409 is a bug in this tab, not in the relay.`,
          ),
        );
      }
    } finally {
      draining = false;
    }
  }

  /**
   * Drop this stream and bring up a new one, resolving once `hello` is queued.
   *
   * Not just `open()`: the registry entry the 409 is about belongs to a stream
   * the relay has already forgotten, and a tab that kept holding it would wait
   * for a `call` frame down a pipe nothing is writing to.
   *
   * It resolves on the new stream's `open` rather than on a timer because the
   * `open` listener is what sends `hello`, and the retried result must go out
   * behind that `hello`. The queue does the rest: `hello` is unshifted ahead of
   * the retry, and the loop above awaits each POST, so the ordering is
   * structural rather than a guessed delay.
   */
  function reconnect(): Promise<void> {
    if (!live) return Promise.resolve();
    if (source) {
      const old = source;
      source = null;
      try {
        old.close();
      } catch (err) {
        onError(err);
      }
      if (reopen) {
        clearTimeout(reopen);
        reopen = null;
      }
      open();
    } else if (!reopen) {
      // No stream and nothing scheduled: the error path has already given up,
      // or two 409s arrived and the first one's reconnect is what closed this.
      open();
    }
    // Otherwise a reopen is already on a timer -- the backoff path's. Waiting
    // for it rather than racing it, because two streams for one tab id is a
    // supersede, and superseding the stream we are waiting on is a loop.
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      openWaiters.push(finish);
      const timer = setTimeout(finish, RECONNECT_WAIT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  function hello(): void {
    const frame: HelloFrame = {
      t: "hello",
      tab,
      ...(options.app === undefined ? {} : { app: options.app }),
      manifest: driver.manifest(),
      snapshot: driver.snapshot(),
      ...(options.title === undefined ? { ...titleFromPage() } : { title: options.title }),
      ...(options.url === undefined ? { ...urlFromPage() } : { url: options.url }),
    };
    up(frame);
  }

  async function onCall(frame: CallFrame): Promise<void> {
    let result: Result;
    try {
      result = await driver.call(
        frame.name,
        frame.args ?? {},
        // Only when the agent sent one. The core treats a present `rev` or
        // `screen` as a check and an absent one as opting out of it, so passing
        // `{ rev: undefined }` would be fine today and a trap the day somebody
        // tightens that. `screen` is the agent's claim about which screen it
        // read, checked by the core before `rev`; this hop is where it would
        // otherwise be dropped, which would leave the field working in-page and
        // silently doing nothing over the relay. `plan` is here for the same
        // reason and with the most to lose by being missed: a commit that
        // requires a token and is reached by a path that drops it is refused
        // forever, and one reached by a path that invents one would be worse.
        {
          ...(frame.rev === undefined ? {} : { rev: frame.rev }),
          ...(frame.screen === undefined ? {} : { screen: frame.screen }),
          ...(frame.plan === undefined ? {} : { plan: frame.plan }),
        },
      );
    } catch (err) {
      // `mount()`'s driver turns a throwing verb into `refused: "threw"`, so
      // this is only reachable for a hand-written driver. Still answered
      // rather than dropped: the agent is holding a request open on this id,
      // and silence costs it the relay's full timeout.
      onError(err);
      result = {
        ok: false,
        refused: "threw",
        hint: err instanceof Error ? err.message : String(err),
        snapshot: driver.snapshot(),
      };
    }
    up({ t: "result", id: frame.id, result, tab });
  }

  /**
   * Bring up a stream, fetching a credential first when that takes a tick.
   *
   * Split from `start` so the common cases -- a static token, an anonymous
   * secret out of `sessionStorage`, or no credential at all -- still open the
   * stream synchronously inside the `connect()` call. Only an async `token`
   * getter defers, and `opening` is what stops a `reconnect()` arriving in that
   * window from opening a second stream for one tab id.
   */
  function open(): void {
    if (!live || opening) return;
    if (typeof options.token !== "function") {
      start();
      return;
    }
    opening = true;
    void (async () => {
      await refresh();
      opening = false;
      start();
    })();
  }

  function start(): void {
    if (!live) return;
    const es = new ES!(streamUrl());
    source = es;

    es.addEventListener("open", () => {
      // Every open, not just the first. `EventSource` reconnects by itself and
      // the relay has forgotten the tab by then -- the registry entry dropped
      // when the stream closed -- so a `hello` that were sent once would leave
      // a tab that is connected and unidentifiable. This re-send is the
      // reconnect handling; the rest is the browser's.
      delay = backoffMs;
      // Before `hello`, so a reconnect presents a live credential. `/dk/events`
      // was authenticated with whatever we had a moment ago; the POST that
      // follows is a separate request and may be the one the old token no
      // longer covers. Awaiting here is not an option -- this is an
      // `EventSource` listener -- so the refresh runs beside the `hello`, and
      // the 401 path above is what catches the race on the rare occasion the
      // old token was already dead.
      if (typeof options.token === "function") void refresh();
      hello();
      // After `hello()`, never before. A 409 retry waiting here resumes on the
      // next microtask and must find the `hello` already at the head of the
      // outbox, or it goes out first and 409s again.
      const waiting = openWaiters;
      openWaiters = [];
      for (const waiter of waiting) waiter();
    });

    es.addEventListener("call", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as CallFrame;
        if (frame?.t !== "call" || typeof frame.id !== "string") throw new Error("not a call frame");
        void onCall(frame);
      } catch (err) {
        // Dropped, not crashed. A frame this page cannot parse is a relay from
        // a newer version of the protocol, and taking the stream down over it
        // would turn a forward-compatible addition into an outage.
        onError(err);
      }
    });

    es.addEventListener("error", () => {
      // `error` fires on every blip, including the ones `EventSource` is about
      // to retry by itself. Only a CLOSED stream is ours to restart; racing the
      // browser's own retry would open two streams for one tab.
      if (!live || es.readyState !== CLOSED) return;
      if (source === es) source = null;
      if (reopen) return;
      reopen = setTimeout(() => {
        reopen = null;
        open();
      }, delay);
      (reopen as { unref?: () => void }).unref?.();
      delay = Math.min(delay * 2, maxBackoffMs);
    });
  }

  function changed(): void {
    if (!live) return;
    if (debounce) return; // Already coalescing; the flush reads the latest state.
    debounce = setTimeout(() => {
      debounce = null;
      if (!live) return;
      // Read at flush time, not at call time. Ten `changed()` calls in one
      // frame must produce one push of the FINAL state, not the first.
      up({ t: "snapshot", snapshot: driver.snapshot(), tab });
    }, debounceMs);
    (debounce as { unref?: () => void }).unref?.();
  }

  if (options.watchMs !== undefined) {
    const every = Math.max(500, options.watchMs);
    let seen = driver.snapshot().rev;
    watch = setInterval(() => {
      if (!live) return;
      try {
        const rev = driver.snapshot().rev;
        if (rev === seen) return;
        seen = rev;
        changed();
      } catch (err) {
        onError(err);
      }
    }, every);
    (watch as { unref?: () => void }).unref?.();
  }

  open();

  return {
    tab,
    changed,
    disconnect() {
      live = false;
      // Dropped rather than flushed. `disconnect` is the page saying it is done
      // driving; POSTing answers to a relay nobody is listening to would be
      // writing into the void, and a `drain` still awaiting a reconnect has to
      // be let go or it holds a timer open past the teardown.
      outbox.length = 0;
      const waiting = openWaiters;
      openWaiters = [];
      for (const waiter of waiting) waiter();
      if (debounce) clearTimeout(debounce);
      if (reopen) clearTimeout(reopen);
      if (watch) clearInterval(watch);
      debounce = reopen = null;
      watch = null;
      try {
        source?.close();
      } catch (err) {
        onError(err);
      }
      source = null;
    },
  };
}

/**
 * Refuse to publish a driver that has not said what its verbs do.
 *
 * THE GAP THIS CLOSES. The core's gate fires on `kind === "commit"`, and the
 * publish check below counts only DECLARED commits. So a verb with no `kind`
 * that changes data went out to an outside agent with no gate in front of it
 * and nobody complaining — the whole guarantee resting on the app having
 * declared its kinds, which is the one thing nothing checked.
 *
 * WHY HERE AND NOT IN `mount()`. In-page leniency is deliberate and
 * documented: `Verb.kind` is optional, an absent one makes no safety claim in
 * either direction, and a half-written app with three undeclared verbs must
 * still mount and still work. Nothing is published by mounting. Publishing to
 * a relay is the act that hands an agent in another process the ability to
 * change data, and it is already the place this library demands an explicit
 * declaration rather than inferring one. So the demand is the same demand, one
 * field over: say what your verbs do before strangers can call them.
 *
 * THE RULE: every verb in a published manifest declares a `kind`, unless the
 * driver declared `approve: "unattended"`.
 *
 * Total, rather than the narrower rules that were available:
 *
 *   "Only verbs that look like they change data." There is no such predicate.
 *   It would have to be a guess from the name — `delete-*`, `set-*` — which is
 *   the exact inference the controls layer refuses to make, for the exact
 *   reason: a near miss is how `set-view` gets gated and `finalize` does not.
 *   A rule that is wrong in both directions teaches an author to distrust it.
 *
 *   "Only when no approver was declared at all." This is the tempting one and
 *   it is unsound. A declared hook does NOT cover an undeclared verb: the core
 *   asks only about `kind === "commit"`, so a driver with a perfectly good
 *   approval hook and one silent verb publishes that verb ungated. The narrow
 *   rule would accept precisely the configuration that is unsafe. Which is
 *   also why a `hook` policy does not satisfy this check.
 *
 *   "Warn instead of throw." A warning on publish is a warning the author of
 *   the app is not reading, because the app works. The precedent in PROTOCOL.md
 *   is a refusal to start, and that is what a configuration which must not be
 *   reachable by accident looks like.
 *
 * WHY `"unattended"` SATISFIES IT. Because it is the same claim, said louder.
 * A driver declaring `"unattended"` runs its declared commits with nobody in
 * front of them; a silent verb on that driver is treated no differently from a
 * verb that declared `commit`, so there is nothing left for this check to
 * protect. Refusing it anyway would be demanding paperwork after the risk has
 * already been accepted out loud — and it would leave an author who really does
 * run unattended with no way to connect at all, which is how a safety check
 * gets deleted rather than satisfied. `"unattended"` is the typed opt-out the
 * core already defines for this exact decision; this reuses it rather than
 * inventing a second one.
 */
function requireDeclaredKinds(driver: Driver): void {
  if (driver.approval?.policy === "unattended") return;
  const manifest = driver.manifest();
  const silent = manifest.verbs.filter((v) => v.kind === undefined).map((v) => v.name);
  if (silent.length === 0) return;
  throw new Error(
    `driverkit: refusing to connect \`${manifest.app}\` to a relay. ` +
      `${silent.length} of its ${manifest.verbs.length} verb(s) declare no \`kind\` — ` +
      `${silent.slice(0, 6).join(", ")}${silent.length > 6 ? ", …" : ""} — so the core's ` +
      `approval gate, which fires on \`kind: "commit"\`, cannot see them. A verb that changes ` +
      `data and never said so is published to an agent in another process with nothing in ` +
      `front of it. In-page this is allowed on purpose (an absent \`kind\` makes no claim); ` +
      `publishing is where the claim has to be made. Pass ONE of these: ` +
      `\`kind: "read" | "describe" | "commit"\` on each verb above — the honest answer, and it ` +
      `is also what tells an agent which calls are free to try; or \`approve: "unattended"\` to ` +
      `\`mount()\`, which says out loud that commits on this driver run with nobody watching ` +
      `and takes every verb off this list. See Verb.kind and MountOptions.approve.`,
  );
}

/**
 * Refuse to publish a driver whose commits nobody has said who approves.
 *
 * THE GAP THIS CLOSES. The confirmation used to live in the agent loop's
 * `onBeforeCommit`, which `mountWidget` defaults on, so the in-page panel
 * asked a person and an agent arriving over this stream called
 * `accept-selected` and it simply ran. A live tab was driven from a shell and
 * 425 rows could have been committed with nothing in the way. The gate now
 * lives in `mount()`'s `call`, where both paths converge — but a gate the app
 * never installed is still no gate, so the declaration is required HERE, at
 * the one act that makes the app reachable from outside the page.
 *
 * WHY A THROW. The precedent is PROTOCOL.md's: a relay with remote access
 * turned on and no way to identify callers **refuses to start** rather than
 * serving every connected tab to anyone who asks. Three deliberate acts to
 * publish a relay, and by the same argument three to let an outside agent
 * change data: write a `commit` verb, connect to a relay, and say who
 * approves. The unsafe answer is still available — `approve: "unattended"` —
 * and it is now a sentence somebody wrote rather than a field they left out.
 *
 * WHICH VERBS COUNT. Only a `commit` that has not declared `reversible`, which
 * is the same line the widget's dialog draws and for the same reason: an
 * absent `reversible` makes no claim, and a commit that has not said there is
 * a way back is treated as one that has not got one. An app whose every commit
 * declares `reversible` connects exactly as it did before. So does an app with
 * no commit verbs at all, and so does a hand-written driver that declares
 * `approval` itself.
 */
function requireApprovalPolicy(driver: Driver): void {
  if ((driver.approval?.policy ?? "none") !== "none") return;
  const exposed = driver
    .manifest()
    .verbs.filter((v) => v.kind === "commit" && v.reversible !== true)
    .map((v) => v.name);
  if (exposed.length === 0) return;
  throw new Error(
    `driverkit: refusing to connect \`${driver.manifest().app}\` to a relay. It publishes ` +
      `${exposed.length} commit verb(s) that have not declared \`reversible\` — ` +
      `${exposed.slice(0, 6).join(", ")}${exposed.length > 6 ? ", …" : ""} — and \`mount()\` was ` +
      `given no \`approve\`, so an agent on the other end of this stream would change data with ` +
      `nothing in front of it. Pass ONE of these to \`mount()\`: ` +
      `\`approve: (req) => …\`, an async hook that asks a person and returns true, false or a ` +
      `reason; or \`approve: "unattended"\`, which says out loud that commits here run with ` +
      `nobody watching. Declaring \`reversible: true\` on the commits the app really can undo ` +
      `also takes them off this list. See MountOptions.approve.`,
  );
}

/**
 * The remembered tab id, or a fresh one.
 *
 * `sessionStorage`, not `localStorage`: the id names one open tab, and
 * `localStorage` is shared across every tab on the origin, so two windows
 * would claim one identity and the second `hello` would steal the first's
 * stream. Keyed by app so two drivers in one page do not collide.
 */
function remembered(
  storage: StorageLike | null,
  app: string | undefined,
  randomUUID: (() => string) | undefined,
  onError: (err: unknown) => void,
): string {
  const key = `driverkit:tab:${app ?? "-"}`;
  try {
    const found = storage?.getItem(key);
    if (found) return found;
  } catch (err) {
    onError(err); // Private-mode storage throws on access rather than returning null.
  }
  const mint =
    randomUUID ??
    (globalThis.crypto?.randomUUID ? () => globalThis.crypto.randomUUID() : null) ??
    // A tab id is a capability, so the fallback still has to be unguessable;
    // it is only here for an insecure origin, where `crypto` is absent.
    (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const id = mint();
  try {
    storage?.setItem(key, id);
  } catch (err) {
    onError(err);
  }
  return id;
}

/**
 * The remembered anonymous credential, or a fresh one.
 *
 * `sessionStorage`, like the tab id, and for the same reason plus one more: an
 * anonymous session should not outlive the window, and `localStorage` would
 * make one anonymous principal shared by every tab on the origin -- which is
 * the single shared "anonymous" bucket this whole design exists to avoid.
 *
 * 256 bits from `crypto.getRandomValues`, because this string is the whole of
 * an anonymous visitor's isolation: anybody who can guess it is that visitor.
 * The fallback for an insecure origin with no `crypto` is deliberately loud
 * rather than silent -- a guessable anonymous secret is worse than none, so a
 * page served over plain HTTP is told rather than quietly weakened.
 */
function anonCredential(
  storage: StorageLike | null,
  app: string | undefined,
  onError: (err: unknown) => void,
): string {
  const key = `${ANON_KEY}:${app ?? "-"}`;
  try {
    const found = storage?.getItem(key);
    if (found) return found;
  } catch (err) {
    onError(err); // Private-mode storage throws on access rather than returning null.
  }
  const random = globalThis.crypto?.getRandomValues;
  if (!random) {
    throw new Error(
      "driverkit: anonymous credentials need `crypto.getRandomValues`, which this origin " +
        "does not have (an insecure origin, most likely). A guessable anonymous secret is " +
        "one anonymous visitor able to drive another's screen, so this refuses rather than " +
        "falling back to Math.random. Serve the page over HTTPS, or pass `token`.",
    );
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let base64 = "";
  for (const byte of bytes) base64 += String.fromCharCode(byte);
  // base64url, unpadded, matching the relay's `anon1.` reader on both sides.
  const secret = btoa(base64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const credential = `anon1.${secret}`;
  try {
    storage?.setItem(key, credential);
  } catch (err) {
    onError(err);
  }
  return credential;
}

function titleFromPage(): { title?: string } {
  const title = (globalThis as { document?: { title?: string } }).document?.title;
  return title ? { title } : {};
}

function urlFromPage(): { url?: string } {
  const loc = (globalThis as { location?: { pathname?: string; search?: string } }).location;
  if (!loc?.pathname) return {};
  return { url: `${loc.pathname}${loc.search ?? ""}` };
}
