/**
 * A tiny app with the pairing in it, plus a scripted `think`.
 *
 * Shaped like `driverkit/agent`'s own test app on purpose — a `describe` that
 * takes a predicate and reports a count, a `commit` that takes none and acts
 * on the selection — because that pair is what this harness measures and a toy
 * without it would exercise nothing. The numbers are small and fixed so a test
 * can assert "4" the way the demo suite asserts "112": the whole discipline of
 * this package is that a count assertion is only worth making against a seeded
 * fixture.
 *
 * `planned` mounts the same app with `consumes: "plan"` on the commit, which is
 * what the demo now does. It is a separate option rather than the default
 * because most of these tests are about scoring a transcript, and threading a
 * token through a scripted model would be ceremony in front of every one of
 * them.
 */

import { mount } from "../../driverkit/src/core/registry.ts";
import type { Driver, Scalar, Snapshot, VerbContext } from "../../driverkit/src/core/types.ts";
import type { Think, ThinkInput, ThinkResult, ToolCall } from "../../driverkit/src/agent/types.ts";

export interface Fixture {
  driver: Driver;
  accepted: () => string[];
}

export interface FixtureOptions {
  /** Put `consumes: "plan"` on the commit, as the contacts demo does. */
  planned?: boolean;
}

export function app(options: FixtureOptions = {}): Fixture {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `a-${i}`,
      company: "Acme",
      status: "new",
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `p-${i}`,
      company: "Acme",
      status: "pending",
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `g-${i}`,
      company: "Globex",
      status: "new",
    })),
  ];
  let rev = 1;
  let screen = "dashboard";
  let selected: string[] = [];
  const accepted: string[] = [];

  const visible = (): Snapshot => ({
    where: screen,
    screen,
    rev,
    rows: rows.slice(0, 5).map((r) => ({ ...r })),
    page: { index: 0, size: 5, total: rows.length },
    ...(selected.length ? { selected: selected.slice(0, 3), selectedCount: selected.length } : {}),
  });

  const driver = mount({
    app: "Toy",
    visible,
    verbs: [
      {
        name: "go",
        kind: "read",
        describe: "go to a screen",
        args: {
          screen: { type: "string", describe: "which", oneOf: ["dashboard", "contacts"] },
        },
        run: ({ screen: next }: { screen: Scalar }) => {
          screen = String(next);
          rev += 1;
        },
      },
      {
        name: "select-where",
        kind: "describe",
        describe: "select every contact at one company, optionally by status",
        args: {
          company: { type: "string", describe: "the company", oneOf: ["Acme", "Globex"] },
          status: {
            type: "string",
            describe: "only this status",
            oneOf: ["new", "pending"],
            optional: true,
          },
        },
        run: ({ company, status }: { company: Scalar; status?: Scalar }) => {
          selected = rows
            .filter((r) => r.company === company && (status == null || r.status === status))
            .map((r) => r.id);
          rev += 1;
          return { count: selected.length };
        },
      },
      {
        name: "select-contact",
        kind: "describe",
        describe: "select exactly one contact by id",
        args: { id: { type: "string", describe: "the id" } },
        refuses: ["no-such-contact"],
        run: ({ id }: { id: Scalar }, ctx: VerbContext) => {
          if (!rows.some((r) => r.id === id)) return ctx.refuse("no-such-contact");
          selected = [String(id)];
          rev += 1;
          return { count: 1 };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        ...(options.planned ? ({ consumes: "plan" } as const) : {}),
        describe: "accept the current selection",
        refuses: ["nothing-selected"],
        run: (_args: Record<string, Scalar>, ctx: VerbContext) => {
          if (selected.length === 0) return ctx.refuse("nothing-selected", "select something");
          const n = selected.length;
          for (const id of selected) {
            accepted.push(id);
            rows.find((r) => r.id === id)!.status = "accepted";
          }
          selected = [];
          rev += 1;
          return { count: n };
        },
      },
    ],
  });

  return { driver, accepted: () => [...accepted] };
}

export interface Scripted {
  think: Think;
  seen: ThinkInput[];
}

/** A `think` that replays a script, and complains if the loop takes a turn the
 *  test did not predict. */
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
      if (step === undefined) throw new Error(`scripted think ran out of script at step ${i}`);
      return typeof step === "function" ? step(input, i) : step;
    },
  };
}

let n = 0;
export function call(name: string, args: object = {}): ToolCall {
  return { id: `t-${++n}`, name, args: args as ToolCall["args"] };
}
