/**
 * The specification for deriving `rev` from the DOM. The decisions pinned here
 * are all versions of one question -- when in doubt, bump or not? -- and the
 * answer is always bump. A false `stale` costs one round trip; a missed change
 * costs a commit against a row the agent never saw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { revFromMutations } from "../src/index.ts";
import {
  attributeChange,
  childListChange,
  FakeDocument,
  FakeMutationObserver,
  FakeTimers,
  html,
  textChange,
} from "./fake-dom.ts";

function watcher(opts: Record<string, unknown> = {}) {
  const timers = new FakeTimers();
  const bumps: number[] = [];
  const target = html(`<table><tbody><tr><td>INV-1</td></tr></tbody></table>`);
  const handle = revFromMutations(target, {
    MutationObserver: FakeMutationObserver,
    timers,
    onBump: (rev) => bumps.push(rev),
    ...opts,
  });
  return { handle, timers, bumps, observer: FakeMutationObserver.last(), target };
}

test("rev starts at a positive integer", () => {
  // Not zero. Zero is falsy and gets `if (rev)`-tested out of existence
  // somewhere between here and the wire, and the symptom is a staleness check
  // that quietly stops running.
  const { handle } = watcher();

  assert.equal(handle.rev(), 1);
  assert.equal(Number.isInteger(handle.rev()), true);
});

test("a burst of mutations in one render is one bump, not five", () => {
  // A React commit, a jQuery .html() or a grid re-render arrives as dozens of
  // records in several batches. Bumping per record does not make staleness
  // stricter -- it makes a well-behaved agent retry five times for one change.
  const { handle, timers, bumps, observer } = watcher({ debounceMs: 50 });

  observer.emit(childListChange, childListChange);
  observer.emit(textChange);
  observer.emit(childListChange);
  assert.deepEqual(bumps, []);

  timers.advance(50);

  assert.deepEqual(bumps, [2]);
  assert.equal(handle.rev(), 2);
});

test("the debounce window is not reset by later mutations", () => {
  // A trailing debounce is the usual choice and is wrong here: a live clock, a
  // spinner or an animating chart would reset the timer forever and `rev`
  // would never move. A frozen `rev` refuses nothing, which is the missed-
  // change failure arrived at by being careful. One bump per window, always.
  const { timers, bumps, observer } = watcher({ debounceMs: 50 });

  observer.emit(childListChange);
  timers.advance(40);
  observer.emit(childListChange);
  timers.advance(40); // 80ms since the first change: the window has closed

  assert.deepEqual(bumps, [2]);
});

test("reading rev flushes a pending bump, so a caller is never handed a number that is already wrong", () => {
  // The dangerous direction is subtle. If `rev()` answered 1 while a bump sat
  // in the timer, the snapshot would carry 1, the agent would echo 1 back, and
  // the call would be ACCEPTED because both sides agree -- on a number that
  // was already stale when it was issued. Coalescing survives (one burst is
  // still one bump); the window where `rev` is knowingly behind does not.
  const { handle, timers, observer } = watcher({ debounceMs: 50 });

  observer.emit(childListChange);

  assert.equal(handle.rev(), 2);
  timers.advance(50);
  assert.equal(handle.rev(), 2, "the timer must not bump a second time for the same burst");
});

test("rev only ever increases", () => {
  const { handle, timers, observer } = watcher({ debounceMs: 10 });
  const seen = [handle.rev()];

  for (const batch of [[childListChange], [textChange], [attributeChange("data-state")]]) {
    observer.emit(...batch);
    timers.advance(10);
    seen.push(handle.rev());
  }
  seen.push(handle.rev(), handle.rev());

  assert.deepEqual(seen, [1, 2, 3, 4, 4, 4]);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! >= seen[i - 1]!);
});

test("attribute churn on an ignorable attribute does not bump rev", () => {
  // Hover and focus rewrite `class` and `style` constantly. These cannot carry
  // anything `rowsFromTable` reads, so ignoring them is the one place where
  // not bumping is safe.
  const { handle, timers, bumps, observer } = watcher();

  observer.emit(attributeChange("class"), attributeChange("style"), attributeChange("tabindex"));
  timers.advance(100);

  assert.deepEqual(bumps, []);
  assert.equal(handle.rev(), 1);
});

test("an attribute not on the ignore list bumps: the default is to err toward stale", () => {
  const { handle, timers, observer } = watcher();

  observer.emit(attributeChange("data-dk-total"));
  timers.advance(100);

  assert.equal(handle.rev(), 2);
});

test("the ignore list replaces the default rather than adding to it", () => {
  // An app that encodes selection in a class and reads it back in `visible()`
  // must NOT ignore `class`, so the set in force has to be visible at the call
  // site rather than merged with a default the caller cannot see.
  const { handle, timers, observer } = watcher({ ignoreAttributes: ["data-tooltip"] });

  observer.emit(attributeChange("class"));
  timers.advance(100);
  assert.equal(handle.rev(), 2, "class is no longer ignored once the list is replaced");

  observer.emit(attributeChange("data-tooltip"));
  timers.advance(100);
  assert.equal(handle.rev(), 2);
});

test("childList and characterData count whatever the ignore list says", () => {
  // Nodes coming or going, and text rewritten in place, are exactly what
  // `rowsFromTable` reads. No inspection of the record can rule out that it
  // mattered, so the ignore list does not get a vote.
  const { handle, timers, observer } = watcher({ ignoreAttributes: ["childList", "characterData"] });

  observer.emit(childListChange);
  timers.advance(100);
  observer.emit(textChange);
  timers.advance(100);

  assert.equal(handle.rev(), 3);
});

test("an attribute record with no name counts", () => {
  // Unnameable is unjudgeable. Erring toward a bump.
  const { handle, timers, observer } = watcher();

  observer.emit({ type: "attributes", attributeName: null });
  timers.advance(100);

  assert.equal(handle.rev(), 2);
});

test("a batch containing one interesting record bumps, however much noise is around it", () => {
  const { handle, timers, observer } = watcher();

  observer.emit(attributeChange("class"), attributeChange("style"), childListChange);
  timers.advance(100);

  assert.equal(handle.rev(), 2);
});

test("bump() lets an app count a change the DOM cannot show", () => {
  // A store write, a fetch landing, a filter applied to data that renders
  // identically. Mixing a real signal with this one has to be possible, or an
  // app with a half-decent counter has to choose between them.
  const { handle, bumps } = watcher();

  handle.bump();

  assert.equal(handle.rev(), 2);
  assert.deepEqual(bumps, [2]);
});

test("stop() disconnects and freezes rev", () => {
  // Frozen is the truthful answer once nothing is watching: no observer, so no
  // grounds to claim anything changed. It is also why `stop()` belongs to the
  // app's teardown and not to anything an agent can reach.
  const { handle, timers, observer } = watcher();

  observer.emit(childListChange);
  timers.advance(100);
  handle.stop();
  observer.emit(childListChange);
  timers.advance(100);

  assert.equal(observer.disconnected, true);
  assert.equal(handle.rev(), 2);
  assert.equal(timers.pending, 0, "stop() must not leave a timer holding the process open");
  handle.stop(); // idempotent
});

test("a target selector that matches nothing throws rather than freezing rev", () => {
  // Observing nothing leaves `rev` at its start value forever, and a frozen
  // `rev` accepts every stale call. Silent, permanent, and indistinguishable
  // from a very calm app.
  const doc = new FakeDocument(html(`<div id="app"></div>`));

  assert.throws(
    () =>
      revFromMutations("#invoices", {
        document: doc,
        MutationObserver: FakeMutationObserver,
        timers: new FakeTimers(),
      }),
    /a frozen rev accepts every stale call/,
  );
});

test("a target selector resolves against the injected document", () => {
  const doc = new FakeDocument(html(`<div id="app"><table id="invoices"></table></div>`));

  const handle = revFromMutations("#invoices", {
    document: doc,
    MutationObserver: FakeMutationObserver,
    timers: new FakeTimers(),
  });

  const observed = FakeMutationObserver.last().observed[0]!;
  assert.equal((observed.target as { tag: string }).tag, "table");
  assert.equal(observed.options?.subtree, true);
  handle.stop();
});

test("start must be a positive integer", () => {
  assert.throws(
    () =>
      revFromMutations(html(`<div></div>`), {
        start: 0,
        MutationObserver: FakeMutationObserver,
        timers: new FakeTimers(),
      }),
    /positive integer start/,
  );
});

test("a start above 1 is honoured, for an app resuming a counter it already had", () => {
  const { handle } = watcher({ start: 7 });
  assert.equal(handle.rev(), 7);
});
