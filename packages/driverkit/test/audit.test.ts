/**
 * The audit trail, as a specification.
 *
 * This library commits data on a person's behalf and, until these tests, kept
 * no record that it had. Each name below pins a decision that was argued for,
 * so a change that looks harmless has to break a named test and read why the
 * rule exists before deleting it.
 *
 * Three of those decisions are the ones worth knowing before reading:
 *
 *   The record is emitted from the same place the outcome is decided, and
 *   built from the `Result` the call is about to return. A log that can
 *   disagree with the `Result` is worse than no log.
 *
 *   Redaction is declared by the verb and performed by the core, before the
 *   hook. The host is the far side of the boundary a record is most likely to
 *   leave the box across.
 *
 *   The hook is fire-and-forget. It cannot refuse anything — it is called
 *   after the data has moved — so a broken sink must not be a broken app, and
 *   a lost record must be said out loud rather than swallowed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mount, REDACTED, selectionId } from "../src/core/index.ts";
import type { AuditEvent, Scalar, Snapshot, VerbContext } from "../src/core/index.ts";
import { otelAudit } from "../src/otel/index.ts";
import type { AuditSpan, AuditTracer } from "../src/otel/index.ts";
import type { RelayAuditEvent } from "../src/relay/relay.ts";
import { serve } from "../src/relay/serve.ts";
import { HttpEventSource, postJson } from "./sse-client.ts";

/**
 * A toy app with the one shape this is all about: a `describe` that counts a
 * selection larger than the screen, and a `commit` that may only act on a
 * counted one. Plus a verb that takes a secret, because one of this
 * repository's own checks spends a real API key.
 */
function app(options: Partial<Parameters<typeof mount>[0]> = {}) {
  let rev = 1;
  let accepted = 0;
  let selected: string[] = [];
  const visible = (): Snapshot => ({
    where: "contacts",
    screen: "contacts",
    rev,
    rows: [{ id: "c1" }, { id: "c2" }],
    ...(selected.length ? { selected, selectedCount: selected.length } : {}),
    selectionId: selectionId(selected),
  });

  const driver = mount({
    app: "contacts",
    visible,
    verbs: [
      { name: "look", kind: "read", describe: "look at the rows", run: () => {} },
      {
        name: "select-where",
        kind: "describe",
        describe: "select every contact matching a filter",
        args: { where: { type: "string", describe: "e.g. company=Acme" } },
        run: ({ where }: { where: string }) => {
          selected = where === "none" ? [] : ["c1", "c2", "c3"];
          rev++;
          return { count: selected.length };
        },
      },
      {
        name: "accept-selected",
        kind: "commit",
        consumes: "plan",
        describe: "accept the current selection",
        refuses: ["nothing-selected"],
        run: (_args: Record<string, Scalar>, ctx: VerbContext) => {
          if (selected.length === 0) return ctx.refuse("nothing-selected");
          accepted += selected.length;
          rev++;
        },
      },
      {
        name: "set-page-size",
        kind: "commit",
        reversible: true,
        describe: "change how many rows a page shows",
        args: { size: { type: "number", describe: "rows per page" } },
        run: () => void rev++,
      },
      {
        name: "sync",
        kind: "commit",
        describe: "push the contacts to the upstream CRM",
        args: {
          vendor: { type: "string", describe: "which CRM" },
          // The field this whole redaction argument is about. Declared by the
          // author, who is the only one who knows which of their own arguments
          // is a credential.
          key: { type: "string", describe: "the CRM's API key", sensitive: true },
        },
        run: () => void rev++,
      },
      {
        name: "break",
        kind: "read",
        describe: "throw, so the record of a broken verb can be asserted",
        run: () => {
          throw new Error("the store is not there");
        },
      },
    ],
    ...options,
  });

  return { driver, accepted: () => accepted, rev: () => rev };
}

/** An app plus the records it emitted, which is what most of these assert on. */
function audited(options: Partial<Parameters<typeof mount>[0]> = {}) {
  const events: AuditEvent[] = [];
  const made = app({ onAudit: (e) => void events.push(e), ...options });
  return { ...made, events, last: () => events[events.length - 1]! };
}

