"""
A call's duration over the relay, through the Python half.

The twin of ``packages/driverkit/test/relay-timing.test.ts``, assertion for
assertion, because PROTOCOL.md's whole argument is that two conforming relays
must not disagree — and a field added to one of them and not the other is the
cheapest possible way to make them disagree.

**The split is the design.** The tab measures, around its own call into its own
driver, with the person taken out by the only party that can see them. The relay
CARRIES: it has exactly one number of its own — the round trip it held the call
open for — and that number is the network out, plus the tab's work, plus any
question the page put to a person, plus the network back, which is the sum
``tookMs`` exists to take apart. So it copies, validates and has no opinion,
exactly as it carries ``rev`` and ``focus``.

And then the rendering, which is why any of it is on the wire: an agent arriving
over MCP previously had only its own round trip and so could not tell a slow app
from a slow network from somebody taking thirty seconds over an Approve button.
``render_duration`` existed for this and was deliberately not called from
``mcp_core`` until there was an honest figure to give it.
"""

from __future__ import annotations

import os
import sys
import threading
import unittest
from typing import Any

from relay_harness import call_async, up  # noqa: E402
from test_relay import RelayTest  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit.mcp_core import TIMING, TabTools, instructions_for  # noqa: E402
from driverkit.render import SLOW_MS, render_duration  # noqa: E402
from driverkit.types import Manifest, Result, Snapshot  # noqa: E402

SNAP: dict[str, Any] = {"where": "descents", "rev": 7, "rows": [{"id": "01a2"}]}


class TimingOnTheWire(RelayTest):
    """What the relay does with the two fields, and above all what it does not."""

    def _answer(self, result: dict[str, Any] | None = None, **extra: Any) -> Any:
        """One round trip: a call out, a `result` frame back, the agent's body."""
        one = self.tab("t1")
        one.hello()
        pending = call_async(self.url, "t1", {"name": "goto"})
        frame = one.es.next_event("call")
        one.answer(frame["id"], result or {"ok": True, "snapshot": SNAP}, **extra)
        status, body = pending.result()
        self.assertEqual(status, 200)
        return body

    def test_the_relay_carries_the_tabs_figure_to_the_agent_untouched(self):
        body = self._answer(tookMs=2100, waitedMs=38_000)
        self.assertEqual(body["tookMs"], 2100)
        self.assertEqual(body["waitedMs"], 38_000)
        # And the `result` itself is still forwarded byte for byte: the copy is
        # shallow and the two reserved keys are the only thing it touches.
        self.assertEqual(body["snapshot"], SNAP)
        self.assertIs(body["ok"], True)

    def test_a_tab_that_reports_nothing_leaves_the_agent_with_no_figure_rather_than_a_zero(self):
        # Absent is UNKNOWN. An older tab, a hand-written ``fetch`` loop and a
        # tab that could not say honestly all send nothing, and a relay that
        # filled in a zero would have every one of those apps reading as
        # instant — which is the one reading a client cannot recover from,
        # because zero looks like a measurement.
        body = self._answer()
        self.assertNotIn("tookMs", body)
        self.assertNotIn("waitedMs", body)

    def test_the_relay_never_substitutes_its_own_round_trip_for_a_missing_figure(self):
        # The relay's own number is in its audit record and is a different
        # quantity. Offering it here would make the relay a second place that
        # decides, beside the only process that can see where the call started.
        one = self.tab("t1")
        one.hello()
        pending = call_async(self.url, "t1", {"name": "goto"})
        frame = one.es.next_event("call")
        # A real delay, so a relay that timed the round trip would have
        # something non-zero to put in the body.
        threading.Event().wait(0.06)
        one.answer(frame["id"], {"ok": True, "snapshot": SNAP})
        self.assertNotIn("tookMs", pending.result()[1])

    def test_a_figure_the_app_put_in_its_own_result_is_not_passed_off_as_a_measurement(self):
        # ``tookMs`` is reserved on this body. The ``result`` is what the APP
        # returned, and an app reporting its own speed is a claim where the
        # agent is entitled to an observation — so a value found in there is
        # dropped, and only the frame's own field, written by the page-side
        # harness around its one call into the driver, is forwarded.
        body = self._answer({"ok": True, "snapshot": SNAP, "tookMs": 5, "waitedMs": 5})
        self.assertNotIn("tookMs", body)
        self.assertNotIn("waitedMs", body)
        # And the frame's own field wins over one the app wrote, rather than the
        # two being merged in whichever order the copy happened to run.
        second = self._answer({"ok": True, "snapshot": SNAP, "tookMs": 5}, tookMs=2100)
        self.assertEqual(second["tookMs"], 2100)

    def test_anything_that_is_not_a_finite_millisecond_count_is_dropped_on_the_way_through(self):
        # The rule ``Tab.from_dict`` already has for a ``focus`` that is not a
        # string: a relay carries what it was given or nothing, never a figure a
        # reader would have to guess the meaning of. A negative number is a
        # broken clock rather than a fast call, and ``True`` is an ``int`` in
        # Python, which is why it is excluded by name.
        for junk in ("2100", True, None, -1, {}):
            with self.subTest(junk=junk):
                self.assertNotIn("tookMs", self._answer(tookMs=junk))
        # A float is a number and survives JSON; it is floored rather than
        # dropped, because nothing downstream wants tenths of a millisecond and
        # every reader flooring for itself is how two clients come to disagree.
        self.assertEqual(self._answer(tookMs=2100.7)["tookMs"], 2100)

    def test_waited_ms_never_travels_without_the_figure_it_was_subtracted_from(self):
        # It is defined as the amount already taken out of ``tookMs``, so on its
        # own it is a quantity relative to nothing — and a reader might well
        # subtract it a second time from something.
        self.assertNotIn("waitedMs", self._answer(waitedMs=38_000))


