#!/usr/bin/env node
// driverkit plugin: survey a repository for the material a verb list is made of.
//
// `/driverkit:draft-verbs` runs this first so the drafting is grounded in what
// the app actually exports rather than in a guess about where its code lives.
// It prints a short text report: the app's framework, whether a driver is
// already mounted, candidate functions grouped by the `kind` their NAME
// suggests, buttons already marked with `data-dk`, and whether the screen looks
// like a table with paging.
//
// EVERY candidate found is printed, including the ones whose `kind` the name
// does not settle: those come out as `unknown`. That is the one rule here worth
// not undoing. Earlier this script dropped a name that matched none of its word
// lists, which made a real app's eight `write*` functions and its `castVerdict`
// and `abandonDescent` simply absent from the output -- and an absence is not a
// claim an author can check. The silence read as "this app has no writes", and
// it reads that way in one direction only: the destructive half is what goes
// missing. Extending the word lists helps the next app and does not fix that;
// printing the ones it cannot place does.
//
// It only ever reads files and prints. Nothing is written, nothing is executed,
// no network, no dependencies -- `node scan-app.mjs` on a bare Node 18+ is the
// whole requirement. A name is weak evidence, so every line here is a
// CANDIDATE: the model reads the file before it writes a verb, and the human
// prunes what is left.
import fs from "node:fs";
import path from "node:path";

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".html"]);
const SKIP_DIR = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "coverage",
  ".venv", "venv", "__pycache__", ".turbo", ".cache", "vendor", ".output", "target",
]);

// A function name is the only signal available before anything is read, so the
// buckets are deliberately coarse and the labels say "looks like".
//
// A word earns a place on one of these lists only when the word ON ITS OWN
// settles the kind. `generate`, `build`, `make`, `copy`, `print`, `export` and
// `download` are deliberately absent: each is a write in one app and a pure
// function in the next, and a confident wrong `kind` is worse than none at all
// -- `kind` is the field that decides whether a call is gated. Those land in
// `unknown`, where the author decides. See the `unknown` bucket below.
//
// The match is a loose PREFIX, so `promote` also catches `promotedLabelOf` and
// `store` catches `storePath`. That is left loose deliberately: over-calling a
// pure function a `commit` costs an author one line of pruning, while the
// reverse -- a write that lands in `read` -- hands an agent an ungated commit.
// The two errors are not symmetrical and the slack goes the safe way.
const KINDS = [
  ["commit", /^(create|add|insert|update|edit|patch|set|save|delete|remove|destroy|archive|restore|accept|approve|reject|deny|decline|send|submit|assign|unassign|pay|refund|charge|cancel|publish|unpublish|merge|apply|confirm|close|reopen|resolve|import|upload|invite|rename|move|duplicate|bulk|batch|sync|run|trigger|start|stop|enable|disable|toggle|write|cast|abandon|post|push|emit|queue|dequeue|dispatch|commit|persist|store|flush|upsert|drop|purge|revoke|grant|requeue|retry|schedule|abort|terminate|release|deploy|rollback|undo|append|prepend|replace|attach|detach|unlink|subscribe|unsubscribe|claim|unlock|unban|unmute|snooze|escalate|transfer|withdraw|deposit|settle|invoice|ship|fulfil|fulfill|restock|reserve|unreserve|promote|demote|finalize|finalise|dismiss|acknowledge|unflag|prune|park|stash|execute|perform|draft)/i],
  ["describe", /^(select|deselect|unselect|check|uncheck|mark|filter|search|query|sort|order|page|paginate|goto|next|prev|previous|clear|reset|expand|collapse|focus|choose|highlight|narrow|untick)/i],
  ["read", /^(get|list|fetch|load|read|find|lookup|count|total|visible|show|view|open|retrieve|poll|observe|snapshot|peek|inspect|compute|derive|parse|format|summarise|summarize|preview|exists)/i],
];
// Everything else. The fourth bucket is the point of this file: before it
// existed a name matching none of the three regexes was DROPPED, and a dropped
// function is indistinguishable from one that is not there. The failure always
// ran one way -- an app whose writes are spelled in a vocabulary these lists do
// not carry read as an app with no writes -- so the output could never be
// wrong out loud. It is `unknown` now, and printed.
const UNKNOWN = "unknown";

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(`driverkit scan-app: survey a repo for the material a verb list is made of

  node scan-app.mjs [--root DIR] [--max-files N] [--max-report N]

  --root DIR       the app to survey -- a DIRECTORY, never a file
                   (default: the current directory)
  --max-files N    stop walking after N source files (default 4000)
  --max-report N   print this many files in the candidate section (default 12);
                   "--max-report all" prints every file that had a candidate

Reads and prints only. Output is CANDIDATES, not conclusions: read the file
before writing a verb for it. A candidate whose name this script cannot place
is printed as "unknown" rather than left out -- see that section's note.`);
  process.exit(0);
}

