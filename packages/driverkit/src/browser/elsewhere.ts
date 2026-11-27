/**
 * driverkit/browser — the cross-tab commit channel.
 *
 * One function, and it is twenty lines over a browser primitive. What it is
 * FOR is the interesting part, and the argument is on `ElsewhereChannel` in
 * core: two tabs of one app over one backend, an agent commits in tab A, and
 * tab B goes on reporting stale rows at an unmoved `rev` — so B's `stale`
 * check passes, B's plan token verifies, and the staleness machinery passes in
 * exactly the situation it exists to catch.
 *
 * WHY `BroadcastChannel` AND NOT THE RELAY. The relay sees both tabs and knows
 * they belong to one principal, so it looks like the natural place. It is not,
 * for two reasons that are both about what a relay is. It is a dumb pipe that
 * grants no authority and knows nothing about verbs — to decide that a call
 * was a commit it would have to read `kind` out of a manifest, which makes it
 * a second place that decides what a commit is, and the first thing to drift.
 * And it cannot help the case that needs help most: an app driven by its own
 * in-page panel has no relay at all, and that configuration is the library's
 * own worked example. `BroadcastChannel` is same-origin, server-free, and
 * reaches exactly the tabs that mounted driverkit — which is precisely the
 * hazard, since a tab with no driver has no `rev` to be wrong about.
 *
 * WHAT IT IS NOT. It is not replication and it is not invalidation. Nothing on
 * this channel carries a row, a count or a user; see `ElsewhereNotice`. An app
 * that wants tab B to be CORRECT rather than merely honest listens on the same
 * channel itself and refetches — and then `rev` moves, the notice clears, and
 * none of the core's checks ever fire. That app is the destination. This is
 * what keeps the gap visible on the way there.
 */

import type { ElsewhereChannel, ElsewhereNotice } from "../core/index.ts";

/**
 * The part of `BroadcastChannel` this uses, as a structural type.
 *
 * Narrow for the same reason `EventSourceLike` in `connect.ts` is narrow, and
 * it is a design requirement rather than a testing shim: a cross-tab mechanism
 * that can only be exercised by opening two real tabs is a mechanism whose
 * tests nobody runs. The real `BroadcastChannel` satisfies this and so does a
 * ten-line in-process fake, which is what makes "two drivers sharing a store,
 * a commit through one, and an assertion about what the other now reports"
 * an ordinary unit test.
 */
export interface BroadcastChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: "message", listener: (event: { data?: unknown }) => void): void;
  removeEventListener?(type: "message", listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface BroadcastChannelCtor {
  new (name: string): BroadcastChannelLike;
}

export interface BroadcastElsewhereOptions {
  /**
   * The channel name. Defaults to `driverkit:elsewhere`.
   *
   * PASS ONE PER APP if two different driverkit apps are served from one
   * origin. They would otherwise share a channel, and a commit in the admin
   * console would mark the customer portal's tabs behind — true of nothing,
   * and it would refuse commits there until that tab's own `rev` moved.
   */
  name?: string;
  /** The constructor, defaulting to the global. Injected in tests, and the
   *  reason `BroadcastChannelLike` is as narrow as it is. */
  BroadcastChannel?: BroadcastChannelCtor;
}

const DEFAULT_NAME = "driverkit:elsewhere";

/**
 * An `ElsewhereChannel` over `BroadcastChannel`. Pass it to `mount()`.
 *
 * ```js
 * const driver = mount({ app: "CRM", verbs, visible, elsewhere: broadcastElsewhere() });
 * ```
 *
 * THROWS rather than returning a channel that does nothing when there is no
 * `BroadcastChannel` — the same rule as `driverkit/relay` having no browser
 * shim, and for the same reason stated there: "a `createRelay` that silently
 * did nothing would be worse than a build error". A no-op here would be worse
 * still, because the app would believe it had a cross-tab check and the whole
 * point of the check is that the failure it guards is silent.
 *
 * Supported everywhere that matters (Chrome 54, Firefox 38, Safari 15.4). An
 * app that must run below Safari 15.4 should pass its own channel over
 * whatever it already has — a websocket, a service worker, `localStorage`
 * events — rather than get a quiet nothing from here.
 */
export function broadcastElsewhere(options: BroadcastElsewhereOptions = {}): ElsewhereChannel {
  const Ctor =
    options.BroadcastChannel ??
    (globalThis as { BroadcastChannel?: BroadcastChannelCtor }).BroadcastChannel;
  if (!Ctor) {
    throw new Error(
      "driverkit: no BroadcastChannel. Pass options.BroadcastChannel, or give `mount()` an " +
        "`elsewhere` channel over a transport this environment has. A channel that silently " +
        "did nothing would leave the app believing it had a cross-tab check.",
    );
  }

  const bus = new Ctor(options.name ?? DEFAULT_NAME);

  return {
    post(notice: ElsewhereNotice) {
      // Sent as the plain object. `BroadcastChannel` structured-clones it and
      // does NOT deliver it to the sender, so a driver's own notice never
      // comes back — but the core checks `from` anyway, because a channel
      // written over a websocket does echo and the core must behave the same
      // over either.
      bus.postMessage({ ...notice });
    },
    listen(heard: (notice: ElsewhereNotice) => void) {
      const onMessage = (event: { data?: unknown }): void => {
        const data = event?.data as Partial<ElsewhereNotice> | undefined;
        // Shape-checked here as well as in the core. Anything else on this
        // channel name — another library, a newer driverkit, a page's own
        // messages — is dropped rather than passed on as a notice, because a
        // notice with no `verb` would put the word `undefined` into a refusal
        // a model reads.
        if (!data || typeof data.verb !== "string" || typeof data.from !== "string") return;
        heard({ verb: data.verb, from: data.from });
      };
      bus.addEventListener("message", onMessage);
      return () => {
        bus.removeEventListener?.("message", onMessage);
        // Closed on unmount, so a hot-reloading dev server does not leave one
        // open channel per save. A `BroadcastChannel` is per-page, not
        // per-driver, but this function created it, so this function owns it.
        bus.close();
      };
    },
  };
}
