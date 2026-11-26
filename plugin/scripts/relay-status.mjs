#!/usr/bin/env node
// driverkit plugin: ask a relay what tabs it has, and say what to do next.
//
// Three questions keep coming up while wiring driverkit, and all three are
// answered by the relay's own agent-facing surface (PROTOCOL.md, "The HTTP
// surface the agent uses"): is a relay there, has the page dialled out to it,
// and are the verbs the ones I think I wrote. So this reads `/dk/tabs`,
// `/dk/tabs/:tab/manifest` and `/dk/tabs/:tab/snapshot` and nothing else.
//
// It never drives anything. `POST /call` runs the app's own code, possibly a
// `commit`, so a status command must not be able to -- the whole library is an
// argument for a human in front of that.
//
// Node 18+, no dependencies, no install. Exits 0 when a relay answered, 1 when
// one answered but there is nothing to drive, 2 when nothing answered at all.
const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(`driverkit relay-status: what is connected to the relay

  node relay-status.mjs [--relay URL] [--tab ID] [--token T] [--manifest] [--snapshot] [--mcp]

  --relay URL   relay base URL (env DK_RELAY). Default: tries http://127.0.0.1:7777
                then http://127.0.0.1:8770 (the contacts example mounts it at /dk
                on its own port).
  --tab ID      the tab to report on. Default: the only connected one.
  --token T     tab token to present (env DK_TOKEN). Needed only if the relay
                was started with --secret/--audience.
  --manifest    print the tab's verbs (name, kind, args, refuses)
  --snapshot    print the tab's last pushed snapshot
  --mcp         print the 'claude mcp add' line for the tab

Read-only: it never POSTs a call.`);
  process.exit(0);
}

function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}
const want = (name) => args.includes(name);

const explicit = flag("--relay", process.env.DK_RELAY || null);
const candidates = explicit ? [explicit] : ["http://127.0.0.1:7777", "http://127.0.0.1:8770"];
const token = flag("--token", process.env.DK_TOKEN || null);
const headers = token ? { authorization: `Bearer ${token}` } : {};

async function get(base, path) {
  const url = base.replace(/\/+$/, "") + path;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: the status and the raw text are all there is to report */
  }
  return { url, status: res.status, body, text };
}

function die(lines, code = 2) {
  console.error(lines.join("\n"));
  process.exit(code);
}

// ---- find a relay --------------------------------------------------------

let relay = null;
let tabs = null;
const tried = [];

for (const base of candidates) {
  let res;
  try {
    res = await get(base, "/dk/tabs");
  } catch (err) {
    tried.push(`${base}  ${err?.name === "TimeoutError" ? "no answer in 4s" : err?.cause?.code || err?.message || "unreachable"}`);
    continue;
  }
  if (res.status === 401) {
    die([
      `driverkit: ${res.url} answered 401 ${res.body?.error ?? ""}`.trim(),
      ``,
      `That relay was started with --secret/--audience, so it identifies its callers.`,
      `Pass the tab token the app's backend mints: --token <dkt1....> (or DK_TOKEN).`,
      `A token that does not verify answers 401 for every reason there is -- expired,`,
      `wrong audience, unknown key -- so there is nothing more specific to go on.`,
    ]);
  }
  if (res.status === 403) {
    die([
      `driverkit: ${res.url} answered 403 forbidden.`,
      ``,
      `The relay is refusing this peer outright: it is loopback-only and you are not on`,
      `loopback. Nothing you can present will change that; run the relay where you are,`,
      `or start it with --allow-remote (which then requires --secret and --audience).`,
    ]);
  }
  if (res.status !== 200 || !res.body || !Array.isArray(res.body.tabs)) {
    tried.push(`${base}  answered ${res.status} but not a /dk/tabs envelope (${res.text.slice(0, 80)})`);
    continue;
  }
  relay = base.replace(/\/+$/, "");
  tabs = res.body.tabs;
  break;
}

if (!relay) {
  die([
    `driverkit: no relay answered GET /dk/tabs.`,
    ``,
    ...tried.map((t) => `  tried ${t}`),
    ``,
    `A relay is the one place a tab and an agent can both reach, so nothing outside the`,
    `page can drive anything until one is running. Three ways to get one:`,
    ``,
    `  python3 -m driverkit.serve_relay --port 7777     # or the driverkit-relay command`,
    `  driverkit.asgi.relay_asgi mounted in the server you already run   # the deployment to prefer`,
    `  python3 examples/contacts/server.py              # the repo's demo: app + relay on one port`,
    ``,
    `The Python half is stdlib only: PYTHONPATH=python/src is enough, no install needed.`,
    `If your relay is elsewhere, pass --relay http://host:port.`,
  ]);
}

