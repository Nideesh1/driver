/**
 * Northwind CRM: six screens, one driver, two ways in.
 *
 * `store.js` holds the store, the per-screen `visible()` reads and the verb
 * table. `screens.js` holds the DOM. This file is the part that joins them to
 * the browser: it syncs the route to the address bar, redraws on every change,
 * and opens BOTH of driverkit's paths over the one driver —
 *
 *   `mountWidget(driver, …)` — a chat panel in the corner of this page, which
 *       drives the app in-process with no transport at all.
 *   `connect(driver, { relay: "" })` — an SSE stream held open to the relay
 *       that this page's own server mounted at `/dk`, so an agent in another
 *       process drives the same screens through the same verbs.
 *
 * One page, both cases, and the point of the exercise: they are not two
 * integrations. Everything arrives at `driver.call()`, which is the only place
 * arguments are validated and `rev` is checked.
 *
 * THE ROUTE SYNC IS ONE-WAY BY DESIGN. The store's `route` is the truth and
 * the address bar follows it. The other direction — a verb calls
 * `history.pushState`, a `hashchange` eventually updates the store — would
 * mean `open-contact` returning a snapshot of the screen it just left, because
 * the core reads `visible()` the instant `run` returns and `hashchange` is a
 * later task. A navigation verb that reports the previous screen is a
 * navigation verb an agent cannot chain, so the store moves first and the URL
 * catches up. The browser's own Back still works, because `hashchange` from a
 * real history move is the one case that writes INTO the store.
 */

import { mountWidget } from "../../../packages/driverkit/dist/widget/widget.js";
import { connect } from "../../../packages/driverkit/dist/browser/connect.js";
import { broadcastElsewhere } from "../../../packages/driverkit/dist/browser/elsewhere.js";
import { backendThink } from "../../../packages/driverkit/dist/agent/backend.js";
import { createApp } from "./store.js";
import { renderScreen } from "./screens.js";
import { href, parse, same } from "./router.js";

/**
 * The relay connection. Declared before `createApp` because the change
 * callback notifies it, and it is opened after the driver exists.
 *
 * @type {{ changed: () => void, disconnect: () => void } | undefined}
 */
let connection;

/** True while we are writing `location.hash` ourselves, so the `hashchange`
 *  our own write fires is ignored rather than treated as the person pressing
 *  Back. Without it every verb-driven navigation would be applied twice: once
 *  by the store and once by the listener reading the URL we just set. */
let writingHash = false;

/**
 * The chat panel, assigned below and referred to before it exists.
 *
 * The forward reference is unavoidable and it is the documented wiring:
 * `mount()` has to happen before there is a panel to answer for it, and the
 * panel needs the driver `mount()` returns. So the approval hook closes over
 * this variable and is not called until an agent asks for a commit, by which
 * time it is set.
 *
 * @type {import("../../../packages/driverkit/dist/widget/widget.js").Widget | undefined}
 */
let panel;

