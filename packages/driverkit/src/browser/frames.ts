/**
 * The wire frames, as PROTOCOL.md defines them.
 *
 * Declared here as well as in `driverkit/relay` on purpose: see the note at
 * the top of that file. The protocol document is the contract between the two
 * sides; a shared module would quietly become the contract instead, and then
 * the Rust relay and the hand-written page loop PROTOCOL.md promises are
 * possible would be second-class.
 */

import type { Driver, Manifest, Result, Scalar, Snapshot } from "../core/index.ts";

export type { Driver, Manifest, Result, Scalar, Snapshot };

export interface HelloFrame {
  t: "hello";
  tab: string;
  app?: string;
  manifest?: Manifest;
  snapshot?: Snapshot;
  title?: string;
  url?: string;
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
