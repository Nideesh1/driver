/**
 * The seam between this draft and FACTORY.
 *
 * WHY THERE IS A PORT AT ALL, since the procedure does not describe one.
 * `plugin/commands/draft-verbs.md` says to draft `src/driverkit.ts` *inside
 * the app*, where `run` bodies can import the app's own functions directly.
 * This draft was written under a constraint that forbade touching FACTORY, so
 * the dependency is inverted: the verb list declares the subset of
 * `frontend/src/app/lib/kernel.ts` it calls, and the FACTORY side supplies it
 * in three lines (see ../README.md).
 *
 * Every signature below is COPIED from FACTORY, not invented. The source is
 * `frontend/src/app/lib/kernel.ts` and the line numbers are given so a
 * reviewer can diff them. Nothing here is a wrapper: the verbs call these
 * functions with the arguments the app's own screens pass.
 *
 * The three-armed write result is FACTORY's, unchanged and deliberately not
 * flattened. `{landed:false, refused:false}` is "nothing answered and the
 * browser cannot tell you whether it landed", which is a third outcome
 * driverkit's `Result` has no arm for. See `../README.md`, "what driverkit
 * could not express".
 */

/** `Lane` — frontend/src/types/Lane.ts. The five values, no sixth. */
export type Lane = "todo" | "doing" | "pruning" | "held" | "done";
/** `Prune` — frontend/src/types/Prune.ts. What a human decides at the gate. */
export type Prune = "deeper" | "stop" | "park";
/** `Leg` — frontend/src/types/Leg.ts. */
export type Leg = "study" | "code";
/** `PieceKind` — frontend/src/types/kernel.ts:753. */
export type PieceKind = "breadth" | "depth";
/** `FindingKind` — frontend/src/types/kernel.ts:584. */
export type FindingKind = "hole" | "ceiling";

/** `FindingFilter` — frontend/src/types/kernel.ts:599. Every field optional,
 *  and every field a scalar, which is why `find-findings` is the one verb in
 *  this list whose arguments are the app's own query type one for one. */
export interface FindingFilter {
  path?: string;
  path_suffix?: string;
  lane?: Lane;
  kind?: FindingKind;
  iteration?: string;
  template?: string;
  descent?: string;
  admissible?: boolean;
  text?: string;
}

/** The three-armed result every FACTORY write returns. None of them throw. */
export type Wrote<T = unknown> =
  | { landed: true; detail: string; record?: T }
  | { landed: false; refused: true; status: number; reason: string }
  | { landed: false; refused: false; reason: string };

/**
 * `IterationRunResult` — kernel.ts:1953. FIVE outcomes, and the two that are
 * easy to get wrong are `no-emitter` (the descents WERE written, nothing was
 * pushed) and `unclear` (a 2xx that never said whether it pushed).
 */
export type RunOutcome =
  | { outcome: "pushed"; event: string | null; eventId: string | null; detail: string; queued: number; already: string[] }
  | { outcome: "no-emitter"; reason: string; queued: number; already: string[] }
  | { outcome: "unclear"; status: number; body: string }
  | { outcome: "refused"; status: number; reason: string }
  | { outcome: "unreachable"; reason: string };

/** The rows these verbs project. Only the fields a FACTORY screen shows. */
export interface DescentRow {
  id: string;
  lane: Lane;
  repository: string;
  symptom: string;
  claimed: string;
  created: string;
  iteration_id: string | null;
  verdict: string | null;
  [k: string]: unknown;
}
export interface FindingRow {
  descent_id: string;
  lane: Lane;
  layer: number;
  kind: string;
  breadth: string;
  claim: string;
  outcome: string;
  admissible: boolean;
  iteration_id: string | null;
  template_id: string;
  [k: string]: unknown;
}
export interface Iteration { id: string; name: string; kind: Leg; set_id: string; why: string; template_id?: string; updated: string; [k: string]: unknown }
export interface RepoSet { id: string; name: string; repos: unknown[]; updated: string; [k: string]: unknown }
export interface Template { id: string; name: string; about: string; breadth: unknown[]; depth: unknown[]; updated: string; [k: string]: unknown }
export interface Piece { id: string; label: string; kind: PieceKind; bullet: string; prompt: string; updated: string; [k: string]: unknown }
export interface DescentList { graph: string; lanes: Array<{ lane: Lane; descents: DescentRow[] }> }
export interface DescentWhole { descent: DescentRow; findings: FindingRow[]; unreadable: string[]; withheld: unknown[] }
export interface FindingsAnswer { findings: FindingRow[]; unreadable: string[] }

