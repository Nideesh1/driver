"""
Rendering a Snapshot and a Result for a model to read.

Why this file exists at all, rather than ``json.dumps`` at the MCP boundary:
a tool result is prompt. The snapshot that comes back from every call is the
uncached half, so its bytes are paid for on every turn of the conversation,
and JSON spends a large share of them on punctuation and on repeating each
column name once per row. A two-column, ten-row table costs about 240 bytes of
braces and quotes as JSON and about none as text. The win is not elegance, it
is that the thing an agent re-reads most often is the thing we made smallest.

The second rule here is that the post-call snapshot is never dropped. The TS
``Result`` carries it so that acting and observing are one round trip; a
renderer that returned "ok" and nothing else would hand that saving straight
back, because the model's next move would be to read the screen it was just
given.
"""

from __future__ import annotations

from .types import Result, Snapshot

__all__ = ["render_snapshot", "render_result", "render_duration", "SLOW_MS"]

#: What an unanswered call means, per PROTOCOL.md: the call was accepted and no
#: answer came back, so the tab may well have run the verb. Only
#: ``no-such-tab`` proves otherwise. Each slug gets its own sentence, because
#: "it went quiet" and "its connection closed" lead to different next moves —
#: wait and re-read, versus check whether the tab is still there at all.
_UNKNOWN_WHY = {
    "timeout": "The tab accepted this call and went quiet past the deadline.",
    "tab-went-away": (
        "The tab accepted this call and its connection then closed, so the answer died "
        "with the stream."
    ),
}
_UNKNOWN_OUTCOME = "The outcome is UNKNOWN: it may well have run."
#: Spelled out for a `commit` verb because that is the case where guessing
#: wrong is expensive. The natural reflex — treat a non-answer as a failed step
#: and retry it — is the one move that turns one bulk accept into two.
_UNKNOWN_COMMIT = (
    "DO NOT retry this. It changes data, and it may already have taken effect. "
    "Read the screen first and decide from what you see there."
)
_UNKNOWN_SAFE = "Reading the screen again is cheap and safe, and settles it."
_NEVER_LANDED = (
    "The call was never forwarded, because there was nowhere to forward it: nothing ran "
    "and nothing changed."
)


#: The shortest honest wait worth a line in a prompt.
#:
#: One second, and the number is the whole token argument. A duration on every
#: call is a line in every turn forever, for a capability most runs never use,
#: and the TS half's ``pruneScreens`` cut a ten-step run from 5,775 to 1,397
#: characters by refusing to pay exactly that kind of per-step rent. So the
#: default is that a call which took no time says nothing: a snappy app renders
#: not one byte more than it did before this existed, and the bytes get spent
#: only on the calls where elapsed time is a fact about the app rather than
#: noise.
#:
#: A second is also roughly where a wait stops being invisible to the person
#: watching. Below it, the model learning the number changes no decision it
#: could make; above it, "this verb is slow" is a real property of the app that
#: explains why the next step should not be another one of these.
SLOW_MS = 1000


