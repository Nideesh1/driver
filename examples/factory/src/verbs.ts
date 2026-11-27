/**
 * FACTORY's verb list.
 *
 * No DOM imports, by the procedure's last instruction, so the whole list can
 * be driven headlessly against a fake `KernelPort`.
 *
 * ── HOW THE THREE KINDS WERE ASSIGNED, SO A REVIEWER CAN ARGUE WITH IT ─────
 *
 * `read` — every verb whose body is a `GET` through FACTORY's machine proxy.
 * Ten of them. None reports a `count`, which `read` promises not to: the size
 * of an answer goes in `Report.note` as prose instead. That is the one place
 * this draft fought the type, and ../README.md argues it.
 *
 * `describe` — exactly one, `select-pieces`, because exactly one bulk job in
 * FACTORY is real: the piece library has a tick box per row and a batch
 * delete. Nothing else in the app selects many rows for one action.
 *
 * `commit` — the eight verbs whose body reaches the HUMAN port. The port split
 * does the classifying for us and it is a gift: `frontend/src/app/lib/kernel.ts`
 * dials 8788 from the browser for exactly the writes a machine is not allowed
 * to make, so "does the body call anything that writes" is answerable by
 * reading one URL constant. Not one of them is `reversible` except the two
 * creates, and ../README.md argues those two as the judgement call they are.
 *
 * ── WHAT A COMMIT HERE SKIPS, AND IT MATTERS ───────────────────────────────
 *
 * FACTORY already has a human gate in front of its three most expensive
 * actions, and it is a `ConfirmModal`, in the UI: Run is two clicks ("run",
 * then "queue the descents and ask"), a piece delete is two, a batch delete is
 * two. A verb calling `runIteration` goes round all of it. `MountOptions.approve`
 * is the only thing that puts a person back in front of these, which is why
 * `mount.ts` refuses to mount without one.
 */
import type { Report, Verb, VerbContext } from "driverkit";
import type { FindingFilter, KernelPort, Lane, PieceKind, Prune, Wrote } from "./port.ts";
import type { Board } from "./board.ts";
import type { Row } from "driverkit";

const LANES: Lane[] = ["todo", "doing", "pruning", "held", "done"];
const PRUNES: Prune[] = ["deeper", "stop", "park"];
const PIECE_KINDS: PieceKind[] = ["breadth", "depth"];

/**
 * A read's two failures, in one place.
 *
 * FACTORY's reads THROW — `KernelRefused` for a 404/409/501 and
 * `KernelUnreachable` for nothing answering — and driverkit is explicit that
 * throwing is a bug and not a no. So every read is wrapped, and the two are
 * kept apart for the reason kernel.ts keeps them apart: "the kernel said no
 * such descent" and "the kernel did not answer" call for different next moves,
 * and an empty list is never either of them.
 */
async function reading<T>(ctx: VerbContext, go: () => Promise<T>): Promise<T | ReturnType<VerbContext["refuse"]>> {
  try {
    return await go();
  } catch (e) {
    const name = (e as { name?: string }).name;
    const said = e instanceof Error ? e.message : String(e);
    if (name === "KernelRefused") {
      return ctx.refuse("kernel-said-no", said);
    }
    return ctx.refuse(
      "kernel-unreachable",
      `${said}. Nothing was read — this is not an empty answer. The reads go through this app's own ` +
        `/api/kernel proxy, so either the kernel is down or the proxy could not reach it.`,
    );
  }
}

const refused = (v: unknown): boolean =>
  typeof v === "object" && v !== null && (v as { __driverkit?: string }).__driverkit === "refusal";

/**
 * A write's three outcomes, mapped onto driverkit's two.
 *
 * `landed` is an `ok`. `refused: true` is the kernel's own no, carried with
 * its words. `refused: false` is "nothing answered and the browser cannot tell
 * you whether it landed", and driverkit's `Result` has no arm for that — so it
 * becomes a refusal whose hint says in the first sentence that the write may
 * nonetheless have happened. A refusal is the wrong shape for it and it is the
 * least wrong of the two shapes available; see ../README.md.
 */
