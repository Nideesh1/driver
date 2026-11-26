/**
 * driverkit/relay — who the caller is, and nothing more than that.
 *
 * A port of `python/src/driverkit/auth.py`, claim for claim and refusal for
 * refusal. The long-form argument lives in that file's docstring and in
 * PROTOCOL.md's "Who is allowed to do this"; what follows here is the summary
 * and the places this half could plausibly drift.
 *
 * This module answers one question: WHICH PERSON is on the other end of this
 * request? It never answers "may they do this", because PROTOCOL.md's core
 * property is untouched by any of it:
 *
 *   THE RELAY GRANTS NO AUTHORITY. It forwards a verb to a tab that is already
 *   logged in as a person, and that tab's own session is what the app checks.
 *
 * A credential here buys its holder nothing they could not already do in their
 * own browser. What it buys the RELAY is the ability to keep a hundred people's
 * tabs apart. Isolation, not authorisation.
 *
 * The token:
 *
 *   dkt1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(key, "dkt1." + payload))>
 *
 * The algorithm is in the PREFIX, not in the payload, which is the deliberate
 * departure from JWT: a JWT names its own algorithm in a header the verifier
 * has not authenticated yet, and that is the root of both the `alg: none`
 * family of bugs and the HMAC/RSA confusion family. Here there is nothing to
 * negotiate. A future `dkt2` is a new prefix -- a greppable change rather than
 * a field an attacker can set.
 *
 * Claims: `sub` (the principal), `aud` (which relay this is for), `iat`/`exp`
 * (Unix seconds, honoured with `DEFAULT_SKEW_S` of slack), `kid` (which key
 * signed it; read before verification, used only to SELECT the key, so an
 * attacker who edits it fails the MAC), and an optional `tab` binding the
 * credential to one tab id.
 *
 * Anonymous: `anon1.<base64url(32 random bytes)>`, minted by the page, keyless
 * in the relay, resolving to `anon:<sha256("driverkit-anon-v1." + secret)[:16]>`.
 * Independent per visitor -- "anonymous" is never one bucket. It is a bearer
 * capability and not an identity, it dies with the tab, and it confers nothing
 * at the app.
 *
 * Zero dependencies: `node:crypto` only.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The version prefix that IS the algorithm. */
export const TOKEN_PREFIX = "dkt1";
/** The anonymous credential's prefix. */
export const ANON_PREFIX = "anon1";
/** What an anonymous principal id starts with. */
export const ANON_ID_PREFIX = "anon:";
/**
 * The principal every request resolves to when auth is off.
 *
 * One principal means the scoping in `relay.ts` is a no-op and the
 * unconfigured loopback relay a single developer runs is byte-for-byte what it
 * was before any of this existed.
 */
export const LOCAL_PRINCIPAL = "local";

/**
 * Shortest key accepted. A 16-character shared secret makes the HMAC theatre,
 * and the moment to say so is at construction rather than in a post-mortem.
 */
export const MIN_SECRET_BYTES = 32;

/**
 * How long a freshly minted token lasts, in ms.
 *
 * Short, because a short lifetime is what substitutes for the revocation a
 * stateless token cannot have. The page asks for a new one on every reconnect,
 * so this does not need to cover a session.
 */
export const DEFAULT_TTL_MS = 120_000;

/**
 * Clock slack on `exp`, and the window by which an `iat` may lead now.
 *
 * Sixty seconds, not five minutes. Skew tolerance is a direct extension of
 * every token's lifetime, so a five-minute window on a two-minute token would
 * more than treble the time a leaked one stays useful. Sixty covers two hosts
 * with working NTP, which is the case this is for; a fleet whose clocks are
 * minutes apart has a problem a wider window hides rather than solves.
 */
export const DEFAULT_SKEW_MS = 60_000;

const ANON_DOMAIN = "driverkit-anon-v1.";

/**
 * A credential did not check out.
 *
 * Deliberately carries no machine-readable reason. The relay answers every
 * instance with one slug -- `bad-credential` -- because the distinctions a
 * caller might want are exactly the distinctions an attacker wants: "the
 * signature verified but the audience was wrong" tells a forger the forgery
 * worked. A legitimate client's move is the same in every case (mint a fresh
 * token, retry once), so the split buys it nothing.
 */
export class AuthError extends Error {
  override readonly name = "AuthError";
}

/**
 * Who a request is from.
 *
 * `id` is the registry key half that makes isolation structural: a tab is
 * stored under `(principal, tab id)`, so one principal cannot reach another's
 * tab by any code path, including one somebody adds later and forgets to
 * guard.
 *
 * `tab` is the optional binding from the credential. When it is set the caller
 * may address that tab and no other.
 */
