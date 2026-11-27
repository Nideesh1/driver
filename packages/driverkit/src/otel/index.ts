/**
 * driverkit/otel — one audit sink, for hosts that already run OpenTelemetry.
 *
 * WHY THIS IS A SEPARATE ENTRY POINT AND NOT A FEATURE OF THE CORE. `mount()`
 * emits `AuditEvent`s and owns no sink, because the host already has somewhere
 * for records to go: one adopter runs an OTel collector, the next has Datadog,
 * the next a table in their own database. A library that picked the backend
 * would be one you fight. So the core calls a hook, and this file is one
 * implementation of that hook — nothing in `core`, `agent`, `widget`,
 * `controls`, `browser` or `relay` imports it, and an app that never writes
 * `driverkit/otel` never loads a byte of it.
 *
 * WHY IT IMPORTS `@opentelemetry/api` AND YET DEPENDS ON NOTHING. It does not
 * import it. It takes a `Tracer` as an argument, typed STRUCTURALLY against the
 * slice of the OTel API it uses, so the host passes
 * `trace.getTracer("driverkit")` from its own installed copy and this package
 * keeps its promise of zero runtime dependencies. Three things that buys, in
 * the order they matter:
 *
 *   1. There is one OTel SDK per process, registered by the host at startup,
 *      and a library that imported its own `@opentelemetry/api` could get a
 *      SECOND copy of the global API — a different version, hoisted elsewhere,
 *      or duplicated by a bundler — whose `trace.getTracer` returns a no-op
 *      tracer because the registration happened on the other copy. Spans would
 *      be built and silently dropped, which is the worst failure an audit
 *      trail can have: it looks complete. Taking the tracer as an argument
 *      makes that impossible, because the only tracer that can be passed is
 *      one the host already got from the copy it registered.
 *   2. `@opentelemetry/api` would be this package's first dependency, and the
 *      no-dependency rule is an argument in PROTOCOL.md rather than an
 *      accident. An optional peer would have kept `npm install driverkit`
 *      clean and would still have put an unresolvable import in the published
 *      `.d.ts` of anybody who did not install it.
 *   3. The in-page widget — the case most likely to commit data — can use this
 *      too. Nothing in here is Node-specific, so `./otel` is published to a
 *      browser-targeted bundler like the rest of the library, and a page
 *      running the OTel web SDK passes its tracer in exactly as a server does.
 *
 * The structural types below are written to be satisfied BY `@opentelemetry/
 * api`'s own `Tracer` and `Span`, not to re-describe them. They are
 * deliberately the narrowest shape that works, because every field named here
 * is a field a future version of that package could rename.
 */

import type { AuditEvent } from "../core/types.ts";

/**
 * `SpanStatusCode` from `@opentelemetry/api`, as the two numbers it is.
 *
 * Mirrored rather than imported, and kept as plain numbers because the enum's
 * values are part of its stable surface: `UNSET = 0`, `OK = 1`, `ERROR = 2`.
 * A host that wants to assert on these can import the real enum and compare.
 */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** The slice of `Span` this file touches. Satisfied by the real one. */
export interface AuditSpan {
  setStatus(status: { code: number; message?: string }): unknown;
  end(endTime?: number): void;
}

/** The slice of `Tracer` this file touches. Satisfied by the real one. */
export interface AuditTracer {
  startSpan(
    name: string,
    options?: {
      startTime?: number;
      attributes?: Record<string, string | number | boolean>;
    },
  ): AuditSpan;
}

export interface OtelAuditOptions {
  /**
   * Put each argument on the span as `driverkit.arg.<name>`. Default: true.
   *
   * Off is for a host whose tracing backend bills by attribute, or whose verbs
   * take arguments it would rather keep out of a vendor's index even after the
   * core's redaction. It is not a redaction mechanism and must not be used as
   * one: `ArgSpec.sensitive` is, and it works on every sink rather than this
   * one. See `ArgSpec.sensitive`.
   */
  args?: boolean;
  /**
   * The span name prefix. Default: `"driverkit"`, giving `driverkit accept-selected`.
   *
   * Prefix-and-verb rather than one constant name, because a verb list is
   * STATIC — the same handful of names for every user forever, which is the
   * whole premise of the library — so it is exactly the low-cardinality thing
   * a span name is supposed to be, and it means a trace UI's "slowest
   * operations" list is already a list of verbs.
   */
  prefix?: string;
}