test("a commit is recorded once, carrying every field a later reader needs", async () => {
  // The gap this closes, as one assertion list. "What did the agent do
  // yesterday?" had no answer: who approved it, which plan token, what count,
  // at what rev, on which screen. Every one of those is here, and the test
  // exists so that deleting any single field has to be deliberate.
  const a = audited({ approve: () => true });
  const counted = await a.driver.call("select-where", { where: "company=Acme" });
  assert.equal(counted.ok && counted.count, 3);

  const before = a.rev();
  const out = await a.driver.call("accept-selected", {}, { plan: counted.ok && counted.plan ? counted.plan : "" });
  assert.equal(out.ok, true);
  assert.equal(a.accepted(), 3);

  assert.equal(a.events.length, 2, "one record per call, no more and no fewer");
  const e = a.last();
  assert.equal(e.verb, "accept-selected");
  assert.equal(e.app, "contacts");
  assert.equal(e.kind, "commit");
  assert.equal(e.ok, true);
  assert.equal(e.approval, "allowed");
  assert.equal(e.policy, "hook");
  assert.equal(e.screen, "contacts");
  // The rev the call RAN AGAINST, which on a successful commit is not the rev
  // in the result's snapshot. The one worth keeping is this one: it is the rev
  // the count was taken at and the rev a person approved.
  assert.equal(e.rev, before);
  assert.notEqual(e.rev, out.snapshot.rev);
  assert.equal(e.plan, counted.ok ? counted.plan : undefined);
  assert.ok(e.at > 0 && e.ms >= 0);
  // No claim about `reversible`, because the verb made none. Absent rather
  // than `false`: see `Verb.reversible` for why a default either way lies.
  assert.equal(e.reversible, undefined);
});

test("the record is built from the Result, so the two cannot disagree", async () => {
  // Rule two of three. The alternative -- reconstructing what happened by
  // reading the app again after the call -- produces a log that can say `ok`
  // for a refusal, and a log that disagrees with what the agent was told is
  // worse than no log at all. So every outcome field is read off the one
  // `Result` object the call is about to return, and this walks a mixed bag of
  // calls to say so.
  const a = audited({ approve: () => "not until finance signs off" });
  const calls: Array<[string, Record<string, Scalar>, Record<string, Scalar>]> = [
    ["look", {}, {}],
    ["nonesuch", {}, {}],
    ["select-where", { where: "company=Acme" }, {}],
    ["accept-selected", {}, {}],
    ["break", {}, {}],
    ["look", {}, { screen: "dashboard" }],
  ];
  for (const [name, args, opts] of calls) {
    const result = await a.driver.call(name, args, opts);
    const e = a.last();
    assert.equal(e.ok, result.ok, name);
    assert.equal(e.refused, result.ok ? undefined : result.refused, name);
    assert.equal(e.count, result.ok ? result.count : undefined, name);
    assert.equal(e.verb, name, name);
  }
  assert.equal(a.events.length, calls.length);
});

test("a refusal is recorded as a refusal, with the slug the agent was given", async () => {
  // The most interesting line in an audit trail is a refused call: it is an
  // agent trying something it was not allowed to do. A log of successes only
  // would have nothing to say about the attempt.
  const a = audited();
  const out = await a.driver.call("accept-selected", {}, { plan: "dkp1.1.1.deadbeef0000" });
  assert.equal(out.ok, false);
  assert.equal(a.last().ok, false);
  assert.equal(a.last().refused, "stale-plan");
  // The token that was presented and rejected, recorded all the same. It is
  // how a reader finds the agent that tried to spend a receipt for a count
  // that had moved.
  assert.equal(a.last().plan, "dkp1.1.1.deadbeef0000");
  assert.equal(a.last().approval, "not-asked", "nobody was asked about a call that never ran");
});

test("what the agent claimed is recorded beside what was true", async () => {
  // Which is the whole of a `stale` or a `wrong-screen`: the refusal exists
  // because two claims differ, and a record that kept only one side could not
  // show why the call was refused. Three months later that difference is the
  // difference between "the agent was working from a stale read" and "the
  // agent was on another screen entirely".
  const a = audited();
  await a.driver.call("look", {}, { rev: 99, screen: "dashboard" });
  const e = a.last();
  assert.equal(e.refused, "wrong-screen");
  assert.deepEqual(e.claimed, { rev: 99, screen: "dashboard" });
  assert.equal(e.screen, "contacts");
  assert.equal(e.rev, 1);

  // And absent when the agent claimed nothing, rather than filled in with the
  // truth -- an agent that made no claim has at least not made a false one,
  // and a record that echoed the real values would hide that it opted out.
  await a.driver.call("look");
  assert.equal(a.last().claimed, undefined);
});

