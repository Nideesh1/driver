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
from .types import ArgSpec, FlowSpec, Manifest, ScreenSpec, Tab, VerbSpec

__all__ = [
    "READ_SCREEN",
    "LIST_TABS",
    "ToolOutcome",
    "TabTools",
    "arg_schema",
    "verb_tool",
    "tools_for",
    "render_tabs",
    "pick_tab",
    "FOCUS_WORDS",
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
#: ``consumes: "plan"`` folded into the description.
#:
#: In the cached half for exactly the reason ``refuses`` and ``screen`` are: the
#: point is that the bare call is never made. A model that learns the pairing
#: here runs the ``describe`` first and keeps the token; a model that learns it
#: from a refusal has already spent a round trip, and on a commit it has spent
#: it in front of a person waiting for an answer.
#:
#: It says what the token is FOR and not merely that it is required, because
#: "pass the plan" reads as ceremony and gets dropped, while "the number you
#: read is the number that moves" is the reason it exists. Verbatim from the TS
#: half.
_PLAN_NOTE = (
    "REQUIRES A PLAN. This acts on the selection, so it may only be called with the `plan` "
    "token that the app's `describe` verb returned beside its `count`. Run that describe, read "
    "the count, check it is the number the person asked for, and pass the `plan` straight back "
    "here. If anything has moved the selection in between — the person ticked a row, the "
    "list paged, data arrived — this is refused as `stale-plan` and the refusal names both "
    "counts. That is the point of the token: the number you read is the number that moves."
)

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

    # Hoisted like `rev` and `screen`, with one difference: ONLY onto a verb
    # that declares `consumes`. Those two are claims any verb can make, so they
    # go on everything; a plan token means nothing to a verb that does not
    # consume one, and adding the property to every tool in every app would move
    # every cached prompt prefix in the world for a feature those apps do not
    # use. That prefix is the cost argument the library is built on.
    #
    # NOT in `required`, although the core refuses the call without it, and that
    # is deliberate. `required` moves the failure into the client's validator,
    # where the refusal's hint — which names both counts and spells out the
    # pairing — never reaches the model. The schema stays permissive and the
    # core is strict; the description says it is required.
    if verb.consumes == "plan" and "plan" not in properties:
        properties["plan"] = {
            "type": "string",
            "description": (
                "Required. The `plan` token from the `describe` verb that counted this "
                "selection, passed back exactly as it was given. Without it the call is "
                "refused as `stale-plan`, and so is a token taken before the selection moved."
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
    # Third, above `screen`, because HOW a verb may be called outranks WHERE: a
    # model that goes to the right screen and calls the commit bare has still
    # lost the turn, and this is the sentence that stops it. Both still outrank
    # the mechanics.
    if verb.consumes == "plan":
        description.append(_PLAN_NOTE)
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
                    "List the app tabs connected to this relay, with their titles, URLs and "
                    "whether the person is looking at each one. Use it to tell two open tabs "
                    "apart when a person has to be asked which one they mean. This server "
                    "drives one fixed tab; the others are informational."
                ),
                "inputSchema": {"type": "object", "properties": {}, "required": []},
            }
        )

    return tools


#: How each :attr:`driverkit.types.Tab.focus` value reads to a person being
#: asked "which tab?".
#:
#: Spelled here rather than at each use because this listing is read in two
#: places — the ``list_tabs`` tool and the message ``driverkit-mcp`` prints
#: when it refuses to guess — and two copies is how the two come to describe
#: the same tab differently to the model and to the human.
#:
#: A value this mapping does not know is printed as it arrived rather than
#: dropped: PROTOCOL.md promises a field may gain a value without a version
#: bump, and a client that silently showed nothing for a state it had not heard
#: of would be hiding the one thing the person is choosing on.
FOCUS_WORDS = {
    "focused": "you are looking at this one",
    "visible": "on screen, but this window is not frontmost",
    "hidden": "a background tab",
}


def render_tabs(tabs: list[Tab], current: str) -> str:
    if not tabs:
        return "(no tabs connected to this relay)"
    lines = []
    for tab in tabs:
        mark = " <- this server drives this one" if tab.id == current else ""
        focus = FOCUS_WORDS.get(tab.focus, tab.focus) if tab.focus else ""
        bits = [b for b in (tab.app, tab.title, tab.url, focus) if b]
        lines.append(f"{tab.id}  {' | '.join(bits)}{mark}")
    return "\n".join(lines)


