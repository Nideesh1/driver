/**
 * driverkit/adapters — turn a button into a verb body.
 *
 * ```ts
 * { name: "save", describe: "save the invoice", kind: "commit", run: clickHandle("save") }
 * ```
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT THE BRITTLE-SELECTOR APPROACH IT LOOKS LIKE.
 *
 * It resembles the thing driverkit exists to replace -- an agent driving an app
 * by finding elements -- so the difference is worth stating rather than
 * assuming.
 *
 * 1. The app author put `data-dk="save"` there on purpose. It is not a class
 *    name borrowed from the styling, not an nth-child path, not a label
 *    scraped off the rendered text. It is an attribute whose only reason to
 *    exist is this, which means it cannot rot the way a borrowed selector
 *    rots: restyle the button, rename the component, swap the CSS framework,
 *    move the markup into a different file, translate the label into German --
 *    `data-dk="save"` survives all of it, because none of those are reasons to
 *    touch it. A refactor that drops it is a deliberate deletion, and it fails
 *    loudly on the next call (see below) rather than quietly matching the
 *    wrong element.
 *
 * 2. The agent never sees a selector. It sees a verb named `save` with a
 *    description. It cannot ask for a different element, cannot be prompted
 *    into one, and cannot drift onto one when the DOM changes shape. The
 *    binding from name to element is resolved inside the app by the person who
 *    wrote the app. That is the whole of driverkit's argument, and it holds
 *    here: the static half still contains no selectors, no pixels and nothing
 *    per-user.
 *
 * 3. It is one attribute per button, which is the cheapest adoption step there
 *    is. No store, no refactor, no exported functions. This is tier 2 of the
 *    ladder in the README, and it is where every messy app should start.
 *
 * THE HONEST COST, which is not small.
 *
 * A click runs whatever the handler does. This module cannot know what that
 * is, so it cannot declare `kind`, and `kind` is the field the core leans on
 * to keep an agent from discovering that `accept` is not `select` by doing it.
 * Worse, a click is the LEAST inspectable kind of verb body: the handler may
 * open a dialog, fire three requests, or be the bulk-accept button. The app
 * author has to look at the handler and declare `kind` themselves, and nothing
 * in this package can check that they were right.
 *
 * The related cost: a click goes through the app's own UI, so an element that
 * is rendered but disabled will be clicked and will do nothing, and the call
 * reports `ok`. A verb that silently does nothing is the worst outcome in this
 * library -- the agent reports success and moves on, and the user finds out
 * later. `opts.refuseWhen` is the hook for that, and `fromDom` wires
 * `[disabled]` and `[aria-disabled="true"]` into it by default.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { collapse, resolveRoot } from "./dom.ts";
import type { ElementLike, QueryRootLike } from "./dom.ts";

export interface ClickOptions {
  /** Narrow the search: a selector or an element. Default: the document. */
  root?: string | QueryRootLike;
  document?: QueryRootLike;
  /** The marker attribute. Default `data-dk`. Change it only to fit an
   *  existing convention in your app (`data-testid`, say) -- and read the note
   *  in the README about borrowing a test attribute before you do. */
  attribute?: string;
}

/**
 * A verb body that clicks `[data-dk="<name>"]`.
 *
 * The element is looked up ON EVERY CALL, never captured at mount. Any app
 * worth adapting re-renders, and a captured node is a node that has been
 * detached since -- clicking it does nothing at all, with no error, which is
 * the failure mode this module is most concerned with.
 */
export function clickHandle(name: string, opts: ClickOptions = {}): () => void {
  const attribute = opts.attribute ?? "data-dk";
  return () => {
    const root = resolveRoot(opts.root, opts.document, `clickHandle(${JSON.stringify(name)})`);
    const el = root.querySelector(`[${attribute}=${JSON.stringify(name)}]`);
    if (!el) {
      // Thrown, not refused, and the distinction matters. A refusal is an
      // ordinary "no" the agent is expected to handle and may route around; a
      // missing handle is the app being wired wrong, and routing around it
      // would hide the bug behind a retry. The core catches this and reports
      // `threw` with this message, which reaches whoever is driving.
      throw new Error(
        `driverkit: no handle \`${name}\`. Add ${attribute}="${name}" to the element this verb ` +
          `should click.${knownHandles(root, attribute)}`,
      );
    }
    el.click();
  };
}

/** Find a handle without clicking it. For an app writing its own `refuseWhen`,
 *  or checking at startup that every verb it declared is actually wired. */
export function findHandle(name: string, opts: ClickOptions = {}): ElementLike | null {
  const attribute = opts.attribute ?? "data-dk";
  const root = resolveRoot(opts.root, opts.document, `findHandle(${JSON.stringify(name)})`);
  return root.querySelector(`[${attribute}=${JSON.stringify(name)}]`);
}

/** Every handle currently in the page. The list `clickHandle` puts in its
 *  error, and a useful thing to log once at startup. */
export function listHandles(opts: ClickOptions = {}): string[] {
  const attribute = opts.attribute ?? "data-dk";
  const root = resolveRoot(opts.root, opts.document, "listHandles");
  return handlesIn(root, attribute);
}

function handlesIn(root: QueryRootLike, attribute: string): string[] {
  const names = new Set<string>();
  for (const el of root.querySelectorAll(`[${attribute}]`)) {
    const value = collapse(el.getAttribute(attribute));
    if (value) names.add(value);
  }
  return [...names].sort();
}

/** The same move the core makes when a verb name is unknown: list what IS
 *  there. A typo, a renamed handle and a handle that is only rendered on
 *  another tab all produce the same "not found", and the list is what tells
 *  them apart without a second round trip. */
function knownHandles(root: QueryRootLike, attribute: string): string {
  const names = handlesIn(root, attribute);
  if (names.length === 0) {
    return ` No ${attribute} handles are in the page at all -- is this verb reachable from the current screen?`;
  }
  return ` Handles in the page: ${names.join(", ")}.`;
}
