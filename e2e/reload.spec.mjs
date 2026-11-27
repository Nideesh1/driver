/**
 * Surviving a reload, in a real browser. The other half of `reload.test.ts`.
 *
 * The unit suite drives a hand-rolled fake DOM, and a reload is the one thing
 * it cannot honestly simulate: it fakes the page going away by dropping the
 * widget and mounting another against the same storage, which is the right
 * model and is still a model. What it cannot tell you is whether
 * `sessionStorage` is really reachable from inside a shadow root on a page the
 * library does not own, whether a real `location.reload()` leaves the record
 * behind, or whether the restored notice renders where somebody can read it.
 *
 * ## The one trap
 *
 * Never `waitUntil: "networkidle"`. `connect()` holds an SSE stream to the
 * relay open for the life of the page, so the network never idles and every
 * wait times out. `domcontentloaded`, every time.
 *
 * ## What is faked, and why that is the honest line
 *
 * The record is SEEDED rather than produced by a real run, because a real run
 * needs a model behind `/api/chat` and a missing key is not a regression — the
 * same reason `smoke.spec.mjs` skips its one chat test. What is under test here
 * is the restore: the words the panel says, that it does not resume, and that a
 * clear really is destructive across a reload. The producing half — that a call
 * in flight is written down as `sent` while it is in flight — is unit-tested,
 * where a verb can be made to hang on purpose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { startDemo } from "./server.mjs";

const APP = "Northwind CRM";
const KEY = `driverkit:widget:chat:${APP}`;

/** A conversation as the widget would have written it, with `accept-selected`
 *  in flight. Five steps in, 3,412 rows, and the page dies. */
const MID_COMMIT = {
  v: 1,
  app: APP,
  at: Date.now(),
  conversed: true,
  inFlight: { verb: "accept-selected", phase: "sent" },
  messages: [
    { role: "user", text: "accept the pending Grayson Robotics contacts" },
    { role: "assistant", text: "There are 3,412. Accepting them now." },
    { role: "assistant", calls: [{ id: "c1", name: "accept-selected", args: {} }] },
  ],
};

test("a reload mid-commit, in a real browser", async (t) => {
  const demo = await startDemo();
  t.after(() => demo.stop());
  // `channel: "chrome"` is the house pattern: the real browser somebody has,
  // not a download this test would otherwise require.
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const url = `${demo.base}/examples/contacts/app/`;

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#screen h1", { timeout: 15_000 });

  // Seeded through the page's own `sessionStorage`, which is also the
  // assertion that the widget is reading the per-tab store and not
  // `localStorage` -- a widget that read the wrong one would restore nothing
  // here and the test would fail with an empty panel.
  await page.evaluate(
    ([key, record]) => sessionStorage.setItem(key, record),
    [KEY, JSON.stringify(MID_COMMIT)],
  );

  // The reload. A real one, which is the whole point of doing this in a
  // browser: nothing runs `unmount`, so the record has to have been complete
  // before the page went away.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#screen h1", { timeout: 15_000 });

  // Open the panel and read what it says. `.dk-launcher` is in the shadow
  // root; Playwright pierces it, which is why these selectors are bare.
  await page.click(".dk-launcher");
  const log = await page.locator(".dk-log").innerText();

  await t.test("the panel names the verb and says it cannot tell", () => {
    assert.match(log, /The page reloaded while `accept-selected` was running\./);
    assert.match(log, /cannot tell whether it took effect/);
    assert.match(log, /Check the app before doing anything else\./);
  });

  await t.test("nothing is resumed, and the panel says so", async () => {
    assert.match(log, /Nothing has been resumed/);
    // Not busy: a restored panel is idle, and `dk-busy` is the class that says
    // a run is in flight. A panel that came back busy would be one that had
    // resumed, which is the thing this whole design refuses to do.
    assert.equal(await page.locator(".dk-wrap.dk-busy").count(), 0);
  });

  await t.test("the conversation itself came back", () => {
    assert.match(log, /accept the pending Grayson Robotics contacts/);
    assert.match(log, /There are 3,412\./);
  });

  await t.test("a cleared conversation does not come back from a reload", async () => {
    await page.click(".dk-gear");
    await page.click(".dk-clear");
    // Cleared all the way down: the record is gone from storage before the
    // page is, which is the only ordering that survives a reload.
    assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), KEY), "");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen h1", { timeout: 15_000 });
    await page.click(".dk-launcher");
    const after = await page.locator(".dk-log").innerText();
    assert.doesNotMatch(after, /Grayson Robotics contacts/);
    assert.doesNotMatch(after, /accept-selected/);
    assert.doesNotMatch(after, /from before the reload/);
    // And the greeting is what a fresh panel shows.
    assert.match(after, /Ask me to do things in Northwind/);
  });

  await t.test("the viewer's switch forgets it, and it is beside the others", async () => {
    await page.evaluate(
      ([key, record]) => sessionStorage.setItem(key, record),
      [KEY, JSON.stringify(MID_COMMIT)],
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#screen h1", { timeout: 15_000 });
    await page.click(".dk-launcher");
    assert.match(await page.locator(".dk-log").innerText(), /was running/);

    await page.click(".dk-gear");
    assert.equal(await page.locator(".dk-t-remember").count(), 1, "the switch is not in the settings view");
    await page.click(".dk-t-remember");
    assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), KEY), "");
  });
});