function wrote(ctx: VerbContext, answer: Wrote, board: Board, note?: string): Report | ReturnType<VerbContext["refuse"]> {
  if (answer.landed) {
    board.bump();
    return { note: note ?? answer.detail };
  }
  if (answer.refused) {
    return ctx.refuse("kernel-said-no", `${answer.status}: ${answer.reason}`);
  }
  return ctx.refuse(
    "outcome-unknown",
    `THIS MAY HAVE LANDED. Nothing answered, so whether the write happened is not known from here. ` +
      `Do not retry it blind: read the record back first. ${answer.reason}`,
  );
}

const descentRows = (rows: Array<Record<string, unknown>>): Row[] =>
  rows.map((d) => ({
    id: String(d.id),
    lane: String(d.lane),
    repository: String(d.repository ?? ""),
    symptom: String(d.symptom ?? ""),
    claimed: String(d.claimed ?? "") === "" ? "never claimed" : String(d.claimed).slice(0, 10),
    verdict: d.verdict === null || d.verdict === undefined ? "" : String(d.verdict),
  }));

export interface Wiring {
  port: KernelPort;
  board: Board;
}

export function factoryVerbs({ port, board }: Wiring): Verb<any>[] {
  return [
    // ───────────────────────────── reads ─────────────────────────────────

    {
      name: "read-health",
      kind: "read",
      describe:
        "report what the kernel says about itself in one line: which graph it opened, how many descents sit in " +
        "each of the five lanes, whether a git credential and auth are configured. Answers \"is anything waiting\" " +
        "without opening a screen.",
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async (_a, ctx) => {
        const line = await reading(ctx, () => port.fetchHealth());
        if (refused(line)) return line as never;
        return { note: line as string };
      },
    },

    {
      name: "read-backlog",
      kind: "read",
      describe:
        "read the backlog: every descent, lane by lane. Give a lane to read only that one — `pruning` is the " +
        "human gate, where descents wait for somebody to rule on them. Reports the size of each lane and lists " +
        "the descents it read.",
      args: {
        lane: {
          type: "string",
          describe: "only this lane; omit for all five",
          oneOf: LANES,
          optional: true,
        },
      },
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async ({ lane }: { lane?: Lane }, ctx) => {
        const list = await reading(ctx, () => port.fetchDescents());
        if (refused(list)) return list as never;
        const lanes = (list as { lanes: Array<{ lane: Lane; descents: Array<Record<string, unknown>> }> }).lanes;
        const sizes = lanes.map((l) => `${l.lane}=${l.descents.length}`).join(" ");
        const wanted = lane === undefined ? lanes : lanes.filter((l) => l.lane === lane);
        const rows = descentRows(wanted.flatMap((l) => l.descents));
        const read = board.publishRead(lane === undefined ? "the backlog" : `the ${lane} lane`, rows);
        return { note: `${sizes}. ${read} descent(s) listed${read > 20 ? ", first 20 shown" : ""}.` };
      },
    },

    {
      name: "read-descent",
      kind: "read",
      describe:
        "read one descent in full: the symptom it was sent after, the repository, the lane it sits in, the verdict " +
        "if one has been cast, and every finding it recorded, layer by layer. Lists the findings as rows.",
      args: { descent: { type: "string", describe: "the descent's id, as `read-backlog` reports it" } },
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async ({ descent }: { descent: string }, ctx) => {
        const whole = await reading(ctx, () => port.fetchDescentDetail(descent));
        if (refused(whole)) return whole as never;
        const w = whole as { descent: Record<string, unknown>; findings: Array<Record<string, unknown>>; unreadable: string[] };
        const rows: Row[] = w.findings.map((f, i) => ({
          id: `${String(f.descent_id)}/${String(f.layer)}/${i}`,
          layer: Number(f.layer),
          kind: String(f.kind ?? ""),
          breadth: String(f.breadth ?? ""),
          claim: String(f.claim ?? ""),
          outcome: String(f.outcome ?? ""),
          admissible: Boolean(f.admissible),
        }));
        board.publishRead(`descent ${descent}`, rows);
        const hole = w.unreadable.length > 0 ? ` ${w.unreadable.length} finding(s) came back unreadable.` : "";
        return {
          note:
            `lane ${String(w.descent.lane)}; verdict ${w.descent.verdict === null ? "none yet" : String(w.descent.verdict)}; ` +
            `${w.findings.length} finding(s).${hole} A row's id is descent/layer/index, which is what opens it.`,
        };
      },
    },

    {
      name: "find-findings",
      kind: "read",
      describe:
        "find findings by filter — above all every finding that cites one file, which is the question this " +
        "answers in one hop. Narrow by lane, by hole or ceiling, by whether the claim stood, by the iteration or " +
        "method that produced it, or by free text. An empty answer means nothing matched, never that nothing was " +
        "asked.",
      args: {
        path: { type: "string", describe: "findings citing exactly this file path", optional: true },
        pathEndsWith: { type: "string", describe: "findings citing any file whose path ends in this", optional: true },
        lane: { type: "string", describe: "only findings whose descent sits in this lane", oneOf: LANES, optional: true },
        kind: {
          type: "string",
          describe: "a hole is a specific defect; a ceiling is a whole approach capping out",
          oneOf: ["hole", "ceiling"],
          optional: true,
        },
        iteration: { type: "string", describe: "only findings from this iteration's descents", optional: true },
        template: { type: "string", describe: "only findings produced by this method template", optional: true },
        descent: { type: "string", describe: "only findings from this one descent", optional: true },
        admissible: { type: "boolean", describe: "true for claims that stood, false for claims that did not", optional: true },
        text: { type: "string", describe: "free text, matched by the kernel against the finding's prose", optional: true },
      },
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async (a: Record<string, unknown>, ctx) => {
        const filter: FindingFilter = {};
        if (typeof a.path === "string") filter.path = a.path;
        if (typeof a.pathEndsWith === "string") filter.path_suffix = a.pathEndsWith;
        if (typeof a.lane === "string") filter.lane = a.lane as Lane;
        if (typeof a.kind === "string") filter.kind = a.kind as "hole" | "ceiling";
        if (typeof a.iteration === "string") filter.iteration = a.iteration;
        if (typeof a.template === "string") filter.template = a.template;
        if (typeof a.descent === "string") filter.descent = a.descent;
        if (typeof a.admissible === "boolean") filter.admissible = a.admissible;
        if (typeof a.text === "string") filter.text = a.text;
        const answer = await reading(ctx, () => port.fetchFindings(filter));
        if (refused(answer)) return answer as never;
        const found = answer as { findings: Array<Record<string, unknown>>; unreadable: string[] };
        const rows: Row[] = found.findings.map((f) => ({
          id: `${String(f.descent_id)}/${String(f.layer)}`,
          descent: String(f.descent_id),
          layer: Number(f.layer),
          kind: String(f.kind ?? ""),
          claim: String(f.claim ?? ""),
          outcome: String(f.outcome ?? ""),
          admissible: Boolean(f.admissible),
          iteration: f.iteration_id === null ? "none" : String(f.iteration_id),
        }));
        const n = board.publishRead("findings matching that filter", rows);
        const hole = found.unreadable.length > 0 ? ` ${found.unreadable.length} came back unreadable.` : "";
        return { note: `${n} finding(s) matched.${hole}` };
      },
    },

    {
      name: "read-iterations",
      kind: "read",
      describe:
        "list every iteration: what it is called, which leg it is for, which set of repositories it descends on, " +
        "and when it last changed. An iteration is the intention; a Run is what turns it into descents.",
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async (_a, ctx) => {
        const list = await reading(ctx, () => port.fetchIterations());
        if (refused(list)) return list as never;
        const rows: Row[] = (list as Array<Record<string, unknown>>).map((it) => ({
          id: String(it.id),
          name: String(it.name ?? ""),
          leg: String(it.kind ?? ""),
          set: String(it.set_id ?? ""),
          why: String(it.why ?? ""),
          updated: String(it.updated ?? "").slice(0, 10),
        }));
        const n = board.publishRead("iterations", rows);
        return { note: `${n} iteration(s).` };
      },
    },

    {
      name: "read-iteration",
      kind: "read",
      describe:
        "read one iteration: its set, its reason, its leg, the method its descents are run by, and the model they " +
        "run on. Read this before running one — it is the only place that says what a Run will actually ask.",
      args: { iteration: { type: "string", describe: "the iteration's id, or the slug an older kernel keyed it by" } },
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async ({ iteration }: { iteration: string }, ctx) => {
        const one = await reading(ctx, () => port.fetchIteration(iteration));
        if (refused(one)) return one as never;
        const it = one as Record<string, unknown>;
        board.publishRead(`iteration ${String(it.id)}`, [
          {
            id: String(it.id),
            name: String(it.name ?? ""),
            leg: String(it.kind ?? ""),
            set: String(it.set_id ?? ""),
            method: String(it.template_id ?? "none named"),
            why: String(it.why ?? ""),
          },
        ]);
        return { note: `${String(it.name ?? "")} — the ${String(it.kind)} leg over set ${String(it.set_id)}.` };
      },
    },

    {
      name: "read-sets",
      kind: "read",
      describe:
        "list the repository sets a person has assembled, with how many repositories each holds. A set is what an " +
        "iteration descends on, and assembling one is a human's decision — no verb here writes one.",
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async (_a, ctx) => {
        const sets = await reading(ctx, () => port.fetchSets());
        if (refused(sets)) return sets as never;
        const rows: Row[] = (sets as Array<Record<string, unknown>>).map((s) => ({
          id: String(s.id),
          name: String(s.name ?? ""),
          repositories: Array.isArray(s.repos) ? s.repos.length : 0,
          updated: String(s.updated ?? "").slice(0, 10),
        }));
        const n = board.publishRead("sets", rows);
        return { note: `${n} set(s).` };
      },
    },

    {
      name: "read-templates",
      kind: "read",
      describe:
        "list the method templates: where to dig and how hard to pull. Each row says how many breadth items and " +
        "how many depth items it holds. An iteration names one of these, and its descents are run by it.",
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async (_a, ctx) => {
        const templates = await reading(ctx, () => port.fetchTemplates());
        if (refused(templates)) return templates as never;
        const rows: Row[] = (templates as Array<Record<string, unknown>>).map((t) => ({
          id: String(t.id),
          name: String(t.name ?? ""),
          about: String(t.about ?? ""),
          breadth: Array.isArray(t.breadth) ? t.breadth.length : 0,
          depth: Array.isArray(t.depth) ? t.depth.length : 0,
        }));
        const n = board.publishRead("method templates", rows);
        return { note: `${n} method template(s).` };
      },
    },

    {
      name: "read-template",
      kind: "read",
      describe:
        "read one method template in full: every breadth item an agent is sent after, in the order they are " +
        "offered, and every depth item appended to each of them. This is the whole of what a descent is asked.",
      args: { template: { type: "string", describe: "the method template's id" } },
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async ({ template }: { template: string }, ctx) => {
        const one = await reading(ctx, () => port.fetchTemplate(template));
        if (refused(one)) return one as never;
        const t = one as { id: string; name: string; about: string; breadth: unknown[]; depth: unknown[] };
        const items = (list: unknown[], kind: string): Row[] =>
          list.map((raw, i) => {
            const item = raw as Record<string, unknown>;
            return {
              id: `${kind}/${i}`,
              kind,
              at: i,
              label: String(item.label ?? ""),
              bullet: String(item.bullet ?? ""),
            };
          });
        board.publishRead(`method ${t.id}`, [...items(t.breadth, "breadth"), ...items(t.depth, "depth")]);
        return {
          note: `${t.name}: ${t.breadth.length} breadth, ${t.depth.length} depth. ${t.depth.length === 0 ? "No depth makes this a checklist, which stops at the first answer." : ""}`.trim(),
        };
      },
    },

    {
      name: "read-pieces",
      kind: "read",
      describe:
        "list the piece library: breadth and depth items written once and copied into many methods. Nothing runs a " +
        "piece — the only thing done with one is paste it into a method.",
      args: {
        kind: { type: "string", describe: "only pieces of this kind; omit for both", oneOf: PIECE_KINDS, optional: true },
      },
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async ({ kind }: { kind?: PieceKind }, ctx) => {
        const pieces = await reading(ctx, () => port.fetchPieces());
        if (refused(pieces)) return pieces as never;
        const all = pieces as Array<Record<string, unknown>>;
        const wanted = kind === undefined ? all : all.filter((p) => p.kind === kind);
        const rows: Row[] = wanted.map((p) => ({
          id: String(p.id),
          label: String(p.label ?? ""),
          kind: String(p.kind ?? ""),
          bullet: String(p.bullet ?? ""),
        }));
        const n = board.publishRead(kind === undefined ? "pieces" : `${kind} pieces`, rows);
        const breadth = all.filter((p) => p.kind === "breadth").length;
        return { note: `${n} piece(s) listed; the library holds ${breadth} breadth and ${all.length - breadth} depth.` };
      },
    },

    // ──────────────────────────── describe ───────────────────────────────

    {
      name: "select-pieces",
      kind: "describe",
      screen: "pieces",
      describe:
        "select pieces across the whole library — not just the ten on screen — by kind, by words in their label, " +
        "bullet or prompt, or both. Replaces any selection this driver had and reports how many it matched. This " +
        "is the verb that answers \"how many pieces mention X\" and the only way to line up a batch delete.",
      args: {
        kind: { type: "string", describe: "only pieces of this kind; omit for both", oneOf: PIECE_KINDS, optional: true },
        text: {
          type: "string",
          describe: "words to match against a piece's label, id, kind, bullet and prompt; omit to take every piece of the kind",
          optional: true,
        },
      },
      refuses: ["kernel-said-no", "kernel-unreachable"],
      run: async ({ kind, text }: { kind?: PieceKind; text?: string }, ctx) => {
        const pieces = await reading(ctx, () => port.fetchPieces());
        if (refused(pieces)) return pieces as never;
        const all = pieces as Array<{ id: string; kind: PieceKind }>;
        const ofKind = kind === undefined ? all : all.filter((p) => p.kind === kind);
        // The app's OWN predicate, exported from routes/Pieces.tsx:167. A
        // second search written here would answer a different count from the
        // one the screen shows, which is the whole failure the pairing rule
        // exists to prevent.
        const matched = text === undefined || text.trim() === "" ? ofKind : port.matchingPieces(ofKind as never, text);
        const count = board.selectPieces(matched.map((p) => p.id));
        return { count };
      },
    },

    // ───────────────────────────── commits ───────────────────────────────

    {
      name: "rule-on-descent",
      kind: "commit",
      describe:
        "rule on a descent waiting at the pruning gate: go deeper, stop here, or park it. This is the human " +
        "judgement the whole lane exists for, it is recorded against a name, and there is no way to un-rule it " +
        "from this app.",
      args: {
        descent: { type: "string", describe: "the descent's id, as `read-backlog` reports it" },
        prune: {
          type: "string",
          describe:
            "deeper: this is worth another layer. stop: this line is finished. park: leave it, it is not worth more now",
          oneOf: PRUNES,
        },
        by: {
          type: "string",
          describe:
            "who is ruling. A verdict with no author is one nobody can be asked about, so there is no default and " +
            "no placeholder: use the person's own name, and ask them for it if you do not have it",
        },
        note: { type: "string", describe: "a line about why, recorded with the verdict", optional: true },
      },
      refuses: ["not-at-the-gate", "kernel-said-no", "kernel-unreachable", "outcome-unknown"],
      run: async (
        { descent, prune, by, note }: { descent: string; prune: Prune; by: string; note?: string },
        ctx,
      ) => {
        if (by.trim() === "") {
          return ctx.refuse(
            "kernel-said-no",
            "a blank author is refused on both sides of the wire. Ask the person for their name.",
          );
        }
        // The app's own rule, not an invention: the verdict panel renders only
        // when `row.lane === "pruning"` (routes/IterationFindings.tsx:623), so
        // a verdict cast anywhere else is one the UI would never offer. The
        // check is a `GET /descents/{id}/lane`, which is the route that exists
        // to answer exactly this.
        const lane = await reading(ctx, () => port.fetchLane(descent));
        if (refused(lane)) return lane as never;
        if (String(lane).trim() !== "pruning") {
          return ctx.refuse(
            "not-at-the-gate",
            `that descent is in the ${String(lane).trim()} lane, not pruning. Only a descent at the gate can be ` +
              `ruled on. Use \`read-backlog\` with lane \`pruning\` to see what is actually waiting.`,
          );
        }
        const answer = await port.castVerdict(descent, prune, note === undefined || note.trim() === "" ? null : note.trim(), by);
        return wrote(ctx, answer, board, `ruled ${prune} on ${descent}, by ${by}.`);
      },
    },

    {
      name: "abandon-descent",
      kind: "commit",
      describe:
        "abandon a descent: take it out of the backlog for good. Nothing is kept and nothing in this app puts it " +
        "back. Not the same as parking it — park is a verdict on what it found, this is throwing away the descent.",
      args: { descent: { type: "string", describe: "the descent's id" } },
      refuses: ["kernel-said-no", "kernel-unreachable", "outcome-unknown"],
      run: async ({ descent }: { descent: string }, ctx) =>
        wrote(ctx, await port.abandonDescent(descent), board, `abandoned ${descent}.`),
    },

    {
      name: "run-iteration",
      kind: "commit",
      describe:
        "run an iteration: write one descent per repository in its set and ask the engine to start them. Agents " +
        "then read those repositories and record findings against real money and real time. Read the iteration " +
        "first — this is the verb that spends.",
      args: { iteration: { type: "string", describe: "the iteration's id" } },
      refuses: ["kernel-said-no", "kernel-unreachable", "outcome-unknown"],
      run: async ({ iteration }: { iteration: string }, ctx) => {
        const answer = await port.runIteration(iteration);
        switch (answer.outcome) {
          case "pushed": {
            board.bump();
            const waiting = answer.already.length;
            return {
              count: answer.queued,
              note:
                answer.queued === 0
                  ? `pushed, nothing new queued; ${waiting} repository(ies) already had an open descent, and the ` +
                    `waiting work was asked for again.`
                  : `pushed, ${answer.queued} new descent(s) queued${waiting > 0 ? `, ${waiting} already open` : ""}.`,
            };
          }
          case "no-emitter": {
            // NOT a refusal. The descents are written before the push is
            // attempted, so rows exist in the graph; calling this a refusal
            // would tell an agent nothing happened while `read-backlog` can
            // already see the new descents.
            board.bump();
            return {
              count: answer.queued,
              note:
                `${answer.queued} descent(s) WERE queued and NOTHING WAS PUSHED, so nothing will start until an ` +
                `emitter is configured. ${answer.reason}`,
            };
          }
          case "refused":
            return ctx.refuse("kernel-said-no", `${answer.status}: ${answer.reason}`);
          case "unclear":
            return ctx.refuse(
              "outcome-unknown",
              `THIS MAY HAVE RUN. The kernel answered ${answer.status} without saying whether it pushed anything. ` +
                `Do not press it again: read the backlog and see whether new descents are there. ${answer.body}`,
            );
          case "unreachable":
            return ctx.refuse(
              "outcome-unknown",
              `NOTHING WAS PUSHED as far as this browser can tell, and it cannot tell for certain. ${answer.reason}`,
            );
        }
      },
    },

    {
      name: "draft-iteration",
      kind: "commit",
      reversible: true,
      describe:
        "draft an iteration: a name, a set of repositories, and optionally the method and the model its descents " +
        "should run on. Drafting one starts nothing — a Run does that — and a drafted iteration can be deleted " +
        "again. Only the study leg can be drafted; the code leg is not offered yet.",
      args: {
        name: { type: "string", describe: "what to call it, as a person would say it" },
        leg: {
          type: "string",
          describe: "which leg. Study reads a repository and finds how it should be better, and writes no code",
          oneOf: ["study"],
        },
        set: { type: "string", describe: "the id of the set of repositories to descend on, from `read-sets`" },
        why: { type: "string", describe: "what this iteration is for, in a line", optional: true },
        template: {
          type: "string",
          describe: "the id of the method template its descents are run by; omit to take the kernel's default",
          optional: true,
        },
        provider: {
          type: "string",
          describe: "which provider the descents run on. Must be given together with `model`",
          oneOf: ["ollama", "tinyfish", "langsearch", "telegram"],
          optional: true,
        },
        model: {
          type: "string",
          describe: "the model name at that provider. Must be given together with `provider`",
          optional: true,
        },
      },
      refuses: ["half-a-model", "kernel-said-no", "kernel-unreachable", "outcome-unknown"],
      run: async (
        a: { name: string; leg: "study"; set: string; why?: string; template?: string; provider?: string; model?: string },
        ctx,
      ) => {
        const half = (a.provider === undefined) !== (a.model === undefined);
        if (half) {
          return ctx.refuse(
            "half-a-model",
            "a provider and a model travel together or not at all. Give both, or neither and the worker uses the " +
              "configured default.",
          );
        }
        const answer = await port.createIteration({
          name: a.name,
          kind: "study",
          set_id: a.set,
          ...(a.why === undefined ? {} : { why: a.why }),
          ...(a.template === undefined ? {} : { template_id: a.template }),
          ...(a.provider === undefined || a.model === undefined ? {} : { model: { provider: a.provider, model: a.model } }),
        });
        return wrote(ctx, answer, board, `drafted "${a.name}" over set ${a.set}. Nothing runs until it is run.`);
      },
    },

    {
      name: "delete-iteration",
      kind: "commit",
      describe:
        "delete an iteration. The descents it already started and the findings they recorded are not deleted with " +
        "it, and nothing in this app puts the iteration back.",
      args: { iteration: { type: "string", describe: "the iteration's id" } },
      refuses: ["kernel-said-no", "kernel-unreachable", "outcome-unknown"],
      run: async ({ iteration }: { iteration: string }, ctx) =>
        wrote(ctx, await port.deleteIteration(iteration), board, `deleted iteration ${iteration}.`),
    },

    {
      name: "add-piece",
      kind: "commit",
      reversible: true,
      describe:
        "add a piece to the library: a breadth item is one thread an agent is sent down, a depth item is a stance " +
        "appended to every thread. Three audiences, three fields — the label is skimmed, the bullet is read when " +
        "deciding, the prompt is what the agent is actually given. Adding one changes no existing method, and it " +
        "can be deleted again.",
      args: {
        label: { type: "string", describe: "one or two words, because this is what gets skimmed" },
        kind: {
          type: "string",
          describe: "breadth is where to dig, depth is how hard to pull",
          oneOf: PIECE_KINDS,
        },
        bullet: {
          type: "string",
          describe: "the one-sentence form, phrased as a question and a direction rather than a claim",
        },
        prompt: { type: "string", describe: "what the agent is given. The only one of the three allowed to be long" },
      },
      refuses: ["kernel-said-no", "kernel-unreachable", "outcome-unknown"],
      run: async (a: { label: string; kind: PieceKind; bullet: string; prompt: string }, ctx) =>
        wrote(ctx, await port.createPiece(a), board, `added the ${a.kind} piece "${a.label}".`),
    },

    {
      name: "delete-piece",
      kind: "commit",
      describe:
        "delete one piece from the library. Methods that copied it keep their copies word for word and lose only " +
        "the record of where the wording came from. It is refused outright when a method that copied it has " +
        "already run, and then nothing is deleted.",
      args: { piece: { type: "string", describe: "the piece's id, as `read-pieces` reports it" } },
      refuses: ["copied-into-run-templates", "kernel-said-no", "kernel-unreachable", "outcome-unknown"],
      run: async ({ piece }: { piece: string }, ctx) => {
        const answer = await port.deletePiece(piece);
        if (!answer.landed && answer.refused && answer.status === 409) {
          return ctx.refuse(
            "copied-into-run-templates",
            `nothing was deleted. ${answer.reason}`,
          );
        }
        return wrote(ctx, answer, board, `deleted piece ${piece}.`);
      },
    },

    {
      name: "delete-selected-pieces",
      kind: "commit",
      consumes: "plan",
      screen: "pieces",
      describe:
        "delete the pieces `select-pieces` matched. Takes no filter of its own and acts on that selection, so the " +
        "count is read before anything goes. The kernel has no batch delete, so these go one at a time and any " +
        "that are refused are reported and kept.",
      refuses: ["nothing-selected", "kernel-unreachable"],
      run: async (_a, ctx) => {
        const ids = board.selectedPieces();
        if (ids.length === 0) {
          return ctx.refuse(
            "nothing-selected",
            "nothing is selected. Use `select-pieces` first and read the count it reports.",
          );
        }
        // One call per row, strictly sequential — the same shape
        // `useBatchDelete` uses (components/BatchDelete.tsx:142), because the
        // kernel has no batch route.
        let gone = 0;
        const kept: string[] = [];
        for (const id of ids) {
          const answer = await port.deletePiece(id);
          if (answer.landed) gone += 1;
          else kept.push(`${id}: ${answer.refused ? answer.reason : "nothing answered, and this one may have landed"}`);
        }
        board.selectPieces(kept.length === ids.length ? ids : ids.filter((id) => kept.some((k) => k.startsWith(`${id}:`))));
        return {
          count: gone,
          note:
            kept.length === 0
              ? `deleted ${gone} piece(s).`
              : `deleted ${gone} of ${ids.length}. ${kept.length} were not deleted and are still selected — ${kept.join("; ")}`,
        };
      },
    },
  ];
}
