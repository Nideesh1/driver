/**
 * The panel's stylesheet, as one string in one `<style>` inside the shadow
 * root.
 *
 * Shadow DOM is doing two jobs here and both are about trust. The host app's
 * CSS cannot reach in, so a global `* { box-sizing: border-box }` or an
 * aggressive `button { ... }` in someone's design system cannot deform the
 * panel; and these rules cannot leak out, so dropping the widget into an app
 * cannot move that app's own layout by a pixel. A library that silently
 * restyles the page it was added to does not get a second chance.
 *
 * Everything is a custom property on `:host` so the host app can retheme the
 * panel from outside — custom properties are the one thing that does cross the
 * shadow boundary, which makes them the right and only hook.
 *
 * Position is custom properties for exactly the same reason, and the panel's
 * placement is therefore something a host app can set from its own stylesheet
 * without touching JavaScript. See the comment on `--dk-x` for why the unit is
 * a fraction of the free space rather than pixels.
 *
 * `prefers-color-scheme` rather than a `theme` option: the panel sits in
 * someone else's app, and the person reading it has already told their system
 * which they want. `prefers-reduced-motion` because the panel appears over
 * what someone was looking at, and an animation they asked not to see is worse
 * than no animation.
 */
export const CSS = `
:host {
  --dk-bg: #ffffff;
  --dk-fg: #15171a;
  --dk-dim: #6b7280;
  --dk-line: #e4e6eb;
  --dk-accent: #1f6feb;
  --dk-you: #f2f4f7;
  --dk-commit: #b42318;
  --dk-refused: #9a3412;
  --dk-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  --dk-radius: 10px;
  --dk-font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  --dk-mono: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Position. Two numbers in [0, 1]: 0 is flush with the near edge, 1 with
     the far one, 0.5 centred. The far-edge case is what the translate is for
     -- the element is pushed to the far inset and then pulled back by its own
     full width, so the arithmetic below works out to
     \`left: gap + x * (viewport - 2*gap - width)\`, which is on screen for every
     x in [0, 1] and every viewport at least as wide as the panel. That is why
     the unit is a fraction and not a pixel: a remembered fraction cannot
     describe an off-screen panel, and a remembered pixel offset can -- and an
     off-screen panel has no header to grab and no way back.

     It also means a host app can place the panel from its own stylesheet, the
     same way it can retheme it, with no JavaScript: these are ordinary custom
     properties on the host element and the outer tree outranks :host. The
     widget writes them inline only once somebody has actually moved it. */
  --dk-gap: 16px;
  --dk-x: 1;
  --dk-y: 1;

  all: initial;
  position: fixed;
  left: calc(var(--dk-gap) + var(--dk-x) * (100vw - var(--dk-gap) * 2));
  top: calc(var(--dk-gap) + var(--dk-y) * (100vh - var(--dk-gap) * 2));
  translate: calc(var(--dk-x) * -100%) calc(var(--dk-y) * -100%);
  z-index: 2147483000;
  font: var(--dk-font);
  color: var(--dk-fg);
}

/* Only ever on for a move the person did not make with a pointer -- a snap, a
   keypress. A transition during a drag means the panel trails the finger. */
:host(.dk-snap) {
  transition: left 160ms ease-out, top 160ms ease-out, translate 160ms ease-out;
}
/* Belt as well as braces: the widget also checks this with matchMedia before
   it ever adds the class, so that a host which overrides the stylesheet still
   does not animate at somebody who asked for no animation. */
@media (prefers-reduced-motion: reduce) {
  :host(.dk-snap) { transition: none; }
}

@media (prefers-color-scheme: dark) {
  :host {
    --dk-bg: #16181c;
    --dk-fg: #e8eaed;
    --dk-dim: #9aa0a6;
    --dk-line: #2a2d33;
    --dk-accent: #5b9dff;
    --dk-you: #22252b;
    --dk-commit: #ff8b80;
    --dk-refused: #f0a868;
    --dk-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }
}

button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--dk-accent); outline-offset: 2px; }

.dk-launcher {
  background: var(--dk-bg);
  border: 1px solid var(--dk-line);
  border-radius: 999px;
  box-shadow: var(--dk-shadow);
  padding: 9px 15px;
  /* Draggable too: a collapsed widget sits on top of the app just as much as
     an open one, it is simply smaller. */
  touch-action: none;
}
.dk-open .dk-launcher { display: none; }

.dk-panel {
  display: none;
  flex-direction: column;
  width: min(380px, calc(100vw - 32px));
  height: min(520px, calc(100vh - 32px));
  background: var(--dk-bg);
  border: 1px solid var(--dk-line);
  border-radius: var(--dk-radius);
  box-shadow: var(--dk-shadow);
  overflow: hidden;
}
.dk-open .dk-panel { display: flex; animation: dk-in 140ms ease-out; }

@keyframes dk-in { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) {
  .dk-open .dk-panel { animation: none; }
}

/* The drag handle. \`touch-action: none\` is what makes a finger drag the panel
   instead of scrolling the page behind it, and it is scoped to the handles so
   the transcript still scrolls by touch. \`user-select: none\` stops a drag from
   leaving the title text highlighted behind it. */
.dk-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 8px 10px 14px;
  border-bottom: 1px solid var(--dk-line);
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.dk-title { flex: 1; font-weight: 600; cursor: grab; }
:host(.dk-dragging) .dk-head, :host(.dk-dragging) .dk-title, :host(.dk-dragging) .dk-move {
  cursor: grabbing;
}
.dk-x, .dk-move { background: none; border: 0; padding: 4px 8px; border-radius: 6px; color: var(--dk-dim); }
.dk-x:hover, .dk-move:hover { background: var(--dk-you); }
.dk-move { cursor: grab; touch-action: none; }

/* Announcements only. Visually hidden rather than display:none, because a
   display:none live region is not announced at all -- and it lives outside the
   panel so that moving the COLLAPSED widget is announced too. */
.dk-status {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.dk-log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }

.dk-you, .dk-me { padding: 7px 10px; border-radius: 9px; max-width: 86%; white-space: pre-wrap; }
.dk-you { background: var(--dk-you); align-self: flex-end; }
.dk-me { align-self: flex-start; padding-left: 0; }
.dk-note { color: var(--dk-dim); font-size: 12px; }

/* The trace. A person watching an agent move their own screen needs to see
   what it did; silent mutation is alarming even when it is correct. */
.dk-step {
  font: var(--dk-mono);
  color: var(--dk-dim);
  border-left: 2px solid var(--dk-line);
  padding: 2px 0 2px 8px;
}
.dk-step-commit { color: var(--dk-commit); border-left-color: var(--dk-commit); font-weight: 600; }
.dk-step-refused { color: var(--dk-refused); border-left-color: var(--dk-refused); }

/* The confirmation. The one place in this panel where a person is asked to
   decide something, so it is the one place that is allowed to be loud. */
.dk-ask {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--dk-commit);
  border-radius: 9px;
  padding: 9px 10px;
}
.dk-ask-q { flex: 1 0 100%; font-weight: 600; color: var(--dk-commit); }
.dk-ask-why { flex: 1 0 100%; font-size: 12px; color: var(--dk-dim); }
.dk-ask-said { flex: 1 0 100%; font-size: 12px; color: var(--dk-dim); }
.dk-yes, .dk-no { border-radius: 8px; padding: 6px 12px; border: 1px solid var(--dk-line); background: var(--dk-you); }
.dk-yes { border-color: var(--dk-commit); color: var(--dk-commit); font-weight: 600; }

.dk-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--dk-line); }
.dk-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  color: inherit;
  background: var(--dk-bg);
  border: 1px solid var(--dk-line);
  border-radius: 8px;
  padding: 8px 10px;
}
.dk-send, .dk-stop {
  border: 1px solid var(--dk-line);
  border-radius: 8px;
  background: var(--dk-you);
  padding: 8px 12px;
}
.dk-send[disabled] { opacity: 0.5; cursor: default; }
.dk-stop { display: none; }
.dk-busy .dk-stop { display: block; }
.dk-busy .dk-send { display: none; }
`;
