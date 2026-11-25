/**
 * The browser, as structural types.
 *
 * Narrow on purpose: these describe only what `mountWidget` actually touches,
 * so the real `document` satisfies them and so does a hundred-line fake. That
 * is a design requirement and not a testing shim, for the same reason
 * `@driverkit/browser` injects `EventSource` — a module that can only run in a
 * browser can only be verified in a browser, which in practice means verified
 * by hand, which means the paths nobody clicks through are the untested ones.
 * Here those paths are "Escape while the input has focus", "unmount while a
 * run is in flight", "a commit appears in the trace", and now "the panel was
 * dragged to the right edge of a wide window and the window then narrowed",
 * none of which anybody re-checks by hand after a refactor.
 *
 * It also keeps this package honest about having no framework and no
 * dependencies. Importing the DOM lib types would be free at runtime but it
 * would also let a `querySelector` or a `CSSStyleDeclaration` creep in, and
 * every one of those is a thing the fake would have to grow.
 *
 * Everything added for positioning is OPTIONAL on purpose. A host that hands
 * in a minimal element — or a browser missing `setPointerCapture` — gets a
 * panel that still mounts and still renders in its default corner; it just
 * cannot be moved. Dragging is worth a lot and it is not worth failing an
 * app's boot over.
 */

/** Only the fields the handlers here read. Pointer fields included, because
 *  drag is one code path for mouse, touch and pen — three code paths is three
 *  chances to get the clamping wrong in only one of them. */
export interface EventLike {
  key?: string;
  altKey?: boolean;
  /** The deepest node the event started on. Used to tell "pointerdown on the
   *  header" from "pointerdown on the Close button inside the header", which
   *  is the difference between a drag and a click. */
  target?: ElementLike;
  /** Mouse buttons, so a right-click does not start a drag. Touch and pen
   *  report 0 like a left click. */
  button?: number;
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export type Listener = (event: EventLike) => void;

export interface NodeLike {
  appendChild(child: ElementLike): unknown;
  addEventListener(type: string, listener: Listener): void;
}

/** `DOMRect`, as the four numbers the clamping needs. */
export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** `element.style`, as the two calls positioning needs. Positioning is written
 *  as custom properties and nothing else, so the host app can set a position
 *  from its own CSS and so there is exactly one way the panel can be placed. */
export interface StyleLike {
  setProperty(name: string, value: string): void;
}

export interface ElementLike extends NodeLike {
  className: string;
  textContent: string | null;
  /** On an `<input>`. Optional because every other element lacks it. */
  value?: string;
  disabled?: boolean;
  /** Uppercase, as the DOM spells it. Read only to recognise a control inside
   *  the drag handle. */
  readonly tagName?: string;
  /** Scrolling the transcript. Both optional and both used only if present:
   *  they are a courtesy to a person watching, not part of the contract. */
  scrollTop?: number;
  readonly scrollHeight?: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  focus?: () => void;
  remove: () => void;
  removeEventListener?: (type: string, listener: Listener) => void;
  /** Where positioning is written. Absent means the panel cannot be moved. */
  style?: StyleLike;
  /** The panel's own box, which the clamp needs: "on screen" is a statement
   *  about the far edge, not about the anchor point. */
  getBoundingClientRect?: () => RectLike;
  /** Pointer capture, so a drag keeps receiving moves once the pointer has
   *  left the handle — which it does immediately, because the handle is what
   *  is being moved out from under it. */
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
  /** Absent on a fake that does not model shadow trees, and on a browser old
   *  enough not to have them. See the fallback in `widget.ts`. */
  attachShadow?: (init: { mode: "open" | "closed" }) => NodeLike;
}

export interface DocumentLike {
  createElement(tag: string): ElementLike;
  body: ElementLike;
}

/** The viewport, as the four things a clamp needs: how big it is, when it
 *  changed, and whether the person asked for less animation. */
export interface WindowLike {
  innerWidth?: number;
  innerHeight?: number;
  addEventListener?: (type: string, listener: Listener) => void;
  removeEventListener?: (type: string, listener: Listener) => void;
  matchMedia?: (query: string) => { matches: boolean };
}

/** `localStorage`, as the two calls a remembered position needs. Both can
 *  throw — a private window, blocked site data — so every call site here is
 *  wrapped, including the one that merely reaches for the global. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `new AbortController()`, as a type, so a run can be cancelled without this
 *  package reaching for a global it cannot be handed in a test. */
export interface AbortControllerLike {
  readonly signal: AbortSignal;
  abort(): void;
}

export interface AbortControllerCtor {
  new (): AbortControllerLike;
}