class TheRecordTheRelayKeeps(unittest.TestCase):
    """The audit record deliberately does not grow a field."""

    def test_the_relays_audit_record_does_not_gain_the_tabs_figure(self):
        # The same argument as ``outcome`` saying ``delivered`` rather than
        # ``ok``: a relay must not assert what it did not observe, and
        # ``tookMs`` was measured in another process where the relay cannot
        # check it. Logging it beside ``ms`` would also invite the subtraction
        # nobody should make — the difference is not "the network", it is the
        # network plus however long the frame sat in the tab's event loop plus
        # whatever a proxy buffered.
        from relay_harness import Tab

        seen: list[dict] = []
        lock = threading.Lock()

        def on_audit(event):
            with lock:
                seen.append(dict(event))

        running = up(self, ping_s=20.0, timeout_s=15.0, on_audit=on_audit)
        one = Tab(running.url, "t1")
        self.addCleanup(one.close)
        one.hello()
        pending = call_async(running.url, "t1", {"name": "goto"})
        frame = one.es.next_event("call")
        one.answer(frame["id"], {"ok": True, "snapshot": SNAP}, tookMs=2100, waitedMs=38_000)
        pending.result()

        self.assertEqual(
            sorted(seen[0]), ["at", "ms", "outcome", "principal", "tab", "verb"]
        )
        self.assertEqual(seen[0]["outcome"], "delivered")