export interface Principal {
  readonly id: string;
  readonly tab?: string;
  readonly anonymous?: boolean;
}

export interface TabAuthOptions {
  /**
   * Which relay these tokens are for. No default: a default audience is an
   * audience nobody chose, and two relays that both accept "driverkit" are one
   * relay as far as a stolen token is concerned.
   */
  audience: string;
  /** Key id to secret. Rotation is additive; see `TabAuth`. */
  keys?: Record<string, string | Buffer>;
  /** Sugar for the single-key case. Mutually exclusive with `keys`. */
  secret?: string | Buffer;
  /** Which key `mint` signs with. Defaults to the first in `keys`. */
  activeKid?: string;
  ttlMs?: number;
  skewMs?: number;
  /**
   * Accept `anon1.` credentials. On by default so an unauthenticated visitor
   * is not an error; turn it off in an app where every user is logged in,
   * because an anonymous credential there can only be somebody probing.
   */
  anonymous?: boolean;
  /** Refuse any `dkt1` token without a `tab` claim. See `mint`. */
  requireTabBinding?: boolean;
}

/** The principal id an `anon1.` credential resolves to. Pure and keyless. */
export function anonPrincipalId(credential: string): string {
  const dot = credential.indexOf(".");
  const secret = dot === -1 ? "" : credential.slice(dot + 1);
  const digest = createHash("sha256").update(ANON_DOMAIN + secret, "utf8").digest();
  return ANON_ID_PREFIX + digest.subarray(0, 16).toString("hex");
}

/**
 * A fresh anonymous credential. For a page, or a test; never the relay.
 *
 * 256 bits, because this string is the whole of an anonymous visitor's
 * isolation: anybody who can guess it is that visitor.
 */
export function mintAnonCredential(): string {
  return `${ANON_PREFIX}.${b64u(randomBytes(32))}`;
}

/**
 * Verification, and the minter the app's backend uses.
 *
 * The app's backend is the only thing that knows who a browser is, so it is
 * the only thing that may mint. Give it the same `keys` and `audience` the
 * relay has and it needs nothing else -- no relay client, no callback, no
 * shared database.
 *
 * Rotation is additive and ordered:
 *
 *   1. Add the new key to the RELAY's `keys`. Deploy. It accepts both; nothing
 *      mints with the new one yet.
 *   2. Point the minter at it (`activeKid`). Deploy.
 *   3. After `ttlMs + skewMs`, drop the old key from the relay.
 *
 * The order is the whole of it. A key the relay does not know yet refuses
 * every token signed with it, and a key dropped before the last token signed
 * with it expires logs a hundred people out at once.
 */
export class TabAuth {
  readonly audience: string;
  readonly ttlMs: number;
  readonly skewMs: number;
  readonly anonymous: boolean;
  readonly requireTabBinding: boolean;
  readonly activeKid: string;
  readonly #keys = new Map<string, Buffer>();

  constructor(options: TabAuthOptions) {
    const { audience, keys, secret } = options;
    if (keys && secret !== undefined) throw new Error("driverkit: pass keys or secret, not both");
    // Sugar for the single-key case, which is every deployment until the first
    // rotation. It still gets a kid, so a single-key relay's tokens are shaped
    // exactly like a rotating one's and rotation needs no format change.
    const table = keys ?? (secret === undefined ? undefined : { k1: secret });
    if (!table || Object.keys(table).length === 0) {
      throw new Error("driverkit: TabAuth needs keys or secret");
    }
    if (!audience) throw new Error("driverkit: TabAuth needs an audience naming this relay");

    for (const [kid, value] of Object.entries(table)) {
      const raw = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
      if (raw.length < MIN_SECRET_BYTES) {
        throw new Error(
          `driverkit: key "${kid}" is ${raw.length} bytes; at least ${MIN_SECRET_BYTES} are ` +
            `needed. \`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"\``,
        );
      }
      if (!kid || kid.includes(".")) throw new Error(`driverkit: "${kid}" is not a usable key id`);
      this.#keys.set(kid, raw);
    }

    this.audience = audience;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
    this.anonymous = options.anonymous ?? true;
    this.requireTabBinding = options.requireTabBinding ?? false;
    this.activeKid = options.activeKid ?? this.#keys.keys().next().value!;
    if (!this.#keys.has(this.activeKid)) {
      throw new Error(`driverkit: activeKid "${this.activeKid}" is not in keys`);
    }
  }

