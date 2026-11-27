/**
 * `mountFactory` — the one call, and the only file here that touches the DOM.
 *
 * Everything in `verbs.ts`, `screens.ts`, `flows.ts` and `board.ts` is
 * importable with no browser, which is what makes the verb list drivable
 * headlessly against a fake port before any model is involved.
 */
import { mount } from "driverkit";
import type { ApprovalPolicy, Driver } from "driverkit";
import { makeBoard, type Board, type Place, type Published } from "./board.ts";
import { FLOWS } from "./flows.ts";
import { SCREENS } from "./screens.ts";
import { factoryVerbs } from "./verbs.ts";
import type { KernelPort } from "./port.ts";

/**
 * The app's briefing. Static, cached once, read by the in-page loop and by an
 * agent arriving over the relay alike.
 *
 * It says the things an agent cannot learn from a verb name: what a descent
 * is, that the pruning lane is a person's gate and not a queue, which verb
 * spends money, and that a verdict cannot be taken back. No ids, no counts,
 * nobody's name — one per-user word in here and the prefix stops being
 * cacheable across people.
 */
export const INSTRUCTIONS =
  "FACTORY runs study descents over repositories and records what they find, for a person to rule on.\n\n" +
  "The shape: a SET is a list of repositories. An ITERATION is an intention over one set — which leg, which " +
  "method, which model. Running an iteration writes one DESCENT per repository and asks an engine to start them. " +
  "A descent records FINDINGS, one per layer, each either a hole (a specific defect) or a ceiling (a whole " +
  "approach capping out), and each with a claim that either stood or did not. A METHOD TEMPLATE is where to dig " +
  "(breadth) and how hard to pull (depth); its items are copied from a PIECE library.\n\n" +
  "A descent sits in one of five lanes: todo, doing, pruning, held, done. PRUNING IS A HUMAN GATE, not a queue " +
  "that drains: a descent waits there until a person rules on it — deeper, stop, or park. A verdict is recorded " +
  "against an author's name, there is no default author, and nothing in this app can un-rule one.\n\n" +
  "`run-iteration` is the verb that spends: it starts agents reading real repositories on a real model. Read the " +
  "iteration first and tell the person what it would queue. Do not run one to find out what it does.\n\n" +
  "What this app cannot do through these verbs: assemble or change a set, change a method's breadth or depth " +
  "lists, write a provider key or a secret of any kind, and create a code-leg iteration. If a person asks for one " +
  "of those, say it has to be done on the screen by hand rather than reaching for the nearest verb.";

export interface FactoryMount {
  port: KernelPort;
  /** Who approves a `commit`. REQUIRED here, unlike `mount()`, and ../README.md
   *  argues why: FACTORY's own confirmation dialogs stand in the UI, and every
   *  commit in this list goes round them. */
  approve: ApprovalPolicy;
  approvalTimeout?: number;
  /** `parse(location.pathname).name` — FACTORY's own router function. Passed
   *  in rather than imported so this package does not depend on FACTORY. */
  screenNow: () => string | undefined;
  /** The prose about where the person is. Defaults to the screen id and the
   *  path, which is honest and thin; FACTORY can pass something better. */
  whereNow?: () => string;
  /** FACTORY's `go(route)` if it is reachable, which is the right way to
   *  navigate. Absent falls back to `pushState` plus a `popstate` event, which
   *  is what FACTORY's own `Router` already listens for — see `navigate`. */
  go?: (path: string) => void;
}

export interface Mounted {
  driver: Driver;
  /** Hand this to FACTORY so the screen's real rows reach the snapshot. */
  publish: (p: Published | null) => void;
  board: Board;
}

export function mountFactory(opts: FactoryMount): Mounted {
  const place = (): Place => {
    const screen = opts.screenNow();
    const where =
      opts.whereNow?.() ??
      (screen === undefined ? "FACTORY, before the app has mounted" : `the ${screen} screen`);
    return screen === undefined ? { where } : { screen, where };
  };
  const board = makeBoard(place);

  const driver = mount({
    app: "FACTORY",
    instructions: INSTRUCTIONS,
    screens: SCREENS,
    flows: FLOWS,
    verbs: factoryVerbs({ port: opts.port, board }),
    visible: board.visible,
    approve: opts.approve,
    ...(opts.approvalTimeout === undefined ? {} : { approvalTimeout: opts.approvalTimeout }),
    /**
     * The one function only the app can write.
     *
     * FACTORY's `go()` lives in a React context (`useNav`,
     * `frontend/src/app/lib/router.tsx:702`) and is not reachable from a
     * module, so the fallback goes through the browser: `pushState` and then a
     * `popstate` event, which FACTORY's own `Router` is already listening for
     * and answers by reading `window.location.pathname`. It is the app's own
     * navigation path, entered by the door the app already opened, rather than
     * a selector poked at a link — but it is a door the app opened for the
     * BACK BUTTON, and `go()` is the honest route. Pass `go` and this is never
     * used.
     */
    navigate: ({ url }, ctx) => {
      if (url === undefined) {
        return ctx.refuse(
          "no-address",
          "that screen has no address to navigate to; it opens over whatever you are on.",
        );
      }
      if (opts.go !== undefined) {
        opts.go(url);
        return;
      }
      window.history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.scrollTo(0, 0);
    },
  });

  return { driver, publish: board.publish, board };
}
