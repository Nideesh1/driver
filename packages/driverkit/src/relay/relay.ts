/**
 * driverkit/relay — the one place both parties can reach.
 *
 * Nothing can call into a browser tab, so the tab dials out and holds a stream
 * open; the agent speaks ordinary request/response HTTP. The relay's whole job
 * is to turn one into the other: a `POST /dk/tabs/:tab/call` blocks on an open
 * promise until a `result` frame with the matching `id` arrives on a separate
 * POST from that tab, and then answers with it.
 *
 * Two properties are worth stating before the code, because both are easy to
 * break with a change that looks like a cleanup:
 *
 *   THE RELAY GRANTS NO AUTHORITY. It forwards a verb name to a tab that is
 *   already logged in as a person. It never decides whether a call is allowed,
 *   never rewrites args, never interprets `rev`. Every refusal it originates
 *   is about reachability -- "no tab", "the tab went away", "the tab never
 *   answered" -- and never about the verb. The moment the relay has an opinion
 *   about a verb, there are two sets of rules and one of them is wrong.
 *
 *   EVERY ANSWER IS A `WireResult`, AND THE BODY IS AUTHORITATIVE. An agent
 *   asking for a call gets the same shape at 200 whether the tab refused, the
 *   tab vanished, or the tab id was a typo. A 4xx here would conflate a
 *   transport failure with a business rule, and those want opposite handling:
 *   one is retry-elsewhere, the other is rephrase-and-retry. So a non-2xx from
 *   this relay means no `WireResult` was produced at all -- malformed body,
 *   unroutable path -- and never "the app said no".
 *
 *   A relay refusal carries NO `snapshot`. The three it can originate are a
 *   closed set (`RelayRefusal`), and in none of them did anything run or
 *   anybody look. Inventing an empty snapshot would tell an agent the app has
 *   no rows, which is a lie about the app rather than about the call.
 *
 * CHOICES PROTOCOL.md LEAVES TO THE RELAY, recorded here so the next reader
 * does not have to rediscover them by experiment:
 *
 *   - A second `/dk/events` stream for a known tab id SUPERSEDES the first.
 *     The id is minted by the tab so a reconnect resumes identity; treating the
 *     second stream as a new tab would defeat the only reason the id exists.
 *   - Calls in flight CARRY ACROSS that supersede. A tab that was mid-verb when
 *     its stream blinked can still POST the result on the new one, and failing
 *     those would turn a recovered hiccup into an error the agent must handle.
 *   - `hello` UPSERTS FIELD BY FIELD. It arrives again after every reconnect and
 *     the app may have navigated in between, so the later one wins on each
 *     field it carries and leaves the others alone.
 *   - Everything in `hello` but `tab` is OPTIONAL. The consequence is a real
 *     window: a tab enters the registry when its stream opens and `hello` lands
 *     a moment later on a separate POST. During it `/manifest` answers 404
 *     rather than an empty verb list, because an empty list is a false claim
 *     that the app has no verbs.
 *   - `attach()` is MIDDLEWARE, not a prepended listener. See the comment on it.
 *
 *   A TAB BELONGS TO A PRINCIPAL, AND THE REGISTRY KEY SAYS SO. Tabs are
 *   stored under `principal\u0000tab`, not under the tab id alone. That is not a
 *   check, it is a shape: there is no lookup by bare tab id anywhere in this
 *   file, so a caller cannot reach another principal's tab through a code path
 *   somebody adds next year and forgets to guard. It also removes the question
 *   of what to do when two people mint the same tab id -- nothing, they are two
 *   tabs -- and with it an existence oracle for other people's ids.
 *
 *   Isolation is NOT authorisation. A credential buys its holder nothing they
 *   could not already do in their own browser; it tells the relay which
 *   hundredth of its registry to show them. See `auth.ts`.
 *
 * Zero dependencies: `node:http` types and `node:crypto` only.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { AuthError, LOCAL_PRINCIPAL, TabAuth, credentialFrom, type Principal } from "./auth.ts";
import type {
  CallFrame,
  DownFrame,
  Manifest,
  RelayRefusal,
  Scalar,
  Snapshot,
  TabFocus,
  TabSummary,
  UpFrame,
  WatchFrame,
  WireResult,
} from "./frames.ts";

export interface RelayOptions {
  /**
   * How long a `POST /dk/tabs/:tab/call` waits for the matching `result`.
   *
   * PROTOCOL.md has no queue on purpose: a call either reaches a connected tab
   * or fails cleanly. The timeout is the other half of that promise. Without
   * it a tab whose JavaScript died -- stream still open, event loop wedged --
   * holds the agent's request forever, which is the one failure mode worse
   * than a refusal, because an agent cannot retry what has not returned.
   */
  timeoutMs?: number;
  /** The keep-alive comment interval. PROTOCOL.md says 20s. */
  pingMs?: number;
  /**
   * Serve requests that did not come from loopback.
   *
   * Off by default, and that default is the security model, not a convenience.
   * A tab's own session is what the app checks, so a relay someone else can
   * reach is that person driving your logged-in session -- not a scoped token
   * they could be given, your actual account. There is nothing to revoke
   * because nothing was ever granted. See "Who is allowed to do this".
   *
   * WITHOUT `auth` OR `resolvePrincipal`, THIS THROWS. That combination is the
   * one the whole of `auth.ts` exists to prevent: an exposed relay with no
   * notion of who is calling publishes a hundred people's logged-in sessions
   * to each other and to anybody who can reach the port. It used to be
   * reachable by setting one flag that reads like a convenience, so now it is
   * not reachable at all -- turning on remote access means naming how callers
   * are identified, in the same call.
   */
  allowRemote?: boolean;
  /**
   * How the relay learns which person a request is from.
   *
   * It grants nothing. See `auth.ts`: a credential buys its holder nothing
   * they could not already do in their own browser, and buys the relay the
   * ability to keep a hundred people's tabs apart.
   */
  auth?: TabAuth;
  /**
   * The other door: a function from request headers to a principal id.
   *
   * For a relay embedded in an app that already has sessions and can simply
   * say who the caller is -- no secret to share, no token to mint. Consulted
   * before `auth`, and returning undefined falls through, so it can handle
   * logged-in users and leave anonymous visitors to the token path.
   */
  resolvePrincipal?: (headers: Record<string, string | string[] | undefined>) => string | undefined;
  /** Called with anything thrown while writing to a stream. Default: ignore. */
  onError?: (err: unknown) => void;
  /**
   * Where this relay's own audit records go. One per `/call` it handled; see
   * `RelayAuditEvent`.
   *
   * WHY THE RELAY EMITS AT ALL, when `MountOptions.onAudit` already records
   * every call that reaches a driver. Because of one fact the in-page hook
   * cannot know and this one cannot help knowing: WHICH PRINCIPAL asked. The
   * core sees a `call()` and has no idea whether it came from the panel in
   * front of a person, a cron job, or somebody else's agent holding a token;
   * the relay resolved the credential itself, so it is the only place in the
   * library where "who" is a fact rather than a guess.
   *
   * AND WHY IT SAYS SO LITTLE. It does not report what the verb did. The
   * driver decided that, in another process, and a copy of somebody else's
   * decision is the second source of truth that can disagree with the first —
   * a relay that logged `ok` for a call whose tab died mid-commit would be
   * asserting an outcome nobody observed. So this records what the RELAY
   * decided: that a call arrived, from whom, for which tab and verb, and
   * whether it was delivered or stopped here. What happened to the data is in
   * the driver's own record, where it was decided. The two are not two
   * countings of one event; see `RelayAuditEvent.outcome`.
   *
   * Called and not awaited, like the core's hook, and a throw is passed to
   * `onError` rather than allowed to fail the call: a relay that returned a
   * 500 because its logging backend was down would turn an audit trail into
   * an outage.
   */
  onAudit?: (event: RelayAuditEvent) => void;
}

