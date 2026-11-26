"""
driverkit — the types, mirroring ``packages/driverkit/src/core/types.ts``.

These dataclasses are not a convenience layer over dicts; they are the Python
end of a wire contract. Every field name here matches the TypeScript interface
it mirrors, and ``to_dict``/``from_dict`` are the only places a name is spelled
twice. The reason to be strict about it: the manifest an agent caches was
serialised by the TS core, and a Python client that quietly renames a field
produces a tool list that no longer describes the app it is driving.

Two shapes read differently in Python than in TypeScript and are called out
where they are defined:

* ``Row`` is ``{ id, ...columns }`` in TS — an index signature. Python has no
  such thing, so the extra columns live in a dict and are flattened back out on
  the way to JSON.
* ``Result`` is a discriminated union in TS. Python gets one dataclass with an
  ``ok`` flag, because a union of two dataclasses would make every caller
  ``isinstance``-check before reading ``snapshot``, which both arms carry.

Unknown fields are ignored on the way in. PROTOCOL.md promises a field may be
added without a version bump, so a strict parser here would turn an additive
change on the relay into a broken client.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

__all__ = [
    "Scalar",
    "VerbKind",
    "VERB_KINDS",
    "RELAY_REFUSALS",
    "UNKNOWN_OUTCOME",
    "ArgSpec",
    "VerbSpec",
    "ScreenSpec",
    "FlowStep",
    "FlowSpec",
    "Manifest",
    "Row",
    "Page",
    "Snapshot",
    "Result",
    "Tab",
]

#: A value an agent can pass to a verb. The TS type is the same four: anything
#: that cannot survive JSON cannot cross the relay.
Scalar = str | int | float | bool | None

#: What a verb does to the world, declared in the cached half so an agent knows
#: before it calls: ``read`` changes no data and reports no count (it may still
#: move the person's screen — navigation is a read), ``describe`` changes what
#: is selected and reports a ``count``, ``commit`` changes data and may be
#: irreversible. Mirrors ``VerbKind``, whose comment carries the argument for
#: why navigation is a ``read`` and not a fourth kind.
VerbKind = str
VERB_KINDS = ("read", "describe", "commit")

#: Refusals that come from the relay rather than from an app's verb, as a
#: closed set. A client has to be able to tell "your app said no", which means
#: rephrase and retry, from "your call never landed", which means reconnect or
#: pick another tab. These three are reserved, along with the core's own
#: ``stale``, ``wrong-screen``, ``stale-plan``, ``unknown-verb``,
#: ``bad-argument``, ``unmounted`` and ``threw``:
#: an app that names one of its verb refusals the same thing takes that
#: distinction away, and if ``timeout`` can mean either then it means neither.
#: See ``RelayRefusal`` and PROTOCOL.md, "When a call never reaches a tab".
RELAY_REFUSALS = ("no-such-tab", "tab-went-away", "timeout")

#: Refusals that come from the approval gate in the core's ``call()`` rather
#: than from an app's verb. Reserved like the rest, and listed here so a client
#: can tell them apart from the relay's.
#:
#: ``declined-by-user`` is a person saying no to a ``commit`` before it ran.
#: ``approval-pending`` is a call that arrived while somebody was being asked
#: about another one — nothing ran, and it is a refusal rather than a queue
#: because the call an agent is most likely to make in that window is the
#: Approve button of the dialog asking it (webmachinelearning/webmcp#288).
#:
#: ``approval-timeout`` must never be folded into the relay's ``timeout``, and
#: that is the whole reason it is a separate slug. The relay's means the call
#: was accepted and no answer came back, so the outcome is **unknown** and a
#: commit may already have run; this one means nobody answered the question, so
#: the verb was never reached and nothing changed. Opposite next moves: read
#: the screen before touching anything, versus ask a person and call again.
#: Which is why it is deliberately absent from :data:`UNKNOWN_OUTCOME`.
APPROVAL_REFUSALS = ("declined-by-user", "approval-pending", "approval-timeout")

#: The relay refusals that leave the outcome **unknown** rather than failed.
#:
#: Only ``no-such-tab`` proves the call did not happen: it was never forwarded,
#: because there was nowhere to forward it. The other two are both "the call
#: was accepted and no answer came back" — the tab went quiet past the
#: deadline, or its stream closed and the answer died with it. In either case
#: the verb may well have run.
#:
#: The reflex this exists to block is treating a non-answer as a failed step
#: and retrying it, which is the one move that turns one bulk accept into two.
UNKNOWN_OUTCOME = ("timeout", "tab-went-away")


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    """Omit absent optional fields rather than sending ``null``.

    ``{"optional": null}`` and an absent ``optional`` mean the same thing to a
    tolerant reader, but they hash differently — and the manifest version in
    the TS core is a fingerprint of the serialised verb surface. Emitting
    explicit nulls would make a round-tripped manifest stop matching itself.
    """
    return {k: v for k, v in d.items() if v is not None}


def _screens(value: Any) -> str | tuple[str, ...] | None:
    """A verb's ``screen`` off the wire, in the shape it was sent in.

    One string, several, or nothing. The shape is preserved rather than
    normalised because the manifest is the cached half and its bytes are what a
    fingerprint is taken of: turning ``"contacts"`` into ``["contacts"]`` on a
    round trip would move the version of every app that names one screen, and
    tell every agent holding a cached copy that it had gone stale when nothing
    about the app had changed.
    """
    if isinstance(value, str):
        return value or None
    if isinstance(value, (list, tuple)):
        named = tuple(s for s in value if isinstance(s, str) and s)
        return named or None
    return None


@dataclass(frozen=True)
class ArgSpec:
    """What a verb accepts. Mirrors ``ArgSpec``."""

    type: str  # "string" | "number" | "boolean"
    describe: str
    one_of: tuple[Scalar, ...] | None = None  # wire name: oneOf
    optional: bool | None = None  # absent means required

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ArgSpec":
        one_of = d.get("oneOf")
        return cls(
            type=d["type"],
            describe=d.get("describe", ""),
            one_of=tuple(one_of) if one_of is not None else None,
            optional=d.get("optional"),
        )

    def to_dict(self) -> dict[str, Any]:
        return _drop_none(
            {
                "type": self.type,
                "describe": self.describe,
                "oneOf": list(self.one_of) if self.one_of is not None else None,
                "optional": self.optional,
            }
        )

    @property
    def required(self) -> bool:
        """Absent ``optional`` means required — stated once, here, so no caller
        has to remember that the default is the strict one."""
        return not self.optional


@dataclass(frozen=True)
class VerbSpec:
    """One entry of ``Manifest.verbs``.

    Note what this is *not*: it has no ``run``. The TS ``Verb`` carries a body
    and this does not, because the body never crosses the wire — only the
    surface an agent can observe does.
    """

    name: str
    describe: str
    args: dict[str, ArgSpec] = field(default_factory=dict)
    refuses: tuple[str, ...] = ()
    #: ``read`` | ``describe`` | ``commit``, or None when the app did not say.
    #:
    #: None is kept distinct from every kind rather than defaulted to one,
    #: because both defaults are wrong in a way that costs something. Reading
    #: it as ``read`` tells an agent an irreversible verb is free to try.
    #: Reading it as ``commit`` marks every verb of an app that predates the
    #: field as dangerous, and a warning on everything is a warning on nothing.
    #: Absent means absent: make no claim.
    kind: VerbKind | None = None
    #: The screen this verb belongs to, or the screens it belongs to, matched
    #: against ``Snapshot.screen``; None for "anywhere".
    #:
    #: The tool list does NOT vary with it, and must not: a verb list that
    #: changed on every navigation would bust the prompt prefix every time the
    #: person moved, which is the cost argument the library is built on. The
    #: mapping is static — which verb lives on which screen is the same for
    #: every user forever — and only which screen is live is dynamic. So the
    #: verb is offered everywhere and the core refuses it off its screens, with
    #: the live one and all of the verb's own in the hint. See ``Verb.screen``.
    #:
    #: Several screens because one string made the worked example lie:
    #: ``next-page`` pages both the contacts list and a company's contact list,
    #: and declaring either would refuse a call on a screen still publishing a
    #: ``page`` block. A tuple rather than a list for the reason ``refuses`` is
    #: one — this dataclass is frozen and therefore hashable, and one mutable
    #: field would take that away. ``from_dict`` accepts the wire's list and
    #: ``to_dict`` writes one back.
    screen: str | tuple[str, ...] | None = None
    #: True on a ``commit`` the app says it can undo, else None for "the app
    #: did not say".
    #:
    #: Not defaulted to either answer, for the reason ``kind`` is not:
    #: assuming reversible tells an agent a bulk accept can be taken back, and
    #: assuming irreversible marks every commit written before this field as
    #: the dangerous kind, which is a warning on everything. Only read for
    #: ``commit``; see ``Verb.reversible``.
    reversible: bool | None = None
    #: ``"plan"`` on a ``commit`` that may only be called with the token the
    #: ``describe`` verb returned beside its ``count``, else None.
    #:
    #: The field that turns the describe/commit pairing from advice into a
    #: guarantee. "A commit takes no predicate and acts on the current
    #: selection" re-reads the selection at call time, so between the two calls
    #: a person can tick a row or a websocket can land, and then the count that
    #: was read and approved is not provably the set that moved. With this, the
    #: core refuses the commit as ``stale-plan`` instead, naming both counts.
    #: Absent makes no claim and the verb may be called bare, which is what
    #: every commit written before this field does. See ``Verb.consumes``.
    consumes: str | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "VerbSpec":
        args = d.get("args") or {}
        kind = d.get("kind")
        reversible = d.get("reversible")
        screen = d.get("screen")
        return cls(
            name=d["name"],
            describe=d.get("describe", ""),
            args={k: ArgSpec.from_dict(v) for k, v in args.items()},
            refuses=tuple(d.get("refuses") or ()),
            # An unrecognised kind is dropped rather than passed through. A
            # future fourth kind means this code is out of date, and inventing
            # a safety claim from a word it does not know is the one thing it
            # must not do.
            kind=kind if kind in VERB_KINDS else None,
            # A string stays a string and a list becomes a tuple, so the shape
            # the app declared survives the round trip: a client that reads
            # `verbs[].screen` as a string goes on doing so for every
            # single-screen app. Non-strings inside a list are dropped rather
            # than coerced — `str(None)` is the screen id "None", which is a
            # screen no app has — and a list left empty by that, or sent empty,
            # becomes None: the core refuses `screen: []` at mount precisely
            # because "works nowhere" is nobody's intention, so a reader that
            # met one anyway would be inventing a claim from a mistake.
            screen=_screens(screen),
            # Only a literal True is a claim. The wire form is `true` or the
            # field is absent, so anything else — 0, "", "no" — is a relay or
            # an app getting it wrong, and the safe reading of a garbled
            # "you can undo this" is that nobody said it.
            reversible=True if reversible is True else None,
            # Only the one value the core mints, for the reason an unrecognised
            # `kind` is dropped: a word this code does not know is a manifest
            # from a newer core, and the safe reading is that this client cannot
            # satisfy the requirement rather than that it can. Dropping it means
            # the tool is rendered without a `plan` property and the call comes
            # back refused — which is visible — where honouring an unknown token
            # name would have this client hoist a field nothing ever fills.
            consumes="plan" if d.get("consumes") == "plan" else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "describe": self.describe}
        if self.kind is not None:
            out["kind"] = self.kind
        if self.screen is not None:
            out["screen"] = self.screen if isinstance(self.screen, str) else list(self.screen)
        if self.reversible:
            out["reversible"] = True
        if self.consumes is not None:
            out["consumes"] = self.consumes
        if self.args:
            out["args"] = {k: v.to_dict() for k, v in self.args.items()}
        if self.refuses:
            out["refuses"] = list(self.refuses)
        return out



@dataclass(frozen=True)
class ScreenSpec:
    """One entry of ``Manifest.screens``: a screen the app has.

    Mirrors ``ScreenSpec``, whose comment carries the argument. The short
    version: ``Snapshot.screen`` says which screen is live and ``Verb.screen``
    says where a verb works, and between them an agent still could not learn
    that a screen *exists* without standing on it — so the map is declared
    once, in the cached half, because the names of an app's screens are the
    same for every user forever.

    The rule a reader should not have to go and look up: this is every screen
    the APP has, never the screens the current user may reach. A list filtered
    by role or plan is a per-user list in the cached half, which busts the
    prompt prefix for everybody, and an absence is unfalsifiable — an agent
    that meets one concludes the feature does not exist. "You may not open
    that" is a refusal at the moment of the call.
    """

    id: str
    describe: str = ""
    #: An RFC 6570 URI template, or None for a screen with no address. Absent
    #: is not a defect: a modal, a wizard step and the whole of a router-less
    #: app are screens, and ``goto`` reaches them by id like any other.
    url: str | None = None
    #: What the template takes, by its own variable names. Typed so a wrong
    #: value is refused before anybody navigates.
    args: dict[str, ArgSpec] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ScreenSpec":
        url = d.get("url")
        return cls(
            id=str(d["id"]),
            describe=str(d.get("describe", "")),
            url=str(url) if isinstance(url, str) and url else None,
            args={k: ArgSpec.from_dict(v) for k, v in (d.get("args") or {}).items()},
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "describe": self.describe}
        if self.url is not None:
            out["url"] = self.url
        if self.args:
            out["args"] = {k: v.to_dict() for k, v in self.args.items()}
        return out


@dataclass(frozen=True)
class FlowStep:
    """One step of a flow: a verb, and a line about using it here.

    The shape is webmachinelearning/webmcp#340's ``steps[].{section, tool,
    hint}``, with ``tool`` spelled ``verb`` because that is what this library
    calls the thing. Mirrors ``FlowStep``.
    """

    verb: str
    hint: str = ""
    section: str | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "FlowStep":
        section = d.get("section")
        return cls(
            verb=str(d.get("verb", "")),
            hint=str(d.get("hint", "")),
            section=str(section) if isinstance(section, str) and section else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"verb": self.verb, "hint": self.hint}
        if self.section is not None:
            out["section"] = self.section
        return out


@dataclass(frozen=True)
class FlowSpec:
    """One entry of ``Manifest.flows``: a declared, static, readable recipe.

    **The agent reads it and follows it with ordinary verbs. Nothing calls
    it**, and there is no tool that runs one — see ``FlowSpec`` in the TS
    types for why that is the design and not a missing feature. ``describe``
    is the field a model selects on, which is why it is bounded to one line.
    """

    id: str
    describe: str = ""
    steps: tuple[FlowStep, ...] = ()

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "FlowSpec":
        return cls(
            id=str(d["id"]),
            describe=str(d.get("describe", "")),
            steps=tuple(FlowStep.from_dict(s) for s in d.get("steps") or ()),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "describe": self.describe,
            "steps": [s.to_dict() for s in self.steps],
        }


@dataclass(frozen=True)
class Manifest:
    """The static half. Cache this; its ``version`` is how you learn you may
    not."""

    version: str
    app: str
    verbs: tuple[VerbSpec, ...] = ()
    #: The app's own briefing, in its own words, from ``MountOptions``.
    #:
    #: Static by definition, which is why it rides in the cached half and is
    #: folded into the MCP server instructions rather than into every snapshot.
    #: Before this field the two halves of the library disagreed: a widget
    #: could be handed ``instructions`` and an agent arriving over the relay
    #: could not, so an app that had something to say about itself to both had
    #: to repeat it in ``Snapshot.note`` and pay for it on every turn.
    instructions: str | None = None
    #: Every screen the app has, with an optional RFC 6570 url template each.
    #: Static, cached once, and empty for an app that does not describe its
    #: screens — which is not a claim that it has one. See :class:`ScreenSpec`.
    screens: tuple[ScreenSpec, ...] = ()
    #: The app's multi-step recipes, for an agent to read and follow. Nothing
    #: executes them. See :class:`FlowSpec`.
    flows: tuple[FlowSpec, ...] = ()

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Manifest":
        instructions = d.get("instructions")
        return cls(
            version=d.get("version", ""),
            app=d.get("app", ""),
            verbs=tuple(VerbSpec.from_dict(v) for v in d.get("verbs") or ()),
            instructions=str(instructions) if instructions else None,
            # A screen with no `id` is dropped rather than coerced: the id is
            # the string `Verb.screen` and `Snapshot.screen` are compared
            # against, and a screen that cannot be matched is worse than a
            # screen that is not listed. The core refuses one at mount, so a
            # reader that meets one is reading a hand-rolled manifest.
            screens=tuple(
                ScreenSpec.from_dict(s) for s in d.get("screens") or () if s.get("id")
            ),
            flows=tuple(FlowSpec.from_dict(f) for f in d.get("flows") or () if f.get("id")),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "version": self.version,
            "app": self.app,
            "verbs": [v.to_dict() for v in self.verbs],
        }
        # Omitted rather than sent as null, like every other absent optional
        # here: the TS core computes the manifest version from a shape that
        # leaves it out, and a round trip through this class must not turn
        # "the app said nothing" into a field.
        if self.instructions is not None:
            out["instructions"] = self.instructions
        # Omitted when empty, for the reason `instructions` is: the TS core
        # fingerprints a shape that leaves them out, and a round trip through
        # this class must not turn "the app does not describe its screens" into
        # an empty list that says it has none.
        if self.screens:
            out["screens"] = [s.to_dict() for s in self.screens]
        if self.flows:
            out["flows"] = [f.to_dict() for f in self.flows]
        return out

    def screen(self, screen_id: str) -> "ScreenSpec | None":
        for s in self.screens:
            if s.id == screen_id:
                return s
        return None

    def flow(self, flow_id: str) -> "FlowSpec | None":
        for f in self.flows:
            if f.id == flow_id:
                return f
        return None

    def verb(self, name: str) -> VerbSpec | None:
        for v in self.verbs:
            if v.name == name:
                return v
        return None


@dataclass(frozen=True)
class Row:
    """One row of whatever the screen is showing.

    TS writes this as ``{ id: string; [column: string]: Scalar | undefined }``.
    Python cannot express an index signature on a dataclass, so the other
    columns live in ``columns`` and ``to_dict`` flattens them back beside
    ``id``. The flat form is what goes over the wire; the nested one exists
    only inside this process.
    """

    id: str
    columns: dict[str, Scalar] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Row":
        return cls(id=str(d.get("id", "")), columns={k: v for k, v in d.items() if k != "id"})

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, **self.columns}

    def __getitem__(self, column: str) -> Scalar:
        return self.id if column == "id" else self.columns.get(column)

    def get(self, column: str, default: Scalar = None) -> Scalar:
        if column == "id":
            return self.id
        return self.columns.get(column, default)


@dataclass(frozen=True)
class Page:
    """``Snapshot.page``: the window these rows are a view of.

    ``total`` is OPTIONAL, and the three states it makes are the ones the TS
    ``Snapshot.page`` comment pins:

        page absent          these are all the rows there are
        page, total given    a window, and you know how big the whole is
        page, total absent   a window, and you do NOT know how big the whole is

    The third is not an edge case, it is the normal answer for any app whose
    rows are read out of a rendered table: the DOM cannot tell a virtualised
    grid from a short list, so code that had to supply a total could only omit
    ``page`` — asserting completeness it cannot know — or invent one. Requiring it here made the field unrepresentable from the wire
    anyway: ``int(d["total"])`` raised ``KeyError`` on the commonest snapshot a
    DOM-adapted app produces, before the renderer was ever reached.
    """

    index: int
    size: int
    total: int | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Page":
        total = d.get("total")
        return cls(
            index=int(d["index"]),
            size=int(d["size"]),
            # `is None` rather than falsy: a total of 0 is a real answer — an
            # empty window onto an empty whole — and distinct from "I do not
            # count", which is what absence means.
            total=int(total) if total is not None else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"index": self.index, "size": self.size}
        # Omitted rather than sent as null, so a round trip through this class
        # cannot turn "unknown" into a field a stricter parser rejects.
        if self.total is not None:
            out["total"] = self.total
        return out


@dataclass(frozen=True)
class Snapshot:
    """What a human could see right now. Mirrors ``Snapshot``.

    ``page`` stays ``None`` when the relay did not send one, and that absence
    is meaningful rather than missing data: per the TS comment it is a claim
    that the agent is seeing everything. Defaulting it to a synthetic
    ``{0, len(rows), len(rows)}`` would manufacture that claim, so we don't.
    """

    where: str
    rev: int
    rows: tuple[Row, ...] | None = None
    page: Page | None = None
    selected: tuple[str, ...] | None = None
    #: ``selectedCount`` on the wire: how many rows are selected in all.
    #:
    #: ``selected`` carries only the ids ON SCREEN, exactly like ``rows``, so
    #: that ``select-where`` can select thousands without putting tens of
    #: kilobytes of ids into the uncached half of every later result — which on
    #: a big table goes straight through the relay's 1 MiB body limit. This is
    #: the honest size that ``selected`` therefore cannot be.
    #:
    #: ``None`` means "I do not count" and is distinct from ``0``, which is a
    #: real answer. Dropping it here was not a cosmetic loss: an agent handed
    #: three ids and a bulk commit, with no count, believes three rows are
    #: about to change.
    selected_count: int | None = None
    note: str | None = None
    #: Which screen that is, as a stable kebab-case id: ``contacts``,
    #: ``company``. The partner of ``where``, which is prose for a human and
    #: carries the filter, the sort and a drill-down's record description — so
    #: it moves constantly for reasons that are not navigation, and "did I
    #: navigate?" cannot be answered by diffing it. This can be compared with
    #: ``==``, and that is its whole job.
    #:
    #: Dynamic, which is why it is here: the names of an app's screens and
    #: which verb belongs to which are static and live on ``VerbSpec.screen``;
    #: which one is live is as per-turn as a row. None means the app does not
    #: describe its screens, not that it has one.
    #:
    #: Declared LAST although it renders FIRST, and beside ``where`` in the TS
    #: `Snapshot`. Every field of this dataclass is positional, so inserting
    #: one after ``rev`` would silently reinterpret ``Snapshot("contacts", 7,
    #: rows)`` — written against yesterday's version — as a screen id. New
    #: fields go on the end here, whatever order they are documented in.
    screen: str | None = None
    #: An opaque fingerprint of the WHOLE current selection, off-screen rows
    #: included: the one input the core's plan token is built from.
    #:
    #: Equal when the selection has not changed and different when it has,
    #: including when one row was swapped for another — which is the case
    #: ``selected_count`` cannot see and ``selected``, which by design holds
    #: only the ids on screen, cannot identify. Nothing parses it, nothing
    #: orders it and no model is shown it. See ``Snapshot.selectionId``.
    #:
    #: On the end, like ``screen`` and for the same reason: every field of this
    #: dataclass is positional, so a field inserted in the middle silently
    #: reinterprets a ``Snapshot(...)`` written against an earlier version.
    selection_id: str | None = None

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Snapshot":
        rows = d.get("rows")
        selected = d.get("selected")
        page = d.get("page")
        count = d.get("selectedCount")
        screen = d.get("screen")
        return cls(
            where=d.get("where", ""),
            rev=int(d.get("rev", 0)),
            screen=str(screen) if screen else None,
            rows=tuple(Row.from_dict(r) for r in rows) if rows is not None else None,
            page=Page.from_dict(page) if page else None,
            selected=tuple(str(s) for s in selected) if selected is not None else None,
            selected_count=int(count) if count is not None else None,
            note=d.get("note"),
            # Carried through as a string and never interpreted. It is the
            # app's own fingerprint and only the core that minted a token
            # against it compares it, so a client that read anything out of it
            # would be inventing a second opinion about staleness.
            selection_id=str(d["selectionId"]) if d.get("selectionId") else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"where": self.where, "rev": self.rev}
        if self.screen is not None:
            out["screen"] = self.screen
        if self.rows is not None:
            out["rows"] = [r.to_dict() for r in self.rows]
        if self.page is not None:
            out["page"] = self.page.to_dict()
        if self.selected is not None:
            out["selected"] = list(self.selected)
        if self.selected_count is not None:
            # Spelled `selectedCount` going out, because the wire name is the
            # contract and `selected_count` is only how Python spells it.
            out["selectedCount"] = self.selected_count
        if self.selection_id is not None:
            out["selectionId"] = self.selection_id
        if self.note is not None:
            out["note"] = self.note
        return out

    def columns(self) -> list[str]:
        """The column order for rendering: ``id`` first, then every other key
        in the order it was first seen. Rows are not required to agree on their
        keys, so this is a union and not ``rows[0].keys()``."""
        seen: list[str] = ["id"]
        for row in self.rows or ():
            for key in row.columns:
                if key not in seen:
                    seen.append(key)
        return seen


@dataclass(frozen=True)
class Result:
    """What the agent gets back. Mirrors ``Result``, widened to ``WireResult``.

    ``snapshot`` is the screen AFTER the call — on purpose, so acting and
    observing are one round trip. Anything that renders a Result for a model
    and drops this has thrown away the reason the shape is like that.

    ``count`` is how a ``describe`` verb reports what it matched. It is the
    number a human would have to see before pressing a bulk button, and the
    whole reason ``describe`` and ``commit`` are separate verbs, so a renderer
    that buries it has removed the safety the split was bought with.

    ``snapshot`` is typed optional, where the TS ``Result`` has it required.
    That is not a weakening of the contract: a driver mounted in a page always
    fills it, and this type is the ``WireResult`` an agent receives, where a
    relay refusal about a call that never reached a tab has no screen to
    report. Its absence means "nothing ran and nobody looked", never "the
    screen is empty" — see :meth:`relay_refusal`.
    """

    ok: bool
    snapshot: Snapshot | None = None
    note: str | None = None  # ok=True only
    count: int | None = None  # ok=True only, and only from a `describe` verb
    #: The plan token the core minted for the selection this call left behind:
    #: ok=True only, and only from a ``describe`` in an app that has a verb
    #: consuming them. Pass it back as ``call(..., plan=...)``.
    #:
    #: It travels beside ``count`` because it means nothing without it — the
    #: count is the number a person approves, and this is what binds that number
    #: to the set the next commit touches. Opaque: stored and forwarded, never
    #: parsed.
    plan: str | None = None  # ok=True only
    refused: str | None = None  # ok=False only
    hint: str | None = None  # ok=False only

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Result":
        snapshot = d.get("snapshot")
        ok = bool(d.get("ok"))
        count = d.get("count")
        plan = d.get("plan")
        return cls(
            ok=ok,
            snapshot=Snapshot.from_dict(snapshot) if isinstance(snapshot, Mapping) else None,
            note=d.get("note") if ok else None,
            count=int(count) if ok and isinstance(count, (int, float)) and not isinstance(count, bool) else None,
            plan=str(plan) if ok and isinstance(plan, str) and plan else None,
            refused=None if ok else str(d.get("refused", "unknown")),
            hint=d.get("hint") if not ok else None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": self.ok}
        if self.ok:
            if self.note is not None:
                out["note"] = self.note
            if self.count is not None:
                out["count"] = self.count
            if self.plan is not None:
                out["plan"] = self.plan
        else:
            out["refused"] = self.refused
            if self.hint is not None:
                out["hint"] = self.hint
        if self.snapshot is not None:
            out["snapshot"] = self.snapshot.to_dict()
        return out

    @property
    def relay_refusal(self) -> str | None:
        """The relay refusal slug, when this is one, else None.

        Both documented signals are accepted: a slug from the closed set, and a
        missing snapshot. A conforming relay sends them together. Requiring
        both would mean one sloppy relay turns "your call never landed" into
        "your app said no", which is the single most expensive confusion this
        client can make — it is the difference between retrying and not knowing
        whether a commit already happened.
        """
        if self.ok:
            return None
        if self.refused in RELAY_REFUSALS:
            return self.refused
        if self.snapshot is None:
            return self.refused
        return None

    @property
    def landed(self) -> bool:
        """False only when the call provably never reached a tab.

        That is ``no-such-tab`` alone. ``timeout`` and ``tab-went-away`` are
        both deliberately absent: each means the call was accepted and no
        answer came back, and the verb may well have run — the tab went quiet,
        or its stream closed and the answer died with it. Collapsing unknown
        into failed is how a bulk accept gets made twice.
        """
        return self.relay_refusal not in RELAY_REFUSALS or self.relay_refusal in UNKNOWN_OUTCOME

    @property
    def outcome_unknown(self) -> bool:
        """True when nobody can say whether the verb ran."""
        return self.relay_refusal in UNKNOWN_OUTCOME


@dataclass(frozen=True)
class Tab:
    """One row of ``GET /dk/tabs``.

    The listing is now spelled out in PROTOCOL.md: the ``{"tabs": [...]}``
    envelope, the id field named ``tab`` — the same name the ``hello`` frame
    uses, one name for one thing — and ``manifestVersion`` lifted to the top
    level so a client can tell whether its cached manifest is current without
    fetching the whole thing.

    ``from_dict`` still reads the spellings a relay author might plausibly have
    picked before that was written. Tolerance here costs a few lines and buys
    compatibility with relays built against the earlier prose; it is not a
    licence to emit them, and ``to_dict`` writes only the specified shape.
    """

    id: str
    app: str = ""
    title: str = ""
    url: str = ""
    manifest_version: str = ""  # wire name: manifestVersion
    #: The tab's current ``rev``, so a client can see the screen moved without
    #: reading the snapshot.
    rev: int | None = None
    #: When the tab connected, ISO-8601, as the relay reported it. Kept as a
    #: string rather than parsed: nothing here needs it as a datetime, and
    #: parsing would invent a failure mode for a field only ever shown to a
    #: human choosing between two tabs.
    since: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Tab":
        version = d.get("manifestVersion") or d.get("manifest_version")
        if version is None:
            nested = d.get("manifest")
            if isinstance(nested, Mapping):
                version = nested.get("version")
        rev = d.get("rev")
        return cls(
            id=str(d.get("tab") or d.get("id") or ""),
            app=str(d.get("app") or ""),
            title=str(d.get("title") or ""),
            url=str(d.get("url") or ""),
            manifest_version=str(version or ""),
            rev=int(rev) if isinstance(rev, (int, float)) and not isinstance(rev, bool) else None,
            since=d.get("since"),
            raw=dict(d),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "tab": self.id,
            "app": self.app,
            "title": self.title,
            "url": self.url,
            "manifestVersion": self.manifest_version,
        }
        if self.rev is not None:
            out["rev"] = self.rev
        if self.since is not None:
            out["since"] = self.since
        return out
