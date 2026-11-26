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
const KINDS = [
  ["commit", /^(create|add|insert|update|edit|patch|set|save|delete|remove|destroy|archive|restore|accept|approve|reject|deny|decline|send|submit|assign|unassign|pay|refund|charge|cancel|publish|unpublish|merge|apply|confirm|close|reopen|resolve|import|upload|invite|rename|move|duplicate|bulk|batch|sync|run|trigger|start|stop|enable|disable|toggle)/i],
  ["describe", /^(select|deselect|unselect|check|uncheck|mark|filter|search|query|sort|order|page|paginate|goto|next|prev|previous|clear|reset|expand|collapse|focus)/i],
  ["read", /^(get|list|fetch|load|read|find|lookup|count|total|visible|show|view|open)/i],
];

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(`driverkit scan-app: survey a repo for the material a verb list is made of

  node scan-app.mjs [--root DIR] [--max-files N]

  --root DIR       the app to survey (default: the current directory)
  --max-files N    stop walking after N source files (default 4000)

Reads and prints only. Output is CANDIDATES, not conclusions: read the file
before writing a verb for it.`);
  process.exit(0);
}

function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const root = path.resolve(flag("--root", process.cwd()));
const maxFiles = Number(flag("--max-files", "4000")) || 4000;

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
const dkDeps = Object.keys(deps).filter((d) => d === "driverkit" || d.startsWith("@driverkit/"));

// ---- already mounted? ----------------------------------------------------

// Both the published specifier and a relative import of the built output: the
// repository's own example imports `packages/core/dist/registry.js` directly,
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

const candidates = new Map(); // "rel::name" -> {rel, name, kind}
for (const d of docs) {
  if (/[.\/](test|spec)[.\/]|\.(test|spec)\./.test(d.rel)) continue;
  for (const re of PATTERNS) {
    for (const m of d.text.matchAll(re)) {
      const name = m[1];
      // A capitalised name is a component or a class, not a thing to call.
      if (NOISE.test(name) || name.length < 3 || /^[A-Z]/.test(name)) continue;
      const kind = (KINDS.find(([, re2]) => re2.test(name)) || [null])[0];
      if (!kind) continue;
      candidates.set(`${d.rel}::${name}`, { rel: d.rel, name, kind });
    }
  }
}

const byFile = new Map();
for (const c of candidates.values()) {
  if (!byFile.has(c.rel)) byFile.set(c.rel, []);
  byFile.get(c.rel).push(c);
}
const ranked = [...byFile.entries()]
  .map(([rel, list]) => ({
    rel,
    list,
    commits: list.filter((c) => c.kind === "commit").length,
    score: list.length + 2 * list.filter((c) => c.kind === "commit").length,
  }))
  .sort((a, b) => b.score - a.score);

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
say(`- driverkit packages installed: ${dkDeps.length ? dkDeps.join(", ") : "NONE -- add them before the draft can typecheck"}`);
say(`- driver already mounted: ${mounts.length ? mounts.map((d) => d.rel).join(", ") : "no"}`);
if (widgets.length) say(`- widget / relay wiring in: ${cap(widgets.map((d) => d.rel), 6).join(", ")}`);
if (existingVerbs.size) say(`- verbs already declared: ${[...existingVerbs].sort().join(", ")} (extend this list, do not duplicate it)`);
say();

say(`## Marked buttons (data-dk)`);
if (handles.size === 0) {
  say(`none. Tier 2 of the adapters ladder is unused: no \`data-dk="..."\` attributes anywhere.`);
} else {
  for (const [h, where] of [...handles].slice(0, 40)) say(`- \`${h}\` in ${where.slice(0, 3).join(", ")}`);
}
say();

say(`## Candidate verbs, by file (name-based guess only -- read the file)`);
if (ranked.length === 0) {
  say(`none matched. The app's mutators are named in a vocabulary this script does not know;`);
  say(`grep for the words the UI uses on its buttons instead.`);
} else {
  for (const entry of ranked.slice(0, 12)) {
    say(`### ${entry.rel}  (${entry.list.length} candidates, ${entry.commits} look like commits)`);
    for (const kind of ["commit", "describe", "read"]) {
      const names = entry.list.filter((c) => c.kind === kind).map((c) => c.name);
      if (names.length) say(`- ${kind}: ${cap(names, 18).join(", ")}`);
    }
  }
  if (ranked.length > 12) say(`\n(${ranked.length - 12} further files had candidates; re-run with the file in --root to see them.)`);
}
say();

say(`## Screen shape`);
say(`- table / grid markup: ${tables.length ? cap(tables, 5).join(", ") : "none found"}`);
say(`- paging: ${paging.length ? cap(paging, 5).join(", ") : "none found"}`);
say(`- selection state: ${selection.length ? cap(selection, 5).join(", ") : "none found -- a describe/commit pair may have nothing to act on"}`);
say(`- store: ${stores.length ? cap(stores, 5).join(", ") : "none found -- visible() may have to read the DOM (@driverkit/adapters)"}`);
say();
say(`## Reminders for the draft`);
say(`- A verb that acts on many rows takes a PREDICATE, never an id called a thousand times.`);
say(`- Split every bulk action: a \`describe\` verb that selects and reports \`count\`, a \`commit\` verb that takes no predicate.`);
say(`- \`refuses\` is the field people skip; list the slugs the agent can avoid calling into.`);
say(`- \`visible()\` returns only what the person can see: same filter, same page.`);
say(`- Reserved slugs (mount throws): stale, unknown-verb, bad-argument, unmounted, threw, no-such-tab,`);
say(`  tab-went-away, timeout, declined-by-user.`);

console.log(out.join("\n"));