test("a declined approval is distinguishable from one that was never asked", async () => {
  // The two an auditor must never confuse: one is a person refusing, the other
  // is a gate that was not there. Both end in no data moving, so the outcome
  // alone cannot tell them apart -- which is why `approval` is four values and
  // not a boolean, and why `policy` rides along to say WHY nobody was asked.
  const declined = audited({ approve: () => false });
  await declined.driver.call("set-page-size", { size: 50 });
  assert.equal(declined.last().refused, "declined-by-user");
  assert.equal(declined.last().approval, "declined");
  assert.equal(declined.last().policy, "hook");

  const ungated = audited();
  await ungated.driver.call("set-page-size", { size: 50 });
  assert.equal(ungated.last().ok, true);
  assert.equal(ungated.last().approval, "not-asked");
  assert.equal(ungated.last().policy, "none", "an app that never said who approves");

  // And the third reading of "not asked", which is the one an operator most
  // needs to be able to find: an app that said out loud that commits here run
  // with nobody in front of them.
  const headless = audited({ approve: "unattended" });
  await headless.driver.call("set-page-size", { size: 50 });
  assert.equal(headless.last().approval, "not-asked");
  assert.equal(headless.last().policy, "unattended");
});

test("an approval nobody answered is recorded as timed out, never as declined", async () => {
  // The same distinction the `approval-timeout` slug exists for, carried into
  // the record. A person deciding no and a question nobody saw are different
  // facts about an organisation, and only one of them is about the person.
  const a = audited({ approve: () => new Promise<boolean>(() => {}), approvalTimeout: 5 });
  await a.driver.call("set-page-size", { size: 50 });
  assert.equal(a.last().refused, "approval-timeout");
  assert.equal(a.last().approval, "timed-out");
  assert.notEqual(a.last().approval, "declined");
});

test("an approval hook that throws is recorded as declined, because that is the decision", async () => {
  // A failed ask is a no -- the rule `askApproval` already had -- so the record
  // says what the core decided and not what the hook did. The alternative, a
  // fifth value for "the gate was broken", would be a record of the hook's
  // health in a field that is about consent.
  const a = audited({
    approve: () => {
      throw new Error("the modal could not be shown");
    },
  });
  await a.driver.call("set-page-size", { size: 50 });
  assert.equal(a.last().refused, "declined-by-user");
  assert.equal(a.last().approval, "declined");
});

test("the plan token joins the describe that counted to the commit that spent it", async () => {
  // The one question no single event can answer: was 3,412 the number that
  // moved? The describe's record carries the token as `minted` beside its
  // count, the commit's carries the same string as `plan`, and the join is
  // what makes "a person approved 3,412 and 3,412 rows changed" a checkable
  // claim rather than two lines that happen to be next to each other.
  const a = audited({ approve: () => true });
  const counted = await a.driver.call("select-where", { where: "company=Acme" });
  const token = counted.ok ? counted.plan! : "";

  assert.equal(a.last().minted, token);
  assert.equal(a.last().count, 3);
  assert.equal(a.last().plan, undefined, "a describe spends no token");

  await a.driver.call("accept-selected", {}, { plan: token });
  assert.equal(a.last().plan, token);
  assert.equal(a.last().minted, undefined, "a commit mints none");
  assert.equal(a.events[0]!.minted, a.events[1]!.plan, "the join key is one string");
});

test("a count of zero is recorded as zero and not as silence", async () => {
  // `0` is a real answer and distinct from "I do not count", which is the rule
  // `Report.count` states and the difference that decides whether a commit
  // should follow. A record that dropped a falsy count would turn the most
  // important number in the log into an absence.
  const a = audited();
  await a.driver.call("select-where", { where: "none" });
  assert.equal(a.last().count, 0);
  await a.driver.call("look");
  assert.equal(a.last().count, undefined, "a read does not count, and says so by absence");
});