const app = createApp(
  () => {
    syncHash();
    renderScreen(app, host);
    markNav();
    connection?.changed();
  },
  {
    // THE GATE, AND THE WHOLE REASON THIS LINE EXISTS. Without it the panel
    // asked the person before a commit and an agent arriving over the relay
    // did not get asked at all: `driver.call("accept-selected")` from another
    // process simply accepted the rows. The confirmation was in the in-page
    // loop, which is one of the two ways in.
    //
    // It is in `mount()` now, so this one hook covers both: the panel's own
    // run and anything that arrives over `/dk`. The question is the panel's
    // dialog either way — same wording, same count, same `confirmCommits`
    // switch — and a "No" is the same `declined-by-user` refusal, which is a
    // slug the outside path could not previously produce at all.
    //
    // No `approvalTimeout` here, deliberately. This is a demo somebody drives
    // by hand, and a deadline that denies while they are reading the question
    // would be the wrong lesson; the agent's own transport deadline already
    // tells it the outcome is unknown. An app whose approver is on a phone, or
    // whose gate is a webhook, sets one.
    approve: (req) => panel.approve(req),
    // THE CHANNEL, as against the gate above. `approve` lets the person stop
    // the agent; this lets the agent ask the person something, which is the
    // other direction and was the gap. An instruction like "select the contact
    // called Ada Duarte" names five different people in this fixture, and
    // without this line the agent's only moves were to pick one -- wrong even
    // when it picks the one you meant, because it did not know -- or to give
    // up.
    //
    // Wired here rather than adopted by the panel, and that is not an
    // inconsistency with `approve`: the `ask` verb has to be in the manifest
    // from `mount()`, because `system` and `tools` are byte-identical on every
    // turn so the prompt prefix stays cached, and a verb that appeared when a
    // panel mounted would be a tool list changing underneath a running
    // conversation. So an app that may ever want to ask says so in its own
    // source. The forward reference to `panel` is the same one `approve` uses
    // above and for the same reason.
    //
    // No `askTimeout` here: the core's 45 seconds is already under the relay's
    // 60, which is what keeps "nobody answered" a fact rather than the relay's
    // "nobody knows", and somebody driving this demo by hand answers in
    // seconds.
    ask: (question) => panel.question(question),
    // CROSS-TAB STALENESS, AND WHY THIS DEMO NEEDS IT MOST. Every tab of this
    // page builds its own 3,412 contacts, so two tabs are two stores over what
    // a real app would call one backend. Accept 403 rows in one tab and the
    // other goes on showing them as `new` at a `rev` that has not moved — so
    // its snapshot reads as current, a `stale` check against it passes, and a
    // plan token minted there still verifies. That is the staleness machinery
    // saying yes in the one situation it exists to say no in.
    //
    // One line fixes the lying, not the data: a commit in the second tab is
    // refused `changed-elsewhere` and every snapshot it hands back says why.
    // An app whose tabs share a real backend would also LISTEN on this channel
    // and refetch, which is the actual fix; this demo has no backend to
    // refetch from, so it is the honest half.
    elsewhere: broadcastElsewhere(),
  },
);

const { driver, store } = app;

const host = /** @type {HTMLElement} */ (document.getElementById("screen"));
const nav = /** @type {HTMLElement} */ (document.getElementById("nav"));
const connDot = /** @type {HTMLElement} */ (document.getElementById("conn-dot"));
const connText = /** @type {HTMLElement} */ (document.getElementById("conn-text"));

// ---- the URL ------------------------------------------------------------

/**
 * Push the store's route into the address bar, if it is not already there.
 *
 * `pushState` rather than assigning `location.hash`, so the entry is added
 * without a second `hashchange` round trip, and `writingHash` covers the
 * browsers that fire one anyway. The comparison is on the formatted string,
 * which is why `href()` is total and always absolute: two routes that mean the
 * same screen must produce the same bytes or this pushes an entry per redraw.
 */
function syncHash() {
  const want = href(store.route);
  if (location.hash === want) return;
  writingHash = true;
  try {
    history.pushState(null, "", want);
  } catch {
    // A `file://` page has no session history to push onto. Falling back keeps
    // the demo usable when it is opened by double-click rather than served,
    // which is how most people's first look at it happens.
    location.hash = want;
  }
  // Cleared on a later task, not here: the `hashchange` this write may fire is
  // queued, so clearing synchronously would let it through.
  setTimeout(() => {
    writingHash = false;
  }, 0);
}

/**
 * The browser moved: Back, Forward, a pasted link, or a nav anchor clicked.
 *
 * `record: false`, because this move IS the browser's history — pushing the
 * screen we are leaving onto the app's own trail as well would make the `back`
 * verb bounce between two screens instead of walking back.
 */
function hashMoved() {
  if (writingHash) return;
  const route = parse(location.hash);
  if (same(store.route, route)) return;
  app.navigate(route, { record: false });
}

window.addEventListener("hashchange", hashMoved);
window.addEventListener("popstate", hashMoved);

/** Mark the nav item for the screen we are on, including for the two record
 *  screens, which have no nav item of their own and light up their list. */