class ParsingAFigure(unittest.TestCase):
    """``Result.from_dict``, which is where a client meets the field."""

    def test_an_absent_figure_is_none_and_not_zero(self):
        # ``None`` is the unknown this client must keep, because every renderer
        # downstream has to be able to say nothing rather than say "fast".
        self.assertIsNone(Result.from_dict({"ok": True, "snapshot": SNAP}).took_ms)

    def test_junk_is_dropped_rather_than_raised_on(self):
        # Dropping is the rule ``Tab.from_dict`` set for a ``focus`` that is not
        # a string: a client that refused to parse a result because one optional
        # field was broken would lose the screen as well, and the screen is the
        # half that matters.
        for junk in ("2100", True, None, -1, float("nan"), float("inf"), {}):
            with self.subTest(junk=junk):
                parsed = Result.from_dict({"ok": True, "snapshot": SNAP, "tookMs": junk})
                self.assertIsNone(parsed.took_ms)

    def test_a_float_is_floored_and_a_wait_only_arrives_beside_a_figure(self):
        parsed = Result.from_dict({"ok": True, "snapshot": SNAP, "tookMs": 2100.7})
        self.assertEqual(parsed.took_ms, 2100)
        lone = Result.from_dict({"ok": True, "snapshot": SNAP, "waitedMs": 38_000})
        self.assertIsNone(lone.waited_ms)

    def test_a_round_trip_through_to_dict_puts_them_back_beside_ok(self):
        # Beside ``ok`` and not inside anything, because that is where the relay
        # puts them: they are the relay's copy of the tab's measurement and are
        # reserved on this body, never the app's to fill in.
        out = Result(ok=True, snapshot=Snapshot.from_dict(SNAP), took_ms=400, waited_ms=38_000).to_dict()
        self.assertEqual(out["tookMs"], 400)
        self.assertEqual(out["waitedMs"], 38_000)


#: One commit and one read, which is all the rendering tests need from a
#: manifest: ``kind`` is passed to ``render_result`` for the unknown-outcome
#: wording and changes nothing about a duration.
MANIFEST = {
    "version": "deadbeef0001",
    "app": "toy",
    "verbs": [
        {"name": "fetch", "kind": "read", "describe": "fetch the report"},
        {"name": "accept", "kind": "commit", "describe": "accept the selection"},
    ],
}


class StubClient:
    """A client that answers one prepared ``Result``.

    Not the fake relay, deliberately. What these tests pin is the rendering
    decision — which figure reaches a model and in which half of the turn — and
    a stub is the only way to hand ``TabTools`` a result with a ``tookMs`` in it
    without also re-testing HTTP, which ``TimingOnTheWire`` above already does
    against a real relay over a real socket.
    """

    def __init__(self, result: Result) -> None:
        self.result = result

    def manifest(self, tab: str) -> Manifest:
        return Manifest.from_dict(MANIFEST)

    def call(self, *args: Any, **kwargs: Any) -> Result:
        return self.result

    def snapshot(self, tab: str) -> Snapshot:
        return Snapshot.from_dict(SNAP)


def rendered(timing: str = TIMING, verb: str = "fetch", **fields: Any) -> str:
    result = Result.from_dict({"ok": True, "snapshot": SNAP, **fields})
    return TabTools(StubClient(result), "t1", timing).call(verb).text  # type: ignore[arg-type]


