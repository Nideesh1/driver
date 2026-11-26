/**
 * The wire frames, as PROTOCOL.md defines them.
 *
 * These are declared here and again in `@driverkit/browser` rather than shared
 * from one module, and that duplication is deliberate. PROTOCOL.md is the
 * contract; a shared TypeScript type is not. The whole point of writing the
 * protocol down was that the relay can be written in any language and the page side can
 * be a hand-written `fetch` loop, so neither side may acquire a compile-time
 * dependency on the other's source. Two small copies that must agree with a
 * document beat one copy that quietly becomes the real specification.
 *
 * `Snapshot`, `Manifest` and `Result` DO come from core, by relative path.
 * Those are the payload types an app author already imports, and inventing a
 * second definition of `Result` is how the relay would start disagreeing with
 * the driver about what an answer looks like. The path is relative because
 * driverkit has no node_modules: with zero dependencies there is no package
 * resolution to hang a bare specifier on.
 */

import type {
  Manifest,
  RelayRefusal,
  Result,
  Scalar,
  Snapshot,
  WireResult,
} from "driverkit";

export type { Manifest, RelayRefusal, Result, Scalar, Snapshot, WireResult };

/** Tab → relay, once, immediately on connecting. */
export interface HelloFrame {
  t: "hello";
  tab: string;
  app?: string;
  manifest?: Manifest;
  snapshot?: Snapshot;
  /** Only so a human can tell two tabs apart when asked "which one?". */
  title?: string;
  url?: string;
}

/** Tab → relay, the answer to exactly one `call`. */
export interface ResultFrame {
  t: "result";
  /** Echoed from the `call` frame. This is the only correlation there is. */
  id: string;
  result: Result;
  /** Not in PROTOCOL.md's frame listing; see the note in `relay.ts` about how
   *  the relay learns which tab a POST came from. */
  tab?: string;
}

/** Tab → relay, the page moved on its own because a person clicked something. */
export interface SnapshotFrame {
  t: "snapshot";
  snapshot: Snapshot;
  tab?: string;
}

/** Relay → tab, run a verb. */
export interface CallFrame {
  t: "call";
  id: string;
  name: string;
  args?: Record<string, Scalar>;
  /** The agent's claim about what it was looking at. Forwarded untouched: the
   *  relay has no opinion about staleness, the driver does. */
  rev?: number;
  /** The agent's claim about WHICH SCREEN it was looking at, checked by the
   *  driver before `rev` and refused as `wrong-screen`. Forwarded untouched for
   *  the same reason `rev` is: the relay does not know which screen a tab is
   *  on, and a relay that compared screens would be a second set of rules
   *  beside the core's. See `CallOptions.screen`. */
  screen?: string;
}

export type UpFrame = HelloFrame | ResultFrame | SnapshotFrame;
export type DownFrame = CallFrame;

/**
 * One row of `GET /dk/tabs`, pinned by PROTOCOL.md.
 *
 * The id field is `tab`, spelled the same as in the `hello` frame: one name
 * for one thing. It is not `id`, which would collide in a reader's head with
 * the `id` on a `call` frame and the `id` on a row.
 */
export interface TabSummary {
  tab: string;
  app?: string;
  title?: string;
  url?: string;
  /** The manifest's `version`, not the manifest. An agent caches the manifest
   *  and polls this to learn its copy went stale, which is the whole reason
   *  `Manifest.version` exists -- so it is lifted to the top level here rather
   *  than left for a client to dig out of a nested object it did not want. */
  manifestVersion?: string;
  /** The `rev` of the last snapshot the relay was told about. */
  rev?: number;
  /** ISO 8601, not epoch millis. This is a value a human reads in a "which
   *  tab?" prompt, and it crosses into clients whose JSON numbers are floats. */
  since: string;
}

/** A `snapshot` frame as `GET /dk/tabs/:tab/watch` emits it. Deliberately the
 *  same shape the tab sends up, so one parser serves both directions. */
export interface WatchFrame {
  t: "snapshot";
  tab: string;
  snapshot: Snapshot;
}
