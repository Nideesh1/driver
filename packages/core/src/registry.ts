/**
 * driverkit/core — the registry.
 *
 * One function, `mount`, and one invariant: every way of driving the app goes
 * through `call`. The in-page chatbot calls it directly, the relay calls it
 * after a websocket frame arrives, a test calls it with no transport at all.
 * There is deliberately no second path, because a second path is a second set
 * of validation and staleness rules and one of the two will be the wrong one.
 *
 * The core renders nothing and imports nothing. No React, no model SDK, no
 * websocket. Those live in sibling packages so an app that only wants to be
 * drivable from outside does not pull a UI into its bundle.
 */

import type {
  ArgSpec,
  CallOptions,
  Driver,
  Manifest,
  MountOptions,
  Refusal,
  Report,
  Result,
  Scalar,
  Snapshot,
  Verb,
  VerbContext,
} from "./types.ts";

const REFUSAL = "refusal" as const;

/**
 * The slugs an app may not use as a refusal of its own, or as a verb name.
 *
 * PROTOCOL.md's reserved list, in code, because a list that lives only in prose
 * is a list nothing checks. Seven come from the core itself, three from the
 * relay and one from a confirmation gate, and they have one property in common:
 * each says something about WHERE a call stopped, not about the app's rules. An
 * app that refuses with `timeout` has taken away an agent's only way to tell
 * "the app said no, phrase it differently" from "your call never landed,
 * reconnect or pick another tab" — and an agent that cannot tell those apart
 * will retry a commit that may already have run.
 *
 * `wrong-screen` is the newest, and the only one that was ever an app's own. An
 * app with six screens wrote the check by hand and had to invent a word for it;
 * the next app would have picked `not-on-this-screen`, and an agent that had
 * learned one would not recognise the other. The slug says where a call
 * stopped — you are not there — so it belongs here with the rest, and
 * `Verb.screen` with `CallOptions.screen` is how an app now gets the check for
 * nothing. An app that was refusing it by hand is told so at mount; see below.
 */
export const RESERVED_REFUSALS: readonly string[] = [
  "stale",
  "wrong-screen",
  "unknown-verb",
  "bad-argument",
  "unmounted",
  "threw",
  "no-such-tab",
  "tab-went-away",
  "timeout",
  "declined-by-user",
];

const RESERVED = new Set(RESERVED_REFUSALS);

/** Spelled once. The core originates this slug from two checks and names it in
 *  a third message, and three string literals is how the three come to
 *  disagree. */
const WRONG_SCREEN = "wrong-screen";

/**
 * A verb's `screen` as a list, whatever shape the app declared it in.
 *
 * One string and `["one-string"]` mean the same thing to every check in here,
 * and the alternative — `Array.isArray` at each of the three places that reads
 * the field — is how two of the three come to disagree about the one-element
 * case. The declared shape is still what goes in the manifest and in the
 * fingerprint; this is only for deciding and for phrasing.
 */
function screensOf(screen: string | string[]): string[] {
  return Array.isArray(screen) ? screen : [screen];
}

/**
 * `a`, `b` and `c` — for a hint a person and a model both read.
 *
 * It reads naturally for one as well as for several, which is the point: the
 * refusal for a verb on one screen must not acquire a comma or the word "and"
 * because the field can now hold a list. One screen phrases exactly as it did
 * before this field could be an array.
 */
function naming(screens: string[]): string {
  const quoted = screens.map((s) => `\`${s}\``);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Say so once, and keep running.
 *
 * Deliberately not a throw. An undeclared refusal slug is discovered while a
 * verb is refusing — the path an app takes when it is working correctly and
 * merely saying no — and turning that into an exception would take a live app
 * down over a documentation mistake. Silence is not the alternative: `refuses`
 * is documented as checked, and a check nobody can observe is the bug this
 * exists to fix.
 *
 * Deduped per message, so a model looping on one refused verb cannot turn this
 * into a console flood. Deduping rather than a build flag is also how this
 * stays dev-shaped in a package with no build step and no `process.env` to
 * read: a correct app prints nothing, ever, and an incorrect one prints once.
 */
const warned = new Set<string>();

function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`driverkit: ${message}`);
  }
}

/** Build the value a verb returns to decline. Exported because app code
 *  sometimes wants to refuse from a helper rather than inline. */
