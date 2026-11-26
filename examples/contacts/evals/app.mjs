/**
 * The app under evaluation, as the harness wants it: a factory.
 *
 * A FACTORY and not a driver, because `@driverkit/eval` builds a fresh one for
 * every single run. Sharing one would make the suite order-dependent — a
 * commit in one case changing the counts another case asserts — and the symptom
 * would be a drifting count, which is the one thing this harness reserves for
 * "somebody changed the fixture".
 *
 * No approval hook, on purpose and against the instinct. `createApp` takes one
 * and the page passes the chat panel's dialog; a gate here would veto exactly
 * the calls the eval exists to count, and report zero false commits forever
 * while the verb list that invites them stayed broken. The fixture is 3,412
 * rows in memory and is thrown away after each run, so letting the dangerous
 * call through costs nothing and is the only way to see it.
 */

import { createApp } from "../app/store.js";

export function newDriver() {
  return createApp().driver;
}
