/**
 * FACTORY's recipes.
 *
 * Three, and the first one is the reason the field earns its place here: the
 * pruning lane is a HUMAN GATE, and the job of working it is five steps that
 * every agent would otherwise re-derive — and the ones that get it slightly
 * wrong get it wrong by ruling before reading what the descent actually found.
 *
 * Nothing executes these. The agent reads them and uses the verbs it already
 * has, which is the only shape that can adapt when the lane has moved since
 * the recipe was written down.
 */
import type { FlowSpec } from "driverkit";

export const FLOWS: FlowSpec[] = [
  {
    id: "work-the-pruning-gate",
    describe: "rule on the descents waiting at the pruning gate",
    steps: [
      {
        section: "see what is waiting",
        verb: "read-backlog",
        hint: "pass lane `pruning`. If it is empty, say so and stop — there is nothing to rule on.",
      },
      {
        section: "read before ruling",
        verb: "read-descent",
        hint:
          "one descent at a time. READ THE FINDINGS: the verdict is a judgement about what it found, and ruling " +
          "without reading them is the failure this recipe exists to prevent.",
      },
      {
        section: "read before ruling",
        verb: "find-findings",
        hint: "only if the claim turns on a file's history — `path` answers what anything has ever said about it.",
        skipWhen: "the descent's own findings already settle it",
      },
      {
        section: "take it to the person",
        verb: "goto",
        hint:
          "`goto(screen: \"iteration-findings\", id: <the descent's iteration>)` so the person is looking at the " +
          "same verdict panel you are about to use. Skip it if the descent has no iteration.",
        skipWhen: "nobody is watching, or the descent has no iteration",
      },
      {
        verb: "rule-on-descent",
        hint:
          "needs `by`, and there is no default — ask the person for their own name if you do not have it. If you " +
          "are not sure which of deeper, stop or park they want, ask rather than pick: there is no way to un-rule " +
          "this.",
      },
    ],
  },
  {
    id: "start-a-study-over-a-set",
    describe: "draft a study iteration over a set of repositories and run it",
    steps: [
      { section: "choose", verb: "read-sets", hint: "the set is the list of repositories. No verb here writes one, so it must already exist." },
      {
        section: "choose",
        verb: "read-templates",
        hint: "the method decides what the descents are asked. Omitting it on the draft takes the kernel's default.",
        skipWhen: "the person named a method, or is happy with the default",
      },
      { verb: "draft-iteration", hint: "drafting starts nothing and can be deleted again." },
      {
        verb: "read-iteration",
        hint: "read back what was drafted and tell the person what a Run would queue BEFORE running it.",
      },
      {
        verb: "run-iteration",
        hint:
          "this spends money and time against real repositories. If the person has not said to run it, stop here " +
          "and tell them it is ready.",
      },
    ],
  },
  {
    id: "clear-pieces-out-of-the-library",
    describe: "delete several pieces from the library at once",
    steps: [
      {
        verb: "select-pieces",
        hint: "resolves the predicate across the whole library and reports the count. READ IT: it is what the next step deletes.",
      },
      {
        verb: "delete-selected-pieces",
        hint:
          "takes no filter and acts on that selection. If the count was not what the person asked for, stop and " +
          "say so instead of calling this.",
      },
    ],
  },
];
