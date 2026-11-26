// `COMMIT_ASK_ABOVE` as well as `mountWidget`, because a host overriding
// `commitAskAbove` is making a judgement about its own undo and should be able
// to see — and name in its own help text — the number it is replacing.
// `PANEL_TITLE` alongside, for a host that wants to name the default header
// word in its own help text or reuse it — the same reason `COMMIT_ASK_ABOVE`
// is out here rather than buried.
export { COMMIT_ASK_ABOVE, PANEL_TITLE, mountWidget } from "./widget.ts";
export type { RunControlsFactory, Widget, WidgetOptions } from "./widget.ts";
export { CSS, SPOT_CSS } from "./css.ts";
// `settingsKey` for the same reason as `storageKey`: a host app offering a
// "reset the panel" button needs to know what to clear, and guessing at
// somebody else's localStorage key is how that button goes stale. `SPEEDS` so
// a host can name the same speeds in its own help text.
export { SPEEDS, settingsKey } from "./settings.ts";
export type { Settings } from "./settings.ts";
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
