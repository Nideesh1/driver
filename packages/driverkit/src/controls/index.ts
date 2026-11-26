/**
 * driverkit/controls — the second layer: whatever is on the screen.
 *
 * A verb list is a set of shortcuts, and shortcuts are incomplete by
 * construction: somebody will always ask for the thing nobody listed. This
 * gives an agent three generic verbs over the elements the app's author marked
 * `data-dk-control`, so that request gets done at all.
 *
 * It is a separate entry point because it is a choice, not a default:
 * importing it is how an app says "publish my marked controls to an agent".
 * An app that only wants its own verbs never resolves this module.
 *
 * See `CONTROLS.md` for the design, the refusals and the honest limits — in
 * particular what `data-dk-kind` claims, what nothing here can check, and the
 * three layers that stop an agent pressing the app's own confirm button.
 */
export { controlsFromDom } from "./controls.ts";
export type { ControlsBinding, ControlsConfig, RowsSpec } from "./controls.ts";
export type { RowIdOptions } from "./rows.ts";
/** The whitespace normalisation this layer applies to every label and id.
 *  Exported so an `idFrom` hook can apply the same one rather than a near-miss
 *  of it: rendered HTML is full of indent nobody at the keyboard sees, and a
 *  row id of `"\n  c-0184\n"` matches nothing an agent types back. */
export { collapse } from "./dom.ts";
export type { ElementLike, EventCtor, FieldLike, QueryRootLike } from "./dom.ts";