class RenderingItForAModel(unittest.TestCase):
    """What the MCP path now prints, and what it still refuses to print."""

    def test_a_slow_verb_renders_the_tabs_own_figure_in_the_outcome_half(self):
        # ABOVE THE SCREEN, like the in-page loop puts it: "how long did my
        # third call take" is a question whose answer stays true forever, like
        # ``ok`` and like the count, and unlike the table.
        text = rendered(tookMs=2100)
        self.assertEqual(text.split("\n\n")[0], "ok\ntook: ~2s")
        # Through ``render_duration`` and not a format string of this file's
        # own: the two halves of the library say the same words about the same
        # number, and ``test/cross-impl.test.ts`` is what holds them to it.
        self.assertIn(render_duration(2100), text)

    def test_an_in_page_approvals_wait_is_not_counted_as_app_time_over_the_wire(self):
        # THE LIE THIS WHOLE FILE EXISTS TO PREVENT. 38.4 seconds of wall clock
        # for 400ms of app, and nothing is rendered, because the figure on the
        # wire is already net of the person and 400ms is under the threshold. A
        # renderer that added ``waitedMs`` back would print ``took: ~35s`` and a
        # model reading it would go looking for a faster route around a verb
        # that is not slow.
        text = rendered(verb="accept", tookMs=400, waitedMs=38_000)
        self.assertNotIn("took:", text)
        self.assertNotIn("38", text)
        # And the figure a naive implementation would have printed, spelled out
        # so the assertion above is visibly about a real number and not about a
        # field that happens to be absent.
        self.assertEqual(render_duration(400 + 38_000), "took: ~35s")

    def test_a_tab_that_reports_nothing_renders_no_duration_rather_than_a_zero(self):
        # The older tab, the hand-written loop, and the call the tab could not
        # time honestly. ``None`` is UNKNOWN, and the honest rendering of a
        # measurement that did not happen is silence — not ``took: under 0.1s``,
        # which is a claim, and not a zero, which is a claim twice.
        text = rendered()
        self.assertNotIn("took:", text)
        self.assertEqual(text.split("\n\n")[0], "ok")

    def test_a_fast_call_costs_nothing_which_is_what_makes_slow_affordable_here(self):
        # The token argument, the same one the in-page default rests on: a
        # duration on every call is a line in every turn forever, for a
        # capability most runs never use. The boundary is at ``SLOW_MS`` and not
        # one millisecond either side of it.
        self.assertNotIn("took:", rendered(tookMs=SLOW_MS - 1))
        self.assertIn("took: ~1s", rendered(tookMs=SLOW_MS))

    def test_always_is_for_the_run_that_was_asked_to_compare_two_fast_verbs(self):
        # "Both were under a second" is a true answer and often a useless one.
        self.assertIn("took: ~0.4s", rendered("always", tookMs=450))

    def test_off_renders_the_bytes_this_path_printed_before_any_of_this_existed(self):
        self.assertNotIn("took:", rendered("off", tookMs=2100))
        self.assertNotIn("took:", instructions_for(Manifest.from_dict(MANIFEST)))

    def test_a_relay_refusal_renders_no_duration_even_if_a_figure_arrives_with_it(self):
        # There is no tab answer behind one. ``no-such-tab`` never reached
        # anybody, and ``timeout`` and ``tab-went-away`` leave the outcome
        # unknown — where ``render_duration``'s own rule is that a deadline that
        # fired is not a duration. The refusal's own loud wording is what the
        # model needs there, and a ``took:`` line beside it would read as
        # evidence that something ran.
        result = Result.from_dict({"ok": False, "refused": "timeout", "tookMs": 60_000})
        text = TabTools(StubClient(result), "t1").call("accept").text  # type: ignore[arg-type]
        self.assertNotIn("took:", text)
        self.assertIn("UNKNOWN", text)

    def test_the_mcp_default_is_the_panels_and_not_the_primitives(self):
        # ``drive`` defaults to ``"off"`` because it is a library primitive whose
        # existing callers must get byte-identical transcripts. This server is
        # not that: it is one process pointed at one live tab for one agent, and
        # it is the reader with no other way of knowing the app was slow —
        # which is the whole reason the figure is on the wire at all.
        self.assertEqual(TIMING, "slow")
        self.assertEqual(TabTools(StubClient(Result(ok=True)), "t1").timing, "slow")  # type: ignore[arg-type]

    def test_the_model_is_told_once_what_a_took_line_means_and_that_silence_is_ambiguous(self):
        # A sentence of guidance beside every duration would be the one piece of
        # boilerplate in a turn that is O(calls), for a number that needs
        # explaining once — so it goes in the instructions a client prepends
        # once, which is where the TS half puts it too.
        note = instructions_for(Manifest.from_dict(MANIFEST), "slow")
        self.assertIn("`took:`", note)
        self.assertIn("rounded", note)
        self.assertIn("reading a confirmation", note)
        # AND NOT THE TS HALF'S SENTENCE ABOUT SILENCE. ``systemPrompt`` can say
        # a missing line means the call was fast, because in the page the clock
        # is in the same process as the verb. Over the relay silence has a
        # second cause — PROTOCOL.md makes an absent ``tookMs`` UNKNOWN — and a
        # model told silence means fast would report an unmeasured app as a
        # quick one.
        self.assertIn("does not report its own timing", note)
        self.assertIn("do not say a call with no line was fast", note)
        self.assertIn("network between you and the tab is not in it", note)


if __name__ == "__main__":
    unittest.main()
