/**
 * The contacts table: 3,412 rows, generated the same way every time.
 *
 * Seeded rather than random on purpose. A `describe` verb's whole job is to
 * report a count before anything irreversible runs, and a count is only worth
 * reading if it is reproducible — "select-where company=Acme Industrial
 * matched 431" has to mean the same thing on your machine as on mine, or there
 * is nothing to check a bug report against.
 *
 * Plain `.js` with JSDoc, not TypeScript: this file is served to the browser
 * as-is. The library's own `.ts` sources go through the server's type-stripper;
 * the demo's code needs no such thing and should not pretend to.
 *
 * @typedef {"new" | "pending" | "accepted" | "declined"} Status
 * @typedef {{ id: string, name: string, company: string, status: Status, owner: string }} Contact
 */

/** How many rows. Quoted in the README and in the app's subtitle. */
export const TOTAL = 3412;

/**
 * The companies, as a closed list.
 *
 * Exported because `select-where` declares it as the `oneOf` of its `company`
 * argument, and that is the point of the list being short. A model cannot
 * guess a value set it has not been shown: handed a freeform predicate it
 * invents a query language, and handed `oneOf` it picks a member.
 *
 * @type {readonly string[]}
 */
export const COMPANIES = [
  "Acme Industrial",
  "Berenson Health",
  "Cordova Logistics",
  "Delacroix Media",
  "Everline Capital",
  "Fairmont Dental",
  "Grayson Robotics",
  "Halloway Foods",
];

/** @type {readonly Status[]} */
export const STATUSES = ["new", "pending", "accepted", "declined"];

const FIRST = [
  "Ada", "Bruno", "Clara", "Dmitri", "Elena", "Farid", "Greta", "Hugo",
  "Imani", "Jonas", "Keiko", "Luca", "Mira", "Noor", "Oskar", "Priya",
  "Quentin", "Rosa", "Soren", "Tamar", "Ulric", "Vera", "Wes", "Xiomara",
  "Yusuf", "Zane", "Beatriz", "Caleb", "Dorotea", "Emil",
];

const LAST = [
  "Alvarez", "Bauer", "Castellan", "Duarte", "Eriksen", "Fontaine", "Gallo",
  "Hartley", "Ibarra", "Jorgensen", "Kovac", "Lindqvist", "Moreau", "Nakamura",
  "Oyelaran", "Petrov", "Quintero", "Rosales", "Strand", "Tanaka", "Ustinov",
  "Varga", "Whitlock", "Xu", "Yamada", "Zabala", "Benedetti", "Cho",
  "Delgado", "Ferreira", "Grunwald", "Haddad",
];

const OWNERS = ["R. Okafor", "S. Lindgren", "M. Barros", "T. Nasser", "J. Whitfield"];

/**
 * mulberry32. Thirty-two bits of state, no dependencies, identical output in
 * every JavaScript engine — which is the only property being asked of it.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the table.
 *
 * Statuses are weighted rather than uniform, so the counts a `describe` verb
 * reports look like a real pipeline — most rows new, a few already decided —
 * and a bulk accept has something to be a bad idea about.
 *
 * @returns {Contact[]}
 */
export function buildContacts() {
  const rand = rng(0x5eed1e);
  /** @type {Contact[]} */
  const rows = [];
  for (let i = 1; i <= TOTAL; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    const company = COMPANIES[Math.floor(rand() * COMPANIES.length)];
    const roll = rand();
    /** @type {Status} */
    const status =
      roll < 0.56 ? "new" : roll < 0.78 ? "pending" : roll < 0.92 ? "accepted" : "declined";
    rows.push({
      id: `c-${String(i).padStart(4, "0")}`,
      name: `${first} ${last}`,
      company,
      status,
      owner: OWNERS[Math.floor(rand() * OWNERS.length)],
    });
  }
  return rows;
}