/**
 * One call this relay handled, and nothing about what the app did with it.
 *
 * The fields are the relay's own knowledge and stop there. `principal` is the
 * one an in-page hook cannot have; `outcome` is the relay's own verdict and
 * never the driver's.
 *
 * KEPT IDENTICAL IN THE PYTHON RELAY, field for field and name for name, by
 * the same standing promise that governs the rest of these two files: there
 * are two independent implementations of this protocol and a difference
 * between them is a difference nobody finds until an operator switches.
 */
export interface RelayAuditEvent {
  /** `Date.now()` when the call settled, in milliseconds since the epoch. */
  at: number;
  /** How long the relay held the call, in milliseconds: the round trip to the
   *  tab, which on a gated commit includes the time a person spent deciding. */
  ms: number;
  /** Who asked, as the relay resolved them — a token's subject, a host's own
   *  session id, or `LOCAL_PRINCIPAL` on an unconfigured loopback relay, where
   *  everything is one principal and this field says so rather than implying
   *  an identity nobody established. */
  principal: string;
  /** The tab the call was addressed to. Present even when no such tab was
   *  found: an agent calling a tab id it does not own is the thing worth
   *  having in a log. */
  tab: string;
  /** The verb, as asked for. Not checked against any manifest — the relay does
   *  not hold one it trusts — so this is the agent's word for what it wanted. */
  verb: string;
  /**
   * What the RELAY did with it, which is never what the app did.
   *
   *   `delivered`      the tab answered. What it answered is in the driver's
   *                    own audit record, which is where it was decided; this
   *                    relay deliberately does not copy it.
   *   `no-such-tab`    no tab of this principal's by that id. Nothing ran.
   *   `tab-went-away`  the stream was gone, or went while the call was in
   *                    flight. The verb MAY have run; see `RelayRefusal`.
   *   `timeout`        no answer inside the deadline. Outcome unknown.
   *
   * So `delivered` is the one value that means "ask the other log", and the
   * other three are the cases where there is no other log to ask because the
   * call never reached, or never returned from, a driver. That is the line
   * that keeps the two records from being two countings of one call: COUNT
   * COMMITS FROM THE DRIVER'S RECORDS, and read this one for who asked and for
   * the calls that never arrived.
   */
  outcome: "delivered" | RelayRefusal;
}

export interface Relay {
  /**
   * Handle one request. Returns false if the path is not ours, so the relay
   * can sit in front of an app that owns the rest of the URL space. It does
   * NOT 404 on a miss: deciding that an unknown path is an error is the host
   * server's business, and a relay that answers 404 for everything cannot be
   * embedded in anything.
   */
  handler: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Put the handler in front of an existing server's own routes. */
  attach: (server: Server) => void;
  /**
   * Every connected tab, across every principal.
   *
   * The operator's in-process view: a process that embeds the relay may
   * legitimately want to know what is connected. NOTHING REACHABLE OVER HTTP
   * USES IT -- `GET /dk/tabs` serves `tabsFor` instead. The cross-principal
   * listing was the inventory of other people's sessions, titles and URLs
   * attached, that the split exists to remove.
   */
  tabs: () => TabSummary[];
  /** The tabs one principal owns -- what `GET /dk/tabs` actually serves. */
  tabsFor: (principal: string, tab?: string) => TabSummary[];
  /** Hang up every stream and fail every call in flight. Idempotent. */
  close: () => void;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx buffers proxied responses by default, which turns a live stream into
  // one that arrives when it ends. The ping comments keep the connection open;
  // this keeps the bytes moving.
  "x-accel-buffering": "no",
} as const;

/**
 * 1 MiB, pinned by PROTOCOL.md, and over it is a 413.
 *
 * Not a limit to raise. A snapshot approaching this size is a bug in the app's
 * `visible()` -- the whole design says an agent sees a screenful, so a megabyte
 * of rows means the page is reporting its database rather than its screen.
 */
const MAX_BODY = 1 << 20;

/** Past this, the sender is not going to stop and the connection goes. See
 *  `readJson` for why the limit itself is not enforced by hanging up. */
const ABORT_AT = MAX_BODY * 16;

/**
 * The 401's challenge header. `Bearer` names the scheme an agent should use;
 * the realm is fixed, because a realm that named the app or the principal
 * would be a 401 that leaks who else is here.
 */
const AUTH_HEADERS = { "www-authenticate": 'Bearer realm="driverkit"' } as const;