  /**
   * A token saying `principal` is who the bearer is.
   *
   * `tab` binds it to one tab id, and whether to use it is the one real
   * judgement call here.
   *
   * It costs a round trip. The tab mints its own id -- PROTOCOL.md requires
   * that, so a reconnect resumes identity -- which means the backend cannot
   * know the id at page-render time. Binding turns one template variable into
   * "the page asks the backend for a token AFTER the JS has picked an id", and
   * re-asks on every reconnect that changes it.
   *
   * IT IS NOT STRICTLY SAFER, and the asymmetry is worth understanding before
   * choosing. Both cases assume a stolen token, which is the only case either
   * addresses.
   *
   * Unbound: the thief cannot read or drive the victim's tabs. They can
   * register a tab THEY control under the victim's principal. It runs in their
   * browser, where their own session is what the app checks, so they gain no
   * authority -- but the victim's agent now sees a tab that is not the
   * victim's and may drive it, typing the victim's data onto the attacker's
   * screen. An extra tab; the real ones untouched.
   *
   * Bound to tab T: the thief cannot do that. What they can do is open a stream
   * for T -- and a second stream for a known (principal, tab) is a RECONNECT,
   * which supersedes the first. The victim's own page is hung up on and the
   * thief's becomes that tab, until the victim's `EventSource` reconnects and
   * supersedes back. That is a takeover of the exact tab the agent is already
   * driving, which is worse than an extra tab in the list.
   *
   * What bounds both is the token not leaking: deliver it in a `__Host-`
   * cookie rather than a query parameter, and keep the lifetime short.
   *
   * A credential for an AGENT should be bound whenever the agent drives one
   * known tab. There it is free -- the agent has the tab id already -- and the
   * supersede hazard does not apply, because an agent never opens a tab stream.
   */
  mint(principal: string, options: { tab?: string; ttlMs?: number; now?: number } = {}): string {
    if (!principal) throw new Error("driverkit: a token needs a principal");
    if (principal.startsWith(ANON_ID_PREFIX)) {
      // Otherwise a backend bug could mint a signed token claiming an anonymous
      // principal, and the two kinds would stop being distinguishable -- which
      // is the one thing `Principal.anonymous` is for.
      throw new Error(`driverkit: "${ANON_ID_PREFIX}" is reserved for anonymous visitors`);
    }
    const issued = options.now ?? Date.now();
    const life = options.ttlMs ?? this.ttlMs;
    const claims: Record<string, string | number> = {
      aud: this.audience,
      exp: Math.floor((issued + life) / 1000),
      iat: Math.floor(issued / 1000),
      kid: this.activeKid,
      sub: principal,
      ...(options.tab ? { tab: options.tab } : {}),
    };
    // Sorted keys, so the same claims are the same bytes in both languages.
    const ordered: Record<string, string | number> = {};
    for (const key of Object.keys(claims).sort()) ordered[key] = claims[key]!;
    const body = b64u(Buffer.from(JSON.stringify(ordered), "utf8"));
    return `${TOKEN_PREFIX}.${body}.${b64u(this.#mac(this.activeKid, body))}`;
  }

