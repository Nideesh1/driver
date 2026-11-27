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

  /* The collapsed launcher's box, and it is fixed on purpose.

     Content-sized, it was a different size in every app -- "Ask Northwind CRM"
     is twice the button "Ask Mail" is -- and it changed shape as the label or
     the state changed, which looks like a bug even when it is not. It also
     moved itself: the remembered position is a fraction of the FREE space and
     the free space is the viewport less the element's own measured width, so a
     launcher that grew by thirty pixels slid by thirty pixels times x. A
     constant box makes the placement arithmetic stable as well as the look.

     Two properties rather than one, so a host that wants a bigger target can
     say so, and the radius is derived from the height so it is always a true
     pill and never a rounded rectangle at one size and a circle at another. */
  --dk-launcher-w: 96px;
  --dk-launcher-h: 40px;

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

/* ONE RULE, AND NOTHING ELSE IN THIS STYLESHEET MAY RESIZE IT. The busy and
   open states say what they are with colour and with what they show inside
   this box; none of them touches its width, height, padding or font, because a
   control that changes shape as the state changes reads as a glitch and,
   worse, walks across the screen as it does it. If a new state needs to be
   visible out here, it gets an indicator INSIDE the pill. */
.dk-launcher {
  /* So a host app's \`* { box-sizing: content-box }\` cannot turn the fixed
     width into width-plus-padding. The shadow boundary already stops their
     rules reaching in; this stops the inherited-by-default ones. */
  box-sizing: border-box;
  /* The containing block for the "a conversation is waiting" dot, which is
     positioned INSIDE this box. A badge hanging off the corner would be an
     element of a different size, and this element's size is the one thing
     nothing here is allowed to change. */
  position: relative;
  width: var(--dk-launcher-w);
  height: var(--dk-launcher-h);
  /* Half the height, so it is a pill at any size the host picks. */
  border-radius: calc(var(--dk-launcher-h) / 2);
  padding: 0 14px;
  background: var(--dk-bg);
  border: 1px solid var(--dk-line);
  box-shadow: var(--dk-shadow);
  /* Centre the label in a box it cannot change, and clip it if the host
     overrode the label with something long. Ellipsised rather than wrapped:
     two lines would need a taller box, which is the thing being prevented. */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: none;
  /* Draggable too: a collapsed widget sits on top of the app just as much as
     an open one, it is simply smaller. */
  touch-action: none;
}
.dk-open .dk-launcher { display: none; }

/* "There is a conversation behind this." Its own class, so no rule here
   mentions \`.dk-launcher\` and the one rule that sizes the pill stays the one
   rule that sizes the pill. Inside the pill, clear of the 14px label padding
   at the right end, and 8px across -- big enough to notice in the corner of an
   eye and small enough not to read as a second control. */
.dk-dot {
  display: none;
  position: absolute;
  right: 7px;
  top: 50%;
  width: 8px;
  height: 8px;
  margin-top: -4px;
  border-radius: 50%;
  background: var(--dk-accent);
}
.dk-dot-on { display: block; }
/* And it breathes while a run is in flight, because "the agent is still
   working" is the state somebody who minimised mid-run most needs to see.
   Opt-in to motion rather than opt-out: a person who asked for no animation
   gets a steady dot, which still says everything except the urgency. */
@media (prefers-reduced-motion: no-preference) {
  .dk-busy .dk-dot { animation: dk-pulse 1.6s ease-in-out infinite; }
}
@keyframes dk-pulse { 50% { opacity: 0.3; } }

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

/* The header, which is chrome and nothing else: no \`cursor: grab\`, no
   \`touch-action\`, no drag. The grip beside the title is the handle, and a
   strip that is not a handle cannot start a drag under a press that was aimed
   at the gear and missed. \`user-select: none\` stays, so a double-click on the
   chrome does not leave the title highlighted. */
.dk-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 8px 10px 8px;
  border-bottom: 1px solid var(--dk-line);
  user-select: none;
  -webkit-user-select: none;
}
.dk-title { flex: 1; font-weight: 600; }
:host(.dk-dragging) .dk-move { cursor: grabbing; }
.dk-min, .dk-move, .dk-gear { background: none; border: 0; padding: 4px 8px; border-radius: 6px; color: var(--dk-dim); }
.dk-min:hover, .dk-move:hover, .dk-gear:hover { background: var(--dk-you); }
/* The grip, and the only drag surface on the panel. \`touch-action: none\` is
   what makes a finger drag the panel instead of scrolling the page behind it,
   and it is scoped to the handle so the transcript still scrolls by touch.
   First in the strip and therefore at the far end from the gear and the
   minimise button, which is half of why a mis-aimed press no longer drags. */