export function refusal(reason: string, hint?: string): Refusal {
  return { __driverkit: REFUSAL, reason, ...(hint === undefined ? {} : { hint }) };
}

function isRefusal(v: unknown): v is Refusal {
  return typeof v === "object" && v !== null && (v as Refusal).__driverkit === REFUSAL;
}

/**
 * Validate one argument against its spec.
 *
 * Returns a reason string, or null when the value is acceptable. Kept separate
 * from `call` so the failure messages can be unit-tested without mounting
 * anything, and so they read the same whether the caller was a chatbot or a
 * relay frame — a model that learns one phrasing of "bad argument" should not
 * meet a different phrasing depending on how it connected.
 */
export function checkArg(name: string, spec: ArgSpec, value: Scalar | undefined): string | null {
  if (value === undefined || value === null) {
    return spec.optional ? null : `missing argument \`${name}\``;
  }
  if (typeof value !== spec.type) {
    return `argument \`${name}\` wants a ${spec.type}, got ${typeof value}`;
  }
  if (spec.oneOf && !spec.oneOf.includes(value)) {
    // The accepted values are listed rather than counted. An agent that is
    // told "invalid value" has to guess again; one that is told the set can
    // fix the call on the next turn without another read.
    return `argument \`${name}\` must be one of ${spec.oneOf.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return null;
}

/**
 * Make an app drivable.
 *
 * ```ts
 * const driver = mount({
 *   app: "Contacts",
 *   verbs: [
 *     { name: "open", kind: "read", describe: "open one contact",
 *       args: { id: { type: "string", describe: "contact id" } },
 *       run: ({ id }) => router.push(`/contacts/${id}`) },
 *
 *     // A describe/commit pair. The predicate is resolved inside the app,
 *     // where the rows already are, so selecting a thousand contacts is one
 *     // call and not a thousand -- and the count comes back before anything
 *     // irreversible happens.
 *     { name: "select-where", kind: "describe", describe: "select every contact matching a filter",
 *       args: { where: { type: "string", describe: "e.g. company=Acme" } },
 *       run: ({ where }) => store.select(where) },
 *     { name: "accept-selected", kind: "commit", describe: "accept the current selection",
 *       refuses: ["nothing-selected"],
 *       run: (_, ctx) => store.selected.length ? api.accept(store.selected)
 *                                              : ctx.refuse("nothing-selected") },
 *   ],
 *   visible: () => ({ where: "contacts", rev: store.rev, rows: store.onScreen() }),
 * });
 * ```
 *
 * Nothing above is specific to a framework or a kind of app. `run` bodies call
 * whatever the app already has -- a store action, an API client, or, in an app
 * with neither, a click on a button the author marked themselves. See
 * `@driverkit/adapters` for that last case.
 */
export function mount(options: MountOptions): Driver {
  const verbs = new Map<string, Verb<any>>();
  let live = true;

  for (const verb of options.verbs as Verb<any>[]) {
    if (verbs.has(verb.name)) {
      // Thrown, not refused: two verbs sharing a name is a programming error
      // that makes one of them permanently unreachable, and it should fail at
      // mount rather than silently shadow on the first call.
      throw new Error(`driverkit: two verbs are both named \`${verb.name}\``);
    }

    // Thrown at mount for the same reason the duplicate name above is: both are
    // static facts about the verb surface, both make the app permanently
    // ambiguous to every agent that reads the manifest, and mount runs at
    // startup rather than on a refusal path — so failing here costs a developer
    // one stack trace and costs a running app nothing. The call-time check
    // below, which can only fire while an app is refusing, is a warning
    // instead; see `warn`.
    if (RESERVED.has(verb.name)) {
      throw new Error(
        `driverkit: a verb may not be named \`${verb.name}\`: that is a reserved refusal slug ` +
          `(${RESERVED_REFUSALS.join(", ")}). An agent could not tell a refusal from this verb ` +
          `apart from a refusal about it.`,
      );
    }

    // Thrown at mount, the way a duplicate name is, and for the same reason: it
    // is a static fact about the surface that makes the verb permanently
    // uncallable. `screen: []` says the verb works on no screen at all, which
    // no author means — it is what a `.filter()` over a list of screens
    // produces when the list was empty, or what a config file hands over when
    // a key is missing. The author who meant "anywhere" leaves the field out,
    // and that is said here rather than guessed at, because guessing either
    // way is wrong: treating it as "anywhere" silently makes a scoped verb
    // global, and treating it as "nowhere" leaves a verb in everybody's cached
    // prefix that can only ever be refused.
    if (Array.isArray(verb.screen) && verb.screen.length === 0) {
      throw new Error(
        `driverkit: the verb \`${verb.name}\` declares \`screen: []\`, which says it works on ` +
          `no screen at all. Omit \`screen\` to mean "anywhere", or name the screens it works ` +
          `on.`,
      );
    }

    for (const slug of verb.refuses ?? []) {
      if (RESERVED.has(slug)) {
        throw new Error(
          `driverkit: the verb \`${verb.name}\` declares the reserved refusal \`${slug}\` ` +
            `(reserved: ${RESERVED_REFUSALS.join(", ")}). Reserved slugs say where a call ` +
            `stopped, not what your app decided; pick a name from your own vocabulary.` +
            // Named, because this is the one reserved slug an app may already
            // be using: it was an app's invention before it was the core's, and
            // an author who hits this wants the replacement rather than a rule.
            // At mount, where it costs one stack trace at startup, and never on
            // a refusal path.
            (slug === WRONG_SCREEN
              ? ` \`${WRONG_SCREEN}\` is now the core's: put \`screen: "<the screen this verb ` +
                `is on>"\` on the verb, give \`Snapshot.screen\` the screen that is live, and ` +
                `the refusal — naming both screens — comes back without this guard.`
              : ""),
        );
      }
    }

    verbs.set(verb.name, verb);
  }

  // Computed once. The manifest is the half that gets cached by whoever is
  // driving, so it must not vary call to call; deriving it lazily on every
  // read would invite someone to fold `visible()` into it.
  const manifest: Manifest = {
    version: fingerprint(options.app, verbs, options.instructions),
    app: options.app,
    // The app's own briefing, in the half that is cached once. Omitted rather
    // than sent as an empty string, so an app that passes nothing produces the
    // manifest it produced before this field existed -- byte for byte, which
    // is what the fingerprint hashes.
    ...(options.instructions ? { instructions: options.instructions } : {}),
    verbs: [...verbs.values()].map((v) => ({
      name: v.name,
      describe: v.describe,
      ...(v.kind ? { kind: v.kind } : {}),
      // Copied through untouched and never read by anything in here. `at` is a
      // hint for whoever is drawing the run, not a way to find an element; see
      // `Verb.at`.
      ...(v.at ? { at: v.at } : {}),
      // `screen` IS read in here, by `call` below, and it is still copied for
      // the same reason `kind` is: the manifest is the only description of this
      // verb an agent gets, and "works only on the companies list" is a fact it
      // should read in the cached half rather than discover by being refused.
      //
      // Copied in the shape the app declared, a string staying a string rather
      // than being normalised to a one-element array. Every client reading
      // `verbs[].screen` today reads it as a string, and normalising would move
      // every single-screen app's manifest -- and its fingerprint -- for a
      // change that app did not make.
      ...(v.screen ? { screen: v.screen } : {}),
      ...(v.reversible ? { reversible: v.reversible } : {}),
      ...(v.args ? { args: v.args } : {}),
      ...(v.refuses ? { refuses: v.refuses } : {}),
    })),
  };

  const read = (): Snapshot => options.visible();

  const ctx: VerbContext = { refuse: refusal };

  async function call(
    name: string,
    args: Record<string, Scalar> = {},
    opts: CallOptions = {},
  ): Promise<Result> {
    if (!live) return no("unmounted", "this driver was unmounted", read());

    const verb = verbs.get(name);
    if (!verb) {
      // The known names are listed. An outside agent may be holding a manifest
      // from a previous version of the app, and the list is how it finds out
      // what moved without a second round trip.
      const known = [...verbs.keys()].sort().join(", ");
      return no("unknown-verb", `no verb named \`${name}\`. known: ${known}`, read());
    }

    const before = read();

    // WHICH SCREEN comes before WHICH REV, which comes before the arguments.
    // Each check describes a wider mistake than the next, and the widest one is
    // the useful answer: if the agent is not on the screen it thinks it is,
    // then the rev and the arguments both describe something it never saw, and
    // answering "the number moved" sends it to re-read a screen when what it
    // needs is to navigate back. A `next-page` that lands on another company's
    // contact list and answers `ok` is the live bug this ordering exists to
    // make impossible.
    //
    // Both screen checks are skipped when the app does not fill in
    // `Snapshot.screen`. There is nothing to compare against, and inventing a
    // comparison -- treating absent as "not that one" -- would refuse every
    // screen-scoped verb in an app that simply has not adopted the field.
    if (opts.screen !== undefined && before.screen !== undefined && opts.screen !== before.screen) {
      return no(
        WRONG_SCREEN,
        `you believed you were on the \`${opts.screen}\` screen but the app is on ` +
          `\`${before.screen}\`; read the screen again before acting on it`,
        before,
      );
    }

    if (verb.screen !== undefined) {
      const wants = screensOf(verb.screen);
      if (before.screen === undefined) {
        // Said once, not refused. The app declared a verb→screen mapping and no
        // live screen, so the check it asked for cannot run -- which is a
        // mistake in the app rather than in the call, and refusing a verb an
        // author believes they scoped correctly would break a working app over
        // a missing field. See `warn`.
        warn(
          `the verb \`${name}\` names ${wants.length > 1 ? "the screens" : "the screen"} ` +
            `${naming(wants)} but \`visible()\` returns no \`screen\`, so the check cannot run. ` +
            `Fill in \`Snapshot.screen\` with the id of the screen that is live, or drop ` +
            `\`screen\` from the verb.`,
        );
      } else if (!wants.includes(before.screen)) {
        // ALL the screens are named, the live one and every one the verb works
        // on. `wrong-screen` on its own is a dead end: an agent that is told no
        // and not told where to go has to guess, and the guess is another
        // refused call. Naming only one of several would be a subtler version
        // of the same dead end -- it would send an agent to the contacts list
        // when the company screen it is two clicks from would have done. The
        // verb that navigates is the app's and cannot be named from here, which
        // is what `Manifest.instructions` is for.
        return no(
          WRONG_SCREEN,
          `you are on the \`${before.screen}\` screen; \`${name}\` works on the ` +
            `${naming(wants)} ${wants.length > 1 ? "screens" : "screen"}. Go ` +
            `${wants.length > 1 ? "to one of those" : "there"} first, then call it again.`,
          before,
        );
      }
    }

    // Staleness is checked BEFORE arguments, and that order is deliberate. If
    // the screen has moved on, the arguments describe a row the agent never
    // saw, so complaining about their shape would be answering the wrong
    // question -- and the fix is the same either way: read again.
    if (opts.rev !== undefined && opts.rev !== before.rev) {
      return no(
        "stale",
        `you acted on rev ${opts.rev} but the screen is at rev ${before.rev}; read again`,
        before,
      );
    }

    if (verb.args) {
      for (const [argName, spec] of Object.entries(verb.args)) {
        const reason = checkArg(argName, spec, args[argName]);
        if (reason) return no("bad-argument", reason, before);
      }
    }

    let outcome: void | Refusal | Report;
    try {
      outcome = await verb.run(args, ctx);
    } catch (err) {
      // An app bug is reported as a failed call rather than allowed to
      // propagate. The alternative kills the websocket pump in the relay, and
      // a driver that dies on one bad verb takes every other verb with it.
      return no(
        "threw",
        `the verb \`${name}\` threw: ${err instanceof Error ? err.message : String(err)}`,
        read(),
      );
    }

    if (isRefusal(outcome)) {
      if (RESERVED.has(outcome.reason)) {
        // Reported as `threw` rather than passed through, and rather than
        // raised. Passing it through is the bug: the agent now reads `timeout`
        // from a call that landed and answered, and the reserved list stops
        // meaning anything. Raising would be worse — this is reached only while
        // a working app is saying no, and killing the run over a slug turns a
        // declined commit into a dead panel. `threw` is already the core's word
        // for "the app's own code is broken", which is exactly what this is,
        // and it leaves the reserved slugs saying only what they are for.
        warn(
          `the verb \`${name}\` refused with the reserved slug \`${outcome.reason}\`; ` +
            `reported as \`threw\`. Reserved: ${RESERVED_REFUSALS.join(", ")}.`,
        );
        return no(
          "threw",
          `the verb \`${name}\` refused with \`${outcome.reason}\`, which is a reserved slug and ` +
            `not an app refusal. This is a bug in the app, not something to retry differently.`,
          read(),
        );
      }

      // Declaring `refuses` opts the verb into the check; leaving it absent
      // makes no claim, the same way an absent `kind` makes no safety claim.
      // Warning on every app that never filled the field in would be a warning
      // on everything and therefore a warning on nothing.
      if (verb.refuses && !verb.refuses.includes(outcome.reason)) {
        warn(
          `the verb \`${name}\` refused with \`${outcome.reason}\`, which is not in its declared ` +
            `refuses [${verb.refuses.join(", ")}]. The manifest is the only description of this ` +
            `verb an agent gets, and an undeclared refusal is one it cannot plan around.`,
        );
      }

      return no(outcome.reason, outcome.hint, read());
    }

    // Read again after running, not before: the point of returning a snapshot
    // is to show what the call did.
    //
    // `count` is forwarded with `?? undefined` rather than a truthiness check,
    // because a `describe` verb that matched nothing must report `0` and not
    // silently become "I do not count" — those are different answers, and the
    // difference decides whether a commit should follow.
    return {
      ok: true,
      ...(outcome && outcome.count !== undefined ? { count: outcome.count } : {}),
      ...(outcome && outcome.note !== undefined ? { note: outcome.note } : {}),
      snapshot: read(),
    };
  }

  function no(refused: string, hint: string | undefined, snapshot: Snapshot): Result {
    return { ok: false, refused, ...(hint === undefined ? {} : { hint }), snapshot };
  }

  return {
    manifest: () => manifest,
    snapshot: read,
    call,
    unmount: () => {
      live = false;
    },
  };
}

