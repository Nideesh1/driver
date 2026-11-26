/**
 * What the person watching can change, and where it is kept.
 *
 * The requirement these exist for is one sentence: the agent drives the screen
 * the person is looking at, so it should walk the UI slowly enough to watch,
 * and the person should be able to see each step, slow it down, pause it, or
 * stop it. Three of the four settings here are that sentence — a pace, a
 * highlight, a step-every-call mode — and the fourth is `confirmCommits`,
 * which already existed as a mount option and is surfaced here because this is
 * where a person goes looking for it.
 *
 * They are per VIEWER, not per app. A pace is a statement about how fast this
 * particular person reads, which is why they are remembered the way the
 * panel's position is remembered — in `localStorage`, namespaced by app, with
 * every read and write wrapped. See `loadJson` in `position.ts`: that is
 * deliberately the only storage mechanism in this package, because two of them
 * would be two places to get the try/catch wrong. Storage throws in a private
 * window and with site data blocked, and a panel that fails to render because
 * it could not remember a slider position would be a far worse bug than one
 * that opens at the default speed.
 */

import { WATCHABLE_PACE } from "../agent/control.ts";

import type { StorageLike } from "./dom.ts";
import { loadJson, saveJson } from "./position.ts";

export interface Settings {
  /** Milliseconds the agent waits between steps. See `SPEEDS`. */
  pace: number;
  /** Outline the element a verb is about to touch, when the verb names one.
   *  Default on: it costs nothing when a verb has no `at`, which is most of
   *  them, and when a verb does have one it is the difference between "the
   *  agent did something" and "the agent is about to touch THAT". */
  highlight: boolean;
  /** Require a press of Step for every single call, not just the first.
   *  Default off: it turns a run into a conversation, which is right when you
   *  are watching something you do not trust yet and tedious otherwise. */
  stepMode: boolean;
  /** Ask before every `commit` verb. Default on, matching `WidgetOptions`. */
  confirmCommits: boolean;
}

/**
 * The named speeds, slowest last.
 *
 * Named rather than a free slider, for two reasons. A number of milliseconds
 * is not a thing anybody has an opinion about, and a radio group of four
 * labelled buttons is reachable with a keyboard and announces itself, which a
 * custom-styled `input[type=range]` in a shadow root manages only if somebody
 * is careful about it forever.
 *
 * The range is chosen against what a person can actually follow:
 *
 *   - 250ms is the floor. Below roughly two tenths of a second two consecutive
 *     changes to a screen read as one change, so a faster pace does not buy
 *     visibility, it only buys the feeling of it.
 *   - `WATCHABLE_PACE`, 600ms, is the middle and the default. It is the
 *     agent package's own judgement of a pace a person can follow, and it is
 *     reused rather than re-decided here: two files with two numbers for the
 *     same idea is how they drift.
 *   - 1.5s is for watching something you do not trust yet, where the question
 *     is not "what is it doing" but "is this the row I meant".
 *   - 3s is the ceiling. Twenty steps is the length of run this panel is built
 *     for, and twenty steps at three seconds is a minute of watching, which is
 *     already at the edge of what somebody will sit through. Slower than this
 *     and the honest answer is step mode, not a bigger number.
 */
export const SPEEDS: ReadonlyArray<{ id: string; label: string; ms: number }> = [
  { id: "fast", label: "Fast", ms: 250 },
  { id: "steady", label: "Steady", ms: WATCHABLE_PACE },
  { id: "slow", label: "Slow", ms: 1500 },
  { id: "crawl", label: "Crawl", ms: 3000 },
];

/** The slowest pace worth offering, and the clamp for anything handed in. */
const MAX_PACE = 3000;

export const DEFAULT_PACE = WATCHABLE_PACE;

export function defaults(confirmCommits: boolean): Settings {
  return { pace: DEFAULT_PACE, highlight: true, stepMode: false, confirmCommits };
}

/** The speed whose `ms` is nearest, so a stored or host-supplied pace that is
 *  not one of the four still lights up the button a person would recognise. */
export function nearestSpeed(ms: number): { id: string; label: string; ms: number } {
  let best = SPEEDS[0]!;
  for (const speed of SPEEDS) {
    if (Math.abs(speed.ms - ms) < Math.abs(best.ms - ms)) best = speed;
  }
  return best;
}

export function settingsKey(app: string): string {
  return `driverkit:widget:settings:${app}`;
}

/**
 * The remembered settings, folded over the defaults.
 *
 * Field by field rather than whole-object, because a stored blob written by an
 * older version of the widget is the normal case, not the exceptional one: a
 * person has the panel open in a tab from last month. A missing field takes
 * the default and a field of the wrong type is ignored, so neither can reach
 * the UI as `undefined` and neither is a reason to throw away the three
 * settings that were readable.
 */
export function load(
  storage: StorageLike | undefined,
  app: string,
  base: Settings,
): Settings {
  const stored = loadJson(storage, settingsKey(app), (value) => {
    const s = value as Record<string, unknown> | null;
    if (!s || typeof s !== "object") return null;
    return {
      ...(typeof s.pace === "number" && Number.isFinite(s.pace) ? { pace: pace(s.pace) } : {}),
      ...(typeof s.highlight === "boolean" ? { highlight: s.highlight } : {}),
      ...(typeof s.stepMode === "boolean" ? { stepMode: s.stepMode } : {}),
      ...(typeof s.confirmCommits === "boolean" ? { confirmCommits: s.confirmCommits } : {}),
    } satisfies Partial<Settings>;
  });
  return { ...base, ...(stored ?? {}) };
}

export function save(storage: StorageLike | undefined, app: string, settings: Settings): void {
  saveJson(storage, settingsKey(app), settings);
}

/** A pace that is a real wait. Zero is allowed — a host that wants the old
 *  behaviour back should be able to ask for it — and the ceiling is there so a
 *  corrupt stored value cannot leave the panel apparently frozen. */
export function pace(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_PACE;
  return ms > MAX_PACE ? MAX_PACE : ms;
}