def pick_tab(tabs: Sequence[Tab]) -> Tab | None:
    """The tab a person means by "the one I am looking at", or ``None`` to ask.

    ``--tab <id>`` works and "omit it when exactly one tab is connected" stops
    working at two, and until the page started reporting
    :attr:`driverkit.types.Tab.focus` there was nothing in the protocol that
    could express the thing a person actually means. This is where that field
    is turned into a decision, and it is in the CLIENT rather than in either
    relay on purpose: a relay carries the string and has no opinion about it,
    so the two implementations stay behaviourally identical by not implementing
    this at all.

    The rules, in order, and the last one is the important one:

    1. **One tab connected** — that one. The behaviour this had before focus
       existed, kept exactly, including for a tab that reports no focus.
    2. **Exactly one tab says ``focused``** — that one. It is claiming the
       person is looking at it, which beats a tab that says nothing.
    3. **Nobody says ``focused`` and exactly one says ``visible``** — that one.
       This is the person being in another application entirely, and it is
       still an unambiguous answer: with one window, exactly one tab of an app
       is on screen and the rest are ``hidden``. "The one I was last in" is
       what they will mean when they come back.
    4. **Anything else — ``None``, and the caller asks.** Two windows each with
       a focused tab, two tabs reporting nothing, a relay from before this
       field: in all of them the honest answer is a question. A wrong answer
       confidently given drives somebody's other screen, and the cost of
       asking is one sentence.

    Note what rule 4 does NOT do: it does not fall back to the first tab, the
    newest tab or the one that happens to sort first. Each of those would make
    the ambiguous case *look* handled, and the failure would be a commit landing
    in a window nobody was watching.
    """
    if len(tabs) == 1:
        return tabs[0]
    focused = [t for t in tabs if t.focus == "focused"]
    if len(focused) == 1:
        return focused[0]
    if not focused:
        visible = [t for t in tabs if t.focus == "visible"]
        if len(visible) == 1:
            return visible[0]
    return None



def _screens_note(screens: Sequence[ScreenSpec]) -> str:
    """The app's map, rendered for the model.

    ``Manifest.screens`` is the static list of every screen the app has, so
    this belongs in the instructions a client prepends once rather than in any
    turn's tail. What an agent could not do before the field existed is learn
    that a screen *exists* without standing on it: ``Snapshot.screen`` says
    where it is and ``Verb.screen`` says where a verb works, and between them
    there was still no way to find out that a companies list is in there
    somewhere. The worked example closed that gap by pasting a prose screen-map
    into ``instructions`` — the same map the app's own route table already had,
    written a second time in English with nothing checking that the two agree.

    The sentence about it being the same for every user is not padding. It is
    the one thing a model cannot tell by looking: a list that might have been
    filtered for this person is a list whose absences mean nothing. See
    ``ScreenSpec``, which forbids filtering it. Verbatim from the TS half.
    """
    lines = [
        "THE SCREENS THIS APP HAS. The same screens for every user, always \u2014 a screen listed "
        "here exists whether or not you have been to it. Only which one is LIVE changes, and "
        "that is the `screen` line of every screen you read. If you cannot get to one of "
        "these, the app will tell you why when you try; it is never missing from this list."
    ]
    for screen in screens:
        needs = list(screen.args.keys())
        line = f"- `{screen.id}`: {screen.describe}"
        if screen.url:
            line += f" Address: `{screen.url}`."
        if needs:
            line += " Needs: " + ", ".join(f"`{n}`" for n in needs) + "."
        lines.append(line)
    return "\n".join(lines)


def _render_flow(flow: FlowSpec, verbs: Sequence[VerbSpec] = ()) -> str:
    """One flow, rendered as the recipe it is.

    The id first and the ``describe`` on the same line, because the
    ``describe`` is what a model picks a flow on — Microsoft's finding on
    selection across tool groups is that the choice is made "based on the
    plugin's description, not on any of the individual functions" — and the
    steps are what it follows once it has picked. A ``section`` is printed once
    where it changes rather than on every step.

    TWO MARKS GO IN PARENTHESES AFTER THE VERB, so that a model skimming five
    numbered lines sees the shape of the recipe without reading every hint:
    OPTIONAL for a step with a ``skip_when``, because which steps carry the job
    is structural and used to be a clause buried mid-hint; and the plan
    handoff, naming the numbered step whose ``describe`` mints the token. The
    second is DERIVED from ``kind`` and ``consumes``, which the manifest
    already carries -- nothing for an author to keep in step, and it is the one
    value that crosses two steps in this library. Verbatim from the TS half.
    """
    lines = [f"`{flow.id}` \u2014 {flow.describe}"]
    section: str | None = None
    by_name = {v.name: v for v in verbs}
    # The numbered step whose `describe` verb last minted a plan token, so the
    # mark can name it. Updated AFTER the current step is rendered: a describe
    # does not consume its own plan.
    minted: int | None = None
    for i, step in enumerate(flow.steps):
        if step.section and step.section != section:
            lines.append(f"  ({step.section})")
        section = step.section
        verb = by_name.get(step.verb)
        marks: list[str] = []
        if step.skip_when:
            marks.append(f"OPTIONAL \u2014 skip it when {step.skip_when}")
        if verb is not None and verb.consumes == "plan" and minted is not None:
            marks.append(f"takes the `plan` token step {minted} returned")
        mark = f" ({'; '.join(marks)})" if marks else ""
        lines.append(f"  {i + 1}. `{step.verb}`{mark} \u2014 {step.hint}")
        if verb is not None and verb.kind == "describe":
            minted = i + 1
    return "\n".join(lines)


