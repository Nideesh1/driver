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
 * @typedef {{ id: string, name: string, company: string, status: Status, owner: string,
 *   title: string, email: string, added: string, value: number }} Contact
 * @typedef {{ id: string, name: string, tier: string, region: string, lead: string,
 *   contacts: number, new: number, pending: number, accepted: number, declined: number,
 *   value: number }} Company
 * @typedef {{ id: string, when: string, what: string, who: string }} Event
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

/**
 * The five sales owners.
 *
 * Exported for the same reason `COMPANIES` is: `assign-owner` declares it as
 * the `oneOf` of its `owner` argument, and a closed list an agent is shown is
 * a list it cannot get wrong.
 *
 * @type {readonly string[]}
 */
export const OWNERS = ["R. Okafor", "S. Lindgren", "M. Barros", "T. Nasser", "J. Whitfield"];

/** Job titles, picked by a hash of the contact id rather than by the table's
 *  own rng — see `hash()`. */
const TITLES = [
  "Buyer", "Head of Procurement", "Facilities Lead", "Operations Manager",
  "Clinical Director", "Plant Supervisor", "Finance Partner", "IT Lead",
];

/** One line of company colour each, positional against `COMPANIES`. Fixed
 *  rather than generated: eight rows is a table a person reads, and a seeded
 *  "Tier B / EMEA" is no more informative than a typed one. */
const COMPANY_FACTS = [
  { tier: "Enterprise", region: "Midwest", lead: "R. Okafor" },
  { tier: "Enterprise", region: "Northeast", lead: "S. Lindgren" },
  { tier: "Mid-market", region: "Gulf", lead: "M. Barros" },
  { tier: "Mid-market", region: "West", lead: "T. Nasser" },
  { tier: "Enterprise", region: "Northeast", lead: "J. Whitfield" },
  { tier: "SMB", region: "Southeast", lead: "R. Okafor" },
  { tier: "Mid-market", region: "West", lead: "S. Lindgren" },
  { tier: "SMB", region: "Midwest", lead: "M. Barros" },
];

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
    const row = {
      id: `c-${String(i).padStart(4, "0")}`,
      name: `${first} ${last}`,
      company,
      status,
      owner: OWNERS[Math.floor(rand() * OWNERS.length)],
    };
    // After the draws, never between them. `details` reads the row and hashes
    // its id; it does not touch `rand`, so the company and status counts are
    // the same numbers they were when this file had one screen to serve.
    rows.push({ ...row, ...details(row, i) });
  }
  return rows;
}

/**
 * A company's id: the name, lowercased and hyphenated.
 *
 * The drill-down's identity has to survive a URL and a JSON argument, and a
 * name with a space in it survives neither comfortably. `Row.id` is a string
 * and this is the string.
 *
 * @param {string} name
 * @returns {string}
 */
export function companySlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The company name a slug stands for, or undefined. @param {string} slug */
export function companyFromSlug(slug) {
  return COMPANIES.find((c) => companySlug(c) === slug);
}

/**
 * FNV-1a over a string.
 *
 * Here so the fields added after the first version of this file — title,
 * email, deal value, activity history — can be derived from a contact's id
 * WITHOUT drawing from `buildContacts`'s rng. One extra `rand()` per row would
 * have shifted every draw after it, and the company and status counts quoted
 * in the README and asserted against by `check.mjs` would all have moved. A
 * reproducible count is only worth having if it stays the same number when the
 * demo grows a second screen.
 *
 * @param {string} text
 * @returns {number}
 */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** A date `days` after 2024-01-01, as `YYYY-MM-DD`. @param {number} days */
function dayStamp(days) {
  const ms = Date.UTC(2024, 0, 1) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The fields the record screen shows and the table does not.
 *
 * Called by `buildContacts` after the row's rng draws are done, so it can only
 * read the row and not the generator. See `hash`.
 *
 * @param {{ id: string, name: string, company: string }} row
 * @param {number} index 1-based
 */
function details(row, index) {
  const h = hash(row.id);
  const [first, last] = row.name.split(" ");
  return {
    title: TITLES[h % TITLES.length],
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${companySlug(row.company)}.example`,
    added: dayStamp((index * 7) % 640),
    value: 2500 + ((h >>> 8) % 48) * 500,
  };
}

/**
 * The eight companies, with their contact counts rolled up.
 *
 * Derived from the contacts rather than generated beside them, which is the
 * only way the companies list and the contacts table can agree. A company row
 * that said 431 while the table held 430 would make every count on the
 * companies screen unusable for the thing counts are for.
 *
 * @param {Contact[]} contacts
 * @returns {Company[]}
 */
export function buildCompanies(contacts) {
  /** @type {Map<string, Company>} */
  const byName = new Map();
  COMPANIES.forEach((name, i) => {
    byName.set(name, {
      id: companySlug(name),
      name,
      ...COMPANY_FACTS[i],
      contacts: 0,
      new: 0,
      pending: 0,
      accepted: 0,
      declined: 0,
      value: 0,
    });
  });
  for (const row of contacts) {
    const company = byName.get(row.company);
    if (!company) continue;
    company.contacts += 1;
    company[row.status] += 1;
    if (row.status !== "declined") company.value += row.value;
  }
  return [...byName.values()];
}

const DEEDS = [
  "added from the trade-show list",
  "first call, left a voicemail",
  "sent the standard pricing sheet",
  "replied asking about lead times",
  "moved to pending by the owner",
  "quote revised after a procurement review",
  "forwarded to the regional lead",
  "marked for the quarterly follow-up",
];

/**
 * One contact's activity history: three to six events, oldest first.
 *
 * Seeded from the id and from nothing else, so a deep link straight to
 * `#/contacts/c-0184` shows the same history as clicking through to it, and
 * so the history does not depend on whether the table was built first. The
 * record screen needs rows of its own — a record with no history is a screen
 * with four fields on it, which proves nothing about drilling down.
 *
 * @param {string} contactId
 * @returns {Event[]}
 */
export function historyFor(contactId) {
  const rand = rng(hash(`history:${contactId}`));
  const count = 3 + Math.floor(rand() * 4);
  /** @type {Event[]} */
  const out = [];
  let day = Math.floor(rand() * 300);
  for (let i = 0; i < count; i++) {
    day += 3 + Math.floor(rand() * 40);
    out.push({
      id: `${contactId}-e${i + 1}`,
      when: dayStamp(day),
      what: DEEDS[Math.floor(rand() * DEEDS.length)],
      who: OWNERS[Math.floor(rand() * OWNERS.length)],
    });
  }
  return out;
}
