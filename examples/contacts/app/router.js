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

/**
 * The same six screens as `driverkit`'s `MountOptions.screens` wants them.
 *
 * **HERE, NEXT TO `href()`, AND NOT IN THE VERB TABLE.** The whole authoring
 * argument for `Manifest.screens` is that an app already has a route table and
 * should not be made to type a second one for the agent; declaring the map in
 * `store.js` would have been exactly that second copy, one file away from the
 * first and free to disagree with it. So the map lives in the router, which is
 * the file that already knows what a URL for each screen looks like, and
 * `check.mjs` asserts that every template in here expands to what `href()`
 * produces for the same route. In a framework app this list is generated from
 * the framework's own route table instead; see
 * `skills/driverkit/references/screens.md`.
 *
 * The templates are RFC 6570, which is what `ScreenSpec.url` documents and
 * what `goto` expands: `{id}` and not `:id`, so the same string can be handed
 * to any RFC 6570 implementation.
 *
 * ALL SIX ARE HERE, including the two that need a record. The old `go` verb
 * offered only the four landings — `LANDINGS` is its `oneOf` — because a
 * record screen cannot be reached without saying which record, and an argument
 * that is required on two of six values had nowhere to live in one `ArgSpec`.
 * `goto` takes the screen's own arguments as its own, so `contact` and
 * `company` are reachable by id and the core refuses the pair without one,
 * naming the screen that wanted it. `LANDINGS` is kept because the nav bar is
 * built from it and because it is what a person can click.
 *
 * What may NOT go in here, said where an author would be tempted: the screens
 * THIS user can reach. Six for everybody, forever. A list that narrowed by
 * role would be a per-user list in the cached half, and an agent cannot tell a
 * screen that was filtered out from a screen that does not exist.
 *
 * @type {readonly { id: Screen, describe: string, url: string, args?: Record<string, { type: "string", describe: string }> }[]}
 */
export const SCREEN_SPECS = [
  {
    id: "dashboard",
    describe: "the headline numbers: contacts by status, the pipeline, and the busiest companies. Tiles, not a table.",
    url: "#/dashboard",
  },
  {
    id: "contacts",
    describe: "every contact in the CRM, searchable, twenty rows at a time, with a selection that survives navigation.",
    url: "#/contacts",
  },
  {
    id: "contact",
    describe: "one contact: their own fields, and their activity history as rows. Needs the contact.",
    url: "#/contacts/{id}",
    args: { id: { type: "string", describe: "the contact's id, e.g. c-0184" } },
  },
  {
    id: "companies",
    describe: "the eight companies, rolled up from the contacts and sortable by any column.",
    url: "#/companies",
  },
  {
    id: "company",
    describe: "one company: its roll-up, and its contacts under a status tab that starts on pending. Needs the company.",
    url: "#/companies/{slug}",
    args: { slug: { type: "string", describe: "the company's slug, lower case and hyphenated, e.g. acme-industrial" } },
  },
  {
    id: "settings",
    describe: "the page size, the default owner and two switches. A form, not a table, and it changes both lists.",
    url: "#/settings",
  },
];

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