function markNav() {
  const screen = store.route.screen;
  const owner =
    screen === "contact" ? "contacts" : screen === "company" ? "companies" : screen;
  for (const item of nav.querySelectorAll(".nav-item")) {
    if (item.dataset.screen === owner) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

// ---- first paint --------------------------------------------------------

// The URL wins on load, which is what makes a deep link a deep link:
// `#/contacts/c-0184` pasted cold opens that record rather than the dashboard
// and then jumping. `record: false` so Back from a deep link leaves the app
// rather than walking an invented trail the person never visited.
const initial = parse(location.hash);
if (!same(store.route, initial)) app.navigate(initial, { record: false });
renderScreen(app, host);
markNav();

// ---- the two ways in ----------------------------------------------------

panel = mountWidget(driver, {
  think: backendThink("/api/chat"),
  // Bring the conversation back if this page reloads, which is opt-in because
  // a library must not start writing its users' prose to disk on upgrade. The
  // demo opts in because a reload is the commonest thing anybody does to a
  // page, and because the behaviour is worth seeing: the transcript comes back
  // and the run does not restart. It is kept in `sessionStorage`, so it is per
  // tab and goes when the tab does -- the settings view has the viewer's own
  // switch beside it, which also forgets what is stored.
  rememberChat: true,
  greeting:
    "Ask me to do things in Northwind. Try: “open Grayson Robotics, how many of its " +
    "contacts are pending, then accept them”.",
  // NO `instructions` HERE, AND THAT IS THE POINT. The briefing this used to
  // carry — six screens, how to move between them, what a drill-down means,
  // how the selection behaves — is the APP talking about itself, so it now
  // lives in `MountOptions.instructions` over in `store.js`, where it reaches
  // `Manifest.instructions` and therefore both ways in: this widget's cached
  // system prompt, and an agent arriving over the relay or MCP. A copy here
  // would be visible to one of the two paths and not the other, which is the
  // gap that field was added to close — and two copies of one briefing is how
  // they drift apart.
  //
  // `WidgetOptions.instructions` has not gone away and is not the same field.
  // It is THIS HOST's voice: a house tone, a rule about this deployment,
  // whatever the embedding wants said that the app itself would not say. It is
  // folded into the system prompt AFTER the app's own, which makes it the one
  // a model follows when the two disagree. This page is the app's own page, so
  // it has nothing of its own to add.
  onError: (err) => console.error("driverkit widget:", err),
});

/**
 * The outside path, to the relay this page's own server mounted at `/dk`.
 *
 * `relay: ""` means same origin, so there is one process, one port and no
 * CORS. `watchMs` is deliberately not set: every mutation here goes through
 * the store's `bump()`, which calls `changed()`, and that is the better shape
 * — polling `visible()` is the escape hatch for a codebase too scattered to
 * instrument.
 *
 * `url` is passed explicitly with the fragment on it, because `connect`'s own
 * `urlFromPage()` reads `location.pathname` and `location.search` and drops
 * the hash. Even so it is only right once: `hello` is sent on connect and on
 * reconnect, so after the first navigation `/dk/tabs` is listing a URL this
 * tab has left. There is no frame that says "I navigated"; see the report.
 */
try {
  connection = connect(driver, {
    relay: "",
    app: "Northwind CRM",
    title: document.title,
    // No `url` passed, deliberately, and this is a fix rather than a tidy-up.
    // It used to be `${location.pathname}${location.hash}` computed HERE, once,
    // at page load — so `GET /dk/tabs` listed the route this tab had when it
    // connected and never again, which for a hash-routed app like this one is
    // the whole of what distinguishes two tabs. Left out, `connect()` reads
    // `location` on every push instead, and a person asked "which tab?" is
    // shown where each one actually is.
    onError: (err) => {
      connDot.dataset.state = "down";
      connText.textContent = "relay unreachable";
      console.error("driverkit relay:", err);
    },
  });
  connDot.dataset.state = "live";
  // Deliberately not the tab id. PROTOCOL.md: a tab id is a capability, so it
  // goes neither on the screen nor in a log.
  connText.textContent = "drivable from outside";
} catch (err) {
  connDot.dataset.state = "down";
  connText.textContent = "relay not mounted";
  console.error("driverkit relay:", err);
}

// For poking at from the console, which is how the first real run of anything
// like this actually gets debugged.
Object.assign(globalThis, { driver, store, app });
