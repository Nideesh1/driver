/**
 * Routes, as data. No DOM, no `location`, no driverkit.
 *
 * A route is `{ screen, id }` and nothing else, and the two functions below
 * convert it to and from the string after the `#`. That is the whole router.
 *
 * WHY THE HASH AND NOT `pushState`. Real paths — `/app/companies/acme` — are
 * the shape a production app wants, and they need the server to answer the
 * same HTML at every depth plus a `<base href>` so the relative imports in
 * `index.html` keep resolving. This demo's premise is a static file server and
 * no build step, so the honest version here is the fragment: one URL per
 * screen, browser back and forward for free because `hashchange` is a history
 * entry, and a deep link that works when pasted cold. What it costs is
 * written down in the report — the fragment never reaches the server, so
 * driverkit's `hello` frame, which reads `location.pathname` and deliberately
 * drops the hash, cannot see which screen the tab is on.
 *
 * Kept in its own file because both halves need it and only one of them may
 * touch a browser: `store.js` holds the route as state and must stay headless
 * so `check.mjs` can drive every screen, and `app.js` syncs it to the address
 * bar. A router that lived in `app.js` would make the drill-down screens
 * reachable only by clicking.
 *
 * @typedef {"dashboard" | "contacts" | "contact" | "companies" | "company" | "settings"} Screen
 * @typedef {{ screen: Screen, id: string | null }} Route
 */

/**
 * The screens an agent may name.
 *
 * `contact` and `company` are absent on purpose: they are record screens and
 * cannot be reached without saying WHICH record, so `go` does not offer them
 * and `open-contact`/`open-company` exist instead. This list is the `oneOf` of
 * `go`'s one argument, which is the only way an agent learns the app has more
 * than one screen before it has visited one.
 *
 * @type {readonly Screen[]}
 */
export const LANDINGS = ["dashboard", "contacts", "companies", "settings"];

/** Every screen, including the two that need an id. @type {readonly Screen[]} */
export const SCREENS = ["dashboard", "contacts", "contact", "companies", "company", "settings"];

/** The route the app opens on when the URL says nothing. @type {Route} */
export const HOME = { screen: "dashboard", id: null };

/**
 * `#/companies/acme-industrial` → `{ screen: "company", id: "acme-industrial" }`.
 *
 * Anything unrecognised becomes `HOME` rather than an error. A URL is user
 * input arriving from a paste, a stale bookmark or somebody's chat log, and a
 * router that throws on one leaves a blank page where a person expected their
 * CRM.
 *
 * @param {string} hash the fragment, with or without the leading `#`
 * @returns {Route}
 */
export function parse(hash) {
  const parts = String(hash || "")
    .replace(/^#/, "")
    .split("/")
    .filter((p) => p !== "");

  if (parts.length === 0) return { ...HOME };

  const [head, id] = parts;
  if (head === "contacts") return id ? { screen: "contact", id } : { screen: "contacts", id: null };
  if (head === "companies") return id ? { screen: "company", id } : { screen: "companies", id: null };
  if (head === "dashboard") return { screen: "dashboard", id: null };
  if (head === "settings") return { screen: "settings", id: null };
  return { ...HOME };
}

/**
 * The other direction. Always absolute and always leading with `#/`, so the
 * output can be compared to `location.hash` as a string — which is how
 * `app.js` decides whether the address bar needs moving at all, and therefore
 * how the hash sync avoids a loop with its own `hashchange` listener.
 *
 * @param {Route} route
 * @returns {string}
 */
export function href(route) {
  switch (route.screen) {
    case "contacts":
      return "#/contacts";
    case "contact":
      return `#/contacts/${route.id}`;
    case "companies":
      return "#/companies";
    case "company":
      return `#/companies/${route.id}`;
    case "settings":
      return "#/settings";
    default:
      return "#/dashboard";
  }
}

/** Two routes name the same place. @param {Route} a @param {Route} b */
export function same(a, b) {
  return a.screen === b.screen && (a.id ?? null) === (b.id ?? null);
}
