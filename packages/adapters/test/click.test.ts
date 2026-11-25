/**
 * The specification for binding a verb to a marked button. The decision this
 * file keeps coming back to: a verb that silently does nothing is the worst
 * outcome in the library, because the agent reports success, moves on, and the
 * user finds out later.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { clickHandle, findHandle, listHandles } from "../src/index.ts";
import { FakeDocument, html } from "./fake-dom.ts";

function page(markup: string) {
  const root = html(markup);
  return { root, doc: new FakeDocument(root) };
}

test("clickHandle finds the marked element and clicks it", () => {
  const { root, doc } = page(`
    <div id="app">
      <button data-dk="save">Save</button>
      <button data-dk="cancel">Cancel</button>
    </div>`);
  let handlerRan = 0;
  root.querySelector(`[data-dk="save"]`)!.onclick = () => (handlerRan += 1);

  clickHandle("save", { document: doc })();

  assert.equal(root.querySelector(`[data-dk="save"]`)!.clicks, 1);
  assert.equal(root.querySelector(`[data-dk="cancel"]`)!.clicks, 0);
  // The app's own handler is what runs. That is the point of tier 2 and also
  // its honest cost: this module cannot see what that handler does, so it
  // cannot declare `kind` on the verb's behalf.
  assert.equal(handlerRan, 1);
});

test("the missing-handle error names the handle and lists the ones that are there", () => {
  // The same move the core makes for an unknown verb. A typo, a renamed
  // handle, and a handle that only renders on another screen all produce the
  // same "not found", and the list is what tells them apart without another
  // round trip.
  const { doc } = page(`
    <div id="app"><button data-dk="save">Save</button><button data-dk="next-page">Next</button></div>`);

  assert.throws(() => clickHandle("delete", { document: doc })(), (err: Error) => {
    assert.match(err.message, /no handle `delete`/);
    assert.match(err.message, /Add data-dk="delete"/);
    assert.match(err.message, /Handles in the page: next-page, save\./);
    return true;
  });
});

test("a page with no handles at all says so, rather than listing nothing", () => {
  // An empty list reads as "you typed it wrong". No handles anywhere usually
  // means the driver mounted against the wrong root, or before the view
  // rendered, and that is a different fix.
  const { doc } = page(`<div id="app"><button>Save</button></div>`);

  assert.throws(
    () => clickHandle("save", { document: doc })(),
    /No data-dk handles are in the page at all/,
  );
});

test("the handle is resolved on every call, so a re-render does not detach the verb", () => {
  // Captured at mount, this is the classic silent failure: the node still
  // exists, it is just no longer in the document, so clicking it does
  // precisely nothing and reports success. Any app worth adapting re-renders.
  const { root, doc } = page(`<div id="app"><button data-dk="save">Save</button></div>`);
  const save = clickHandle("save", { document: doc });

  save();
  const stale = root.querySelector(`[data-dk="save"]`)!;
  stale.remove();
  const fresh = root.append(html(`<button data-dk="save">Save</button>`));
  save();

  assert.equal(stale.clicks, 1);
  assert.equal(fresh.clicks, 1);
});

test("a handle that disappears entirely throws on the next call rather than going quiet", () => {
  const { root, doc } = page(`<div id="app"><button data-dk="save">Save</button></div>`);
  const save = clickHandle("save", { document: doc });
  save();

  root.querySelector(`[data-dk="save"]`)!.remove();

  assert.throws(() => save(), /no handle `save`/);
});

test("opts.root scopes the lookup, so two tables can own the same handle name", () => {
  const { root, doc } = page(`
    <div id="app">
      <section id="left"><button data-dk="save">Save</button></section>
      <section id="right"><button data-dk="save">Save</button></section>
    </div>`);

  clickHandle("save", { document: doc, root: "#right" })();

  assert.equal(root.querySelector("#left")!.querySelector(`[data-dk="save"]`)!.clicks, 0);
  assert.equal(root.querySelector("#right")!.querySelector(`[data-dk="save"]`)!.clicks, 1);
});

test("a root selector that matches nothing throws naming the verb that wanted it", () => {
  const { doc } = page(`<div id="app"></div>`);

  assert.throws(
    () => clickHandle("save", { document: doc, root: "#missing" })(),
    /clickHandle\("save"\) found no element matching `#missing`/,
  );
});

test("the attribute is configurable, for an app with an existing convention", () => {
  const { root, doc } = page(`<div id="app"><button data-testid="save">Save</button></div>`);

  clickHandle("save", { document: doc, attribute: "data-testid" })();

  assert.equal(root.querySelector(`[data-testid="save"]`)!.clicks, 1);
});

test("listHandles reports what the current screen offers", () => {
  // Worth logging once at startup: it is how an app author notices that a verb
  // they declared has no element behind it, before an agent finds out for them.
  const { doc } = page(`
    <div id="app">
      <button data-dk="save"></button>
      <button data-dk="save"></button>
      <button data-dk="archive"></button>
      <button data-dk="  "></button>
    </div>`);

  assert.deepEqual(listHandles({ document: doc }), ["archive", "save"]);
});

test("findHandle looks without clicking", () => {
  const { doc } = page(`<div id="app"><button data-dk="save" disabled>Save</button></div>`);

  const el = findHandle("save", { document: doc });

  assert.equal(el?.getAttribute("disabled"), "");
  assert.equal(findHandle("nope", { document: doc }), null);
  assert.equal(el!.clicks, 0);
});
