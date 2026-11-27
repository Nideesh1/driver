/**
 * A FAKE FACTORY, for running this suite without a kernel.
 *
 * ── READ THIS BEFORE POINTING THE SUITE AT THE REAL APP ───────────────────
 *
 * Every case in this directory is a plain-English ask, and running them means
 * a model calling `commit` verbs. Three of those cast a verdict, abandon a
 * descent and run an iteration, and the first and the third cannot be undone
 * from the app at all. So the suite ships against this fixture, where the data
 * is invented and a write changes a Map.
 *
 * Swapping it for the real adapter (`../README.md`) points the same cases at a
 * real kernel and a real graph. `--dry-run` never calls a model and is safe
 * either way; a scored run against a live FACTORY is not, and it should be a
 * deliberate act against a throwaway graph.
 *
 * The numbers here are invented and are not a claim about the owner's data.
 * The one id taken from FACTORY's own source is `blog-pipeline-run-check`,
 * which `frontend/src/app/lib/kernel.ts:1179` records as a real legacy slug.
 */
import type { KernelPort, Lane, Piece, Prune, Wrote } from "../src/port.ts";

const descents = new Map<string, Record<string, unknown>>([
  [
    "d-0001",
    {
      id: "d-0001",
      lane: "pruning" as Lane,
      repository: "797th/blog-pipeline",
      symptom: "the humanizer stage is the only thing anybody tunes",
      claimed: "2026-11-20T09:00:00Z",
      created: "2026-11-19T18:00:00Z",
      iteration_id: "blog-pipeline-run-check",
      verdict: null,
    },
  ],
  [
    "d-0002",
    {
      id: "d-0002",
      lane: "done" as Lane,
      repository: "797th/ghost-theme",
      symptom: "",
      claimed: "2026-11-10T09:00:00Z",
      created: "2026-11-09T18:00:00Z",
      iteration_id: "blog-pipeline-run-check",
      verdict: "stop",
    },
  ],
  [
    "d-0003",
    {
      id: "d-0003",
      lane: "todo" as Lane,
      repository: "797th/retired-scraper",
      symptom: "",
      claimed: "",
      created: "2026-11-25T18:00:00Z",
      iteration_id: null,
      verdict: null,
    },
  ],
]);

const findings = [
  {
    descent_id: "d-0001",
    lane: "pruning" as Lane,
    layer: 1,
    kind: "ceiling",
    breadth: "Shape",
    claim: "the pipeline is a chain of prompt stages with no seam to test one of them",
    argument: "every stage reads the previous stage's prose, so a stage cannot be run alone",
    outcome: "passed",
    exit_code: 0,
    admissible: true,
    iteration_id: "blog-pipeline-run-check",
    template_id: "study-the-shape",
    cites: [{ path: "crates/kernel/src/serve.rs", from: 1214, to: 1230 }],
  },
  {
    descent_id: "d-0002",
    lane: "done" as Lane,
    layer: 1,
    kind: "hole",
    breadth: "Seams",
    claim: "the theme's build step silently keeps a stale asset manifest",
    argument: "the manifest is written before the hash is computed",
    outcome: "failed",
    exit_code: 1,
    admissible: false,
    iteration_id: "blog-pipeline-run-check",
    template_id: "study-the-shape",
    cites: [{ path: "crates/kernel/src/serve.rs", from: null, to: null }],
  },
];

const sets = [
  { id: "the-797th", name: "797th blog", repos: [{ owner: "797th", name: "blog-pipeline" }, { owner: "797th", name: "ghost-theme" }], updated: "2026-11-18T00:00:00Z" },
  { id: "omni", name: "Omni fleet", repos: [{ owner: "omni", name: "screenbuddy" }], updated: "2026-11-02T00:00:00Z" },
];

const iterations = new Map<string, Record<string, unknown>>([
  [
    "blog-pipeline-run-check",
    {
      id: "blog-pipeline-run-check",
      name: "blog pipeline, run check",
      kind: "study",
      set_id: "the-797th",
      why: "find out where the pipeline caps out",
      template_id: "study-the-shape",
      updated: "2026-11-19T00:00:00Z",
    },
  ],
]);