function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const root = path.resolve(flag("--root", process.cwd()));
const maxFiles = Number(flag("--max-files", "4000")) || 4000;
const maxReportRaw = flag("--max-report", "12");
const maxReport = maxReportRaw === "all" ? Infinity : Number(maxReportRaw) || 12;

let stat;
try {
  stat = fs.statSync(root);
} catch {
  fail(`no such directory: ${root}\nPass --root with the app's repository root.`);
}
if (!stat.isDirectory()) fail(`not a directory: ${root}\nPass --root with the app's repository root.`);

function fail(message) {
  console.error(`driverkit scan-app: ${message}`);
  process.exit(2);
}

// ---- walk ----------------------------------------------------------------

const files = [];
let truncated = false;

(function walk(dir, depth) {
  if (truncated || depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: not this script's problem to report
  }
  for (const entry of entries) {
    if (truncated) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(full, depth + 1);
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      files.push(full);
      if (files.length >= maxFiles) truncated = true;
    }
  }
})(root, 0);

if (files.length === 0) {
  console.error(
    `driverkit scan-app: no .ts/.tsx/.js/.jsx/.vue/.svelte/.html files under ${root}\n` +
      `This looks like the wrong directory (or an app whose UI lives elsewhere).\n` +
      `Pass --root with the directory that holds the app's source.`,
  );
  process.exit(1);
}

// ---- read ----------------------------------------------------------------

const MAX_BYTES = 400_000;
const docs = [];
for (const file of files) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) continue;
    docs.push({ file, rel: path.relative(root, file), text: fs.readFileSync(file, "utf8") });
  } catch {
    /* skip */
  }
}

// ---- package.json --------------------------------------------------------

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
} catch {
  /* no package.json, or not JSON: fine, just less to say */
}
const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
const known = ["react", "next", "vue", "nuxt", "svelte", "@angular/core", "solid-js", "preact", "lit", "htmx.org", "jquery"];
const frameworks = known.filter((d) => deps[d]);
// One package now, so one name to look for -- the subpaths (`driverkit/widget`,
// `driverkit/controls`, ...) are entry points, never separate dependencies.
const dkDeps = Object.keys(deps).filter((d) => d === "driverkit");

// ---- already mounted? ----------------------------------------------------

