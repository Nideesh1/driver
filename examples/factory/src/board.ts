/**
 * `visible()`, and the honest accounting behind it.
 *
 * ── THE PROBLEM THE PROCEDURE DOES NOT HAVE AN ANSWER FOR ──────────────────
 *
 * `references/authoring-verbs.md` sorts an app into "has a store" (read the
 * store) and "has no store" (read the DOM, and bump `rev` off a
 * `MutationObserver`). FACTORY is neither. It has no store, and its rows carry
 * no `data-*`, no `id` and no semantic class — the only id-bearing node in the
 * whole routes tree is `id="run-says-<iterationId>"` on one screen, and the
 * only row-level `data-*` is `data-slot` in the template editor. Every list's
 * search text, page index, selection and kind filter lives in
 * component-local `useState` with no export, no context and no window hook.
 * So there is nothing to read from outside React and nothing to select with.
 *
 * ── WHAT THIS DOES INSTEAD, IN TWO TIERS ───────────────────────────────────
 *
 * TIER 0, with no change to FACTORY: `screen`, `where` and `rev`. `screen` is
 * free and exact — `parse(location.pathname).name` is the app's own router
 * function over the app's own URL — and that is enough for `Verb.screen` to
 * work, for `wrong-screen` to name both halves, and for `goto` to be
 * checkable. `rows`, `page`, `selected` and `selectedCount` are ABSENT, which
 * `Snapshot` is explicit means "the app does not publish these" and not "there
 * are none". `rev` moves only on this driver's own commits, which is a `rev`
 * that is honest about what it knows and blind to a person clicking in the UI.
 *
 * TIER 1, after one `useEffect` in `frontend/src/components/Dashboard.tsx`
 * calls `publish()`: the rows the person is looking at, their page window, and
 * a `rev` that moves when the app re-reads. ../README.md has the exact lines.
 *
 * The draft ships Tier 0 working and Tier 1 wired but unfed, because that is
 * what "do not modify FACTORY" leaves. It is also the honest shape of the
 * finding: an app can be DRIVEN without a store, and it cannot be OBSERVED
 * without one.
 *
 * ── THE SELECTION IS THIS DRIVER'S, NOT THE SCREEN'S ───────────────────────
 *
 * `select-pieces` cannot tick the checkboxes on the pieces screen: the ticks
 * are a `useState<string[]>` inside `useBatchDelete`
 * (frontend/src/components/BatchDelete.tsx:102), unreachable from here. So the
 * selection below is a second one, held in this module, and
 * `retire-selected-pieces` acts on it. The count is real, the plan token binds
 * it, and the person at the keyboard CANNOT SEE IT — which is a weaker gate
 * than the procedure's `describe`→count→`commit` pairing assumes, since that
 * pairing's second guarantee is that the rows are highlighted on screen. Said
 * out loud here and again in the README rather than papered over.
 */
import { selectionId } from "driverkit";
import type { Row, Snapshot } from "driverkit";

/** Where the person is. Supplied by `mount.ts`, which is the only file here
 *  that touches `location` — so this one stays testable with no DOM. */
export interface Place {
  /** `parse(location.pathname).name`, or undefined before the island mounts. */
  screen?: string;
  /** The prose: the filter, the record that is open, the sort. */
  where: string;
}

/**
 * What is in the rows block, and WHOSE rows they are.
 *
 * ── THE GAP THIS FIELD EXISTS TO ADMIT ─────────────────────────────────────
 *
 * `Result` has `count` and `note` and nothing else, so a `read` verb whose
 * answer is forty rows from an HTTP GET has nowhere to put them but the
 * snapshot. Putting them there unlabelled would break the one rule
 * `Snapshot` is built on: the agent would be holding rows the person at the
 * keyboard is not looking at. The contacts demo never meets this because its
 * store IS its screen — reading and showing are one act there, and in FACTORY
 * a read is a request to a kernel on another port.
 *
 * So the rows are carried and LABELLED. `from: "screen"` is what the person
 * can see (Tier 1, pushed by the app). `from: "read"` is what this driver
 * last asked the kernel for, and the snapshot says so in `note` every turn it
 * is true. An agent is then never misled about which it is holding; it is
 * still shown something the person is not, and that is the honest cost.
 */
