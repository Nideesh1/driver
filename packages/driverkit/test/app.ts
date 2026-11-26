/**
 * The app under test, and a scripted `think`.
 *
 * The app is deliberately the same shape as the core's own
 * `a describe verb reports the count the commit decision turns on`: 3,412
 * contacts, a twenty-row window, a `describe` verb that resolves a predicate
 * and reports what it selected, and a `commit` verb that takes no predicate
 * and acts on that selection. The two suites tell one story — "find the Acme
 * contacts and accept the top thousand" — because that story is the reason
 * this package exists, and a toy without the pairing would not exercise it.
 *
 * The numbers matter. The match is far larger than the window, so the count
 * cannot be inferred from `rows` and cannot be inferred from `page.total`
 * either: that one describes the table, not the selection. The only way a
 * model learns it is `Report.count` coming back on the `Result`.
 *
 * `scripted` is the other half of the design argument for `think` being a
 * function the caller supplies: the loop's hard parts — the refusal path, the
 * commit gate, the bounds — are all testable in-process, with no key, no
 * network and no vendor.
 */

import { mount } from "../src/core/registry.ts";
import type { Driver, Scalar, Snapshot, VerbContext } from "../src/core/types.ts";
import type { Think, ThinkInput, ThinkResult, ToolCall } from "../src/agent/index.ts";

export const TOTAL = 3412;
/** Only twenty rows are on screen, the same as for the person at the keyboard. */
export const WINDOW = 20;

export interface Contacts {
  driver: Driver;
  /** Ids that have been accepted. The thing that must not happen by accident. */
  accepted: () => string[];
  rev: () => number;
}

export function contacts(): Contacts {
  const all = Array.from({ length: TOTAL }, (_, i) => ({
    id: `c-${i}`,
    company: "Acme",
    status: "new",
  }));
  let rev = 1;
  let where = "contacts";
  let selected: string[] = [];
  const accepted: string[] = [];

  const visible = (): Snapshot => ({
    where,
    rev,
    rows: all.slice(0, WINDOW).map((r) => ({ ...r })),
    page: { index: 0, size: WINDOW, total: all.length },
    // Only what is on screen, even when far more than that is selected. That
    // is the rule the Snapshot type exists to enforce, and it is also why the
    // count has to come back on the Result instead.
    ...(selected.length ? { selected: selected.slice(0, 3) } : {}),
  });

  const driver = mount({
    app: "Contacts",
    visible,
    verbs: [
      {
        name: "select-where",
        kind: "describe",
        describe: "select every contact matching a filter",
        args: {
          where: { type: "string", describe: "e.g. company=Acme" },
          limit: { type: "number", describe: "select at most this many", optional: true },
        },
        refuses: ["bad-predicate"],
        run: ({ where: predicate, limit }: { where: string; limit?: number }, ctx: VerbContext) => {
          const m = /^company=(.+)$/.exec(String(predicate));
          if (!m) return ctx.refuse("bad-predicate", "only `company=NAME` is understood");
          const matched = all.filter((r) => r.company === m[1]);
          selected = matched.slice(0, limit ?? matched.length).map((r) => r.id);
          where = `contacts, filtered to ${m[1]}`;
          rev++;
          return { count: selected.length, note: `${matched.length} matched` };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        describe: "accept the current selection",
        refuses: ["nothing-selected"],
        run: (_args: Record<string, Scalar>, ctx: VerbContext) => {
          if (!selected.length) return ctx.refuse("nothing-selected", "select something first");
          for (const id of selected) {
            accepted.push(id);
            all.find((r) => r.id === id)!.status = "accepted";
          }
          const n = selected.length;
          selected = [];
          rev++;
          return { count: n };
        },
      },
      {
        name: "open",
        kind: "read",
        describe: "open one contact",
        args: { id: { type: "string", describe: "contact id" } },
        refuses: ["no-such-contact"],
        run: ({ id }: { id: string }, ctx: VerbContext) => {
          if (!all.some((r) => r.id === id)) return ctx.refuse("no-such-contact");
          where = `contact ${id}`;
          rev++;
        },
      },
    ],
  });

  return { driver, accepted: () => [...accepted], rev: () => rev };
}

export interface Scripted {
  think: Think;
  /** Every `ThinkInput` the loop handed over, in order. */
  seen: ThinkInput[];
}

/** A `think` that replays a script. A step may be a function so a test can
 *  look at what it was given, or abort mid-run, before answering. */
export function scripted(
  script: Array<ThinkResult | ((input: ThinkInput, step: number) => ThinkResult)>,
): Scripted {
  const seen: ThinkInput[] = [];
  let i = 0;
  return {
    seen,
    think: async (input) => {
      seen.push(input);
      const step = script[i++];
      if (step === undefined) {
        // A loud failure rather than a quiet stop: running off the end of the
        // script means the loop took a turn the test did not predict, which is
        // exactly the thing a test should fail on.
        throw new Error(`scripted think ran out of script at step ${i}`);
      }
      return typeof step === "function" ? step(input, i) : step;
    },
  };
}

let n = 0;
export function call(name: string, args: Record<string, never> | object = {}): ToolCall {
  return { id: `t-${++n}`, name, args: args as ToolCall["args"] };
}
