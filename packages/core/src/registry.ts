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
 * is a list nothing checks. Six come from the core itself, three from the relay
 * and one from a confirmation gate, and they have one property in common: each
 * says something about WHERE a call stopped, not about the app's rules. An app
 * that refuses with `timeout` has taken away an agent's only way to tell "the
 * app said no, phrase it differently" from "your call never landed, reconnect
 * or pick another tab" — and an agent that cannot tell those apart will retry a
 * commit that may already have run.
 */
export const RESERVED_REFUSALS: readonly string[] = [
  "stale",
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

    for (const slug of verb.refuses ?? []) {
      if (RESERVED.has(slug)) {
        throw new Error(
          `driverkit: the verb \`${verb.name}\` declares the reserved refusal \`${slug}\` ` +
            `(reserved: ${RESERVED_REFUSALS.join(", ")}). Reserved slugs say where a call ` +
            `stopped, not what your app decided; pick a name from your own vocabulary.`,
        );
      }
    }

    verbs.set(verb.name, verb);
  }

  // Computed once. The manifest is the half that gets cached by whoever is
  // driving, so it must not vary call to call; deriving it lazily on every
  // read would invite someone to fold `visible()` into it.
  const manifest: Manifest = {
    version: fingerprint(options.app, verbs),
    app: options.app,
    verbs: [...verbs.values()].map((v) => ({
      name: v.name,
      describe: v.describe,
      ...(v.kind ? { kind: v.kind } : {}),
      // Copied through untouched and never read by anything in here. `at` is a
      // hint for whoever is drawing the run, not a way to find an element; see
      // `Verb.at`.
      ...(v.at ? { at: v.at } : {}),
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

    // Staleness is checked BEFORE arguments, and that order is deliberate. If
    // the screen has moved on, the arguments describe a row the agent never
    // saw, so complaining about their shape would be answering the wrong
    // question -- and the fix is the same either way: read again.
    const before = read();
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
function fingerprint(app: string, verbs: Map<string, Verb<any>>): string {
  // `kind` is in here on purpose. A verb reclassified from `describe` to
  // `commit` has not changed its name or its arguments, so without this the
  // fingerprint would not move and every agent holding a cached manifest would
  // go on believing an irreversible verb is free to try.
  //
  // So is `at`, for the weaker but real version of the same reason: it is part
  // of what a cached manifest claims about the surface, and a UI holding the
  // old copy would outline an element the verb no longer touches.
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
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
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