/**
 * What the verbs need from FACTORY. One method per function the app already
 * has, named as the app names it.
 *
 * `humanBase` is NOT in here. FACTORY's copy comes from
 * `process.env.KERNEL_HUMAN_URL` at Astro render time
 * (`frontend/src/pages/app/[...path].astro:32`) and reaches the island as a
 * React prop, so the adapter closes over it rather than this file guessing at
 * it. A draft that hardcoded `http://127.0.0.1:8788` would be right on the
 * owner's laptop and wrong on every deployment, silently.
 */
export interface KernelPort {
  /** kernel.ts:182 — `GET /healthz`, one line of text. */
  fetchHealth(): Promise<string>;
  /** kernel.ts:214 — `GET /descents`, all five lanes. */
  fetchDescents(): Promise<DescentList>;
  /** kernel.ts:226 — `GET /descents/{id}/lane`, exactly one lane name. */
  fetchLane(id: string): Promise<string>;
  /** kernel.ts:431 — `GET /descents/{id}`, the descent and its findings. */
  fetchDescentDetail(id: string): Promise<DescentWhole>;
  /** kernel.ts:502 — `GET /findings?<filter>`. */
  fetchFindings(filter: FindingFilter): Promise<FindingsAnswer>;
  /** kernel.ts:536 / :1154 / :1595 / :2173 — the four listings. */
  fetchSets(): Promise<RepoSet[]>;
  fetchIterations(): Promise<Iteration[]>;
  fetchTemplates(): Promise<Template[]>;
  fetchPieces(): Promise<Piece[]>;
  /** kernel.ts:1179 / :1625 — one record, by the id the kernel matches. */
  fetchIteration(id: string): Promise<Iteration>;
  fetchTemplate(id: string): Promise<Template>;

  /** kernel.ts:338 — `POST {human}/descents/{id}/verdict`. `by` is required
   *  and there is no default for it; see that function's header. */
  castVerdict(id: string, prune: Prune, note: string | null, by: string): Promise<Wrote>;
  /** kernel.ts:271 — `DELETE {human}/descents/{id}`. */
  abandonDescent(id: string): Promise<Wrote>;
  /** kernel.ts:2006 — `POST {human}/iterations/{id}/run`. */
  runIteration(id: string): Promise<RunOutcome>;
  /** kernel.ts:1458 — the create and the delete arms only. `replace` is not
   *  here: it carries `key_ids`/`chat_ids` arrays, and a verb argument has to
   *  be a scalar. */
  createIteration(draft: {
    name: string; kind: Leg; set_id: string; why?: string;
    template_id?: string; model?: { provider: string; model: string };
  }): Promise<Wrote<Iteration>>;
  deleteIteration(id: string): Promise<Wrote>;
  /** kernel.ts:2228 — create and delete. `replace` is expressible in scalars
   *  and is left out for a different reason; see ../README.md. */
  createPiece(piece: { label: string; kind: PieceKind; bullet: string; prompt: string }): Promise<Wrote<Piece>>;
  deletePiece(id: string): Promise<Wrote>;

  /** `matchingPieces` — frontend/src/app/routes/Pieces.tsx:167, EXPORTED.
   *  The app's own search predicate over `[label, id, kind, bullet, prompt]`.
   *  `select-pieces` calls it rather than re-implementing a second search that
   *  would answer a different count from the one the screen shows. */
  matchingPieces(pieces: Piece[], query: string): Piece[];

  /** Who the person is, for a verdict's `by`: the signed-in GitHub login, or
   *  `null` when nobody is signed in — `connection(useIdentity())` in
   *  frontend/src/components/identity.tsx:130. `null` means the person has to
   *  type a name, which `rule-on-descent` then requires as an argument. */
  signedInAs(): string | null;
}
