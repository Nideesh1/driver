export { connect } from "./connect.ts";
export type {
  Connection, ConnectOptions, EventSourceCtor,
  EventSourceLike, FetchLike, FocusEventsLike, LocationLike, PageLike,
  ResponseLike, StorageLike,
} from "./connect.ts";
// The cross-tab commit channel, and the only `ElsewhereChannel` the library
// ships. See `elsewhere.ts` for why it is a `BroadcastChannel` and not the
// relay.
export { broadcastElsewhere } from "./elsewhere.ts";
export type {
  BroadcastChannelCtor, BroadcastChannelLike, BroadcastElsewhereOptions,
} from "./elsewhere.ts";
export type { CallFrame, HelloFrame, ResultFrame, SnapshotFrame } from "./frames.ts";
// Keeping a spend ceiling across a page load. See `budget.ts`: without it an
// agent that can navigate can refresh its way past `MountOptions.budget`.
export { budgetKey, localBudgetStore } from "./budget.ts";
export type { LocalBudgetStore, LocalBudgetStoreOptions } from "./budget.ts";