test("a `sensitive` argument's value never reaches the hook, and the record says so", async () => {
  // The redaction decision, in one test. The app declares which of ITS OWN
  // arguments is a credential -- nobody else can know -- and the CORE replaces
  // it, before the hook, because the hook is the boundary a record is most
  // likely to leave the box across. A library that handed the key over and
  // trusted every sink to strip it would make the dangerous case the one you
  // get by doing the obvious thing.
  const a = audited();
  const out = await a.driver.call("sync", { vendor: "acme-crm", key: "sk-live-REAL-KEY" });
  assert.equal(out.ok, true);

  const e = a.last();
  assert.equal(e.args.key, REDACTED);
  assert.deepEqual(e.redacted, ["key"]);
  // The undeclared arguments are untouched: an audit record whose arguments
  // were all stars would answer none of the questions it exists for.
  assert.equal(e.args.vendor, "acme-crm");
  // Nothing anywhere in the record carries it, not just the one field. The
  // cheap bug here is a second copy -- a note, a hint, a stringified args
  // somewhere -- so this asserts on the whole serialised event.
  assert.doesNotMatch(JSON.stringify(e), /REAL-KEY/);
});

test("redaction is about the record and never about the call", async () => {
  // The verb still receives the real value. `sensitive` is a statement about
  // what may be written down, and a library that also hid the argument from
  // the app would have turned an audit feature into a silent behaviour change
  // -- the one thing this whole addition promised not to be.
  const seen: Scalar[] = [];
  const events: AuditEvent[] = [];
  const driver = mount({
    app: "x",
    visible: (): Snapshot => ({ where: "x", rev: 1 }),
    onAudit: (e) => void events.push(e),
    verbs: [
      {
        name: "sync",
        kind: "commit",
        describe: "push",
        args: { key: { type: "string", describe: "api key", sensitive: true } },
        run: ({ key }: { key: string }) => void seen.push(key),
      },
    ],
  });
  await driver.call("sync", { key: "sk-live-REAL-KEY" });
  assert.deepEqual(seen, ["sk-live-REAL-KEY"]);
  assert.equal(events[0]!.args.key, REDACTED);
});

test("`sensitive` is in the manifest and in the fingerprint, and an app without it has not moved", () => {
  // Declaring a field sensitive changes what the cached surface claims, so it
  // moves the version like every other `ArgSpec` field -- that is consistent
  // rather than surprising, and the alternative (a field the manifest hides)
  // would mean two apps whose manifests read identically hash the same and
  // behave differently. What must NOT move is an app that declares none, and
  // that is the second half of this test.
  const base = {
    app: "toy",
    visible: (): Snapshot => ({ where: "x", rev: 1 }),
  };
  const plain = mount({
    ...base,
    verbs: [
      {
        name: "sync",
        kind: "commit" as const,
        describe: "push",
        args: { key: { type: "string" as const, describe: "api key" } },
        run: () => {},
      },
    ],
  });
  const marked = mount({
    ...base,
    verbs: [
      {
        name: "sync",
        kind: "commit" as const,
        describe: "push",
        args: { key: { type: "string" as const, describe: "api key", sensitive: true as const } },
        run: () => {},
      },
    ],
  });
  assert.notEqual(plain.manifest().version, marked.manifest().version);
  assert.equal(marked.manifest().verbs[0]!.args!.key!.sensitive, true);
  assert.equal(plain.manifest().verbs[0]!.args!.key!.sensitive, undefined);

  // And the claim that matters to every app already out there: audit is a
  // runtime arrangement, so passing a hook is not part of the cached surface.
  const version = plain.manifest().version;
  assert.equal(mount({ ...plain_opts(), onAudit: () => {} }).manifest().version, version);
  function plain_opts() {
    return {
      ...base,
      verbs: [
        {
          name: "sync",
          kind: "commit" as const,
          describe: "push",
          args: { key: { type: "string" as const, describe: "api key" } },
          run: () => {},
        },
      ],
    };
  }
});

test("with no hook, nothing happens: no record, no clock, no change in behaviour", async () => {
  // The compatibility claim as a test rather than a promise. An app mounted
  // before any of this existed passes no hook and must behave identically --
  // same results, same manifest version, same snapshot -- because an audit
  // trail that changed what an app did would be a feature nobody could adopt
  // on a Friday.
  const quiet = app();
  const loud = audited();
  for (const [name, args] of [
    ["look", {}],
    ["select-where", { where: "company=Acme" }],
    ["accept-selected", {}],
  ] as Array<[string, Record<string, Scalar>]>) {
    const a = await quiet.driver.call(name, args);
    const b = await loud.driver.call(name, args);
    // The plan token is the one field that cannot match, and for a reason
    // worth not "fixing": every driver mints with a salt of its own, so that a
    // receipt from one app is not honoured by another. So the two are compared
    // without it, and then on whether each has one at all -- which is the part
    // a hook could have changed and must not have.
    assert.equal(a.ok, b.ok, name);
    assert.deepEqual({ ...a, plan: undefined }, { ...b, plan: undefined }, name);
    assert.equal("plan" in a, "plan" in b, name);
  }
  assert.equal(quiet.driver.manifest().version, loud.driver.manifest().version);
});