def render_duration(ms: float, floor_ms: float = SLOW_MS) -> str:
    """How long a call took, as one line for the outcome half of a tool turn.

    ::

        ok — 3,412 contacts accepted
        took: ~2s

        On screen now:
        screen: contacts

    **Why this is a function and not a field on ``Result``.** A ``Result`` is
    what the APP returned; a duration is a fact about the call that wrapped it,
    which the app never measured and cannot be asked to. Putting it on the wire
    would invite an app to fill it in, and then the number a model reads would
    be an app's claim about its own speed rather than an observation. The
    caller measures, the caller renders, and this is the one place either half
    of the library says it in words.

    **Why it is bucketed rather than exact.** Every other byte of a rendered
    turn is a function of app state, so two identical runs produce identical
    transcripts — which is what eval caching, snapshot tests and anything that
    diffs transcripts are built on. A wall-clock millisecond count breaks that
    for every reader at once. Rounding to a coarse bucket gives it back for the
    ordinary case: a verb that takes 2.1s one run and 2.3s the next renders
    ``~2s`` both times, so the transcript is stable wherever the app's own
    behaviour is. It does not make the output a pure function of state — a
    bucket boundary is still a boundary, and a call that straddles one renders
    two ways — and that is why the TS half's ``DriveOptions.clock`` is
    injectable: a suite or an eval that needs a byte-exact transcript pins the
    clock and gets one. Buckets are for production, the injected clock is for
    determinism, and neither is asked to do the other's job.

    ``~`` is on the number on purpose. A model shown ``took: 2.13s`` will
    compare two of them to three figures and report a difference that is
    scheduler noise; ``~2s`` cannot be over-read, and reads naturally in an
    answer a person gets back.

    **What this must never include.** The time a person spent deciding. ``ms``
    in an audit record is approval-inclusive by design — a reader of the record
    wants that gap back — but telling a MODEL that a call "took 40 seconds"
    when 38 of them were somebody reading a confirmation dialog is a false
    claim about the app's speed, and a model that believes it will go looking
    for a faster route around a verb that is not slow. Over the relay there is
    a second thing to keep out: this is the time the CALL took, and a deadline
    that fired is not a duration — a ``timeout`` means the outcome is unknown,
    so the only honest figure for it is none at all.

    **NOT YET CALLED BY THIS HALF'S MCP SERVER, AND THAT IS DELIBERATE RATHER
    THAN UNFINISHED.** The function is here because the two renderers are kept
    string-for-string and ``test/cross-impl.test.ts`` crosses them — a half that
    did not have it would drift the moment anybody touched the other. What it is
    not yet wired to is ``mcp_core``, because the only duration the MCP path can
    measure today is the whole relay round trip: the network hop out, the tab's
    own work, any approval the page asked a person for, and the hop back. Three
    of those four are not the app's speed, and there is no ``waited`` channel
    over the wire to subtract the human one with — so wiring it would render
    exactly the lie the TS half's ``DriveOptions.waited`` exists to prevent. The
    honest fix is for the relay to carry the tab's own elapsed time in the
    ``result`` frame, which is a PROTOCOL.md change and not a renderer change.

    ``floor_ms`` is the "not interesting" threshold, and ``0`` renders every
    call. Returns the EMPTY STRING rather than a sentinel when there is nothing
    worth saying, so a caller appends it unconditionally and the fast path adds
    no line at all.

    Verbatim with ``render.ts``. Both halves say the same words about the same
    number, which is the rule for everything in this file: a prompt that worked
    through MCP and misbehaves in the widget is a bug with no stack trace.
    """
    # A negative or non-finite figure is a broken clock, not a fast call, and
    # the honest rendering of a measurement that did not happen is silence. A
    # monotonic clock cannot go backwards; an injected one can, and a test
    # clock that does should not put `took: ~-1s` in a prompt.
    if ms != ms or ms in (float("inf"), float("-inf")):
        return ""
    whole = int(ms // 1)
    if whole < 0 or whole < floor_ms:
        return ""
    return f"took: {_bucket(whole)}"


def _bucket(ms: int) -> str:
    """Whole milliseconds as a coarse, stable label.

    Integer arithmetic only, and no locale and no float formatting anywhere:
    ``toFixed`` and ``%.1f`` are the two things most likely to disagree between
    the two implementations, and this function's entire job is to agree. Each
    band floors rather than rounds, so the label never claims more time than
    elapsed.

    ==============  ==============  =========================================
    under 100ms     ``under 0.1s``  said in words, because ``~0.0s`` reads as
                                    zero and ``~0.1s`` would overstate it
    under 1s        ``~0.4s``       tenths: the resolution a ``floor_ms=0``
                                    caller asked for, and the one at which two
                                    fetches are actually worth comparing
    under 10s       ``~2s``         whole seconds
    under 1m        ``~15s``        five-second steps. Tens were the first try
                                    and understated badly at the top of the
                                    band — 19 seconds rendering ``~10s`` is a
                                    47% lie, and "it took ten seconds" is the
                                    sentence a model will repeat to somebody.
                                    Five is still far coarser than any
                                    scheduler noise, so the label is stable
                                    where the app is
    1m and over     ``~3m``         whole minutes
    ==============  ==============  =========================================
    """
    if ms < 100:
        return "under 0.1s"
    if ms < 1000:
        return f"~0.{ms // 100}s"
    if ms < 10_000:
        return f"~{ms // 1000}s"
    if ms < 60_000:
        return f"~{(ms // 5_000) * 5}s"
    return f"~{ms // 60_000}m"


def render_snapshot(snapshot: Snapshot) -> str:
    """The screen as a short text block.

    ::

        screen: contacts
        where: contacts, filtered to Acme (rev 8)
        selected: c-8821
        rows 1-2 of 5
        id      company  status
        c-8820  Acme     new
        c-8821  Acme     accepted

    Field order is fixed so the same screen renders identically every time: a
    model comparing two reads should see a diff only where the screen changed.

    ``screen`` goes FIRST, above the prose, and is omitted by an app that does
    not declare one. It is the one line on this block a model can compare for
    equality: ``where`` carries the filter, the sort and a drill-down's record
    description, so it moves for reasons that are not navigation, and two reads
    either side of a ``go`` differ in a dozen ways. One short word that changes
    if and only if the screen changed is worth a line of the uncached half.
    Verbatim from the TS half, which this file is kept string-for-string with.
    """
    # ``getattr`` for the same reason ``selected_count`` below uses it: the
    # field arrives from the wire, and an older ``Snapshot`` dataclass without
    # it must keep rendering rather than raise.
    screen = getattr(snapshot, "screen", None)
    lines = [f"where: {snapshot.where} (rev {snapshot.rev})"]
    if screen:
        lines.insert(0, f"screen: {screen}")

    # ``is None`` and not ``or ()``: an absent ``selected`` and an empty one
    # are different claims, and the branch below has to tell them apart.
    selected = snapshot.selected if snapshot.selected is not None else None
    on_screen = selected or ()
    if on_screen:
        # Before the rows, because "this one" is usually the subject of the
        # next verb and the model should not have to scan the table to find it.
        lines.append("selected: " + ", ".join(on_screen))

    # Read off the snapshot defensively because a relay may be newer or older
    # than this client: the field arrives from the wire, and an older
    # ``Snapshot`` dataclass without it must keep rendering rather than raise.
    selected_count = getattr(snapshot, "selected_count", None)
    if selected_count is not None and selected_count != len(on_screen):
        # The ids and the size of a selection are different facts, and the size
        # is the one a commit decision turns on. ``selected`` carries only what
        # is on screen — ten thousand ids in the uncached half is the token
        # budget gone — so a model holding three ids and about to commit has to
        # be told in words that the list is a window onto the selection and not
        # the selection. Verbatim from the TS half.
        lines.append(
            f"selected {selected_count:,} rows in all; "
            + (
                f"the {len(on_screen)} ids above are only the ones on screen"
                if on_screen
                else "none of them are on screen"
            )
        )
    elif not on_screen:
        # An absent value reads as a claim — the same defect already fixed on
        # ``page`` and on ``rows``, in the one remaining place it was still
        # live.
        #
        # This block used to be nothing at all: the selection was described
        # only when it was non-empty, so a screen with nothing selected said
        # NOTHING about selections, and silence cannot be told from "this
        # screen does not report selections". The library's own rule is that a
        # commit is never made on a count nobody read, so a model asked to
        # accept the selection here obeyed the rule against a screen that told
        # it nothing — and went navigating other screens hunting for the
        # number. Observed in an eval run, not imagined.
        #
        #   selectedCount: 0            the app counts, and the answer is none
        #   count absent, selected []   the app says which ids on screen are
        #                               selected and none are, but does not
        #                               count, so a row off screen may still
        #                               be selected
        #   both absent                 the app does not report selections at
        #                               all
        #
        # Three sentences because they are three different facts, and the whole
        # bug was one of them being rendered as another. The middle one is the
        # weakest claim and the one nobody thinks about; conflating it with the
        # first would say "nothing is selected" on the strength of a window.
        # Verbatim from the TS half.
        if selected_count == 0:
            lines.append("selected: none (0 rows; this screen counts the selection)")
        elif selected is None:
            lines.append("(this screen reports no selection)")
        else:
            lines.append(
                "selected: none on screen; this screen does not count the selection, so rows "
                "off screen may be selected"
            )

    if snapshot.note:
        lines.append(f"note: {snapshot.note}")

    rows = snapshot.rows
    if rows is None:
        # Absent rows and zero rows are different claims. An app with no table
        # on screen reports no rows; a filter that matched nothing reports an
        # empty list, and an agent told "no rows" in the first case would
        # conclude the records do not exist.
        lines.append("(this screen reports no rows)")
        return "\n".join(lines)

    page = snapshot.page
    if page is not None:
        first = page.index * page.size + 1 if rows else 0
        seen = page.index * page.size + len(rows)
        # ``total`` is optional in the TS `Snapshot`, and total-absent is the
        # NORMAL case for anything reading a rendered DOM: an adapter cannot
        # tell a virtualised grid from a short list, so it is the only honest
        # thing it can say. ``getattr`` because this dataclass may still
        # require it while a relay is already sending screens without it.
        total = getattr(page, "total", None)

        if total is None:
            # Rendered as a claim rather than as a gap. "of at least 20" is
            # true, which "of None" and "of 20" are not — the first is noise a
            # model ignores or hallucinates around, the second tells it the
            # table ends where the window ends and invites it to report that a
            # record does not exist. The count a nobody-knows total would need
            # is simply not said. Verbatim from the TS half.
            lines.append(
                f"rows {first}-{first + len(rows) - 1} of at least {seen} (total unknown)"
                if rows
                else f"rows 0 of at least {seen} (total unknown)"
            )
            lines.append(
                "the total is not known, so more rows may exist off screen; use the app's own "
                "paging verb to look further, and do not report that something is absent on "
                "the strength of this window"
            )
        else:
            lines.append(
                f"rows {first}-{first + len(rows) - 1} of {total}" if rows else f"rows 0 of {total}"
            )
            if seen < total:
                # Said in words, because `of 5` alone has repeatedly been read
                # by models as "I have all five".
                lines.append(
                    "more rows exist off screen; use the app's own paging verb to reach them"
                )
    else:
        # No `page` is a claim that this is everything. Worth stating, since
        # the alternative reading — "the relay forgot to tell me" — leads an
        # agent to hunt for a paging verb that does not exist.
        lines.append(f"rows {len(rows)} (all of them)")

    if not rows:
        lines.append("(no rows on screen)")
        return "\n".join(lines)

    lines.extend(_table(snapshot))
    return "\n".join(lines)


def render_result(result: Result, kind: str | None = None) -> str:
    """A Result as text: the outcome, then the screen it left behind.

    ``kind`` is the verb's ``read``/``describe``/``commit`` and changes only
    one thing: what a client is told to do when the outcome is unknown. It is
    passed in rather than read off the result because the kind lives in the
    cached half and the result does not carry it.

    A refusal renders as an ordinary outcome and not as an error banner. The
    refusal slug is the one the manifest already declared under ``refuses``, so
    an agent that read the tool description recognises the word and generally
    knows the fix; wrapping it in alarm language mostly teaches a model to
    retry the same call.

    A relay refusal is the exception, and is rendered loudly, because it is not
    the app saying no — it is the call not landing, or nobody knowing.
    """
    relay = result.relay_refusal
    if relay is not None:
        return _render_relay_refusal(result, relay, kind)

    if result.ok:
        head = "ok" + (f" — {result.note}" if result.note else "")
        if result.count is not None:
            # On its own line, high up, with thousands separators. This is the
            # number a person would have to see before pressing a bulk button,
            # and the reason `describe` and `commit` are separate verbs; a
            # renderer that folds it into prose further down has given back the
            # safety the split was bought with. 1000 and 10000 also look alike
            # at a glance, which is the mistake that costs the most.
            head += (
                f"\ncount: {result.count:,} matched"
                "\nThis is what a commit verb acting on the current selection would affect. "
                "Check it is the number you expect before committing."
            )
        if result.plan is not None:
            # Rendered directly under the count, because it is the count's
            # receipt and means nothing apart from it. Without this line the
            # token exists in the Result and the model never sees it, so every
            # commit that requires one is refused -- the field would be plumbing
            # that reaches everywhere except the one reader that has to use it.
            #
            # Verbatim with the TS half. The two renderers say the same words to
            # the same model, and a difference between them is a difference in
            # what an agent is told depending on how it connected.
            head += (
                f"\nplan: {result.plan}"
                "\nPass this `plan` back to the commit verb that acts on this selection. It is "
                "the receipt for the count above: if anything moves the selection first the "
                "commit is refused as `stale-plan` rather than acting on rows nobody counted. "
                "One commit per plan. Reading and navigating do not move the selection and do "
                "not spend this plan, so go and check whatever you need to before you commit."
            )
    else:
        head = f"refused: {result.refused}"
        if result.hint:
            head += f"\nhint: {result.hint}"

    if result.snapshot is None:
        # Shape says app refusal, but there is no screen. Not a case a
        # conforming relay produces; saying so beats rendering a blank screen,
        # which would read as "the app is empty".
        return head + "\n(no snapshot was returned)"

    return head + "\n\n" + render_snapshot(result.snapshot)


def _render_relay_refusal(result: Result, relay: str, kind: str | None) -> str:
    """A refusal from the relay about a call that never reached a tab.

    Kept visibly distinct from an app's own refusal. An agent that reads
    ``no-such-tab`` as a business rule will rephrase its arguments and try
    again forever, when what it needs to do is list the tabs; and an agent that
    reads ``timeout`` as a failure may repeat a commit that already happened.
    """
    lines = [f"the call did not complete: {relay}"]
    if result.hint:
        lines.append(f"hint: {result.hint}")

    if result.outcome_unknown:
        lines.append(_UNKNOWN_WHY.get(relay, "") + " " + _UNKNOWN_OUTCOME)
        lines.append(_UNKNOWN_COMMIT if kind == "commit" else _UNKNOWN_SAFE)
    elif relay == "no-such-tab":
        lines.append(_NEVER_LANDED + " List the tabs: the id may be wrong, or that tab has closed.")
    else:
        lines.append(_NEVER_LANDED)

    # Never an invented empty screen. Its absence is the signal, and a blank
    # table would tell an agent the app has no rows.
    #
    # Worded by case: "nothing ran" is only true of `no-such-tab`, and putting
    # it under an unknown outcome would contradict the line above it — the one
    # saying the verb may well have run. A model reading both believes the
    # reassuring one.
    lines.append(
        "(no snapshot: nobody read the screen, so this says nothing about what the app now holds)"
        if result.outcome_unknown
        else "(no snapshot: nothing ran and nobody looked)"
    )
    return "\n".join(lines)


def _table(snapshot: Snapshot) -> list[str]:
    """Rows as a padded text table.

    Columns are the union of every row's keys, not the first row's: rows are
    not required to agree, and silently dropping a column that only some rows
    carry would hide exactly the outlier a person is usually asking about.
    """
    columns = snapshot.columns()
    rows = snapshot.rows or ()
    cells = [[_cell(row.get(c)) for c in columns] for row in rows]

    widths = [len(c) for c in columns]
    for row_cells in cells:
        for i, text in enumerate(row_cells):
            widths[i] = max(widths[i], len(text))

    def line(values: list[str]) -> str:
        # The last column is not padded: trailing spaces are tokens that carry
        # nothing.
        return "  ".join(
            v.ljust(widths[i]) if i < len(values) - 1 else v for i, v in enumerate(values)
        ).rstrip()

    return [line(columns), *(line(c) for c in cells)]


def _cell(value: object) -> str:
    if value is None:
        return "-"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)