const templates = new Map<string, Record<string, unknown>>([
  [
    "study-the-shape",
    {
      id: "study-the-shape",
      name: "study the shape",
      about: "where to dig when the thing works and nobody likes it",
      breadth: [
        { label: "Shape", bullet: "Is this the right technology, or the one that was nearest?", prompt: "…", from_piece: "p-shape" },
        { label: "Seams", bullet: "Where would you cut this to test one part of it?", prompt: "…", from_piece: "p-seams" },
      ],
      depth: [{ label: "Prove it", bullet: "What command would show this is true?", prompt: "…", from_piece: "p-prove" }],
      updated: "2026-11-15T00:00:00Z",
    },
  ],
]);

const pieces = new Map<string, Piece>([
  ["p-shape", { id: "p-shape", label: "Shape", kind: "breadth", bullet: "Is this the right technology?", prompt: "…", updated: "" }],
  ["p-seams", { id: "p-seams", label: "Seams", kind: "breadth", bullet: "Where would you cut this?", prompt: "…", updated: "" }],
  ["p-prove", { id: "p-prove", label: "Prove it", kind: "depth", bullet: "What command would show this is true?", prompt: "run it and paste the exit code", updated: "" }],
  ["p-telem", { id: "p-telem", label: "Telemetry", kind: "depth", bullet: "Would telemetry have caught this?", prompt: "say what telemetry would have shown", updated: "" }],
  ["p-cost", { id: "p-cost", label: "Cost", kind: "depth", bullet: "What does this cost per run, and does telemetry say so?", prompt: "…", updated: "" }],
]);

const landed = <T,>(detail: string): Wrote<T> => ({ landed: true, detail });

/** The app's own search predicate, copied from routes/Pieces.tsx:167. */
function matchingPieces(list: Piece[], query: string): Piece[] {
  const q = query.trim().toLowerCase();
  if (q === "") return list;
  return list.filter((p) =>
    [p.label, p.id, p.kind, p.bullet, p.prompt].some((f) => String(f).toLowerCase().includes(q)),
  );
}

