export { mountWidget } from "./widget.ts";
export type { Widget, WidgetOptions } from "./widget.ts";
export { CSS } from "./css.ts";
// `storageKey` is exported because a host app that offers a "reset the panel"
// button needs to know what to clear, and guessing at somebody else's
// localStorage key is how that button goes stale. The rest of `position.ts` is
// internal: `describe` and `nearestCorner` are too generically named to put in
// a package's public surface.
export { storageKey } from "./position.ts";
export type { Corner, Fraction, Position } from "./position.ts";
export type {
  AbortControllerCtor, AbortControllerLike, DocumentLike, ElementLike, EventLike,
  Listener, NodeLike, RectLike, StorageLike, StyleLike, WindowLike,
} from "./dom.ts";