.dk-move { cursor: grab; touch-action: none; font-size: 13px; line-height: 1; letter-spacing: 1px; }
/* A minus, not a cross: this puts the panel away and keeps the conversation,
   and a cross is the glyph for throwing something away. The sizing matches the
   gear so the two read as one pair of controls. */
.dk-min { font-size: 15px; line-height: 1; }
/* A glyph and not the word "Settings", because the header is also the drag
   handle and three words plus a title is a strip nobody can grab. The button
   is a real button with a real label for anybody not reading the glyph. */
.dk-gear { font-size: 15px; line-height: 1; }
.dk-gear[aria-expanded="true"] { background: var(--dk-you); color: var(--dk-fg); }

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

/* The step list. A person watching an agent move their own screen needs to
   see what it did -- silent mutation is alarming even when it is correct --
   and, since the loop announces a call before it runs, what it is ABOUT to do.
   Each row is one call and moves pending -> running -> done, refused or
   skipped.

   The state is a class and a \`::before\` marker rather than text, which is
   deliberate: the row's text is the record of the call, it is what a person
   copies out of the panel, and it should read the same whether they looked at
   it while it was pending or a minute later. */
.dk-step {
  font: var(--dk-mono);
  color: var(--dk-dim);
  border-left: 2px solid var(--dk-line);
  padding: 2px 0 2px 8px;
  /* One line each, always. Twenty steps that each wrap to three lines is not a
     list anybody can skim, and skimming is the only thing it is for. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Consecutive steps close up into one block, so the transcript's 8px gap
   separates the CONVERSATION and not every line of a twenty-step run. */
.dk-step + .dk-step { margin-top: -6px; }
.dk-step::before {
  /* A fixed-width marker column, so the verb names line up down the list and
     a change of state does not shift the text sideways. */
  display: inline-block;
  width: 1.1em;
  content: "\\00b7";
}
.dk-step-pending { opacity: 0.75; }
.dk-step-pending::before { content: "\\25cb"; }
.dk-step-running { color: var(--dk-fg); border-left-color: var(--dk-accent); }
.dk-step-running::before { content: "\\25b8"; color: var(--dk-accent); }
.dk-step-done::before { content: "\\2713"; }
/* Commit steps are marked three ways at once -- the word in the text, the
   colour, and a tinted band -- because this is the row somebody scrolls back
   to when they want to know what changed their data, and because the whole
   confirmation design rests on a person being able to tell a commit from a
   selection at a glance. */
.dk-step-commit {
  color: var(--dk-commit);
  border-left: 3px solid var(--dk-commit);
  padding-left: 7px;
  font-weight: 600;
  background: color-mix(in srgb, var(--dk-commit) 8%, transparent);
}
.dk-step-refused { color: var(--dk-refused); border-left-color: var(--dk-refused); }
.dk-step-refused::before { content: "\\2715"; }
/* A call that was announced and then never ran, because the run was stopped
   during its pace wait or while it was held. Dimmed rather than coloured: it
   is not an outcome, it is the absence of one. */
.dk-step-skipped { opacity: 0.6; text-decoration: line-through; }
.dk-step-skipped::before { content: "\\2013"; text-decoration: none; }

/* The run controls, beside the trace they control. Only while a run is in
   flight: four dead buttons in the corner of somebody's app the rest of the
   time is four buttons they learn to ignore. */
.dk-run {
  display: none;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--dk-line);
}
.dk-busy .dk-run { display: flex; }
.dk-set-open .dk-run { display: none; }
.dk-run button {
  border: 1px solid var(--dk-line);
  background: var(--dk-you);
  border-radius: 8px;
  padding: 4px 10px;
  font: var(--dk-mono);
}
/* Disabled rather than hidden when no controller supplied one, because the
   person should be able to see that pausing is a thing this panel does and
   that this build cannot do it -- a Pause button that silently does nothing
   while the agent keeps changing the screen is how somebody ends up closing
   the tab. */
.dk-run button[disabled] { opacity: 0.45; cursor: default; }
.dk-run-note { margin-left: auto; font-size: 12px; color: var(--dk-dim); }

/* Settings. In the panel rather than a window of its own: it is four
   preferences, and the person is already looking here. */