export interface Published {
  from: "screen" | "read";
  /** What was read, in the owner's words: "the pruning lane", "pieces". */
  of: string;
  rows?: Row[];
  page?: { index: number; size: number; total?: number };
  /** One short line the rows cannot carry. Keep it short: uncached half. */
  note?: string;
}

/** Never put more rows in the snapshot than the findings screen itself shows
 *  on one page. `PER_PAGE` is 20 there, 10 on pieces, 6 on iterations, 12 on
 *  sets and templates — 20 is the largest window FACTORY ever renders. */
export const WINDOW = 20;

export interface Board {
  visible: () => Snapshot;
  /** The ONE place `rev` moves. Every commit in `verbs.ts` calls it, and the
   *  app's own re-reads would call it from the `publish()` effect. A path that
   *  changed FACTORY without moving this hands out a `rev` that is a lie. */
  bump: () => void;
  /** Called by FACTORY (Tier 1, `from: "screen"`) and by this draft's own
   *  `read-` verbs (`from: "read"`). Replaces what the agent is shown. */
  publish: (p: Published | null) => void;
  /** A read verb's answer, windowed to `WINDOW` rows and labelled as a read.
   *  Returns the number of rows the kernel answered with, which a `read` verb
   *  puts in its `note` — never in `count`, which `read` promises not to
   *  report. */
  publishRead: (of: string, rows: Row[], note?: string) => number;
  /** Replace the driver's piece selection. Returns the size. */
  selectPieces: (ids: string[]) => number;
  /** The ids currently selected, in selection order. */
  selectedPieces: () => string[];
  clearPieces: () => void;
}

export function makeBoard(place: () => Place): Board {
  let rev = 1;
  let shown: Published | null = null;
  let picked: string[] = [];

  const bump = () => {
    rev += 1;
  };

  return {
    bump,
    publish: (p) => {
      shown = p;
      bump();
    },
    publishRead: (of, rows, note) => {
      const total = rows.length;
      shown = {
        from: "read",
        of,
        rows: rows.slice(0, WINDOW),
        page: { index: 0, size: WINDOW, total },
        ...(note === undefined ? {} : { note }),
      };
      bump();
      return total;
    },
    selectPieces: (ids) => {
      picked = [...new Set(ids)];
      bump();
      return picked.length;
    },
    selectedPieces: () => [...picked],
    clearPieces: () => {
      picked = [];
      bump();
    },
    visible: () => {
      const at = place();
      const rows = shown?.rows;
      const snap: Snapshot = {
        where: at.where,
        rev,
        // `selectedCount: 0` rather than omitted, so the core can say
        // "nothing is selected, so there is nothing for a plan to be taken
        // on" instead of an agent going off to select something.
        selectedCount: picked.length,
      };
      if (at.screen !== undefined) snap.screen = at.screen;
      if (rows !== undefined) {
        snap.rows = rows;
        // On-screen ids only. The selection is over the whole library, so
        // `selectedCount` above is the honest size and this is the subset a
        // pronoun can resolve against.
        const here = new Set(rows.map((r) => r.id));
        snap.selected = picked.filter((id) => here.has(id));
      }
      if (shown?.page !== undefined) snap.page = shown.page;
      // ALWAYS, including over an empty selection. Publishing it only when
      // something is selected makes the core warn that the token can bind
      // only the `rev` and the count — and the empty selection is exactly the
      // case where a plan is minted over a count of 0 and then run.
      snap.selectionId = selectionId(picked);
      const notes: string[] = [];
      if (shown === null) {
        notes.push(
          "this screen's rows are not published to the driver; read them with a `read-` verb instead",
        );
      } else if (shown.from === "read") {
        notes.push(
          `the rows are this driver's last read of ${shown.of}, not the rows on the person's screen`,
        );
      }
      if (shown?.note !== undefined) notes.push(shown.note);
      if (notes.length > 0) snap.note = notes.join("; ");
      return snap;
    },
  };
}
