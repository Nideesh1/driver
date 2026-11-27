"""Which tab is the person looking at, through the Python half.

``driverkit-mcp --tab <id>`` works and "omit it when exactly one tab is
connected" stops working at two, and nothing in the protocol expressed *"the
one I am looking at"* — which is what a person means when they are asked. The
page now reports its own focus; this file pins the two halves of what happens
next.

**The split is the design.** The relay carries the string and has no opinion
about it, exactly as it carries ``rev`` — which is what keeps the two relay
implementations behaviourally identical, by having neither of them implement
the rule. The rule lives in :func:`driverkit.mcp_core.pick_tab`, in the client,
where it is one function both MCP servers call.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from relay_harness import get_json, up  # noqa: E402
from test_relay import RelayTest  # noqa: E402

from driverkit.mcp_core import FOCUS_WORDS, pick_tab, render_tabs  # noqa: E402
from driverkit.types import Tab  # noqa: E402


def tab(tab_id: str, focus: str | None = None, **extra: object) -> Tab:
    return Tab(id=tab_id, focus=focus, **extra)  # type: ignore[arg-type]


class PickTab(unittest.TestCase):
    """The rule, and above all the cases where it refuses to answer."""

    def test_one_tab_is_that_tab_even_when_it_reports_no_focus(self):
        # The behaviour this had before focus existed, kept exactly. A relay
        # from before the field, or a tab driven by a hand-written loop, must go
        # on being drivable with no ``--tab`` at all.
        self.assertEqual(pick_tab([tab("t1")]).id, "t1")

    def test_the_one_focused_tab_wins_over_a_tab_that_says_nothing(self):
        # A tab reporting ``focused`` is CLAIMING the person is looking at it,
        # which is a stronger statement than silence. The silent tab might in
        # truth be the one, and that is the trade: a positive claim beats an
        # absence, because the alternative is asking a question in the ordinary
        # case of one modern page and one older one.
        chosen = pick_tab([tab("old"), tab("new", "focused")])
        self.assertEqual(chosen.id, "new")

    def test_hidden_tabs_are_not_candidates(self):
        chosen = pick_tab([tab("a", "hidden"), tab("b", "focused"), tab("c", "hidden")])
        self.assertEqual(chosen.id, "b")

    def test_nobody_focused_and_one_tab_on_screen_is_the_tab_they_were_last_in(self):
        # THE PERSON IS IN ANOTHER APPLICATION ENTIRELY. No tab is focused, and
        # the answer is still unambiguous: with one window exactly one tab of an
        # app is on screen and the rest are hidden. "The one I was last in" is
        # what they will mean when they come back, and refusing to answer here
        # would make the common case — alt-tab to a terminal, run the agent —
        # the case that asks a question.
        chosen = pick_tab([tab("a", "visible"), tab("b", "hidden")])
        self.assertEqual(chosen.id, "a")

    def test_two_windows_each_with_a_focused_tab_is_a_question_and_not_a_guess(self):
        # It should not happen -- ``hasFocus()`` is false in a window that is
        # not frontmost -- which is exactly why it must not be guessed at when
        # it does. A wrong answer confidently given drives somebody's other
        # screen; the cost of asking is one sentence.
        self.assertIsNone(pick_tab([tab("a", "focused"), tab("b", "focused")]))

    def test_two_tabs_on_screen_and_neither_focused_is_a_question(self):
        self.assertIsNone(pick_tab([tab("a", "visible"), tab("b", "visible")]))

    def test_two_tabs_that_report_nothing_is_the_question_it_always_was(self):
        # A relay or a page from before this field. The old behaviour, kept: two
        # tabs and no way to tell them apart is a refusal to guess.
        self.assertIsNone(pick_tab([tab("a"), tab("b")]))

    def test_it_never_falls_back_to_the_first_tab(self):
        # The one thing that would make the ambiguous case LOOK handled. The
        # failure would be a commit landing in a window nobody was watching, and
        # nobody would find out until afterwards.
        tabs = [tab("a"), tab("b"), tab("c")]
        self.assertIsNone(pick_tab(tabs))
        self.assertIsNone(pick_tab(list(reversed(tabs))))

    def test_no_tabs_at_all_is_a_question_too(self):
        self.assertIsNone(pick_tab([]))


class RenderTabs(unittest.TestCase):
    def test_the_listing_a_person_is_asked_from_says_which_one_they_are_looking_at(self):
        # The listing IS the question. A person who is shown which tabs are open
        # and which one is in front of them answers in one line; a listing of
        # three opaque ids leaves them guessing as badly as the server was.
        text = render_tabs(
            [
                tab("a", "focused", app="CRM", title="Contacts", url="/app/#/contacts"),
                tab("b", "hidden", app="CRM", title="Companies", url="/app/#/companies"),
            ],
            "a",
        )
        self.assertIn(FOCUS_WORDS["focused"], text)
        self.assertIn(FOCUS_WORDS["hidden"], text)
        self.assertIn("this server drives this one", text)

    def test_a_focus_value_this_version_has_not_heard_of_is_printed_rather_than_dropped(self):
        # PROTOCOL.md promises a field may gain a value without a version bump.
        # Showing nothing for a state we do not recognise would hide the one
        # thing the person is choosing on.
        self.assertIn("dozing", render_tabs([tab("a", "dozing")], ""))

    def test_a_tab_that_reports_no_focus_reads_exactly_as_it_did_before(self):
        self.assertEqual(render_tabs([tab("a", None, app="CRM")], ""), "a  CRM")


class FocusOnTheWire(RelayTest):
    """What the relay does with the field: carries it, and nothing else."""

    def test_hello_reports_focus_and_the_listing_carries_it_untouched(self):
        one = self.tab("t1")
        one.hello(focus="focused")
        row = get_json(f"{self.url}/dk/tabs")[1]["tabs"][0]
        self.assertEqual(row["focus"], "focused")

    def test_a_push_corrects_the_focus_and_the_url_that_hello_alone_could_not(self):
        # THE STALE URL, which is the bug that rode along. ``TabInfo.url`` came
        # from ``hello`` ALONE, so it was wrong from the first client-side route
        # change — and a single-page app navigates without reconnecting, so
        # ``hello`` may never come again. A push was already going out whenever
        # the page moved.
        one = self.tab("t1")
        one.hello(focus="focused", url="/app/#/contacts")
        one.push({"where": "companies", "rev": 8}, focus="visible", url="/app/#/companies/acme")

        row = get_json(f"{self.url}/dk/tabs")[1]["tabs"][0]
        self.assertEqual(row["focus"], "visible")
        self.assertEqual(row["url"], "/app/#/companies/acme")
        self.assertEqual(row["rev"], 8)

    def test_a_push_that_carries_neither_leaves_both_as_they_were(self):
        # Absent means "did not say", upserted exactly as ``hello`` upserts. A
        # tab connected by a hand-written loop, or by a driverkit older than
        # these fields, must read as it always did.
        one = self.tab("t1")
        one.hello(focus="focused", url="/app/#/contacts")
        one.push({"where": "contacts", "rev": 9})

        row = get_json(f"{self.url}/dk/tabs")[1]["tabs"][0]
        self.assertEqual(row["focus"], "focused")
        self.assertEqual(row["url"], "/app/#/contacts")

    def test_a_tab_that_never_reports_focus_has_no_focus_key_at_all(self):
        # Not ``null`` and not ``"hidden"``. Absence is unknown, and a client
        # that read it as "not the one" would stop being able to drive the tab.
        one = self.tab("t1")
        one.hello()
        row = get_json(f"{self.url}/dk/tabs")[1]["tabs"][0]
        self.assertNotIn("focus", row)

    def test_the_relay_originates_no_focus_of_its_own(self):
        # The relay cannot see ``document.hasFocus()`` and must not invent an
        # answer: a relay that decided which tab was active would be a second
        # place that decides, beside the page that actually knows. Two tabs, one
        # reporting, and the other stays silent rather than being inferred to be
        # the hidden one.
        a = self.tab("tab-a")
        b = self.tab("tab-b")
        a.hello(focus="focused")
        b.hello()
        rows = {r["tab"]: r for r in get_json(f"{self.url}/dk/tabs")[1]["tabs"]}
        self.assertEqual(rows["tab-a"]["focus"], "focused")
        self.assertNotIn("focus", rows["tab-b"])


class TabParsing(unittest.TestCase):
    def test_a_focus_the_relay_sent_survives_a_round_trip_through_Tab(self):
        parsed = Tab.from_dict({"tab": "t1", "focus": "visible", "since": "2026-01-01T00:00:00Z"})
        self.assertEqual(parsed.focus, "visible")
        self.assertEqual(parsed.to_dict()["focus"], "visible")

    def test_a_row_with_no_focus_parses_to_None_and_writes_nothing(self):
        parsed = Tab.from_dict({"tab": "t1"})
        self.assertIsNone(parsed.focus)
        self.assertNotIn("focus", parsed.to_dict())

    def test_a_non_string_focus_is_dropped_rather_than_coerced(self):
        # ``str(7)`` would become the state ``"7"``, which ``pick_tab`` would
        # then treat as a tab that reported something. Unknown is the honest
        # reading of a field whose type is wrong.
        self.assertIsNone(Tab.from_dict({"tab": "t1", "focus": 7}).focus)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