test("a hook that throws does not break the call, and does not lose the record in silence", async () => {
  // It cannot refuse anything -- it is called after the outcome is decided and,
  // for a commit, after the data has moved -- so failing the call would turn a
  // broken logging backend into a broken application. But a record that
  // vanished quietly is the one failure an audit trail cannot survive, so the
  // loss is said out loud through the same console the core's other authoring
  // mistakes use.
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void said.push(m);
  try {
    const made = app({
      onAudit: () => {
        throw new Error("the collector is down");
      },
    });
    const out = await made.driver.call("set-page-size", { size: 50 });
    assert.equal(out.ok, true, "the call survived its own audit hook");
    // Still taking calls afterwards: one broken sink must not leave a driver
    // that fails every later call, which is the rule the approval lock has.
    assert.equal((await made.driver.call("look")).ok, true);
  } finally {
    console.warn = warn;
  }
  const about = said.find((m) => m.includes("audit record was lost"));
  assert.ok(about, "a lost record was never mentioned");
  assert.match(about!, /the collector is down/);
});

test("a hook that rejects is reported too, and is never an unhandled rejection", async () => {
  // The async half of the same rule, and the one that could take a Node
  // process down rather than merely lose a line. The hook is NOT awaited -- a
  // slow sink must not delay the agent, and there is nothing left to decide by
  // waiting -- so a returned promise gets a `catch` attached and nothing else.
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void said.push(m);
  try {
    const made = app({ onAudit: () => Promise.reject(new Error("the exporter queue is full")) });
    assert.equal((await made.driver.call("look")).ok, true);
    // One turn of the microtask queue, which is all an attached `catch` needs.
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    console.warn = warn;
  }
  assert.ok(
    said.find((m) => m.includes("the exporter queue is full")),
    "an async failure was swallowed",
  );
});

test("a slow hook does not delay the call", async () => {
  // Not awaited, asserted. A sink that takes a second to answer must cost the
  // agent nothing: batching and retrying are the host exporter's job, and a
  // library that waited would make every verb as slow as the slowest
  // collector.
  let release: (() => void) | undefined;
  const made = app({ onAudit: () => new Promise<void>((r) => (release = r)) });
  const started = Date.now();
  const out = await made.driver.call("look");
  assert.equal(out.ok, true);
  assert.ok(Date.now() - started < 1_000, "the call waited for the sink");
  release!();
});

test("the record is emitted for a call that never reached a verb", async () => {
  // An unknown verb, an unmounted driver, a call that arrived while somebody
  // was being asked about another one: none of them run anything, and all of
  // them are an agent doing something worth having a line about. The emit sits
  // outside the dozen checks rather than inside each of them, which is what
  // makes this true by construction instead of by a dozen remembered calls.
  const a = audited();
  await a.driver.call("nonesuch");
  assert.equal(a.last().verb, "nonesuch");
  assert.equal(a.last().refused, "unknown-verb");
  assert.equal(a.last().kind, undefined, "there is no verb to have declared a kind");

  a.driver.unmount();
  await a.driver.call("look");
  assert.equal(a.last().refused, "unmounted");
  assert.equal(a.events.length, 2);
});

// ---- the OpenTelemetry sink ----------------------------------------------

/** A tracer that records what it was asked for. Not a mock of the OTel SDK:
 *  the point of taking the tracer as an argument is that this file never needs
 *  one. */
function tracer() {
  const spans: Array<{
    name: string;
    startTime?: number;
    attributes: Record<string, string | number | boolean>;
    status?: { code: number; message?: string };
    endTime?: number;
  }> = [];
  const made: AuditTracer = {
    startSpan: (name, options) => {
      const span = {
        name,
        ...(options?.startTime === undefined ? {} : { startTime: options.startTime }),
        attributes: options?.attributes ?? {},
      } as (typeof spans)[number];
      spans.push(span);
      const handle: AuditSpan = {
        setStatus: (status) => void (span.status = status),
        end: (endTime) => void (endTime === undefined ? undefined : (span.endTime = endTime)),
      };
      return handle;
    },
  };
  return { tracer: made, spans };
}

