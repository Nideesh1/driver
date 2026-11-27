/**
 * FACTORY's screens, as `Manifest.screens`.
 *
 * This is the one part of the draft that was nearly free, and the reason is
 * worth recording because `references/screens.md` asks for exactly it:
 * FACTORY's router already holds a closed `Route` union
 * (`frontend/src/app/lib/router.tsx:79`) whose `name` values are stable
 * kebab-case, and an `href(route)` that is the route table in reverse. So
 * every `id` below is a `Route["name"]` verbatim and every `url` is what
 * `href()` produces, with the kernel-minted segments turned into RFC 6570
 * variables. `Snapshot.screen` is `parse(location.pathname).name`, which means
 * the three fields the procedure warns can disagree after a rename cannot:
 * they are all the same union.
 *
 * TWO THINGS THE ROUTE TABLE HAS AND THIS CANNOT SAY.
 *
 * 1. `iteration-new` carries a `step` ("leg" | "set" | "model" | "name"), and
 *    `href()` serialises step 1 to `/app/iterations/new` and the other three
 *    to `/app/iterations/new/<step>` — deliberately, so the page has one
 *    canonical entry URL. RFC 6570 simple expansion cannot express "this
 *    segment, or nothing": `{step}` with no value expands to the empty string
 *    and leaves a trailing slash, and the core expands only `{var}`. So this
 *    screen is declared at its step-1 address with no arguments, and an agent
 *    cannot deep-link to step 3. Declaring four screens instead would put
 *    three wizard steps in every cached prefix forever to buy a link nobody
 *    asked for.
 * 2. `unknown` is a `Route` and is not a screen. It is where a bad URL lands,
 *    so declaring it would offer an agent a destination whose whole content is
 *    "No such screen."
 *
 * Per `ScreenSpec`'s rule, this is every screen the APP has and not the
 * screens a given person can reach: `/app/settings/github` works without a
 * GitHub account and says so on the page, and `src/middleware.ts` guards a
 * set that none of these are in. Nothing here is filtered per user.
 */
import type { ScreenSpec } from "driverkit";

/** `PROVIDER_SEGMENTS` — frontend/src/app/lib/router.tsx:68. */
const PROVIDERS = ["ollama", "tinyfish", "langsearch", "telegram"];

