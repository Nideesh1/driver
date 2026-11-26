"""
driverkit — the manifest→tools translation, shared by both MCP servers.

Two MCP servers ship in this package and they must expose the same tools. One
is the hand-rolled JSON-RPC-over-stdio server in :mod:`driverkit.mcp_server`,
which has no dependencies and is the path that runs today; the other is
:mod:`driverkit.fastmcp_server`, which needs ``fastmcp`` and exists because
FastMCP owns the authentication story an agent-facing server should not
hand-roll. A tool list written twice is two tool lists, and the second one is
wrong the first time somebody adds a verb kind — so it is written here once and
both servers are transports over :class:`TabTools`.

What lives here is everything that is not transport: the schema translation,
the two fixed reads, the instructions a client is given, and the dispatch from
a tool name to the text a model sees. What lives in each server is JSON-RPC
framing, or FastMCP's decorators, and nothing else.

THE POINT OF ALL OF IT, worth repeating where the generator is: **the tool list
is generated from the tab's manifest.** Nothing here knows the name of a single
verb. Each verb becomes one MCP tool, its ``args`` become the tool's
``inputSchema``, and its ``refuses`` go into the description so a model can
decline a call that was always going to be declined.

The alternative — hand-writing an MCP tool per app feature — is the thing this
replaces. It means every app ships a second, drifting copy of its own
capability list, and the copy is wrong the first time somebody adds an
argument.

Two tools are not verbs and are added by hand: ``read_screen`` and
``list_tabs``. They are not app features, they are the protocol's own two
reads, and no app should have to declare them. (Verb names are kebab-case by
the core's contract and these are snake_case, so they cannot collide; the
generator checks anyway rather than silently shadowing a verb.)

Stdlib only, like everything that must run.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from .client import Driverkit
from .render import render_result, render_snapshot
from .types import ArgSpec, Manifest, Tab, VerbSpec

__all__ = [
    "READ_SCREEN",
    "LIST_TABS",
    "ToolOutcome",
    "TabTools",
    "arg_schema",
    "verb_tool",
    "tools_for",
    "render_tabs",
    "instructions_for",
]

READ_SCREEN = "read_screen"
LIST_TABS = "list_tabs"

#: ``ArgSpec.type`` is already a JSON Schema type name for all three cases, but
#: the mapping is written out rather than passed through: the core's three
#: accepted types are a closed set, and an unknown one should be loud here
#: instead of producing a schema no client will validate.
_JSON_TYPES = {"string": "string", "number": "number", "boolean": "boolean"}

_RESULT_NOTE = (
    "Returns the screen as it is AFTER this runs, so you do not need to read it again."
)
_REFUSAL_NOTE = (
    "A refusal is a normal answer, not an error: read the reason and change what you do, "
    "rather than repeating the same call."
)

#: ``kind`` folded into the description, because it is the difference between a
#: call that is free to try and one that is irreversible, and nothing else in
#: the tool definition can express that. Asked to "select the top 1000 and bulk
#: accept", a model that cannot tell `select` from `accept` finds out by doing
#: it, and the finding out costs a thousand accepted rows.
#:
#: ``read`` says "changes no data and reports no count" and no longer says
#: "changes nothing", because `go`, `open-contact` and `back` are reads and they
#: move the person's screen out from under them. The two things the sentence
#: must get right are the ones that decide whether the next call is safe; "the
#: person will see it" is said as well, because they will. Verbatim from the TS
#: half.
_KIND_NOTE = {
    "read": (
        "READ-ONLY: this changes no data and reports no count. Free to call, free to get "
        "wrong. It may still move what the person is looking at \u2014 navigating is a read "
        "\u2014 so they will see you do it."
    ),
    "describe": (
        "DESCRIBE: this changes what is SELECTED and changes no data. "
        "Safe to call \u2014 the worst outcome is the wrong rows highlighted. It reports a "
        "`count` of what it matched; read that count before you commit to anything."
    ),
    "commit": (
        "*** COMMIT: THIS CHANGES DATA AND MAY BE IRREVERSIBLE. ***\n"
        "Do not call it to find out what it does. If it acts on a selection, use the "
        "app's `describe` verb first, check the `count` it reports is the number you "
        "expect, and only then commit."
    ),
}

#: The commit banner for a commit the app says it can undo.
#:
#: A separate string rather than a sentence appended to the shouted one, and the
#: difference is the point. ``set-setting("dense-rows", "true")`` and accepting
#: 3,412 contacts were both getting THIS CHANGES DATA AND MAY BE IRREVERSIBLE,
#: and a banner that appears on a page-size change is a banner a model learns to
#: read past — the same way a person learns to click Yes without reading. So
#: the reversible one is not shouted, and the irreversible one keeps its
#: asterisks and goes on meaning something.
#:
#: It still says the data changes, because it does. ``reversible`` is a claim
#: that there is a way back, not that nobody minds. Verbatim from the TS half.
_COMMIT_REVERSIBLE_NOTE = (
    "COMMIT (reversible): this changes data, and the app says the change can be undone. "
    "Still a change the person will see, so do not call it to find out what it does; if it "
    "acts on a selection, read the `count` from the app's `describe` verb first."
)


def _screen_note(screen: str | Sequence[str]) -> str:
    """``screen`` folded into the description.

    The tool list is the same on every screen — a verb list that changed
    with the screen would bust the prompt prefix on every navigation, which is
    the cost argument — so this sentence is how a model learns, in the
    cached half, that a verb it can see will not work where it is standing.
    Exactly the argument for putting ``refuses`` in here: the point is that the
    call is never made.

    A verb on several screens names them all, because naming one of three is
    worse than naming none: a model told ``next-page`` is "ONLY ON THE
    `contacts` SCREEN" will navigate away from the company list it was already
    standing on to do something it could have done where it was. The one-screen
    wording is byte-for-byte what it was before this could be a list, so no
    app's cached prefix moved for a feature it does not use. Verbatim from the
    TS half.
    """
    # A string is one screen and anything else is a sequence of them. Tested
    # that way round rather than with `isinstance(..., list)`, because a string
    # IS a sequence of characters and a tuple is what ``VerbSpec`` holds — the
    # list check passes a tuple straight through and prints it.
    screens = [screen] if isinstance(screen, str) else list(screen)
    quoted = [f"`{s}`" for s in screens]
    if len(quoted) > 1:
        where = f"ONLY ON THE {', '.join(quoted[:-1])} AND {quoted[-1]} SCREENS."
    else:
        where = f"ONLY ON THE {quoted[0]} SCREEN."
    return (
        f"{where} The screen you are on is the `screen` line of "
        "every screen you read. Called from anywhere else this is refused as `wrong-screen`, "
        "and the refusal names where you are and where the verb lives."
    )


# ---- manifest → tools ----------------------------------------------------


def arg_schema(spec: ArgSpec) -> dict[str, Any]:
    """One ``ArgSpec`` as one JSON Schema property.

    ``oneOf`` becomes ``enum`` and not a JSON Schema ``oneOf``. The names look
    alike and the meanings diverge: the core's ``oneOf`` is a list of permitted
    scalar values, which is ``enum``, while JSON Schema's ``oneOf`` is a list of
    subschemas. Emitting the latter would produce a schema that validates
    anything.
    """
    if spec.type not in _JSON_TYPES:
        raise ValueError(f"driverkit: unknown arg type {spec.type!r}")
    schema: dict[str, Any] = {"type": _JSON_TYPES[spec.type], "description": spec.describe}
    if spec.one_of is not None:
        schema["enum"] = list(spec.one_of)
    return schema


def verb_tool(verb: VerbSpec) -> dict[str, Any]:
    """One manifest verb as one MCP tool.

    ``optional`` is expressed by omission from ``required``, which is how JSON
    Schema says it; an ``"optional": true`` key would be ignored by every
    validator and the argument would silently become mandatory.

    ``rev`` is added as an extra optional property on every verb. It is not an
    app argument — it is the staleness claim from PROTOCOL.md's ``call`` frame,
    hoisted into the schema because a model has nowhere else to put it. Passing
    the ``rev`` it last read is what turns "act on a row somebody already
    moved" into a clean ``stale`` refusal. A verb that declares its own ``rev``
    argument keeps it and does not get the hoisted one, because the app's
    meaning wins over ours.
    """
    properties = {name: arg_schema(spec) for name, spec in verb.args.items()}
    required = [name for name, spec in verb.args.items() if spec.required]

    if "rev" not in properties:
        properties["rev"] = {
            "type": "integer",
            "description": (
                "Optional. The `rev` from the last screen you read. If the screen has "
                "moved since, the call is refused as `stale` instead of acting on "
                "something you did not see. Omit it to skip that check."
            ),
        }

    # Hoisted exactly as `rev` is, and for a failure `rev` does not catch: a
    # paging call sent with no rev once landed on a screen the agent had never
    # seen, paged a different company's list and answered `ok`. "You are
    # somewhere else" and "the number moved" are different mistakes with
    # different fixes, so they are different claims and different refusals. A
    # verb with its own `screen` argument keeps it, because the app's meaning
    # wins over ours — the same rule as `rev`.
    if "screen" not in properties:
        properties["screen"] = {
            "type": "string",
            "description": (
                "Optional. The `screen` from the last screen you read. If the app is on "
                "another screen now, the call is refused as `wrong-screen` instead of "
                "acting on a screen you never saw. Omit it to skip that check."
            ),
        }

    description = [verb.describe]
    if verb.kind == "commit" and verb.reversible:
        # Checked before the table, so a reversible commit reads differently
        # from an irreversible one. `reversible` is read only here, on a
        # `commit`: on a `read` or a `describe` it is a claim about nothing,
        # since the app has already said no data moves.
        description.append(_COMMIT_REVERSIBLE_NOTE)
    elif verb.kind in _KIND_NOTE:
        # Second, straight after what the verb does and ahead of the mechanical
        # notes, so a model skimming the first two lines of a description
        # cannot miss that a verb commits. An unknown or absent kind adds
        # nothing: this server does not manufacture a safety claim the app did
        # not make, in either direction.
        description.append(_KIND_NOTE[verb.kind])
    # Third: what a verb does to the world outranks where it works, and both
    # outrank the mechanics.
    if verb.screen:
        description.append(_screen_note(verb.screen))
    description.append(_RESULT_NOTE)
    if verb.refuses:
        # In the description rather than only in the error path, because this is
        # the half that gets cached in the prompt prefix: the point of
        # `refuses` is that a well-briefed agent never makes the call.
        description.append("May refuse: " + ", ".join(verb.refuses) + ". " + _REFUSAL_NOTE)

    return {
        "name": verb.name,
        "description": "\n\n".join(description),
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            # The app named its own arguments; an extra one is a mistake worth
            # catching at the client rather than sending to a verb that will
            # ignore it.
            "additionalProperties": False,
        },
    }


def tools_for(manifest: Manifest) -> list[dict[str, Any]]:
    """The whole tool list: every verb, then the two fixed reads."""
    tools = [verb_tool(v) for v in manifest.verbs]
    taken = {t["name"] for t in tools}

    if READ_SCREEN not in taken:
        tools.append(
            {
                "name": READ_SCREEN,
                "description": (
                    f"Read what is on screen in the {manifest.app or 'app'} right now: where "
                    "the user is, the rows visible to them, what they have selected, and the "
                    "`rev` to quote back when you act.\n\n"
                    "You see exactly what the person at the keyboard sees — same filters, same "
                    "page — and nothing more. If a record you expect is missing, it is probably "
                    "off screen rather than absent.\n\n"
                    "Read it again after anything unexpected: it is the cheapest tool here and "
                    "the only way to settle what actually happened."
                ),
                "inputSchema": {"type": "object", "properties": {}, "required": []},
            }
        )

    if LIST_TABS not in taken:
        tools.append(
            {
                "name": LIST_TABS,
                "description": (
                    "List the app tabs connected to this relay, with their titles and URLs. "
                    "Use it to tell two open tabs apart when a person has to be asked which "
                    "one they mean. This server drives one fixed tab; the others are "
                    "informational."
                ),
                "inputSchema": {"type": "object", "properties": {}, "required": []},
            }
        )

    return tools


def render_tabs(tabs: list[Tab], current: str) -> str:
    if not tabs:
        return "(no tabs connected to this relay)"
    lines = []
    for tab in tabs:
        mark = " <- this server drives this one" if tab.id == current else ""
        bits = [b for b in (tab.app, tab.title, tab.url) if b]
        lines.append(f"{tab.id}  {' | '.join(bits)}{mark}")
    return "\n".join(lines)


def instructions_for(manifest: Manifest) -> str:
    """The server instructions an MCP client prepends to its system prompt.

    Shared because this text is half the safety story: it is where a model is
    told to read the screen before acting, to quote the ``rev`` back, and that
    COMMIT verbs change data. Two servers with two copies of it would be two
    different safety stories, and the one that drifts is the one nobody is
    reading when it matters.
    """
    parts = [
        f"You are driving a live {manifest.app} tab that a person has open. "
        f"Call {READ_SCREEN} before acting so you know what they are looking at, "
        "then quote that screen's `rev` back when you act. Every verb returns the "
        "screen after it ran, so acting and looking are one step. You can do exactly "
        "what that person could do, and nothing more.",
        "Every verb says what it does to the world: READ-ONLY changes no data and reports "
        "no count \u2014 moving to another screen is a read, and the person watching will "
        "see it \u2014 DESCRIBE changes what is selected and reports a count, COMMIT "
        "changes data and may be irreversible. Never commit on a selection whose count you "
        "have not read.",
    ]
    # The app's own briefing, last. This is the field that closes the one gap
    # where driverkit's two paths disagreed: a widget could be handed
    # `instructions` through `drive()` and an agent arriving here could not, so
    # an app with something to say about itself — "this app has screens, and
    # `go` reaches those" — had to repeat it in every snapshot's `note`, in
    # the uncached half, paid for on every turn. It is static, so it goes in
    # the half a client prepends once.
    if manifest.instructions:
        parts.append(manifest.instructions)
    return "\n\n".join(parts)


@dataclass(frozen=True)
class ToolOutcome:
    """What a tool call produced: text for the model, and whether it ran.

    ``is_error`` is MCP's ``isError`` and means "the tool could not run". It is
    deliberately False for an app refusal — see :meth:`TabTools.call`.
    """

    text: str
    is_error: bool = False


class TabTools:
    """MCP tools over one driverkit tab, with no transport attached.

    The manifest is fetched once and kept. That is not a performance tweak, it
    is the shape of the protocol: the manifest is the static half and is
    guaranteed not to vary between two calls, while the snapshot is read fresh
    every time and never cached. Getting that backwards is the whole cost
    argument reversed.

    ``client`` carries whatever credential the agent was given, so everything
    this class can reach is already scoped to one principal by the relay. It
    cannot see another person's tabs even in ``list_tabs``, because the relay
    does not list them — which is why there is no filtering here and must not
    be: a second place that decides what an agent may see is a second set of
    rules, and the relay's is the one that is enforced.
    """

    def __init__(self, client: Driverkit, tab: str) -> None:
        self.client = client
        self.tab = tab
        self._manifest: Manifest | None = None

    def manifest(self) -> Manifest:
        if self._manifest is None:
            self._manifest = self.client.manifest(self.tab)
        return self._manifest

    def tools(self) -> list[dict[str, Any]]:
        return tools_for(self.manifest())

    def instructions(self) -> str:
        return instructions_for(self.manifest())

    def call(self, name: str, arguments: Mapping[str, Any] | None = None) -> ToolOutcome:
        """Run one tool and render the answer for a model.

        ``isError`` is False for an app refusal. MCP's ``isError`` means the
        tool could not run; a refusal means it ran and the answer was no, which
        is information the model is supposed to act on. Flagging it as an error
        invites a client to hide it or a model to retry unchanged.

        It is True only when the call provably never landed — ``no-such-tab``,
        ``tab-went-away`` — where there is nothing to reason about and the next
        move is to list the tabs.

        ``timeout`` is deliberately NOT an error, and this is the subtle one.
        The outcome is unknown: the tab may have run the verb and died before
        answering. Clients commonly render an ``isError`` result as a failed
        step for the model to retry, and retrying an unknown commit is how a
        bulk accept happens twice. So it comes back as an ordinary result whose
        text says the outcome is unknown and, for a commit, to read the screen
        before deciding anything.
        """
        args = dict(arguments or {})

        if name == READ_SCREEN:
            return ToolOutcome(render_snapshot(self.client.snapshot(self.tab)))

        if name == LIST_TABS:
            return ToolOutcome(render_tabs(self.client.tabs(), self.tab))

        manifest = self.manifest()
        verb = manifest.verb(str(name))
        if verb is None:
            known = ", ".join([v.name for v in manifest.verbs] + [READ_SCREEN, LIST_TABS])
            # isError, because this one never reached the app: the model asked
            # for a tool that does not exist. The known names are listed for the
            # same reason the core lists them — so the fix needs no extra round
            # trip.
            return ToolOutcome(f"no such tool `{name}`. available: {known}", is_error=True)

        # `rev` is ours unless the verb claimed the name, in which case it is an
        # ordinary argument and goes through untouched.
        rev = None
        if "rev" not in verb.args:
            raw_rev = args.pop("rev", None)
            if isinstance(raw_rev, bool) or raw_rev is None:
                rev = None
            elif isinstance(raw_rev, (int, float)):
                rev = int(raw_rev)

        # And so is `screen`, by the same rule: the app keeps the name if it
        # declared one, because `go(screen)` is a real verb in a real app.
        # Anything that is not a non-empty string is dropped rather than sent;
        # a number is not a screen id, and the relay would refuse the frame
        # anyway. The in-page loop refuses it instead of dropping it, and the
        # difference is that it has the screen in hand to quote back.
        screen = None
        if "screen" not in verb.args:
            raw_screen = args.pop("screen", None)
            if isinstance(raw_screen, str) and raw_screen.strip():
                screen = raw_screen.strip()

        result = self.client.call(self.tab, verb.name, args, rev=rev, screen=screen)
        return ToolOutcome(render_result(result, verb.kind), is_error=not result.landed)