  /**
   * The principal a credential proves, or `AuthError`.
   *
   * Anonymous first, because it needs no key and cannot be confused with a
   * token: the prefixes are disjoint and both are checked exactly.
   */
  principal(credential: string, now = Date.now()): Principal {
    const text = (credential ?? "").trim();
    if (!text) throw new AuthError("empty credential");

    if (text.startsWith(`${ANON_PREFIX}.`)) {
      if (!this.anonymous) throw new AuthError("anonymous credentials are not accepted");
      const secret = text.slice(ANON_PREFIX.length + 1);
      // 32 base64url characters is 24 bytes. A short anonymous secret is a
      // guessable principal, and a guessable anonymous principal is the shared
      // bucket this design exists to avoid.
      if (secret.length < 32) throw new AuthError("an anonymous secret is too short");
      return { id: anonPrincipalId(text), anonymous: true };
    }

    const parts = text.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) throw new AuthError("not a dkt1 token");
    const body = parts[1]!;
    const claims = parseJson(b64uDecode(body));
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
      throw new AuthError("the payload is not a JSON object");
    }
    const c = claims as Record<string, unknown>;

    const kid = c["kid"];
    // Refused, never retried against the other keys. "Try them all" turns a
    // rotation window into a period where every key is live for every token,
    // which is the opposite of what rotating is for.
    if (typeof kid !== "string" || !this.#keys.has(kid)) throw new AuthError("unknown key id");

    const want = this.#mac(kid, body);
    const got = b64uDecode(parts[2]!);
    // `timingSafeEqual` THROWS on unequal lengths rather than returning false,
    // which would turn a truncated signature into a 500 instead of a refusal.
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      throw new AuthError("the signature does not verify");
    }

    // Everything below reads an AUTHENTICATED payload. The order matters:
    // nothing from `c` was trusted above except `kid`, which only selects the
    // key the MAC is then checked with.
    if (c["aud"] !== this.audience) throw new AuthError("the token is for another audience");

    const sub = c["sub"];
    if (typeof sub !== "string" || !sub) throw new AuthError("the token names no principal");
    if (sub.startsWith(ANON_ID_PREFIX)) {
      throw new AuthError(`a signed token may not claim an "${ANON_ID_PREFIX}" principal`);
    }

    const exp = c["exp"];
    const iat = c["iat"];
    if (typeof exp !== "number" || typeof iat !== "number") {
      throw new AuthError("the token has no usable iat/exp");
    }
    if (exp * 1000 + this.skewMs < now) throw new AuthError("the token has expired");
    // A token from the future is not evidence. Accepting it would let a minter
    // with a wrong clock issue credentials that outlive their stated lifetime
    // by however far the clock is out.
    if (iat * 1000 - this.skewMs > now) throw new AuthError("the token was issued in the future");

    const tab = c["tab"];
    if (tab !== undefined && (typeof tab !== "string" || !tab)) {
      throw new AuthError("the tab claim is not a tab id");
    }
    if (this.requireTabBinding && !tab) throw new AuthError("a tab-bound token is required");

    return { id: sub, ...(tab ? { tab } : {}) };
  }

  #mac(kid: string, body: string): Buffer {
    // The prefix is inside the MAC, so a `dkt2` with a different meaning cannot
    // be produced by relabelling a `dkt1` payload.
    return createHmac("sha256", this.#keys.get(kid)!).update(`${TOKEN_PREFIX}.${body}`, "utf8").digest();
  }
}

function b64u(raw: Buffer): string {
  return raw.toString("base64url");
}

/**
 * Unpadded base64url, with anything undecodable raised as an `AuthError`.
 *
 * Node's `base64url` decoder is lenient and never throws, so the round trip is
 * what rejects: a payload that merely LOOKS like base64 would otherwise become
 * a mojibake principal id rather than a refusal.
 */
function b64uDecode(text: string): Buffer {
  const raw = Buffer.from(text, "base64url");
  if (raw.length === 0 && text.length > 0) throw new AuthError("not base64url");
  return raw;
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AuthError("the payload is not JSON");
  }
}

/**
 * The caller's credential, from the four places it can arrive.
 *
 * In order, and the order is the order of preference:
 *
 *  1. `Authorization: Bearer` -- what an agent, an MCP server or any HTTP
 *     client should use. Standard, and not logged by anything by default.
 *  2. `X-DK-Token` -- for a client whose `Authorization` is already spoken for
 *     by the app the relay is embedded in.
 *  3. The `dk_token` cookie (`__Host-` prefixed or not) -- the one that works
 *     for `EventSource`, which cannot set a header at all. In the deployment
 *     PROTOCOL.md recommends, where the relay is same-origin with the app, this
 *     is the best option a page has: the app sets the cookie and the browser
 *     attaches it to the stream request with no token anywhere in a URL.
 *  4. `?dk_token=` -- the last resort, for a cross-origin `EventSource` where
 *     no cookie will be sent. A QUERY PARAMETER ENDS UP IN EVERY REVERSE
 *     PROXY'S ACCESS LOG, which is the one place a token must not be. It is
 *     accepted because refusing it would mean cross-origin pages could not
 *     connect at all, and it is last and documented as a liability. Short token
 *     lifetimes are what make a logged one survivable.
 */
export function credentialFrom(
  headers: Record<string, string | string[] | undefined>,
  query: URLSearchParams,
): string | undefined {
  const raw = one(headers["authorization"]);
  if (raw && raw.slice(0, 7).toLowerCase() === "bearer ") return raw.slice(7).trim() || undefined;

  const direct = one(headers["x-dk-token"])?.trim();
  if (direct) return direct;

  // Node joins a repeated `Cookie` with "; " already, but HTTP/2 splits it and
  // some proxies pass an array through, so both shapes are handled: keeping
  // only the first copy would silently drop the credential in a jar with
  // several entries.
  const jar = headers["cookie"];
  const cookie = Array.isArray(jar) ? jar.join("; ") : jar;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const at = part.indexOf("=");
      if (at === -1) continue;
      const name = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if ((name === "dk_token" || name === "__Host-dk_token") && value) {
        return decodeURIComponent(value);
      }
    }
  }

  return query.get("dk_token") || undefined;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
