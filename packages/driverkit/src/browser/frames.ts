/**
 * The wire frames, as PROTOCOL.md defines them.
 *
 * Declared here as well as in `driverkit/relay` on purpose: see the note at
 * the top of that file. The protocol document is the contract between the two
 * sides; a shared module would quietly become the contract instead, and then
 * the Rust relay and the hand-written page loop PROTOCOL.md promises are
 * possible would be second-class.
 */

import type { Driver, Manifest, Result, Scalar, Snapshot, TabFocus } from "../core/index.ts";

export type { Driver, Manifest, Result, Scalar, Snapshot, TabFocus };

export interface HelloFrame {
  t: "hello";
  tab: string;
  app?: string;
  manifest?: Manifest;
  snapshot?: Snapshot;
  title?: string;
  url?: string;
  /** Where this tab stands in the person's attention; see `TabFocus`. In
   *  `hello` as well as in `snapshot` because `hello` is the only frame a tab
   *  that is opened and left alone ever sends. */
  focus?: TabFocus;
}

export interface ResultFrame {
  t: "result";
  id: string;
  result: Result;
  /** Which tab is answering. PROTOCOL.md's frame listing omits this; the page
   *  sends it in the body AND as `?tab=` so a relay reading either one works. */
  tab?: string;
}

export interface SnapshotFrame {
  t: "snapshot";
  snapshot: Snapshot;
  tab?: string;
  /**
   * The tab's url as it is NOW.
   *
   * Here as well as in `hello` because `hello` is sent once per stream and a
   * single-page app navigates without reconnecting -- so `TabInfo.url`, which
   * came from `hello` alone, was stale from the first client-side route change
   * and had no way back. A push is already going out whenever the page moves.
   */
  url?: string;
  /** The tab's focus as it is NOW. A change of focus is pushed on this frame
   *  rather than on a frame of its own: the protocol gains a field, and a relay
   *  written before it goes on reading the frame it always read. */
  focus?: TabFocus;
}

export interface CallFrame {
  t: "call";
  id: string;
  name: string;
  args?: Record<string, Scalar>;
  rev?: number;
  /** The agent's claim about which screen it read, handed to the driver as
   *  `CallOptions.screen` and checked there before `rev`. */
  screen?: string;
  /** The plan token the agent is presenting, handed to the driver as
   *  `CallOptions.plan` and checked there before `rev`. Carried here because
   *  this hop is where it would otherwise be dropped — which would leave the
   *  field working in-page and silently doing nothing over the relay, and a
   *  commit guarantee that holds on one of two paths is not a guarantee. */
  plan?: string;
}