def _flows_note(flows: Sequence[FlowSpec], verbs: Sequence[VerbSpec] = ()) -> str:
    """The app's flows, rendered for the model.

    THE SENTENCE THAT MATTERS is the one saying there is no tool that runs a
    flow. A model handed a list of numbered steps will look for the button, and
    not finding one it may well decide the flow is unavailable; being told that
    following the steps IS the mechanism, and why, is what turns a list into an
    instruction. The why is honest and is the design: a flow that executed
    internally could not adapt when step three found the record already
    accepted, and the agent would get back an ``ok`` that told it nothing.
    Apple's app skills say the same thing about themselves — "Skills don't
    enforce deterministic behavior, and Siri doesn't run the listed intents in
    sequence." Verbatim from the TS half.
    """
    return (
        "THE JOBS THIS APP SAYS ITS VERBS ARE USUALLY COMBINED INTO. Each one is a recipe for "
        "YOU to carry out with the verbs you already have. **There is no tool that runs a "
        "flow**, and that is deliberate: following the steps yourself means you see what each "
        "one actually returned and can change course, which something running them for you "
        "could not. Take the steps in order, read what each verb reports before the next, and "
        "depart from the recipe when the screen says something it did not expect \u2014 then say so."
        # The sentence about OPTIONAL steps is added only when some step
        # actually is one. Everything in here rides in the cached prefix of
        # every session of every user, and a paragraph about a construct the app
        # does not use is the kind of cost that is real, paid once, and
        # invisible -- which is the exact cost the size budgets exist to make
        # somebody weigh. An app whose flows mark nothing optional gets the note
        # it got before the field existed.
        + (
            " A step marked OPTIONAL may be skipped when the condition beside it holds, and "
            "that condition is a sentence for you to judge, not a rule something checks: when "
            "it is not clearly true, take the step."
            if any(s.skip_when for f in flows for s in f.steps)
            else ""
        )
        + "\n\n"
        + "\n\n".join(_render_flow(f, verbs) for f in flows)
    )


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
        # The other half of "never commit on a count you have not read", which
        # that sentence could only ever ask for. A count read and then acted on
        # a moment later is not a count of the rows that moved: the person can
        # tick a row between the two calls. A commit that says `consumes:
        # "plan"` is one the core will not let that happen to, and this is where
        # an agent arriving over MCP learns the pairing rather than meeting it
        # as a refusal.
        "A COMMIT whose description says REQUIRES A PLAN takes the `plan` token that the "
        "`describe` verb returned beside its `count`. Pass it straight back, do not reuse one "
        "and do not keep one for later: a plan is good for one commit and only while nothing "
        "has moved the selection. `stale-plan` means the rows changed under you and names both "
        "counts — the one you were shown and the one there is now — so run the "
        "describe again, read the new number and say it before committing to it.",
        # The consent half of the safety story, which used to be missing from
        # this text because it was missing from this path: the confirmation
        # lived in the in-page loop, so a person watching the widget was asked
        # and an agent arriving here was not. It is in the core's `call()` now,
        # so every one of these three answers is reachable from here — and the
        # last sentence is the one that matters. An agent that is refused a
        # commit and then presses the page's own Approve button has not been
        # approved by anybody; see webmachinelearning/webmcp#288, where exactly
        # that happened and the receipt said "approved by you".
        "A COMMIT may be put to the person first. `declined-by-user` means they said no: do "
        "not retry it, do not try another verb or control that does the same thing, and do "
        "not press an approve or confirm control \u2014 pressing it yourself is not consent and "
        "is refused anyway. `approval-pending` means somebody is being asked right now and "
        "nothing ran; wait. `approval-timeout` means nobody answered and the verb DID NOT "
        "RUN, which is not the same as the transport `timeout`, where the call was accepted "
        "and the outcome is unknown.",
    ]
    # The map and the recipes, between the library's rules and the app's own
    # words. Both are pure functions of the static manifest, so this text stays
    # byte-identical for every session of every user — which is the only reason
    # either of them is affordable. They go AFTER the safety rules, because a
    # recipe is a thing to do within those rules and not an exception to them,
    # and BEFORE `instructions`, because whichever text is last is the one a
    # model follows when two of them disagree and the app's own voice should
    # outrank a list the library rendered.
    if manifest.screens:
        parts.append(_screens_note(manifest.screens))
    if manifest.flows:
        parts.append(_flows_note(manifest.flows, manifest.verbs))

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

        # And so is `plan`, by the same rule, and only on a verb that consumes
        # one — that is the only verb whose tool schema offered it, so a `plan`
        # key on any other is either an argument the app named or a mistake the
        # core should be allowed to see.
        #
        # Anything that is not a non-empty string is dropped rather than sent,
        # as with `screen`. The core then refuses as `stale-plan` with the
        # pairing spelled out, which is a better answer than a `bad-argument`
        # about the shape of a field the model should not have invented.
        plan = None
        if verb.consumes == "plan" and "plan" not in verb.args:
            raw_plan = args.pop("plan", None)
            if isinstance(raw_plan, str) and raw_plan.strip():
                plan = raw_plan.strip()

        result = self.client.call(
            self.tab, verb.name, args, rev=rev, screen=screen, plan=plan
        )
        return ToolOutcome(render_result(result, verb.kind), is_error=not result.landed)