export function fixturePort(): KernelPort {
  return {
    fetchHealth: async () =>
      "ok graph=factory todo=1 doing=0 pruning=1 held=0 done=1 git=none auth=off surface=machine",
    fetchDescents: async () => ({
      graph: "factory",
      lanes: (["todo", "doing", "pruning", "held", "done"] as Lane[]).map((lane) => ({
        lane,
        descents: [...descents.values()].filter((d) => d.lane === lane) as never,
      })),
    }),
    fetchLane: async (id) => {
      const d = descents.get(id);
      if (d === undefined) throw Object.assign(new Error(`no descent ${id}`), { name: "KernelRefused" });
      return String(d.lane);
    },
    fetchDescentDetail: async (id) => {
      const d = descents.get(id);
      if (d === undefined) throw Object.assign(new Error(`no descent ${id}`), { name: "KernelRefused" });
      return { descent: d as never, findings: findings.filter((f) => f.descent_id === id) as never, unreadable: [], withheld: [] };
    },
    fetchFindings: async (filter) => ({
      findings: findings.filter((f) => {
        if (filter.lane !== undefined && f.lane !== filter.lane) return false;
        if (filter.kind !== undefined && f.kind !== filter.kind) return false;
        if (filter.descent !== undefined && f.descent_id !== filter.descent) return false;
        if (filter.iteration !== undefined && f.iteration_id !== filter.iteration) return false;
        if (filter.template !== undefined && f.template_id !== filter.template) return false;
        if (filter.admissible !== undefined && f.admissible !== filter.admissible) return false;
        if (filter.path !== undefined && !f.cites.some((c) => c.path === filter.path)) return false;
        if (filter.path_suffix !== undefined && !f.cites.some((c) => c.path.endsWith(filter.path_suffix!))) return false;
        if (filter.text !== undefined && !`${f.claim} ${f.argument}`.toLowerCase().includes(filter.text.toLowerCase())) return false;
        return true;
      }) as never,
      unreadable: [],
    }),
    fetchSets: async () => sets as never,
    fetchIterations: async () => [...iterations.values()] as never,
    fetchTemplates: async () => [...templates.values()] as never,
    fetchPieces: async () => [...pieces.values()],
    fetchIteration: async (id) => {
      const it = iterations.get(id);
      if (it === undefined) throw Object.assign(new Error(`no iteration ${id}`), { name: "KernelRefused" });
      return it as never;
    },
    fetchTemplate: async (id) => {
      const t = templates.get(id);
      if (t === undefined) throw Object.assign(new Error(`no template ${id}`), { name: "KernelRefused" });
      return t as never;
    },

    castVerdict: async (id, prune: Prune, note, by) => {
      const d = descents.get(id);
      if (d === undefined) return { landed: false, refused: true, status: 404, reason: `no descent ${id}` };
      if (by.trim() === "") return { landed: false, refused: true, status: 400, reason: "a verdict with no author is refused" };
      d.verdict = prune;
      d.verdict_by = by;
      d.verdict_note = note ?? "";
      d.lane = prune === "deeper" ? "todo" : "done";
      return landed(`verdict ${prune} recorded by ${by}`);
    },
    abandonDescent: async (id) =>
      descents.delete(id) ? landed(`abandoned ${id}`) : { landed: false, refused: true, status: 404, reason: `no descent ${id}` },
    runIteration: async (id) => {
      const it = iterations.get(id);
      if (it === undefined) return { outcome: "refused", status: 404, reason: `no iteration ${id}` };
      const set = sets.find((s) => s.id === it.set_id);
      const open = [...descents.values()].filter((d) => d.iteration_id === id && (d.lane === "todo" || d.lane === "doing"));
      const already = open.map((d) => String(d.repository));
      let queued = 0;
      for (const repo of set?.repos ?? []) {
        const name = `${repo.owner}/${repo.name}`;
        if (already.includes(name)) continue;
        queued += 1;
        const fresh = `d-${String(descents.size + queued).padStart(4, "0")}`;
        descents.set(fresh, { id: fresh, lane: "todo", repository: name, symptom: "", claimed: "", created: "", iteration_id: id, verdict: null });
      }
      if (queued === 0 && already.length === 0) return { outcome: "refused", status: 409, reason: "nothing to queue" };
      return { outcome: "pushed", event: "factory:descent.requested", eventId: "e-1", detail: "pushed", queued, already };
    },
    createIteration: async (draft) => {
      const id = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (iterations.has(id)) return { landed: false, refused: true, status: 409, reason: `an iteration ${id} already exists` };
      if (sets.find((s) => s.id === draft.set_id) === undefined) {
        return { landed: false, refused: true, status: 422, reason: `no set ${draft.set_id}` };
      }
      iterations.set(id, { ...draft, id, updated: "", why: draft.why ?? "" });
      return landed(`drafted ${id}`);
    },
    deleteIteration: async (id) =>
      iterations.delete(id) ? landed(`deleted ${id}`) : { landed: false, refused: true, status: 404, reason: `no iteration ${id}` },
    createPiece: async (p) => {
      const id = `p-${p.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      pieces.set(id, { ...p, id, updated: "" });
      return landed(`added ${id}`);
    },
    deletePiece: async (id) => {
      const used = [...templates.values()].some((t) =>
        [...(t.breadth as Array<{ from_piece?: string }>), ...(t.depth as Array<{ from_piece?: string }>)].some(
          (i) => i.from_piece === id,
        ),
      );
      // The 409 the real kernel answers when a template that copied this
      // piece has RUN. In the fixture every template has run.
      if (used) {
        return { landed: false, refused: true, status: 409, reason: `nothing was deleted: methods that copied ${id} have run` };
      }
      return pieces.delete(id) ? landed(`deleted ${id}`) : { landed: false, refused: true, status: 404, reason: `no piece ${id}` };
    },

    matchingPieces,
    signedInAs: () => null,
  };
}
