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

__all__ = ["render_snapshot", "render_result"]

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


def render_snapshot(snapshot: Snapshot) -> str:
    """The screen as a short text block.

    ::

        where: contacts, filtered to Acme (rev 8)
        selected: c-8821
        rows 1-2 of 5
        id      company  status
        c-8820  Acme     new
        c-8821  Acme     accepted

    Field order is fixed so the same screen renders identically every time: a
    model comparing two reads should see a diff only where the screen changed.
    """
    lines = [f"where: {snapshot.where} (rev {snapshot.rev})"]

    selected = snapshot.selected or ()
    if selected:
        # Before the rows, because "this one" is usually the subject of the
        # next verb and the model should not have to scan the table to find it.
        lines.append("selected: " + ", ".join(selected))

    # Read off the snapshot defensively because a relay may be newer or older
    # than this client: the field arrives from the wire, and an older
    # ``Snapshot`` dataclass without it must keep rendering rather than raise.
    selected_count = getattr(snapshot, "selected_count", None)
    if selected_count is not None and selected_count != len(selected):
        # The ids and the size of a selection are different facts, and the size
        # is the one a commit decision turns on. ``selected`` carries only what
        # is on screen — ten thousand ids in the uncached half is the token
        # budget gone — so a model holding three ids and about to commit has to
        # be told in words that the list is a window onto the selection and not
        # the selection. Verbatim from the TS half.
        lines.append(
            f"selected {selected_count:,} rows in all; "
            + (
                f"the {len(selected)} ids above are only the ones on screen"
                if selected
                else "none of them are on screen"
            )
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
