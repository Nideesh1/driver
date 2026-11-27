/**
 * The slice of React this area uses, typed structurally.
 *
 * WHY THIS FILE EXISTS AT ALL, which is the first question anybody will ask of
 * a React library that does not `import React from "react"`. It is the same
 * argument `src/otel/index.ts` makes about `@opentelemetry/api`, and it is
 * stronger here rather than weaker, because React's failure mode when there
 * are two copies is louder than OTel's and more common:
 *
 *   1. **There is one React per app, and a second one breaks hooks.** React's
 *      hook dispatcher is module-level mutable state. A component built
 *      against a different copy of `react` than the one that rendered it
 *      throws "Invalid hook call", or — worse, and this is the realistic case
 *      with a bundler that hoisted two versions — silently reads the wrong
 *      dispatcher. A library that imports its own `react` can get that second
 *      copy through a version mismatch, a nested `node_modules`, a monorepo
 *      hoist, or an app that loads React from a CDN while the bundle resolves
 *      it from disk. Taking the runtime as an argument makes it impossible:
 *      the only React that can be passed is the one the host already has.
 *
 *   2. **It keeps the optional peer honest in the published `.d.ts`.** `import
 *      type { ReactNode } from "react"` in a declaration file is an
 *      unresolvable import for anybody who did not install React — which is
 *      the whole population this library promises not to inconvenience.
 *      `peerDependenciesMeta: { optional: true }` stops npm installing it; it
 *      does nothing about a dangling type reference. Nothing in here names
 *      `react`, so there is nothing to dangle.
 *
 *   3. **It keeps the emitted JavaScript free of bare specifiers.** The
 *      package's own packaging test pins that every area but the relay emits
 *      JavaScript naming no bare specifier, because that is the difference
 *      between "copy `dist/` onto a static host" and "and also write an import
 *      map". `from "react"` would be the second import-map entry this library
 *      has ever needed. See `test/packaging.test.ts`.
 *
 * WHAT IT COSTS, stated plainly because it is a real cost. The host writes one
 * line — `const { DriverPanel } = createDriverPanel(React)` — in a file it
 * owns, and that is less idiomatic than a bare import. The components that
 * come back are ordinary components, so everything after that line is
 * ordinary React; what is lost is the ability to `import { DriverPanel } from
 * "driverkit/react"` in forty files instead of re-exporting it from one. That
 * is the trade, and it is taken in this direction because the thing on the
 * other side is not a convenience but a class of bug the adopter cannot debug
 * from inside their own app.
 *
 * The shapes below are written to be satisfied BY React's own types, not to
 * re-describe them, and they are deliberately the narrowest set that works:
 * every name here is a name a future React could rename. `peerDependencies`
 * in `package.json` records the range they were written against — React 18 or
 * newer, because `useSyncExternalStore` is an 18 API and it is the one that
 * makes the rest of this area small.
 */

/**
 * Anything React can render. `unknown` on purpose.
 *
 * `ReactNode` is a big union and re-describing it would be re-describing it
 * wrongly — a host passing a real `ReactNode` would then fail to satisfy a
 * narrower copy of it. Nothing in here inspects a child, so nothing in here
 * needs to know what one is: these values are created by the host's
 * `createElement` and handed straight back to it.
 */
export type Node = unknown;

/** A component, as this area builds and accepts them. */
export type Component<P> = (props: P) => Node;

/**
 * The hooks and the element factory, as one object.
 *
 * Satisfied by the `react` module namespace itself — `createDriverPanel(React)`
 * with `import * as React from "react"` or the default import, both of which
 * carry every name below.
 */
export interface ReactRuntime {
  createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: Node[]
  ): Node;
  /** For a list of siblings with no wrapper element. */
  readonly Fragment: unknown;
  /**
   * React 18's store subscription, and the reason this area needs so little of
   * React.
   *
   * The panel's whole state lives in a framework-free store (see `store.ts`),
   * so the React layer is a subscription and a render and nothing else. The
   * alternative was a `useReducer` plus an effect per event, which would have
   * put the transcript, the step list and the approval state machine inside
   * React — untestable in this repository, which has no React to test with,
   * and unusable from anything that is not React.
   */
  useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps?: readonly unknown[]): T;
  // NO `useCallback`. It used to be here, unused by this area, and it was a
  // compile error in the adopter's own `createDriverPanel(React)` line: React
  // types it `<T extends Function>(callback: T, deps: DependencyList) => T`,
  // which does not satisfy a `<T>(fn: T, deps?) => T` that accepts any `T` at
  // all. That is the cost of a structural interface written against types
  // nobody in this repository could resolve, and it is exactly the kind of
  // thing "the narrowest set that works" above is a defence against: a member
  // this file does not call cannot be checked by anything, and this one was
  // wrong. `test/react-dom.test.ts` now assigns React's own namespace to this
  // interface, so `tsc` answers the question rather than the prose.
}