// ---- report --------------------------------------------------------------

console.log(`relay: ${relay}  (${tabs.length} tab${tabs.length === 1 ? "" : "s"})`);

if (tabs.length === 0) {
  console.log(
    [
      ``,
      `The relay is up and no tab has dialled out to it.`,
      `A page joins by calling connect() from driverkit/browser:`,
      ``,
      `    import { connect } from "driverkit/browser";`,
      `    connect(driver, { relay: "${relay}" });   // "" when the relay is on the page's own origin`,
      ``,
      `Then load the page. Check the browser console for the EventSource, and remember the`,
      `tab only appears once it is open -- a closed tab is not a tab.`,
    ].join("\n"),
  );
  process.exit(1);
}

for (const t of tabs) {
  console.log(
    `\n  tab   ${t.tab}\n  app   ${t.app ?? "(no hello yet)"}\n  page  ${t.title ?? "?"}  ${t.url ?? ""}\n  rev   ${t.rev ?? "?"}   manifest ${t.manifestVersion ?? "?"}   since ${t.since ?? "?"}`,
  );
}

const chosen = flag("--tab", tabs.length === 1 ? tabs[0].tab : null);
if (!chosen) {
  console.log(
    `\n${tabs.length} tabs are connected, so pass --tab <id> for a manifest, a snapshot or an MCP line.` +
      `\nThe titles and urls above are there so a person can say which one; guessing would mean driving somebody's other screen.`,
  );
  process.exit(0);
}

if (want("--manifest")) {
  const res = await get(relay, `/dk/tabs/${encodeURIComponent(chosen)}/manifest`);
  if (res.status === 404) {
    console.log(`\nmanifest: 404 ${res.body?.error ?? ""} -- the stream is open but hello has not landed yet (or that tab is not yours). Try again in a moment.`);
  } else if (res.status !== 200 || !res.body) {
    console.log(`\nmanifest: ${res.status} ${res.text.slice(0, 200)}`);
  } else {
    const m = res.body;
    console.log(`\nmanifest ${m.version}  app "${m.app}"  ${m.verbs?.length ?? 0} verbs`);
    for (const v of m.verbs ?? []) {
      const argNames = Object.entries(v.args ?? {})
        .map(([n, s]) => `${n}${s.optional ? "?" : ""}: ${s.type}`)
        .join(", ");
      console.log(
        `  ${(v.kind ?? "NO KIND").padEnd(8)} ${v.name}(${argNames})` +
          (v.refuses?.length ? `  refuses: ${v.refuses.join(", ")}` : ``),
      );
    }
    const unkinded = (m.verbs ?? []).filter((v) => !v.kind).map((v) => v.name);
    if (unkinded.length) {
      console.log(`\n  ${unkinded.length} verb(s) declare no kind: ${unkinded.join(", ")}`);
      console.log(`  An absent kind makes no safety claim in either direction, so an agent cannot tell`);
      console.log(`  a free read from an irreversible commit. Declare it.`);
    }
  }
}

if (want("--snapshot")) {
  const res = await get(relay, `/dk/tabs/${encodeURIComponent(chosen)}/snapshot`);
  if (res.status === 200) {
    console.log(`\nsnapshot (the last one the tab volunteered, not a fresh read):`);
    console.log(JSON.stringify(res.body, null, 2).slice(0, 4000));
  } else {
    console.log(`\nsnapshot: ${res.status} ${res.body?.error ?? res.text.slice(0, 120)}`);
  }
}

if (want("--mcp")) {
  const tokenArg = token ? ` --token "$DK_TOKEN"` : ``;
  console.log(
    [
      ``,
      `To let this Claude Code session drive that tab, add the stdio MCP server:`,
      ``,
      `    claude mcp add driverkit -- driverkit-mcp --relay ${relay} --tab ${chosen}${tokenArg}`,
      ``,
      `From a checkout, with nothing installed:`,
      ``,
      `    claude mcp add driverkit -e PYTHONPATH=/path/to/driverkit/python/src -- \\`,
      `      python3 -m driverkit.mcp_server --relay ${relay} --tab ${chosen}${tokenArg}`,
      ``,
      `The tool list is generated from that tab's manifest, so no tool is hand-written per`,
      `verb -- and the tab id pins which screen it drives. Omit --tab only while exactly one`,
      `tab is connected: the server refuses to guess, because guessing means driving the`,
      `wrong screen. A tab id is a capability; keep it out of shared logs.`,
    ].join("\n"),
  );
}