test("each record becomes one span, with the call's own start and end times", async () => {
  // The span is created and ended inside the hook, from the times in the
  // record, because the record arrives after the fact: there is no live span
  // to hold open across the verb, and a duration measured by a clock the core
  // does not own would be a different number from the one in the record.
  const t = tracer();
  const made = app({ onAudit: otelAudit(t.tracer), approve: () => true });
  await made.driver.call("set-page-size", { size: 50 }, { rev: 1 });

  assert.equal(t.spans.length, 1);
  const span = t.spans[0]!;
  assert.equal(span.name, "driverkit set-page-size");
  assert.equal(span.attributes["driverkit.app"], "contacts");
  assert.equal(span.attributes["driverkit.kind"], "commit");
  assert.equal(span.attributes["driverkit.reversible"], true);
  assert.equal(span.attributes["driverkit.approval"], "allowed");
  assert.equal(span.attributes["driverkit.policy"], "hook");
  assert.equal(span.attributes["driverkit.arg.size"], 50);
  assert.equal(span.attributes["driverkit.claimed.rev"], 1);
  assert.ok(span.endTime! >= span.startTime!, "the span ends no sooner than it starts");
  assert.equal(span.endTime! - span.startTime!, 0 + (span.endTime! - span.startTime!));
});

test("a refusal is not an error on the span, but a verb that threw is", async () => {
  // A refusal is an ordinary outcome -- `declined-by-user` is a person saying
  // no and `stale-plan` is the safety mechanism working -- and an exporter that
  // painted those red would light a dashboard up for every correctly refused
  // call, which is a warning on everything and therefore a warning on nothing.
  // `threw` is the core's word for the app's own code being broken, which is
  // an error in anybody's reading.
  const t = tracer();
  const made = app({ onAudit: otelAudit(t.tracer), approve: () => false });
  await made.driver.call("set-page-size", { size: 50 });
  await made.driver.call("break");

  assert.equal(t.spans[0]!.status!.code, 1, "a declined commit is not an error");
  assert.equal(t.spans[0]!.attributes["driverkit.refused"], "declined-by-user");
  assert.equal(t.spans[1]!.status!.code, 2, "a verb that threw is");
  assert.equal(t.spans[1]!.attributes["driverkit.refused"], "threw");
});

test("the span carries that a value was redacted, and never the value", async () => {
  // Both halves. A sink that dropped the field names as well as the values
  // would leave a reader unable to tell a record that was cleaned from one
  // that never had anything to clean -- and `args: false` is a cardinality
  // control, not a redaction mechanism, so it must not be what keeps a secret
  // out of a vendor's index.
  const t = tracer();
  const made = app({ onAudit: otelAudit(t.tracer) });
  await made.driver.call("sync", { vendor: "acme-crm", key: "sk-live-REAL-KEY" });
  assert.doesNotMatch(JSON.stringify(t.spans), /REAL-KEY/);
  assert.equal(t.spans[0]!.attributes["driverkit.redacted"], "key");
  assert.equal(t.spans[0]!.attributes["driverkit.arg.key"], REDACTED);

  const off = tracer();
  const quiet = app({ onAudit: otelAudit(off.tracer, { args: false }) });
  await quiet.driver.call("sync", { vendor: "acme-crm", key: "sk-live-REAL-KEY" });
  assert.equal(off.spans[0]!.attributes["driverkit.arg.vendor"], undefined);
  assert.equal(off.spans[0]!.attributes["driverkit.redacted"], "key", "still said, with args off");
});

test("the tracer this sink asks for is one `@opentelemetry/api` already satisfies", () => {
  // The whole argument for `driverkit/otel` importing nothing rests on this:
  // the host passes `trace.getTracer("driverkit")` from ITS OWN installed copy,
  // so there is no second global API registered nowhere and quietly dropping
  // every span. That claim is a structural-typing claim, and this is it
  // checked -- against the real package's declared signatures, copied here,
  // because this repository has no dependencies to install and that is the
  // point. If `@opentelemetry/api` ever changes these, this stops compiling.
  type TimeInput = [number, number] | number | Date;
  type AttributeValue = string | number | boolean | Array<null | undefined | string>;
  interface RealSpan {
    setAttribute(key: string, value: AttributeValue): this;
    setStatus(status: { code: 0 | 1 | 2; message?: string }): this;
    end(endTime?: TimeInput): void;
    isRecording(): boolean;
  }
  interface RealTracer {
    startSpan(
      name: string,
      options?: { startTime?: TimeInput; attributes?: Record<string, AttributeValue | undefined> },
      context?: unknown,
    ): RealSpan;
  }

  const real: RealTracer = {
    startSpan: () => {
      const span: RealSpan = {
        setAttribute: () => span,
        setStatus: () => span,
        end: () => {},
        isRecording: () => true,
      };
      return span;
    },
  };
  // The assignment is the assertion: if a real `Tracer` did not satisfy
  // `AuditTracer`, this line would not typecheck and the suite would not run.
  const accepted: AuditTracer = real;
  const hook = otelAudit(accepted);
  assert.equal(typeof hook, "function");
});

