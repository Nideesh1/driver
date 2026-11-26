/**
 * The demo, in a real browser.
 *
 *     node --test e2e/smoke.spec.mjs
 *
 * Everything else in this repository asserts against a hand-rolled fake DOM
 * (`packages/driverkit/test/fake-dom.ts`), which is the right tool for the
 * widget's logic and tells you nothing about whether the thing renders. This
 * file is the other half: one real Chrome, the real `index.html`, the real
 * stylesheet, the real shadow root, and assertions that only a browser can
 * make -- a box that is 96 by 40, a panel that a pointer can drag, a
 * transcript that survives being minimised.
 *
 * THE ONE TRAP, and it cost an afternoon: never `waitUntil: "networkidle"`.
 * `connect()` holds an SSE stream to the relay open for as long as the page is
 * open, so the network NEVER idles and every navigation times out after 30
 * seconds with nothing wrong. Use `domcontentloaded` (the default here) and
 * then wait on an element. Every `goto` below does.
 *
 * ENVIRONMENT
 *
 *   DK_BASE        drive the server already listening there instead of
 *                  starting one. CI sets it; so can you, if a demo is up.
 *   DK_PLAYWRIGHT  import specifier or absolute path for `playwright`, for
 *                  running against an install that is not this repo's.
 *   DK_CHANNEL     browser channel. Default: the bundled chromium if
 *                  `playwright install` has been run, else real Chrome.
 *   DK_E2E_CHAT    set to a non-empty value to also run the test that needs a
 *                  model behind `/api/chat`. Without it that one test skips,
 *                  because a missing key is not a regression.
 *   DK_HEADED      set to watch it.
 *   DK_E2E_OUT     where screenshots go. Default `e2e/artifacts`.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startDemo } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.DK_E2E_OUT || path.join(HERE, "artifacts");
const APP = "/examples/contacts/app/";

/** The widget's own constants, restated here so the test can disagree with the code. */
const LAUNCHER = { w: 96, h: 40 };
const GRIP = "⠿";
const GEAR = "⚙";
const MINUS = "−";

let demo;
let browser;
let context;
let page;
/** Console messages of type `error`, in order, with the phase they arrived in. */
let consoleErrors = [];
let pageErrors = [];

/**
 * `playwright`, from wherever it is.
 *
 * Resolved at runtime rather than imported at the top so that `node --test`
 * over the whole directory reports "playwright is not installed" as one clear
 * failure instead of an unhandled module-resolution error.
 */
async function loadPlaywright() {
  const spec = process.env.DK_PLAYWRIGHT || "playwright";
  try {
    return await import(spec);
  } catch (err) {
    throw new Error(
      `cannot import playwright (${spec}): ${err.message}\n` +
        `Install it: npm i -D playwright && npx playwright install chromium\n` +
        `Or point DK_PLAYWRIGHT at an existing install's index.mjs.`,
    );
  }
}

/**
 * Launch a browser that exists.
 *
 * `playwright install` downloads a chromium; a developer machine often has
 * none and a real Chrome instead. Try the download first (CI, where the
 * workflow runs `playwright install --with-deps chromium`) and fall back to
 * the installed Chrome, so the same command works in both places.
 */
async function launch(chromium) {
  const headless = !process.env.DK_HEADED;
  const forced = process.env.DK_CHANNEL;
  if (forced) return await chromium.launch({ headless, channel: forced });
  try {
    return await chromium.launch({ headless });
  } catch (bundled) {
    try {
      return await chromium.launch({ headless, channel: "chrome" });
    } catch (chrome) {
      throw new Error(
        `no browser to run in.\n  bundled chromium: ${bundled.message}\n  chrome channel: ${chrome.message}`,
      );
    }
  }
}

