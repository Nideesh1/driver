/**
 * `newDriver()` — what the eval CLI asks a suite for.
 *
 * A FRESH driver over FRESH data on every call, which is the contract: a case
 * that casts a verdict must not leave it behind for the next case. The fixture
 * builds its own Maps per call, so `newDriver()` is literally that.
 *
 * The screen is faked rather than read from a DOM: there is no browser here,
 * and `screenNow` is the one thing `mountFactory` needs a page for. It starts
 * on the dashboard and `goto` moves it, which is enough for `Verb.screen`,
 * `wrong-screen` and the two piece verbs to behave as they would in the page.
 */
import { mountFactory } from "../src/mount.ts";
import { fixturePort } from "./fixture.ts";

export function newDriver() {
  let screen = "dashboard";
  const { driver } = mountFactory({
    port: fixturePort(),
    // Nobody is at the keyboard in an eval, and the gate has to be declared
    // rather than defaulted. `"unattended"` is the deliberate unsafe case and
    // it is correct here: the whole point of a case is to see which commits a
    // model reaches for.
    approve: "unattended",
    screenNow: () => screen,
    whereNow: () => `the ${screen} screen`,
    go: (path) => {
      const parts = path.replace(/^\/app\/?/, "").split("/").filter(Boolean);
      // A deliberately crude stand-in for FACTORY's own `parse()`: enough to
      // move `Snapshot.screen` for the screens these cases visit.
      screen =
        parts.length === 0 ? "dashboard"
        : parts[0] === "templates" && parts[1] === "pieces" && parts.length === 2 ? "pieces"
        : parts[0] === "templates" && parts[1] === "pieces" ? "piece"
        : parts[0] === "templates" && parts[1] === "all" ? "templates-all"
        : parts[0] === "templates" && parts.length === 1 ? "templates"
        : parts[0] === "iterations" && parts[2] === "findings" ? "iteration-findings"
        : parts[0] === "iterations" && parts[2] === "edit" ? "iteration-edit"
        : parts[0] === "iterations" && parts.length === 2 ? "iteration"
        : parts[0] === "iterations" ? "iterations"
        : parts[0] === "findings" && parts.length > 1 ? "finding"
        : parts[0] ?? "dashboard";
    },
  });
  return driver;
}