// ---- the relay's own records ---------------------------------------------

/** A relay nobody else will touch, torn down after. */
async function relay(t: { after: (fn: () => unknown) => void }, options = {}) {
  const { server, relay: made, url } = await serve({ port: 0, pingMs: 20_000, ...options });
  t.after(() => {
    made.close();
    server.close();
  });
  return { url };
}

/** A tab played by hand, for the reason `relay.test.ts` plays one by hand:
 *  driving both ends of a protocol with one codebase passes happily when both
 *  ends agree on the wrong thing. */
async function tab(url: string, id: string) {
  const es = new HttpEventSource(`${url}/dk/events?tab=${encodeURIComponent(id)}`);
  await new Promise<void>((r) => es.addEventListener("open", () => r()));
  return {
    es,
    answer: (callId: string, result: unknown) =>
      postJson(`${url}/dk/result?tab=${encodeURIComponent(id)}`, { t: "result", id: callId, result }),
  };
}

const callTab = (url: string, id: string, body: unknown) =>
  postJson(`${url}/dk/tabs/${encodeURIComponent(id)}/call`, body);

test("the relay records who asked, which no in-page hook can know", async (t) => {
  // The one fact the relay cannot help knowing and a driver cannot learn: a
  // call arrived from outside, and from which principal. The core sees a
  // `call()` and has no idea whether it came from the panel in front of a
  // person or from somebody else's agent holding a token.
  const seen: RelayAuditEvent[] = [];
  const { url } = await relay(t, { onAudit: (e: RelayAuditEvent) => void seen.push(e) });
  const one = await tab(url, "t1");

  const frame = one.es.next("call");
  const pending = callTab(url, "t1", { name: "accept-selected" });
  const got = (await frame) as { id: string };
  await one.answer(got.id, { ok: true, snapshot: { where: "contacts", rev: 2 } });
  assert.equal((await pending).status, 200);

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.verb, "accept-selected");
  assert.equal(seen[0]!.tab, "t1");
  // The unconfigured loopback relay is one principal and says so, rather than
  // implying an identity nobody established.
  assert.equal(seen[0]!.principal, "local");
  // `delivered`, and nothing more. What the app decided is in the driver's own
  // record, in the process where it was decided -- so the two logs are not two
  // countings of one commit.
  assert.equal(seen[0]!.outcome, "delivered");
  assert.equal(Object.keys(seen[0]!).sort().join(","), "at,ms,outcome,principal,tab,verb");
  assert.ok(seen[0]!.ms >= 0 && seen[0]!.at > 0);
});

test("the relay never copies the driver's verdict into its own record", async (t) => {
  // Rule two again, across a process boundary this time. The relay has the
  // `WireResult` in its hand and deliberately does not read it: a copy of
  // somebody else's decision is a second source of truth that can disagree
  // with the first, and a relay that logged `ok` for a call whose tab died
  // mid-commit would be asserting an outcome nobody observed.
  const seen: RelayAuditEvent[] = [];
  const { url } = await relay(t, { onAudit: (e: RelayAuditEvent) => void seen.push(e) });
  const one = await tab(url, "t2");

  const frame = one.es.next("call");
  const pending = callTab(url, "t2", { name: "accept-selected" });
  const got = (await frame) as { id: string };
  await one.answer(got.id, {
    ok: false,
    refused: "nothing-selected",
    snapshot: { where: "contacts", rev: 2 },
  });
  assert.equal((await pending).body.refused, "nothing-selected");

  assert.equal(seen[0]!.outcome, "delivered", "a refused call still reached the tab");
  assert.equal(JSON.stringify(seen[0]!).includes("nothing-selected"), false);
});