export const SCREENS: ScreenSpec[] = [
  {
    id: "dashboard",
    describe:
      "the landing screen: the kernel's health line, and the backlog as five lane counts you can open in place. " +
      "Where you look first to see whether anything is waiting at the pruning gate.",
    url: "/app/dashboard",
  },
  {
    id: "control",
    describe:
      "the control plane: one tile per external system FACTORY can be wired to. An index of connections, " +
      "not a dashboard — the dashboard reads the kernel, this reads what is attached to it.",
    url: "/app/control",
  },

  {
    id: "sets",
    describe:
      "the repository sets a person has assembled. A set is the list of repositories an iteration descends on. " +
      "Searchable, twelve cards at a time.",
    url: "/app/sets",
  },
  {
    id: "set-new",
    describe: "the form for assembling a new set: a name, and a repository picker.",
    url: "/app/sets/new",
  },
  {
    id: "set",
    describe: "one set, on a page: its name and which repositories are in it, editable.",
    url: "/app/sets/{set}",
    args: { set: { type: "string", describe: "the set's id, as `read-sets` reports it" } },
  },

  {
    id: "iterations",
    describe:
      "every iteration, newest change first, six cards at a time and searchable by name, reason, leg or set. " +
      "Each card carries the Run control and a note of what a Run would queue.",
    url: "/app/iterations",
  },
  {
    id: "iteration-new",
    describe:
      "the four-step form for writing an iteration: which leg, which set, which model, and a name. " +
      "This is its first step; the later steps have addresses of their own that cannot be linked to from here.",
    url: "/app/iterations/new",
  },
  {
    id: "iteration",
    describe:
      "one iteration: its set, its reason, its leg, the method its descents are run by, the Run control, " +
      "and a live scene of the descents it has started.",
    url: "/app/iterations/{iteration}",
    args: { iteration: { type: "string", describe: "the iteration's id, or the slug an older kernel keyed it by" } },
  },
  {
    id: "iteration-edit",
    describe: "editing one iteration: its name, reason, leg, set, model, method, credentials and where findings are posted.",
    url: "/app/iterations/{iteration}/edit",
    args: { iteration: { type: "string", describe: "the iteration's id, or the slug an older kernel keyed it by" } },
  },
  {
    id: "iteration-findings",
    describe:
      "what one iteration produced, grouped by the descent that found it, with the verdict panel for any descent " +
      "sitting at the pruning gate. This is the screen a person rules from.",
    url: "/app/iterations/{iteration}/findings",
    args: { iteration: { type: "string", describe: "the iteration's id, or the slug an older kernel keyed it by" } },
  },

  {
    id: "templates",
    describe:
      "the index over methods: two panels with a count each — the method templates, and the piece library they " +
      "are assembled from — and a link into whichever you came to work on.",
    url: "/app/templates",
  },
  {
    id: "templates-all",
    describe:
      "the list of method templates: where to dig and how hard to pull, one row each with its breadth and depth " +
      "sizes. Searchable, twelve at a time, with a tick box per row and a batch delete.",
    url: "/app/templates/all",
  },
  {
    id: "template-new",
    describe: "the form for writing a new method: a name, a line about it, and two ordered lists assembled from pieces.",
    url: "/app/templates/new",
  },
  {
    id: "template-edit",
    describe:
      "editing one method: its breadth list and its depth list, reorderable, with the piece library beside them " +
      "to drag from.",
    url: "/app/templates/{template}",
    args: { template: { type: "string", describe: "the method template's id" } },
  },
  {
    id: "pieces",
    describe:
      "the piece library: breadth and depth items written once and copied into many methods. Searchable, " +
      "filterable to one kind, ten at a time, with a tick box per row and a batch delete.",
    url: "/app/templates/pieces",
  },
  {
    id: "piece-new",
    describe: "the form for writing a new piece: a label, a kind, the one-sentence bullet, and the prompt an agent is given.",
    url: "/app/templates/pieces/new",
  },
  {
    id: "piece",
    describe: "one piece, editable: its label, kind, bullet and prompt, and a delete.",
    url: "/app/templates/pieces/{piece}",
    args: { piece: { type: "string", describe: "the piece's id, as `read-pieces` reports it" } },
  },

  {
    id: "findings",
    describe:
      "every finding, asked by filter: a cited path, a lane, hole or ceiling, admissible or not, free text. " +
      "The screen that answers \"what has anything ever said about this file\". Twenty at a time.",
    url: "/app/findings",
  },
  {
    id: "finding",
    describe:
      "one finding in full: its claim, its argument, the commands that were run to prove it and what they exited " +
      "with, and the files it cites.",
    url: "/app/findings/{descent}/{layer}/{index}",
    args: {
      descent: { type: "string", describe: "the descent's id, as `read-backlog` reports it" },
      layer: { type: "number", describe: "which layer of that descent, as the finding reports it" },
      index: { type: "number", describe: "which finding within that layer, counting from 0" },
    },
  },

  {
    id: "settings",
    describe: "configuration as an index: one row per integration and the state it is in.",
    url: "/app/settings",
  },
  {
    id: "settings-github",
    describe: "the GitHub connection: one account per browser session, held behind a cookie. Not a provider key.",
    url: "/app/settings/github",
  },
  {
    id: "settings-provider",
    describe:
      "one provider's keys: the credentials an iteration's descents run on. The secrets cannot be read back, " +
      "and no verb in this list writes one.",
    url: "/app/settings/{provider}",
    args: {
      provider: { type: "string", describe: "which provider's keys", oneOf: PROVIDERS },
    },
  },
];