/**
 * A short, stable hash of the verb surface.
 *
 * Only the parts an agent can observe go in: names, descriptions, argument
 * shapes, refusals. Not `run`, because reimplementing a verb's body without
 * changing its interface must not invalidate anybody's cached manifest.
 *
 * Not cryptographic and does not need to be. It answers one question -- "is
 * the copy I cached still the current one" -- and a collision costs a stale
 * manifest, not a security property.
 */
function fingerprint(
  app: string,
  verbs: Map<string, Verb<any>>,
  instructions?: string,
): string {
  // `kind` is in here on purpose. A verb reclassified from `describe` to
  // `commit` has not changed its name or its arguments, so without this the
  // fingerprint would not move and every agent holding a cached manifest would
  // go on believing an irreversible verb is free to try.
  //
  // So is `at`, for the weaker but real version of the same reason: it is part
  // of what a cached manifest claims about the surface, and a UI holding the
  // old copy would outline an element the verb no longer touches.
  //
  // `screen` and `reversible` are in for the strong version of it. Moving a
  // verb to another screen changes where a cached copy says it works, and so
  // does GIVING IT A SECOND ONE -- a verb that now also works on a company's
  // contact list is a verb whose cached description was wrong about where it
  // can be called. Dropping `reversible` from a commit changes whether an agent
  // was told there is a way back -- which is the same class of mistake as a
  // reclassified `kind`.
  //
  // The DECLARED shape is hashed, so `"contacts"` and `["contacts"]` give
  // different versions. That is not a wart: they are different bytes in the
  // manifest, a client caching the manifest would see a different document, and
  // a fingerprint that hid the difference would be claiming two cached copies
  // are interchangeable when they do not read the same. So is `instructions`: it is rendered straight into the
  // system prompt, so an agent holding the old manifest is briefed with the
  // app's old words.
  //
  // All three are APPENDED, and only when the app actually used them, so the
  // shape of an app that uses none is the exact string it was before these
  // fields existed. That is not neatness: every stored `Manifest.version` out
  // there was computed from the old string, and an upgrade of this library that
  // silently moved every app's version would tell every agent its cached
  // manifest had gone stale when nothing about the app had changed at all.
  const extras = (v: Verb<any>): Array<Record<string, unknown>> => {
    const e: Record<string, unknown> = {};
    if (v.screen) e.screen = v.screen;
    if (v.reversible) e.reversible = v.reversible;
    return Object.keys(e).length ? [e] : [];
  };

  const shape = JSON.stringify([
    app,
    [...verbs.values()]
      .map((v) => [
        v.name,
        v.describe,
        v.kind ?? null,
        v.at ?? null,
        v.args ?? null,
        v.refuses ?? null,
        ...extras(v),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ...(instructions ? [instructions] : []),
  ]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < shape.length; i++) {
    const c = shape.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}