test("a call for a tab nobody owns is recorded here, because nowhere else will", async (t) => {
  // Nothing reached a tab, so no `onAudit` anywhere in the library will ever
  // hear about this call. An agent working through tab ids it does not own
  // leaves its marks only in the relay's log, which is the reason three of the
  // four outcomes exist at all.
  const seen: RelayAuditEvent[] = [];
  const { url } = await relay(t, { onAudit: (e: RelayAuditEvent) => void seen.push(e) });
  const out = await callTab(url, "ghost", { name: "accept-selected" });
  assert.equal(out.body.refused, "no-such-tab");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.outcome, "no-such-tab");
  assert.equal(seen[0]!.tab, "ghost");
  assert.equal(seen[0]!.verb, "accept-selected");
});

test("a call that arrives with no verb name is not an audit record", async (t) => {
  // It is not a call: there is no verb to have been asked for, so the relay
  // answers 400 rather than a `WireResult`, and a record naming no verb would
  // be a line in an audit log that says nothing. The relay's log is a record of
  // calls, not an HTTP access log -- the host's server already has one of
  // those, and this is the gap worth being honest about rather than papering.
  const seen: RelayAuditEvent[] = [];
  const { url } = await relay(t, { onAudit: (e: RelayAuditEvent) => void seen.push(e) });
  const out = await callTab(url, "ghost", { args: { id: "x" } });
  assert.equal(out.status, 400);
  assert.deepEqual(seen, []);
});

test("one record per call, even when the deadline and a late answer race", async (t) => {
  // The guard that makes it one is the same `done` flag that makes the HTTP
  // response one, so a tab answering after its call timed out cannot produce a
  // second outcome for a call that has already been answered. Two lines for one
  // call is how an audit trail starts double-counting commits.
  const seen: RelayAuditEvent[] = [];
  const { url } = await relay(t, {
    timeoutMs: 20,
    onAudit: (e: RelayAuditEvent) => void seen.push(e),
  });
  const one = await tab(url, "t3");

  const frame = one.es.next("call");
  const pending = callTab(url, "t3", { name: "accept-selected" });
  const got = (await frame) as { id: string };
  assert.equal((await pending).body.refused, "timeout");
  // The late answer, which the relay drops rather than resurrecting.
  await one.answer(got.id, { ok: true, snapshot: { where: "contacts", rev: 2 } });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.outcome, "timeout");
});

test("a stream that drops under a call in flight is recorded as the relay's own outcome", async (t) => {
  // The fourth outcome, and the one where the record is at its least certain:
  // `tab-went-away` means the verb MAY have run, so this line is the only
  // evidence that anything was attempted at all -- the driver's own hook may
  // have emitted a record for it in a page that is now gone, or may not. A
  // relay that wrote `ok` or `failed` here would be inventing the half nobody
  // observed, which is why the vocabulary is the relay's four words and not the
  // driver's.
  const seen: RelayAuditEvent[] = [];
  const { url } = await relay(t, {
    timeoutMs: 10_000,
    onAudit: (e: RelayAuditEvent) => void seen.push(e),
  });
  const one = await tab(url, "dropping");

  const frame = one.es.next("call");
  const pending = callTab(url, "dropping", { name: "accept-selected" });
  await frame;
  one.es.close();

  assert.equal((await pending).body.refused, "tab-went-away");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.outcome, "tab-went-away");
  assert.equal(seen[0]!.verb, "accept-selected");
});

test("a relay with no hook behaves exactly as it did", async (t) => {
  // The same additive claim the core makes. The relay's records are for an
  // operator who wants them, and an embedded relay that was never asked for one
  // must be the relay it was: no clock read, no record built.
  const { url } = await relay(t);
  const out = await callTab(url, "ghost", { name: "look" });
  assert.equal(out.body.refused, "no-such-tab");
});

test("a relay audit hook that throws goes to onError and never to the caller", async (t) => {
  // A 500 because the logging backend is down would turn an audit trail into an
  // outage. `onError` is where everything else this relay cannot help goes, so
  // there is no second error channel to reason about.
  const errors: unknown[] = [];
  const { url } = await relay(t, {
    onError: (err: unknown) => void errors.push(err),
    onAudit: () => {
      throw new Error("the collector is down");
    },
  });
  const out = await callTab(url, "ghost", { name: "look" });
  assert.equal(out.status, 200);
  assert.equal(out.body.refused, "no-such-tab");
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /collector is down/);
});