/**
 * An `AuditHook` that turns each record into one span.
 *
 * ```ts
 * import { trace } from "@opentelemetry/api";
 * import { otelAudit } from "driverkit/otel";
 *
 * mount({ ..., onAudit: otelAudit(trace.getTracer("driverkit")) });
 * ```
 *
 * ONE SPAN PER CALL, with real start and end times taken from the record, so
 * the span's duration is the call's duration — approval included, which is the
 * part of a gated bulk commit a reader most often wants back. The span is
 * created and ended inside this function rather than wrapping the call,
 * because the record arrives after the outcome is decided: there is no live
 * context to parent into, and pretending otherwise would mean holding an open
 * span across a verb and reporting a duration from a clock the core does not
 * own.
 *
 * WHAT IT DOES NOT DO, and each one is a decision rather than an omission:
 *
 *   It does not parent the span into the ambient context. A driverkit call
 *   arrives from a model turn, a relay frame or a click, and in the page there
 *   is no active span to attach to; a span nested under whatever happened to be
 *   active would claim a causal link the library cannot verify. An audit record
 *   is a standalone fact about an app, which is what a root span says.
 *
 *   It does not mark a refusal as an error. A refusal is an ordinary outcome —
 *   `declined-by-user` is a person saying no and `stale-plan` is the safety
 *   mechanism working — and an exporter that painted those red would light up
 *   a dashboard for every correctly refused call, which is a warning on
 *   everything and therefore a warning on nothing. The slug is on the span as
 *   `driverkit.refused`, so filtering for one is a query. The ONE exception is
 *   `threw`, which is the core's word for the app's own code being broken, and
 *   which is an error in anybody's reading.
 *
 *   It does not batch, retry or flush. The SDK the host registered does all
 *   three, and better.
 */
export function otelAudit(
  tracer: AuditTracer,
  options: OtelAuditOptions = {},
): (event: AuditEvent) => void {
  const withArgs = options.args !== false;
  const prefix = options.prefix ?? "driverkit";

  return (event: AuditEvent): void => {
    const attributes: Record<string, string | number | boolean> = {
      "driverkit.app": event.app,
      "driverkit.verb": event.verb,
      "driverkit.rev": event.rev,
      "driverkit.ok": event.ok,
      // On every span, including a `read` in an app with no gate, because
      // "nobody was asked" is the fact an auditor is checking for and a field
      // that appeared only when somebody WAS asked would make its absence
      // ambiguous between "not asked" and "this exporter is out of date".
      "driverkit.approval": event.approval,
      "driverkit.policy": event.policy,
    };
    if (event.kind !== undefined) attributes["driverkit.kind"] = event.kind;
    if (event.reversible !== undefined) attributes["driverkit.reversible"] = event.reversible;
    if (event.screen !== undefined) attributes["driverkit.screen"] = event.screen;
    if (event.refused !== undefined) attributes["driverkit.refused"] = event.refused;
    if (event.count !== undefined) attributes["driverkit.count"] = event.count;
    if (event.plan !== undefined) attributes["driverkit.plan"] = event.plan;
    if (event.minted !== undefined) attributes["driverkit.plan.minted"] = event.minted;
    // What the agent CLAIMED, beside what was true. The pair is the whole of a
    // `stale` or a `wrong-screen`, and a span carrying only one side cannot
    // show why the call was refused.
    if (event.claimed?.rev !== undefined) attributes["driverkit.claimed.rev"] = event.claimed.rev;
    if (event.claimed?.screen !== undefined) {
      attributes["driverkit.claimed.screen"] = event.claimed.screen;
    }
    // The redacted field NAMES go on the span even when the values do not, and
    // even when `args: false`. "This call carried a secret and it was replaced"
    // is itself an audit fact: without it, a reader cannot tell a record that
    // was cleaned from one that never had anything to clean.
    if (event.redacted !== undefined) attributes["driverkit.redacted"] = event.redacted.join(",");
    if (withArgs) {
      for (const [name, value] of Object.entries(event.args)) {
        // `null` is a legal `Scalar` and not a legal attribute value, so it is
        // written as the string the agent meant by it rather than dropped: a
        // missing attribute would read as an argument that was never sent.
        attributes[`driverkit.arg.${name}`] = value === null ? "null" : value;
      }
    }

    const span = tracer.startSpan(`${prefix} ${event.verb}`, {
      startTime: event.at - event.ms,
      attributes,
    });
    if (event.refused === "threw") {
      span.setStatus({ code: STATUS_ERROR, message: "the verb threw" });
    } else {
      span.setStatus({ code: STATUS_OK });
    }
    span.end(event.at);
  };
}