/**
 * The hint on every `no-such-tab`, whatever the real reason.
 *
 * One string, with no tab id in it, because the four reasons an agent can get
 * this -- never minted, closed, somebody else's, outside a tab-bound
 * credential's reach -- must be one answer. A hint that said "no tab `abc` is
 * connected" for one and something else for another would make the endpoint
 * the membership test the status code was carefully chosen not to be.
 */
const NO_SUCH_TAB_HINT = "no such tab is connected";

/** The principal every request is, with auth off. */
const LOCAL: Principal = { id: LOCAL_PRINCIPAL };

interface Pending {
  /**
   * Answer the call, once, saying what the RELAY decided.
   *
   * The outcome is a required argument rather than something derived from `r`,
   * and that is deliberate: a relay refusal is recognisable from a `WireResult`
   * only by its missing `snapshot`, which is a type-level invariant that the
   * wire can violate, and an audit record must not rest on one. Required also
   * means the compiler finds every place a call can be settled -- there are
   * five, two of them nowhere near the dispatch -- so a sixth added later
   * cannot forget to say what it is.
   */
  settle: (r: WireResult, outcome: RelayAuditEvent["outcome"]) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What `ingest` reports back: accepted, or the exact status to answer with. */
interface Ingested {
  ok: boolean;
  status?: number;
  error?: string;
  why?: string;
}

function no400(error: string, why: string): Ingested {
  return { ok: false, status: 400, error, why };
}

interface Tab {
  tab: string;
  /**
   * Who this tab belongs to. The other half of the registry key, kept on the
   * record too so a summary and a watcher fan-out can find it without carrying
   * the key around.
   */
  principal: string;
  app?: string;
  title?: string;
  url?: string;
  /** Where the tab said its person's attention is. Stored as the tab sent it
   *  and never computed: the relay cannot see `document.hasFocus()`. */
  focus?: TabFocus;
  manifest?: Manifest;
  snapshot?: Snapshot;
  /** ISO 8601. Formatted once, at connect, rather than on every list. */
  since: string;
  res: ServerResponse;
  ping: ReturnType<typeof setInterval>;
  pending: Map<string, Pending>;
}

export function createRelay(options: RelayOptions = {}): Relay {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pingMs = options.pingMs ?? 20_000;
  const allowRemote = options.allowRemote ?? false;
  const auth = options.auth;
  const resolvePrincipal = options.resolvePrincipal;
  const onError = options.onError ?? (() => {});
  const onAudit = options.onAudit;

  /**
   * Hand one record to the host, and survive the host.
   *
   * A throw goes to `onError`, which is where everything else this relay
   * cannot help goes, rather than to the caller: a 500 because the logging
   * backend is down would make an audit trail into an outage. Not awaited --
   * nothing here is async, and a hook that wants to be is the host's business.
   */
  const audit = (
    principal: string,
    tab: string,
    verb: string,
    started: number,
    outcome: RelayAuditEvent["outcome"],
  ): void => {
    if (onAudit === undefined) return;
    const at = Date.now();
    try {
      onAudit({ at, ms: at - started, principal, tab, verb, outcome });
    } catch (err) {
      onError(err);
    }
  };

  if (allowRemote && !auth && !resolvePrincipal) {
    // Thrown at construction, before a socket exists, for the same reason
    // `serve()` refuses a non-loopback host there: a misconfiguration that
    // surfaced later is one somebody forgot to check, and the failure mode of
    // forgetting is a listening public port that drives strangers' browsers.
    throw new Error(
      "driverkit: allowRemote needs auth or resolvePrincipal. A relay that serves " +
        "non-loopback callers and cannot tell them apart is every connected tab offered to " +
        'every caller. Read "Who is allowed to do this" in PROTOCOL.md, then pass ' +
        "auth: new TabAuth({ secret, audience }).",
    );
  }

  /**
   * Connected tabs, keyed by `principal\u0000tab`.
   *
   * The pair, never the bare id. A NUL joins them because it cannot occur in a
   * principal id or a tab id that arrived as a URL path segment, so there is no
   * pair of distinct identities that collides into one key -- which a `:`
   * separator would allow for an id containing a colon.
   */
  const tabs = new Map<string, Tab>();
  /**
   * `GET /dk/tabs/:tab/watch` subscribers, keyed by tab id.
   *
   * A SET, because PROTOCOL.md requires every watcher to get the frames: two
   * agents beside one human is the shared-presence case, and a single-slot
   * registry would silently make the second one blind rather than refuse it.
   *
   * Kept OUTSIDE the tab record on purpose. A tab record dies with its stream,
   * and a watcher must survive the page reloading -- that reload is one of the
   * things it is watching for.
   */
  const watchers = new Map<string, Set<ServerResponse>>();
  /** The rev last broadcast per tab, so a refusal that moved nothing is quiet. */
  const broadcast = new Map<string, number>();

  const key = (principal: string, tabId: string) => `${principal}\u0000${tabId}`;

  /**
   * The caller's tab, or undefined. The ONLY way this file finds a tab.
   *
   * `undefined` covers three cases on purpose -- no such tab, somebody else's
   * tab, and a tab outside what a tab-bound credential may address -- and every
   * caller turns it into the same `no-such-tab`. Collapsing them here rather
   * than at each endpoint is what makes the property hold for an endpoint added
   * later: there is no lookup by bare tab id to reach for.
   */
  function owned(who: Principal, tabId: string): Tab | undefined {
    if (who.tab !== undefined && who.tab !== tabId) return undefined;
    return tabs.get(key(who.id, tabId));
  }
  let nextCall = 1;
  let closed = false;

  function send(tab: Tab, frame: DownFrame): boolean {
    try {
      // The event name matters: the page listens for `call` specifically, so an
      // unnamed `message` would be silently dropped by `EventSource`.
      tab.res.write(`event: ${frame.t}\ndata: ${JSON.stringify(frame)}\n\n`);
      return true;
    } catch (err) {
      onError(err);
      return false;
    }
  }

  /**
   * Open a tab's stream and BIND the tab to the caller's principal.
   *
   * The binding happens here, at first contact, rather than on `hello`.
   * PROTOCOL.md already describes the window between a stream opening and its
   * `hello` landing on a separate POST; binding at `hello` would make that a
   * window in which a tab exists and belongs to nobody, and an unowned tab is
   * one every principal either can or cannot see, both of which are wrong.
   *
   * What this means for a credential that expires MID-SESSION: nothing. The
   * binding is the relay's record and lasts as long as the stream, not as long
   * as the token. A relay that hung up at `exp` would disconnect every tab in
   * the deployment once per token lifetime, mid-verb, while a person watched --
   * and the fix people reach for, a longer lifetime, is strictly worse because
   * it also widens the window a leaked token is useful in. Short tokens plus a
   * binding that outlives them gives both.
   *
   * The credential is still needed for `POST /dk/result`, which is a new
   * request and carries its own; see `connect`'s token getter, which is a
   * function for exactly this reason.
   */
  function openStream(
    who: Principal,
    tabId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const id = key(who.id, tabId);
    res.writeHead(200, SSE_HEADERS);
    // A first comment byte makes the browser fire `open` now rather than when
    // the first real frame happens to arrive, and `open` is where the page
    // sends `hello`. Without it a freshly loaded tab is connected but unknown.
    res.write(": driverkit\n\n");

    const existing = tabs.get(id);
    const ping = setInterval(() => {
      try {
        // A comment line, per PROTOCOL.md: it carries nothing, and a comment
        // cannot be mistaken for a frame by a client that does not know it.
        res.write(": ping\n\n");
      } catch (err) {
        onError(err);
      }
    }, pingMs);
    // The relay must never be the reason a process will not exit; a test that
    // forgets `close()` should fail loudly, not hang.
    ping.unref?.();

    const tab: Tab = existing
      ? // A second stream for a known id is a reconnect, not a new tab: the id
        // is minted by the tab precisely so it survives one. Carry the known
        // facts and the calls in flight across -- a tab that was mid-verb when
        // its stream blinked can still POST the result on the new one, and
        // failing those calls would turn a recovered hiccup into an error the
        // agent has to handle.
        { ...existing, res, ping, since: existing.since }
      : {
          tab: tabId,
          principal: who.id,
          since: new Date().toISOString(),
          res,
          ping,
          pending: new Map<string, Pending>(),
        };

    if (existing && existing.res !== res) {
      clearInterval(existing.ping);
      try {
        existing.res.end();
      } catch (err) {
        onError(err);
      }
    }
    tabs.set(id, tab);

    const gone = () => {
      clearInterval(ping);
      // Only drop the registry entry if it is still OURS. A reconnect replaces
      // the record first and then ends the old response, so the old `close`
      // fires afterwards and would otherwise delete the live tab.
      if (tabs.get(id) !== tab) return;
      tabs.delete(id);
      // Fail what is in flight instead of letting each call sit out its own
      // timeout. The answer is already known -- nobody is going to reply -- and
      // "no queue" means the agent learns that now, while it still has the
      // context to try something else.
      for (const [, p] of tab.pending) {
        clearTimeout(p.timer);
        p.settle(relayRefusal("tab-went-away", `tab \`${tabId}\` closed its stream`), "tab-went-away");
      }
      tab.pending.clear();
    };

    res.on("close", gone);
    req.on("aborted", gone);
  }

  /**
   * One tab->relay frame.
   *
   * A TAB MAY NOT ANSWER ANOTHER TAB'S CALL, and two things enforce it. A tab
   * the caller does not own is not found at all (`owned`), so the
   * cross-PERSON case is the same 409 as a tab that is not connected. Within
   * one person, who legitimately has several tabs open, `pending` is per-tab-
   * record and call ids are unique across the relay, so a `result` for a call
   * issued to another of their tabs finds nothing to settle and is dropped as a
   * late answer. A credential carrying a `tab` claim closes that case
   * cryptographically as well; without one, the pending map is what holds,
   * which is a weaker statement and is said here rather than assumed.
   */
  function ingest(who: Principal, frame: UpFrame, tabId: string | undefined): Ingested {
    const id = frame.t === "hello" ? frame.tab : (tabId ?? frame.tab);
    // 400, not 409: a frame that names no tab is malformed. There is no state
    // of the relay under which it could have been accepted, which is what 4xx
    // against 409 is supposed to tell the sender.
    if (!id) return no400("unplaceable", "no tab id: pass ?tab= or a `tab` field");
    const tab = owned(who, id);
    // A tab that belongs to someone else lands here too, with the same body,
    // which is the oracle rule applied to the tab's own endpoint: "not yours"
    // and "not connected" must be one answer.
    if (!tab) return { ok: false, status: 409, error: "no-such-tab", why: NO_SUCH_TAB_HINT };

    switch (frame.t) {
      case "hello": {
        // Upsert, not insert. `hello` arrives again after every reconnect, and
        // the app may have navigated in between, so the later one wins on every
        // field it carries.
        if (frame.app !== undefined) tab.app = frame.app;
        if (frame.title !== undefined) tab.title = frame.title;
        if (frame.url !== undefined) tab.url = frame.url;
        if (frame.focus !== undefined) tab.focus = frame.focus;
        if (frame.manifest !== undefined) tab.manifest = frame.manifest;
        if (frame.snapshot !== undefined) {
          tab.snapshot = frame.snapshot;
          push(tab);
        }
        return { ok: true };
      }
      case "snapshot": {
        tab.snapshot = frame.snapshot;
        // The same upsert rule `hello` uses, on the two fields a push may now
        // carry. `url` is here because it had no other way of ever being
        // right: it came from `hello` alone, and a single-page app navigates
        // without reconnecting, so a tab's url in `/dk/tabs` was whatever it
        // had been at page load. Absent leaves the stored value alone, which
        // is what keeps a tab connected by a hand-written loop -- or by a
        // driverkit older than this field -- reading exactly as it did.
        if (frame.url !== undefined) tab.url = frame.url;
        if (frame.focus !== undefined) tab.focus = frame.focus;
        // Always forwarded, even at an unchanged rev. This frame is the tab
        // SAYING the page moved, and second-guessing it here would make the
        // relay the thing that decides what counts as a change -- which is the
        // app's judgement, carried in `rev`, not the relay's.
        push(tab, true);
        return { ok: true };
      }
      case "result": {
        // Checked BEFORE the pending lookup, and the call is deliberately left
        // pending when it fails.
        //
        // This is the one promise `/call` makes: the body is always a
        // `WireResult`. Settling with a non-object would put `undefined`
        // through `JSON.stringify` and answer the agent a body that is
        // literally the four characters `null` -- or nothing at all -- which no
        // client can parse and which no amount of careful client code can
        // recover from. Rejecting the frame instead leaves the call to time out
        // honestly: `timeout` is a documented unknown outcome, and an unknown
        // outcome is a far better thing to hand an agent than garbage.
        if (typeof frame.result !== "object" || frame.result === null || Array.isArray(frame.result)) {
          return no400("bad-frame", `the \`result\` for \`${frame.id}\` is not an object`);
        }
        const pending = tab.pending.get(frame.id);
        // An id the relay is not waiting on is dropped, not an error. It means
        // the call already timed out and the tab answered late; resurrecting it
        // would deliver an answer to a request that has already been responded
        // to.
        if (!pending) return { ok: true, why: `no call \`${frame.id}\` in flight` };
        tab.pending.delete(frame.id);
        clearTimeout(pending.timer);
        // The `Result` is forwarded byte for byte. A `stale` refusal the driver
        // produced must reach the agent as the driver wrote it, hint and
        // snapshot included -- that hint is how the agent knows to re-read
        // instead of retrying the same dead rev.
        if (frame.result?.snapshot) {
          tab.snapshot = frame.result.snapshot;
          // Watchers hear about an agent's change too, not only a human's.
          // `/watch` exists so a watcher need not poll; one that learned only
          // about human-caused moves would still have to poll for the rest,
          // which is the cost the endpoint was added to remove. Deduped on
          // `rev`, so a refusal that moved nothing stays quiet.
          push(tab);
        }
        // `delivered`, and nothing more. The tab answered; what it answered is
        // the driver's own record to make, in the process where it was decided.
        pending.settle(frame.result, "delivered");
        return { ok: true };
      }
    }
  }

  function dispatch(
    who: Principal,
    tabId: string,
    body: { name?: unknown; args?: unknown; rev?: unknown; screen?: unknown; plan?: unknown },
  ): Promise<WireResult> | null {
    // Null means "this was never a call", and the caller answers non-2xx. A
    // body with no `name` is malformed, not refused: there is no verb to have
    // said no, so dressing it as a `WireResult` would teach an agent to look
    // for a `bad-request` slug that the closed set does not contain.
    if (typeof body.name !== "string" || !body.name) return null;

    // Before the lookup, so `ms` is the time the agent actually waited and not
    // the time minus whatever the registry cost.
    const started = Date.now();

    const tab = owned(who, tabId);
    if (!tab) {
      // Shaped like every other answer. An agent holding a tab id from a
      // closed window gets a refusal it can read with the same code path it
      // uses for "that row is not deletable".
      //
      // And a tab belonging to another principal gets THIS, not a 403: a
      // refusal an agent reads as "that window is gone", identical in status,
      // slug and hint to one for an id that was never minted. A 403 here would
      // turn /call into a membership test for other people's tab ids.
      // Recorded, and this is the half of the trail the driver cannot have:
      // nothing reached a tab, so no `onAudit` anywhere else in the library
      // will ever hear about this call. An agent working through tab ids it
      // does not own leaves its marks only here.
      audit(who.id, tabId, body.name, started, "no-such-tab");
      return Promise.resolve(
        relayRefusal("no-such-tab", `${NO_SUCH_TAB_HINT}; GET /dk/tabs to list them`),
      );
    }

    const id = `c-${nextCall++}`;
    const frame: CallFrame = {
      t: "call",
      id,
      name: body.name,
      ...(body.args && typeof body.args === "object" ? { args: body.args as Record<string, Scalar> } : {}),
      // Forwarded only when the agent sent one. Defaulting it would silently
      // opt an agent into a staleness check it did not ask for; dropping it
      // would silently opt it out of one it did. Neither is the relay's call.
      ...(typeof body.rev === "number" ? { rev: body.rev } : {}),
      // `screen` on exactly the same terms, and with the same restraint: the
      // relay does not know which screen the tab is on, does not compare it,
      // and does not refuse it. It is the agent's claim and the driver's check.
      // An empty string is dropped rather than forwarded, because it is not the
      // id of any screen and no app should be asked to refuse a call over a
      // field left blank.
      ...(typeof body.screen === "string" && body.screen ? { screen: body.screen } : {}),
      // `plan` on the same terms again, and here the restraint is not even a
      // choice: the token is opaque to everything but the core that minted it,
      // so a relay has nothing to compare it against and could only ever get
      // the comparison wrong. Dropped when blank, like `screen`, because an
      // empty string is not a token and the core's refusal should name the
      // field the agent actually left out.
      ...(typeof body.plan === "string" && body.plan ? { plan: body.plan } : {}),
    };

    return new Promise<WireResult>((resolve) => {
      let done = false;
      const settle = (r: WireResult, outcome: RelayAuditEvent["outcome"]) => {
        if (done) return;
        done = true;
        // ONE record per call, from the one place a call can be answered. The
        // `done` guard above is what makes it one: the deadline and a late
        // `result` frame race, and the loser must not log a second outcome for
        // a call that has already been answered.
        audit(who.id, tabId, frame.name, started, outcome);
        resolve(r);
      };
      const timer = setTimeout(() => {
        tab.pending.delete(id);
        // NOT a promise the call did not happen. The tab may have run the verb
        // and died before answering, so a `commit` that times out has an
        // unknown outcome and the agent must read the screen before retrying.
        // The relay says only "no answer arrived"; guessing further here is how
        // every client ends up inventing a different guess.
        settle(
          relayRefusal("timeout", `tab \`${tabId}\` did not answer \`${frame.name}\` within ${timeoutMs}ms`),
          "timeout",
        );
      }, timeoutMs);
      timer.unref?.();
      tab.pending.set(id, { settle, timer });

      if (!send(tab, frame)) {
        tab.pending.delete(id);
        clearTimeout(timer);
        settle(relayRefusal("tab-went-away", `writing to tab \`${tabId}\` failed`), "tab-went-away");
      }
    });
  }

  const handler = (req: IncomingMessage, res: ServerResponse): boolean => {
    const raw = req.url ?? "/";
    const qmark = raw.indexOf("?");
    const path = qmark === -1 ? raw : raw.slice(0, qmark);
    if (!path.startsWith("/dk/")) return false;

    if (closed) {
      json(res, 503, { error: "relay closed" });
      return true;
    }
    if (!allowRemote && !isLoopback(req.socket.remoteAddress)) {
      // Refused here rather than by not binding, because `attach()` means the
      // relay often does not own the listening socket and so cannot choose the
      // interface. The check has to live where the requests are.
      json(res, 403, {
        error: "forbidden",
        hint: "this relay drives a logged-in browser session; set allowRemote and put your app's own auth in front of it",
      });
      return true;
    }

    const query = new URLSearchParams(qmark === -1 ? "" : raw.slice(qmark + 1));
    const method = req.method ?? "GET";

    // Identity BEFORE routing. A caller who cannot be identified is told that
    // and nothing else -- not which methods a path takes, not whether the path
    // exists. Authenticating after routing is how an unauthorised caller gets
    // to map the surface.
    const who = whoami(req);
    if (!("id" in who)) {
      // The body is drained first for the same reason a 405 drains it: bytes
      // left in the socket become the next request on a keep-alive connection.
      void drain(req);
      json(res, 401, { error: who.error, hint: who.hint }, AUTH_HEADERS);
      return true;
    }

    // --- the two the tab uses --------------------------------------------
    if (path === "/dk/events") {
      if (method !== "GET") return bad(res, 405, "GET only", "bad-method");
      const tabId = query.get("tab");
      if (!tabId) return bad(res, 400, "GET /dk/events needs ?tab=");
      if (who.tab !== undefined && who.tab !== tabId) {
        // 403 and not `no-such-tab`, and the difference is the point. The
        // oracle rule is about ADDRESSING somebody else's tab; this caller is
        // opening its own and presented a credential bound to a different id,
        // which it already knows. Telling it so leaks nothing and is the only
        // answer it can act on.
        return bad(res, 403, "this credential is bound to another tab id", "forbidden");
      }
      openStream(who, tabId, req, res);
      return true;
    }

    if (path === "/dk/result") {
      if (method !== "POST") return bad(res, 405, "POST only", "bad-method");
      void readJson(req).then((body) => {
        if (!body || typeof body !== "object") return bad(res, 400, "expected a JSON frame");
        const frame = body as UpFrame;
        if (frame.t !== "hello" && frame.t !== "result" && frame.t !== "snapshot") {
          return bad(res, 400, "unknown frame `t`", "bad-frame");
        }
        const out = ingest(who, frame, query.get("tab") ?? undefined);
        if (!out.ok) return bad(res, out.status ?? 400, out.why ?? "rejected", out.error ?? "bad-frame");
        // 202, not 200: the tab is told its frame was accepted, and nothing
        // more. The answer to a call travels to the AGENT, not back up this
        // POST, so a body here would be an invitation to build a second,
        // divergent return path.
        json(res, 202, { ok: true, ...(out.why ? { note: out.why } : {}) });
      }, (err) => {
        onError(err);
        const f = bodyFailure(err);
        bad(res, f.status, f.hint, f.error);
      });
      return true;
    }

    // --- the four the agent uses -----------------------------------------
    if (path === "/dk/tabs") {
      if (method !== "GET") return bad(res, 405, "GET only", "bad-method");
      // The caller's own tabs, and never anybody else's. A listing of every
      // connected tab is an inventory of other people's sessions with their
      // titles and URLs attached, which is the single worst thing on this
      // surface and was the default.
      json(res, 200, { tabs: summaries(who.id, who.tab) });
      return true;
    }

    const parts = path.split("/").filter(Boolean); // dk, tabs, :tab, leaf
    if (parts.length === 4 && parts[1] === "tabs") {
      const tabId = decodeURIComponent(parts[2]!);
      const leaf = parts[3];

      if (leaf === "manifest" || leaf === "snapshot") {
        if (method !== "GET") return bad(res, 405, "GET only", "bad-method");
        const tab = owned(who, tabId);
        // Not Result-shaped, and that asymmetry is on purpose. A `Result` is
        // the outcome of a CALL; these two read state, and wrapping "there is
        // no such tab" in a fake `{ok:false, snapshot}` would hand the agent a
        // snapshot that describes nothing. Only /call promises one shape,
        // because only /call is the thing an agent must be able to handle
        // uniformly.
        //
        // A tab somebody else owns answers exactly this, byte for byte, so the
        // endpoint cannot be used to probe for other people's tab ids. Checked
        // BEFORE the `no-manifest` case below: a foreign tab that has sent no
        // manifest must not answer `no-manifest`, which would confirm it exists.
        if (!tab) return bad(res, 404, NO_SUCH_TAB_HINT, "no-such-tab");
        const value = leaf === "manifest" ? tab.manifest : tab.snapshot;
        if (!value) return bad(res, 404, `tab \`${tabId}\` has sent no ${leaf}`, `no-${leaf}`);
        json(res, 200, value);
        return true;
      }

      if (leaf === "watch") {
        if (method !== "GET") return bad(res, 405, "GET only", "bad-method");
        // 404 for a tab that is not connected, rather than an open stream that
        // may never carry anything. Consistent with /snapshot, and it is the
        // answer that tells a client to re-read /dk/tabs instead of waiting on
        // a subscription to a screen that does not exist.
        if (!owned(who, tabId)) return bad(res, 404, NO_SUCH_TAB_HINT, "no-such-tab");
        openWatch(who, tabId, req, res);
        return true;
      }

      if (leaf === "call") {
        if (method !== "POST") return bad(res, 405, "POST only", "bad-method");
        void readJson(req).then(
          (body) => {
            const answer = dispatch(who, tabId, (body ?? {}) as Record<string, unknown>);
            if (!answer) {
              // `bad` returns `true` for `handler`'s benefit -- that is how it
              // says "answered, stop looking for a route" -- and returning it
              // from an `onfulfilled` callback is a genuine signature error,
              // not a missing type: a `then` handler must produce `void` or a
              // promise, and `true` makes this branch and the one below
              // disagree about what the chain resolves to. Discarded here, and
              // discarded explicitly rather than by widening the callback's
              // type, because the value is only meaningful to a caller that
              // has a route to decline and this one does not.
              bad(res, 400, "a call needs a `name`");
              return;
            }
            return answer.then((result) => {
              // 200 even for a refusal. The HTTP layer succeeded: the question
              // was asked and answered. `ok:false` is the answer, not a
              // transport failure, and conflating the two is how an agent ends
              // up retrying a refusal it should have read.
              json(res, 200, result);
            });
          },
          (err) => {
            // Non-2xx, because no `WireResult` was produced: nothing was asked
            // of any tab. An agent must read this as an exception, not a no.
            onError(err);
            const f = bodyFailure(err);
            bad(res, f.status, f.hint, f.error);
          },
        );
        return true;
      }
    }

    return bad(res, 404, `no driverkit route ${method} ${path}`, "no-route");
  };

  /**
   * Subscribe an agent to a tab's `snapshot` frames.
   *
   * The same SSE shape the tab's own stream uses, down to the opening comment
   * and the ping, so a client needs one parser for both directions rather than
   * two that drift.
   */
  function openWatch(
    who: Principal,
    tabId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const id = key(who.id, tabId);
    res.writeHead(200, SSE_HEADERS);
    res.write(": driverkit\n\n");

    let set = watchers.get(id);
    if (!set) watchers.set(id, (set = new Set<ServerResponse>()));
    set.add(res);

    // The current snapshot goes out immediately. A watcher that attached to an
    // idle screen would otherwise know nothing at all until the next click,
    // and would have to fetch /snapshot anyway -- which is the poll the
    // endpoint exists to remove.
    const known = tabs.get(id)?.snapshot;
    if (known) write(res, { t: "snapshot", tab: tabId, snapshot: known });

    const ping = setInterval(() => write(res, null), pingMs);
    ping.unref?.();

    const gone = () => {
      clearInterval(ping);
      const live = watchers.get(id);
      live?.delete(res);
      if (live && live.size === 0) watchers.delete(id);
    };
    res.on("close", gone);
    req.on("aborted", gone);
  }

  /** Fan a tab's current snapshot out to its watchers. */
  function push(tab: Tab, force = false): void {
    const snapshot = tab.snapshot;
    if (!snapshot) return;
    const id = key(tab.principal, tab.tab);
    if (!force && broadcast.get(id) === snapshot.rev) return;
    broadcast.set(id, snapshot.rev);
    const set = watchers.get(id);
    if (!set) return;
    const frame: WatchFrame = { t: "snapshot", tab: tab.tab, snapshot };
    // A copy, because a watcher that has hung up is removed from the set by its
    // own `close` handler while this loop is running.
    for (const res of [...set]) write(res, frame);
  }

  /** One SSE write: a frame, or a ping comment when `frame` is null. */
  function write(res: ServerResponse, frame: WatchFrame | null): void {
    try {
      res.write(frame ? `event: ${frame.t}\ndata: ${JSON.stringify(frame)}\n\n` : ": ping\n\n");
    } catch (err) {
      onError(err);
    }
  }

  function summaries(principal?: string, tab?: string): TabSummary[] {
    return [...tabs.values()]
      .filter(
        (t) =>
          (principal === undefined || t.principal === principal) &&
          (tab === undefined || t.tab === tab),
      )
      .map((t) => ({
      tab: t.tab,
      ...(t.app === undefined ? {} : { app: t.app }),
      ...(t.title === undefined ? {} : { title: t.title }),
      ...(t.url === undefined ? {} : { url: t.url }),
      // Forwarded exactly as the tab said it, including not at all. Absence is
      // "the tab did not say", which a client must not read as "not the one";
      // see `TabFocus`. The relay has no opinion here and originates no value,
      // for the same reason it does not interpret `rev`.
      ...(t.focus === undefined ? {} : { focus: t.focus }),
      // The version, not the manifest. Listing tabs is the cheap call an agent
      // makes often; inlining every manifest would make it the expensive one.
      ...(t.manifest === undefined ? {} : { manifestVersion: t.manifest.version }),
        ...(t.snapshot === undefined ? {} : { rev: t.snapshot.rev }),
        since: t.since,
      }));
  }

  /**
   * The caller's principal, or the 401 to answer instead.
   *
   * Three doors, in this order:
   *
   *  1. AUTH OFF. Neither `auth` nor `resolvePrincipal` configured: everything
   *     is one principal and nothing is scoped. The unconfigured loopback relay
   *     a single developer runs, needing no tokens, no keys and no setup -- and
   *     the combination `allowRemote` makes impossible is the one where this is
   *     also exposed.
   *  2. `resolvePrincipal`. The embedded case: an app that already has sessions
   *     answers from its own middleware.
   *  3. THE CREDENTIAL. See `credentialFrom` for where it is read from.
   *
   * NO CREDENTIAL AND A BAD CREDENTIAL ARE DIFFERENT ANSWERS, and neither is
   * "anonymous". Silently treating an unreadable credential as a fresh
   * anonymous visitor was the tempting shape and is wrong twice over: a user
   * whose token lapsed would quietly become a stranger and lose their own tabs,
   * and an agent with a misconfigured key would be told "you have no tabs"
   * rather than "your key is wrong". Anonymous is a credential of its own kind,
   * so it is never what the absence of one means.
   */
  function whoami(req: IncomingMessage): Principal | { error: string; hint: string } {
    if (!auth && !resolvePrincipal) return LOCAL;

    const headers = req.headers as Record<string, string | string[] | undefined>;
    if (resolvePrincipal) {
      let resolved: string | undefined;
      try {
        resolved = resolvePrincipal(headers);
      } catch (err) {
        // A host hook that throws must not become a 500 that mentions the app's
        // internals, and must certainly not become an authenticated request.
        // It is an unidentified caller.
        onError(err);
      }
      if (resolved) return { id: resolved };
    }

    if (!auth) {
      return { error: "no-credential", hint: "this relay identifies callers by session" };
    }

    const url = req.url ?? "/";
    const at = url.indexOf("?");
    const credential = credentialFrom(
      headers,
      new URLSearchParams(at === -1 ? "" : url.slice(at + 1)),
    );
    if (!credential) {
      return {
        error: "no-credential",
        hint:
          "present a tab token: Authorization: Bearer, X-DK-Token, the dk_token cookie, " +
          "or ?dk_token= (the last of those ends up in proxy access logs)",
      };
    }
    try {
      return auth.principal(credential);
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      // ONE slug for every way a credential can fail, and the hint is fixed.
      // "The signature verified but the audience was wrong" tells a forger that
      // the forgery worked; "expired" and "not yet valid" tell a prober the
      // clock. A legitimate client's move is the same in every case -- mint a
      // fresh token, retry once -- so the distinction buys it nothing and buys
      // an attacker a test harness. The reason is never logged either: it would
      // be a log line about a credential.
      return { error: "bad-credential", hint: "present a fresh tab token" };
    }
  }

  return {
    handler,
    attach(server: Server) {
      // The listeners already on the server are taken off and re-called by
      // hand, rather than simply prepending the relay to them.
      //
      // `node:http` runs EVERY `request` listener, so prepending would mean
      // the app's own handler also runs for /dk/* and writes a second set of
      // headers into a response the relay already answered. Making it work
      // would require every host app to start with `if (res.headersSent)
      // return` -- a line nobody adds until the day it crashes a stream. So
      // `attach` behaves the way the word implies: the relay takes /dk/*, and
      // everything else is passed along untouched.
      //
      // The consequence worth knowing: listeners registered AFTER attach are
      // not wrapped and will see /dk/* too. Attach last.
      const downstream = server.listeners("request") as Array<
        (req: IncomingMessage, res: ServerResponse) => void
      >;
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        if (handler(req as IncomingMessage, res as ServerResponse)) return;
        for (const next of downstream) next.call(server, req as IncomingMessage, res as ServerResponse);
      });
    },
    tabs: () => summaries(),
    tabsFor: (principal: string, tab?: string) => summaries(principal, tab),
    close() {
      closed = true;
      for (const tab of [...tabs.values()]) {
        clearInterval(tab.ping);
        for (const [, p] of tab.pending) {
          clearTimeout(p.timer);
          p.settle(relayRefusal("tab-went-away", "the relay is shutting down"), "tab-went-away");
        }
        tab.pending.clear();
        try {
          tab.res.end();
        } catch (err) {
          onError(err);
        }
      }
      tabs.clear();
      for (const set of watchers.values()) {
        for (const res of set) {
          try {
            res.end();
          } catch (err) {
            onError(err);
          }
        }
      }
      watchers.clear();
      broadcast.clear();
    },
  };
}