.dk-settings {
  display: none;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  padding: 14px 12px;
}
.dk-set-open .dk-settings { display: flex; }
.dk-set-open .dk-log, .dk-set-open .dk-form { display: none; }
.dk-set-row { display: flex; flex-direction: column; gap: 5px; }
.dk-set-label { font-weight: 600; }
.dk-set-why { font-size: 12px; color: var(--dk-dim); }
/* The spend row's numbers. Full-strength text under a dimmed reason, which is
   the opposite weighting of every other row in this view -- on those the
   control is the thing and the words explain it, and on this one there is no
   control and the number IS the thing. */
.dk-set-budget { font-size: 12px; font-variant-numeric: tabular-nums; margin-top: 4px; }
.dk-speeds { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.dk-speed {
  border: 1px solid var(--dk-line);
  background: none;
  border-radius: 999px;
  padding: 5px 12px;
}
.dk-speed[aria-checked="true"] {
  border-color: var(--dk-accent);
  color: var(--dk-accent);
  background: var(--dk-you);
  font-weight: 600;
}
.dk-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--dk-line);
  background: none;
  border-radius: 8px;
  padding: 8px 10px;
}
/* The state in the button, as well as in \`aria-checked\` for anybody who is
   being read it. A switch whose only difference between on and off is a shade
   of grey is a switch nobody is sure about. */
.dk-toggle::after {
  margin-left: auto;
  content: "Off";
  font: var(--dk-mono);
  color: var(--dk-dim);
}
.dk-toggle[aria-checked="true"] { border-color: var(--dk-accent); }
.dk-toggle[aria-checked="true"]::after { content: "On"; color: var(--dk-accent); }
/* The destructive item, and the only red thing in the settings view. It is
   given the commit colour on purpose: that colour already means "this changes
   something you cannot take back" everywhere else in this panel, and a second
   vocabulary for danger would weaken the first. Not a filled button -- it is a
   thing to find when you want it, not a thing to notice while changing the
   speed. */
.dk-clear {
  align-self: flex-start;
  border: 1px solid var(--dk-commit);
  background: none;
  color: var(--dk-commit);
  border-radius: 8px;
  padding: 7px 14px;
  font-weight: 600;
  margin-top: 2px;
}
.dk-clear:hover { background: color-mix(in srgb, var(--dk-commit) 10%, transparent); }
.dk-done {
  align-self: flex-start;
  border: 1px solid var(--dk-line);
  background: var(--dk-you);
  border-radius: 8px;
  padding: 7px 14px;
}

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

/**
 * The outline over the element a verb is about to touch, as its own tiny
 * stylesheet in its own shadow root.
 *
 * Separate from `CSS` because it has to be in a separate host element: the
 * panel's `:host` carries a `translate`, a transformed ancestor is the
 * containing block for `position: fixed` descendants, and an outline drawn
 * inside the panel would therefore be offset by wherever the panel sits. See
 * `highlight.ts`.
 *
 * The host is a zero-sized fixed point at the viewport's origin and the box
 * inside it is positioned absolutely, so the numbers written in are exactly
 * the ones `getBoundingClientRect` reported -- no coordinate conversion, which
 * is the only kind of arithmetic that can be wrong here.
 *
 * `pointer-events: none` throughout, and nothing is ever written to the host
 * app's own element: a border on somebody's button reflows their layout, and a
 * panel that nudges the page sideways every time it names an element is not
 * the passive observer it claims to be.
 */
export const SPOT_CSS = `
:host {
  all: initial;
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  pointer-events: none;
  /* One below the panel. If the outline and the panel overlap, the panel is
     the thing that has words in it. */
  z-index: 2147482999;
  --dk-spot-color: #1f6feb;
}
@media (prefers-color-scheme: dark) {
  :host { --dk-spot-color: #5b9dff; }
}
.dk-spot {
  display: none;
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
  left: var(--dk-spot-x, 0);
  top: var(--dk-spot-y, 0);
  width: var(--dk-spot-w, 0);
  height: var(--dk-spot-h, 0);
  border: 2px solid var(--dk-spot-color);
  border-radius: 6px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dk-spot-color) 25%, transparent);
}
.dk-spot-on { display: block; }
@media (prefers-reduced-motion: no-preference) {
  .dk-spot-on { animation: dk-spot-in 120ms ease-out; }
}
@keyframes dk-spot-in { from { opacity: 0; } }
`;