/** Navigate, then wait for the screen to have been drawn. Never networkidle. */
async function go(hash) {
  await page.goto(`${demo.base}${APP}${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#screen h1", { timeout: 15_000 });
}

/**
 * Open the panel, whether or not it is already open.
 *
 * Open/minimised is remembered per viewer, so it survives a navigation -- and
 * `.dk-open .dk-launcher { display: none }` means a blind click on the
 * launcher waits 30 seconds for an element that is deliberately hidden. Which
 * is worth knowing: it is also what a second visit looks like to a person.
 */
async function openPanel() {
  const panel = page.locator(".dk-panel");
  if (await panel.isVisible()) return;
  await page.locator(".dk-launcher").click();
  await panel.waitFor({ state: "visible" });
}

async function shot(name) {
  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

before(async () => {
  const { chromium } = await loadPlaywright();
  demo = await startDemo();
  browser = await launch(chromium);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
});

after(async () => {
  await context?.close();
  await browser?.close();
  await demo?.stop();
});

describe("the demo renders in a real browser", () => {
  test("loads with no console errors and no uncaught exceptions", async () => {
    await go("#/dashboard");
    // The relay connection is what makes this worth asserting: a bad SSE URL,
    // a module that 404s or an import map that does not resolve all show up
    // here and nowhere in the unit tests.
    await page.waitForSelector(".dk-launcher", { timeout: 15_000 });
    assert.deepEqual(pageErrors, [], "uncaught exceptions on load");
    assert.deepEqual(consoleErrors, [], "console errors on load");
    await shot("01-dashboard");
  });

  test("the launcher is a 96x40 pill labelled Ask", async () => {
    const launcher = page.locator(".dk-launcher");
    await launcher.waitFor();
    const box = await launcher.boundingBox();
    assert.equal(Math.round(box.width), LAUNCHER.w, "launcher width");
    assert.equal(Math.round(box.height), LAUNCHER.h, "launcher height");
    // The pill's own word, which is deliberately not the panel's title. The
    // dot inside it is `aria-hidden` and carries no text, so the pill's text
    // is exactly the label.
    assert.equal((await launcher.innerText()).trim(), "Ask");
  });

  test("the panel header is the grip, the gear and a minus, titled Assistant", async () => {
    await openPanel();
    const glyphs = await page.locator(".dk-head button").allInnerTexts();
    assert.deepEqual(
      glyphs.map((g) => g.trim()),
      [GRIP, GEAR, MINUS],
      "header controls, in order",
    );
    assert.equal((await page.locator(".dk-title").innerText()).trim(), "Assistant");
    await shot("02-panel-open");
  });
});

describe("the screens", () => {
  test("#/contacts renders a twenty-row window", async () => {
    await go("#/contacts");
    assert.equal(await page.locator("#rows tr").count(), 20);
  });

  test("#/companies renders eight rows", async () => {
    await go("#/companies");
    assert.equal(await page.locator("#screen table.table tbody tr").count(), 8);
    await shot("03-companies");
  });

  test("a deep link straight to #/contacts/c-0184 renders that record", async () => {
    await go("#/contacts/c-0184");
    const h1 = (await page.locator("#screen h1").innerText()).trim();
    // "Contact" is the heading of the NOT-FOUND screen, so anything else is a
    // record. The id itself appears in the breadcrumb and in the field list.
    assert.notEqual(h1, "Contact", "deep link fell through to the not-found screen");
    assert.ok(h1.length > 0, "record screen has no title");
    const body = await page.locator("#screen").innerText();
    assert.match(body, /c-0184/);
    await shot("04-deep-link");
  });
});

describe("the panel, behaviour nothing else checks", () => {
  test("minimising keeps the transcript", async () => {
    await go("#/contacts");
    await openPanel();

    await page.locator(".dk-input").fill("count the pending contacts");
    await page.locator(".dk-send").click();
    // The person's own line is appended at submit, before the model is asked,
    // so this works with or without a key. Stop the run straight away: what is
    // under test is the transcript surviving, not a model answering.
    await page.waitForSelector(".dk-you", { timeout: 10_000 });
    const said = (await page.locator(".dk-you").first().innerText()).trim();
    await page.locator(".dk-stop").click().catch(() => {});

    await page.locator(".dk-min").click();
    await page.waitForSelector(".dk-launcher", { state: "visible" });
    await page.waitForSelector(".dk-panel", { state: "hidden" });

    await page.locator(".dk-launcher").click();
    await page.waitForSelector(".dk-panel", { state: "visible" });
    assert.equal(await page.locator(".dk-you").count(), 1, "the transcript was thrown away");
    assert.equal((await page.locator(".dk-you").first().innerText()).trim(), said);
    await shot("05-transcript-kept");
  });

  test("the grip drags the panel and the gear does not", async () => {
    const panel = page.locator(".dk-panel");
    await openPanel();

    const drag = async (selector, dx, dy) => {
      const from = await page.locator(selector).boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      // Two moves, not one: the drag has a 4px slop below which nothing moves
      // at all, and a single jump from inside the slop to the destination is
      // indistinguishable from a click that the browser coalesced.
      await page.mouse.move(from.x + from.width / 2 + dx / 2, from.y + from.height / 2 + dy / 2, {
        steps: 8,
      });
      await page.mouse.move(from.x + from.width / 2 + dx, from.y + from.height / 2 + dy, {
        steps: 8,
      });
      await page.mouse.up();
      await page.waitForTimeout(400); // the snap animation
    };

    const before = await panel.boundingBox();
    // Far enough that the nearest corner changes, so the snap cannot put the
    // panel back where it started and call the test passed.
    await drag(".dk-move", -700, -500);
    const afterGrip = await panel.boundingBox();
    assert.ok(
      Math.hypot(afterGrip.x - before.x, afterGrip.y - before.y) > 100,
      `the grip did not move the panel (${JSON.stringify(before)} -> ${JSON.stringify(afterGrip)})`,
    );
    await shot("06-dragged-by-grip");

    // The gear is not a drag surface: `position.handle()` is attached to the
    // grip and the launcher, and to nothing else in the header. An imprecise
    // press near a button must not pick the panel up.
    await drag(".dk-gear", 300, 200);
    const afterGear = await panel.boundingBox();
    assert.ok(
      Math.hypot(afterGear.x - afterGrip.x, afterGear.y - afterGrip.y) < 2,
      `the gear moved the panel (${JSON.stringify(afterGrip)} -> ${JSON.stringify(afterGear)})`,
    );
  });

  test("the settings view opens, and Clear conversation empties the transcript", async () => {
    // The drag above pressed the gear, which also toggles the settings view.
    // Get back to a known state rather than assuming which way it left it.
    if (await page.locator(".dk-settings").isVisible()) await page.locator(".dk-done").click();
    await page.waitForSelector(".dk-settings", { state: "hidden" });
    assert.equal(await page.locator(".dk-you").count(), 1, "lost the transcript before clearing");

    await page.locator(".dk-gear").click();
    await page.waitForSelector(".dk-settings", { state: "visible" });
    assert.equal(await page.locator(".dk-gear").getAttribute("aria-expanded"), "true");
    // The settings view replaces the log and the form while it is open.
    await page.waitForSelector(".dk-log", { state: "hidden" });
    const clear = page.locator(".dk-clear");
    assert.equal((await clear.innerText()).trim(), "Clear conversation");
    await shot("07-settings");

    await clear.click();
    // Clearing leaves the settings view by itself: the thing the person just
    // acted on is the conversation, and that is not the view they are looking
    // at. So no "Done" here -- waiting for one is a 30 second timeout.
    await page.waitForSelector(".dk-settings", { state: "hidden" });
    await page.waitForSelector(".dk-log", { state: "visible" });
    assert.equal(await page.locator(".dk-gear").getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".dk-you").count(), 0, "Clear conversation kept the transcript");
    // A cleared panel is a FRESH panel, not an empty one: the greeting is put
    // back, which is the one line that is allowed to survive.
    assert.equal(await page.locator(".dk-log .dk-note").count(), 1);
    await shot("08-cleared");
  });
});

describe("a verb end to end", () => {
  // Needs a model behind `/api/chat`, so it is opt-in. Skipped without
  // DK_E2E_CHAT rather than failed: CI has no key, and a missing key is not a
  // regression in driverkit.
  test(
    "the agent runs a verb and the step lands in the transcript",
    { skip: process.env.DK_E2E_CHAT ? false : "set DK_E2E_CHAT (and have a key behind /api/chat)" },
    async () => {
      await go("#/contacts");
      await openPanel();
      await page.locator(".dk-input").fill("search for Acme");
      await page.locator(".dk-send").click();
      // One step, in whatever state it ends in: the assertion is that the loop
      // reached the app at all, not that a model chose well.
      await page.waitForSelector(".dk-step", { timeout: 120_000 });
      await page.waitForSelector(".dk-step-done, .dk-step-failed", { timeout: 120_000 });
      await shot("09-verb-ran");
    },
  );
});
