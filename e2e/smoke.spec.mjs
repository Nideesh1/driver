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

/**
 * TWO REAL TABS IN ONE BROWSER, which is the only honest test of either of the
 * two multi-tab problems.
 *
 * Everything else about both of them is asserted in process against injected
 * fakes — a fake `document` for focus, an in-memory channel for the cross-tab
 * notice — and neither fake can tell you that `document.hasFocus()` answers
 * what we think it answers, or that a real `BroadcastChannel` crosses between
 * two real pages of the same origin. This does.
 *
 * The demo is the cross-tab hazard in its purest form and that is not
 * contrived: every tab of this page builds its OWN 3,412 contacts, so two tabs
 * are two stores over what a real app would call one backend. A commit in one
 * changes nothing in the other's store and does not move the other's `rev`.
 */
describe("two real tabs in one browser", () => {
  /** The second tab. `page` above is the first. */
  let other;

  const tabs = async () => (await (await fetch(`${demo.base}/dk/tabs`)).json()).tabs || [];

  /** The id `connect()` minted, read out of that tab's own `sessionStorage`.
   *  Per-tab storage is what makes two tabs two identities; see `connect()`. */
  const idOf = (p) =>
    p.evaluate(() => sessionStorage.getItem("driverkit:tab:Northwind CRM"));

  /** Poll, because `hello` rides a separate POST after the stream opens and a
   *  focus change rides a debounced push after that. Never a fixed sleep. */
  async function until(check, what, ms = 15_000) {
    const deadline = Date.now() + ms;
    let last;
    for (;;) {
      last = await tabs();
      if (check(last)) return last;
      if (Date.now() > deadline) {
        throw new Error(`${what}; /dk/tabs was ${JSON.stringify(last)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Stop Playwright pretending every page is focused.
   *
   * THIS LINE IS THE WHOLE REASON THIS TEST IS HONEST, and finding out it was
   * needed cost a wrong green. Playwright turns on Chrome's focus emulation for
   * every page it drives, so that clicking and typing work on a background tab
   * -- which means `document.hasFocus()` answers `true` in both tabs at once,
   * in headless AND in headed real Chrome. A test written without this asserts
   * that two tabs are indistinguishable by focus and passes whatever the
   * library does, including nothing.
   *
   * Turned off through CDP, the real behaviour appears: exactly one tab has
   * focus, the `focus` and `blur` events fire for real, and the answer follows
   * the person. Note that `visibilityState` stays `"visible"` in the background
   * tab regardless -- Playwright also runs Chrome with occluded-window
   * backgrounding disabled -- so the discrimination here comes entirely from
   * `hasFocus()`, which is exactly what makes `"visible"` a load-bearing third
   * state rather than a nicety.
   */
  async function realFocus(p) {
    const cdp = await context.newCDPSession(p);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  }

  before(async () => {
    other = await context.newPage();
    await other.goto(`${demo.base}${APP}#/settings`, { waitUntil: "domcontentloaded" });
    await other.waitForSelector("#screen h1", { timeout: 15_000 });
  });

  after(async () => {
    await other?.close();
  });

  test("the relay lists both tabs, and exactly one of them says `focused`", async (t) => {
    await go("#/contacts");
    // After the navigations, because a page load puts Playwright's focus
    // emulation back.
    await realFocus(page);
    await realFocus(other);

    // Playwright's own idea of which tab is in front, twice, and the first one
    // is not redundant. Turning focus emulation off changes the answer without
    // firing an event -- nothing in the page is told -- so the tabs are still
    // reporting what they reported a moment ago. Activating the other tab and
    // then this one produces the real `focus` and `blur` pair, which is what
    // the page listens for.
    await other.bringToFront();
    await page.bringToFront();

    const both = await until((rows) => rows.length === 2, "both tabs did not connect");
    const mine = await idOf(page);
    const theirs = await idOf(other);
    assert.notEqual(mine, theirs, "two tabs took one identity");
    // Both report, and what they report is one of the three strings. This much
    // holds in any browser and is the half that proves the field flows at all:
    // a real `document`, through a real `connect()`, over real SSE, into a real
    // relay's listing.
    for (const row of both) {
      assert.ok(
        ["focused", "visible", "hidden"].includes(row.focus),
        `a tab reported ${JSON.stringify(row.focus)}`,
      );
    }

    const listed = await until(
      (rows) => rows.filter((r) => r.focus === "focused").length === 1,
      "exactly one focused tab never appeared",
      4_000,
    ).catch(() => null);
    if (!listed) {
      // SKIPPED, NOT FAILED, and the reason is a property of the harness rather
      // than of the library. Playwright's bundled headless chromium ignores
      // `Emulation.setFocusEmulationEnabled: false`, so every page goes on
      // answering `document.hasFocus() === true` and the two tabs are
      // genuinely indistinguishable here. Which is, incidentally, exactly the
      // ambiguous case a client must refuse to guess in -- see `pick_tab`'s
      // fourth rule -- so the honest outcome is a question, and the honest
      // outcome for this assertion is a skip. Run it with DK_CHANNEL=chrome,
      // where it passes.
      t.skip(
        "this browser cannot be made to report real focus (both tabs say `focused`); " +
          "run with DK_CHANNEL=chrome",
      );
      return;
    }

    const front = listed.find((r) => r.focus === "focused");
    assert.equal(front.tab, mine, "the frontmost tab is not the one reporting focused");
    const back = listed.find((r) => r.tab === theirs);
    // `"visible"` and not `"hidden"`, and the difference is the third state
    // earning its place. Chrome under Playwright keeps a background page's
    // `visibilityState` at `"visible"` (occluded-window backgrounding is
    // disabled), so the only thing that tells these two tabs apart is
    // `hasFocus()` -- and a two-state field would have had to call this one
    // either focused, and send an agent to a tab nobody is looking at, or
    // hidden, which is false. NOT absent: this page reports, so silence would
    // be a different claim; see `TabFocus`.
    assert.equal(back.focus, "visible");

    // And it moves. The whole point of pushing on `visibilitychange` is that
    // the answer tracks the person rather than being whatever it was at
    // connect.
    await other.bringToFront();
    const swapped = await until(
      (rows) => rows.find((r) => r.tab === theirs)?.focus === "focused",
      "bringing the second tab to the front did not move `focus`",
    );
    assert.equal(swapped.find((r) => r.tab === mine).focus, "visible");
  });

  test("a tab's url in the listing follows its navigation, hash and all", async () => {
    // THE STALE URL. `TabInfo.url` came from `hello` alone and `hello` is sent
    // once per stream, so a hash-routed app's listing showed the route each tab
    // had at connect — forever. For this app the hash IS the route, so the one
    // field a person is shown to tell two tabs apart told them nothing.
    const mine = await idOf(page);
    await go("#/companies/acme-industrial");
    const listed = await until(
      (rows) => rows.find((r) => r.tab === mine)?.url?.endsWith("#/companies/acme-industrial"),
      "the listing never caught up with a client-side navigation",
    );
    assert.equal(
      listed.find((r) => r.tab === mine).url,
      `${APP}#/companies/acme-industrial`,
    );
    // Path-relative, never the origin: the relay knows that already, and a full
    // url in a listing is an inventory of where somebody has been.
    assert.equal(listed.find((r) => r.tab === mine).url.startsWith("http"), false);
  });

  test("a commit in one tab makes the other refuse a commit as `changed-elsewhere`", async () => {
    // THE HOLE. Before this, the second tab's snapshot reported stale rows as
    // current, a `stale` check against its unmoved `rev` passed, and a plan
    // token minted in it still verified. Here both tabs are driven from
    // OUTSIDE, through the relay, which is the path that had no gate at all.
    //
    // `set-setting` is the commit, because it is `reversible` and so is not
    // gated by the panel's dialog — this test is about the core's cross-tab
    // check and not about clicking Yes in two windows.
    await go("#/settings");
    await other.goto(`${demo.base}${APP}#/settings`, { waitUntil: "domcontentloaded" });
    await other.waitForSelector("#screen h1", { timeout: 15_000 });

    const mine = await idOf(page);
    const theirs = await idOf(other);
    await until((rows) => rows.length === 2, "both tabs did not stay connected");

    const callOn = async (tab, body) => {
      const res = await fetch(`${demo.base}/dk/tabs/${encodeURIComponent(tab)}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return await res.json();
    };

    const landed = await callOn(mine, {
      name: "set-setting",
      args: { name: "rows-per-page", value: "50" },
    });
    assert.equal(landed.ok, true, `the first tab's commit did not land: ${JSON.stringify(landed)}`);

    // Same verb, other tab. Its own `rev` has not moved — nothing happened in
    // it — so every check built out of its own `visible()` would pass.
    const refused = await callOn(theirs, {
      name: "set-setting",
      args: { name: "rows-per-page", value: "100" },
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, "changed-elsewhere");
    assert.match(refused.hint, /another tab of this app committed `set-setting`/);
    assert.match(refused.hint, /Reading this screen again will NOT fix that/);

    // AND THE FAILURE IS VISIBLE AND NOT ONLY REFUSED. The snapshot the
    // refusal carries says in words that this tab may be behind -- which is
    // what a read gets too, since every snapshot the driver hands back goes
    // through the same annotation.
    assert.match(refused.snapshot.note, /another tab of this app committed `set-setting`/);

    // Through the relay as well. `/snapshot` serves the last snapshot the tab
    // volunteered, and the refusal above was one -- so an agent that only ever
    // LOOKS at this tab is told too, without having to try a commit to find
    // out.
    const served = await (
      await fetch(`${demo.base}/dk/tabs/${encodeURIComponent(theirs)}/snapshot`)
    ).json();
    assert.match(served.note, /another tab of this app committed/);

    await shot("10-two-tabs");
  });
});