/**
 * A refusal the relay originated: one of a closed set, and with NO `snapshot`.
 *
 * The missing field is the whole signal. `Result` requires a snapshot because a
 * driver mounted in a page always has one; the relay often does not -- a call
 * to a tab that never connected has no screen behind it at all -- so
 * `WireResult` widens the type rather than letting the relay invent a value.
 *
 * An invented snapshot would be worse than a missing one in both directions.
 * An empty one tells an agent the app has no rows, which is a lie about the
 * app rather than about the call. A sentinel like `{where:"(not connected)"}`
 * is still a snapshot, so some client eventually renders it to a model as
 * though it were a screen. Absence cannot be mistaken for either: a client
 * reads it as "the call did not arrive", never as "the screen is empty".
 */
function relayRefusal(refused: RelayRefusal, hint: string): WireResult {
  return { ok: false, refused, hint };
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false; // A unix socket or an unknown peer is not proven local.
  return (
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // A tab id is a capability, so nothing here is cacheable by anything.
    "cache-control": "no-store",
    ...extra,
  });
  res.end(text);
}

/**
 * Read and discard a body we are not going to parse.
 *
 * PROTOCOL.md: "An unread body is worse than a wrong answer." On a keep-alive
 * connection the bytes a relay failed to read are still in the socket when the
 * next request is parsed off it, so they BECOME that request. A 401 that left
 * the body behind would answer one caller correctly and destroy every later
 * request on that socket.
 */