// Both the published specifier and a relative import of the built output: the
// repository's own example imports `packages/driverkit/dist/core/registry.js` directly,
// and a scan that called that "not mounted" would invite a second driver.
const mounts = docs.filter(
  (d) =>
    /from\s+["'][^"']*driverkit[^"']*["']|require\(["'][^"']*driverkit[^"']*["']\)/.test(d.text) ||
    /\bmount\(\s*\{/.test(d.text),
);
const widgets = docs.filter((d) => /\b(mountWidget|backendThink)\s*\(|\bconnect\(\s*driver/.test(d.text));

// The verbs a mount already declares. Printed so a draft extends the list
// instead of proposing a second `search` under a slightly different name.
const existingVerbs = new Set();
for (const d of mounts) {
  for (const m of d.text.matchAll(/\bname\s*:\s*["']([a-z0-9][a-z0-9-]*)["']/g)) existingVerbs.add(m[1]);
}

// ---- marked handles ------------------------------------------------------

const handles = new Map(); // handle -> [rel]
for (const d of docs) {
  for (const m of d.text.matchAll(/data-dk\s*=\s*["']([^"']+)["']/g)) {
    if (!handles.has(m[1])) handles.set(m[1], []);
    if (!handles.get(m[1]).includes(d.rel)) handles.get(m[1]).push(d.rel);
  }
}

// ---- candidate functions -------------------------------------------------

// Four declaration shapes cover the overwhelming majority of app code and none
// of them needs a parser: exported functions, exported arrow consts, class and
// object methods. A false positive costs the model one line to ignore; a parser
// would cost this script its zero-dependency promise.
const PATTERNS = [
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
  /^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,
  /^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*)?\(/gm,
];
// Control flow, hooks, framework callbacks and library plumbing. These match
// the kind regexes by accident and crowd out the app's real vocabulary, which
// is the only thing the drafting step is here to read.
const NOISE =
  /^(if|for|while|switch|catch|return|function|constructor|render|use[A-Z]|describe|it|test|expect|beforeEach|afterEach|then|map|filter|forEach|reduce|addEventListener|removeEventListener|dispatchEvent|setTimeout|setInterval|setState|queryFn|mutationFn|queryKey|select(or)?Fn|on(Success|Error|Mutate|Settled|Retry|Change|Click|Submit|Close|Open|Blur|Focus|Input|KeyDown|KeyUp))$/;

// The one thing dropped on purpose, and it is dropped because it is not code.
// Pattern 4 matches a TypeScript type member as readily as an object method --
// `toggle: (id: string) => void;` in an `interface` is the same shape as
// `remove: (p) => writePiece(...)` in a returned object -- and on a React
// codebase the type members were the majority of the output. The test is
// narrow on purpose: the line ends in `;` and everything after the arrow is a
// TYPE, with no call and no block. `remove: (p) => writePiece(...),` keeps its
// parenthesis and its comma and survives, which matters because on the app
// that motivated this filter those four `remove:` lines are the real deletes.
// How many lines this skipped is PRINTED, for the same reason `unknown` is.
const TYPE_MEMBER = /:\s*(?:async\s*)?\([^)]*\)\s*=>\s*[^(){};]*;\s*$/;
let typeMembersSkipped = 0;

const candidates = new Map(); // "rel::name" -> {rel, name, kind}
for (const d of docs) {
  if (/[.\/](test|spec)[.\/]|\.(test|spec)\./.test(d.rel)) continue;
  for (const [index, re] of PATTERNS.entries()) {
    for (const m of d.text.matchAll(re)) {
      const name = m[1];
      // A capitalised name is a component or a class, not a thing to call.
      if (NOISE.test(name) || name.length < 3 || /^[A-Z]/.test(name)) continue;
      // The match stops at the open paren, so the test needs the whole line.
      if (index === 3) {
        const line = d.text.slice(d.text.lastIndexOf("\n", m.index) + 1).split("\n")[0];
        if (TYPE_MEMBER.test(line)) {
          typeMembersSkipped++;
          continue;
        }
      }
      // No `continue` on a miss any more: the bucket is the fix.
      const kind = (KINDS.find(([, re2]) => re2.test(name)) || [UNKNOWN])[0];
      candidates.set(`${d.rel}::${name}`, { rel: d.rel, name, kind });
    }
  }
}

const byFile = new Map();
for (const c of candidates.values()) {
  if (!byFile.has(c.rel)) byFile.set(c.rel, []);
  byFile.get(c.rel).push(c);
}
// An `unknown` counts as much as a `commit` towards a file's rank, because a
// file full of names this script cannot place is exactly where an unrecognised
// write vocabulary lives, and ranking those files last is how the old version
// hid them twice over.
const ranked = [...byFile.entries()]
  .map(([rel, list]) => {
    const commits = list.filter((c) => c.kind === "commit").length;
    const unknowns = list.filter((c) => c.kind === UNKNOWN).length;
    return { rel, list, commits, unknowns, score: list.length + 2 * commits + 2 * unknowns };
  })
  .sort((a, b) => b.score - a.score);

const tally = (kind) => [...candidates.values()].filter((c) => c.kind === kind).length;
const totals = { commit: tally("commit"), describe: tally("describe"), read: tally("read"), unknown: tally(UNKNOWN) };

// ---- what the screen looks like -----------------------------------------

const signal = (re) => docs.filter((d) => re.test(d.text)).map((d) => d.rel);
const tables = signal(/<table[\s>]|role=["']grid["']|ag-grid|react-table|@tanstack\/react-table|DataGrid|<thead[\s>]/);
const paging = signal(/\bpage(?:Index|Number|Size)?\b\s*[:=]|offset\s*[:=]|\blimit\s*[:=]|pagination/i);
const selection = signal(/\bselected(?:Ids|Rows|Keys)?\b|selection|checkedRows/i);
const stores = signal(/\b(create|configure)Store\b|zustand|redux|pinia|mobx|valtio|writable\(|signal\(|useReducer/);

// ---- report --------------------------------------------------------------

const cap = (list, n) => (list.length > n ? [...list.slice(0, n), `... and ${list.length - n} more`] : list);
const out = [];
const say = (s = "") => out.push(s);

say(`# driverkit scan: ${root}`);
say(`${docs.length} source files read${truncated ? ` (stopped at --max-files ${maxFiles})` : ""}.`);
say();
say(`## App`);
say(`- package: ${pkg?.name ? `${pkg.name}` : "(no package.json)"}`);
say(`- framework signals: ${frameworks.length ? frameworks.join(", ") : "none found (plain DOM, or server-rendered)"}`);
say(`- driverkit installed: ${dkDeps.length ? dkDeps.join(", ") : "NO -- add it before the draft can typecheck"}`);
say(`- driver already mounted: ${mounts.length ? mounts.map((d) => d.rel).join(", ") : "no"}`);
if (widgets.length) say(`- widget / relay wiring in: ${cap(widgets.map((d) => d.rel), 6).join(", ")}`);
if (existingVerbs.size) say(`- verbs already declared: ${[...existingVerbs].sort().join(", ")} (extend this list, do not duplicate it)`);
say();

say(`## Marked buttons (data-dk)`);
if (handles.size === 0) {
  say(`none: no \`data-dk="..."\` attributes anywhere, so no verb is wired to a button.`);
} else {
  for (const [h, where] of [...handles].slice(0, 40)) say(`- \`${h}\` in ${where.slice(0, 3).join(", ")}`);
}
say();

say(`## Candidate verbs, by file (name-based guess only -- read the file)`);
if (ranked.length === 0) {
  say(`NOTHING AT ALL. Not "no writes" -- no function of any kind matched the four`);
  say(`declaration shapes this script knows, which usually means the UI's code is`);
  say(`somewhere else, or it is in a language/shape this script cannot read.`);
  say(`Check --root, then grep for the words the UI uses on its buttons.`);
} else {
  say(
    `${candidates.size} candidates in ${ranked.length} files: ` +
      `${totals.commit} commit, ${totals.describe} describe, ${totals.read} read, ` +
      `${totals.unknown} UNKNOWN.`,
  );
  say();
  // The guess is a prefix match against three word lists, so it is wrong in a
  // direction: a write spelled in a word the lists do not carry used to vanish,
  // and a vanished function reads exactly like a function that is not there.
  // Nothing is left out now. An empty `commit:` line means "no name here LOOKED
  // like a write" and it means "this file writes nothing" only when the
  // `unknown:` line is empty too.
  say(`\`unknown\` is not an error and it is not a leftover. It is a name this script`);
  say(`could not place, listed because the alternative -- dropping it -- made "no`);
  say(`writes in this app" and "a write vocabulary I do not know" print the same.`);
  say(`\`kind\` is the field that decides whether a call is gated, so an unknown is`);
  say(`a QUESTION FOR YOU, and answering it means opening the file.`);
  if (totals.commit === 0) {
    say();
    say(`!! NOT ONE name looked like a commit, anywhere.`);
    if (totals.unknown > 0) {
      say(`   There are ${totals.unknown} unknown names. Read those before you believe this app`);
      say(`   is read-only: the writes are far likelier to be hiding there than absent.`);
    } else {
      say(`   And nothing is unknown either, so this really may be a read-only app --`);
      say(`   confirm it against the buttons on the screen, not against this line.`);
    }
  }
  say();
  for (const entry of ranked.slice(0, maxReport)) {
    const kinds = ["commit", "describe", "read", UNKNOWN]
      .map((k) => `${entry.list.filter((c) => c.kind === k).length} ${k}`)
      .join(", ");
    say(`### ${entry.rel}  (${entry.list.length} candidates: ${kinds})`);
    for (const kind of ["commit", "describe", "read"]) {
      const names = entry.list.filter((c) => c.kind === kind).map((c) => c.name);
      if (names.length) say(`- ${kind}: ${cap(names, 18).join(", ")}`);
    }
    const unknowns = entry.list.filter((c) => c.kind === UNKNOWN).map((c) => c.name);
    if (unknowns.length) {
      say(`- unknown -- MATCHED NO WORD LIST, you decide: ${cap(unknowns, 24).join(", ")}`);
    }
  }
  if (ranked.length > maxReport) {
    say(`\n(${ranked.length - maxReport} further files had candidates. \`--root\` takes a DIRECTORY, not a file:`);
    say(`re-run with \`--max-report all\` to print them, or \`--root\` set to a subdirectory.)`);
  }
}
if (typeMembersSkipped) {
  say();
  say(
    `(${typeMembersSkipped} line${typeMembersSkipped === 1 ? "" : "s"} like \`onDone: (id: string) => void;\` were skipped:\n` +
      `a TypeScript type member DECLARES a function, it is not one. Counted out loud for\n` +
      `the same reason \`unknown\` is printed: if a real candidate is missing from the\n` +
      `lists above, this filter is the first thing to suspect.)`,
  );
}
say();

say(`## Screen shape`);
say(`- table / grid markup: ${tables.length ? cap(tables, 5).join(", ") : "none found"}`);
say(`- paging: ${paging.length ? cap(paging, 5).join(", ") : "none found"}`);
say(`- selection state: ${selection.length ? cap(selection, 5).join(", ") : "none found -- a describe/commit pair may have nothing to act on"}`);
say(`- store: ${stores.length ? cap(stores, 5).join(", ") : "none found -- visible() may have to read the DOM by hand"}`);
say();
say(`## Reminders for the draft`);
say(`- A verb that acts on many rows takes a PREDICATE, never an id called a thousand times.`);
say(`- Split every bulk action: a \`describe\` verb that selects and reports \`count\`, a \`commit\` verb that takes no predicate.`);
say(`- \`refuses\` is the field people skip; list the slugs the agent can avoid calling into.`);
say(`- \`visible()\` returns only what the person can see: same filter, same page.`);
// All fifteen of `RESERVED_REFUSALS` (packages/driverkit/src/core/registry.ts).
// A short list here is not a smaller rule: `mount()` throws on every one of
// them, and `stale-plan` is the slug an author drafting a `consumes: "plan"`
// pair reaches for first.
say(`- Reserved slugs (mount throws, all fifteen): stale, stale-plan, wrong-screen, unknown-verb,`);
say(`  bad-argument, unmounted, threw, no-such-tab, tab-went-away, timeout, declined-by-user,`);
say(`  approval-pending, approval-timeout, budget-spent, changed-elsewhere.`);
say(`- More than one screen? \`screen\` on the verb, \`screen\` in visible(), and the core writes wrong-screen.`);
say(`- The app's own briefing goes in \`instructions\` on mount(), not in every snapshot's note.`);

console.log(out.join("\n"));