function drain(req: IncomingMessage): void {
  req.resume();
}

/** A non-2xx answer: no `WireResult` was produced, so the client must read it
 *  as a transport failure rather than as an app's "no". The `error` slug is
 *  pinned per case by PROTOCOL.md's status table. */
function bad(res: ServerResponse, status: number, hint: string, error = "bad-request"): true {
  json(res, status, { error, hint });
  return true;
}

interface BodyError extends Error {
  dkStatus: number;
  dkError: string;
}

function tooLarge(): BodyError {
  return Object.assign(new Error(`body over the ${MAX_BODY}-byte limit`), {
    dkStatus: 413,
    dkError: "too-large",
  });
}

/** The status a failed body read should answer with: 413 when it was too big,
 *  400 when it was unparseable. Distinguished because they are different
 *  problems for the sender -- one is "send less", the other is "send JSON". */
function bodyFailure(err: unknown): { status: number; error: string; hint: string } {
  const e = err as Partial<BodyError>;
  return e?.dkStatus
    ? { status: e.dkStatus, error: e.dkError ?? "too-large", hint: e.message ?? "body too large" }
    : { status: 400, error: "bad-request", hint: "could not read the body" };
}

/**
 * Read a JSON body, with the size limit enforced the way a 413 can survive.
 *
 * Over the limit, buffering stops but READING CONTINUES, and the rejection
 * waits for `end`. The obvious implementation -- hang up the moment the limit
 * is crossed -- loses the 413 it is trying to send: the sender is still writing,
 * so it gets a reset on its own socket and never reads the response that would
 * have told it what was wrong. A sender that cannot learn why it failed retries
 * identically, which is the opposite of what a limit is for.
 *
 * Memory stays bounded because the overflow is counted and discarded rather
 * than kept. `ABORT_AT` is the backstop for a sender that is not going to stop:
 * past it the connection does go, because at that point the upload is an attack
 * and not a mistake, and politely reading all of it is the attack succeeding.
 */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0; // Nothing here will be parsed; stop paying for it.
        if (size > ABORT_AT) {
          reject(tooLarge());
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return reject(tooLarge());
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
