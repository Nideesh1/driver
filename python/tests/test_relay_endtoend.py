"""
The shipped client against the shipped relay, with nothing faked on either side.

``test_relay.py`` plays the tab by hand on purpose: a test that drives both
ends of a contract with one codebase passes happily when both ends agree on the
wrong thing. This file does the opposite on purpose, because the other failure
mode is real too — two halves that each match the document and still cannot
talk to each other, because one reads a field the other spells differently.

So here the agent is :class:`driverkit.Driverkit`, the relay is
:class:`driverkit.Relay` behind the real standalone server, and the only thing
played by hand is the browser, which cannot be anything else from Python.
"""

from __future__ import annotations

import os
import sys
import unittest

from relay_harness import SNAP, Async, Tab, up, wait_for

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit import Driverkit, TransportError, render_result


class EndToEnd(unittest.TestCase):
    def setUp(self) -> None:
        self.running = up(self, timeout_s=0.4, ping_s=20.0)
        self.url = self.running.url
        self.dk = Driverkit(self.url)
        self.tab = Tab(self.url, "01a2-tab")
        self.addCleanup(self.tab.close)
        self.tab.hello()

    def test_the_client_reads_the_three_halves_the_relay_serves(self):
        tabs = self.dk.tabs()
        self.assertEqual([t.id for t in tabs], ["01a2-tab"])
        # The listing the client parses is the listing this relay emits, field
        # for field: the `tabs` envelope, the id spelled `tab`, and the manifest
        # version lifted out so a cache can be checked in one cheap request.
        self.assertEqual(tabs[0].manifest_version, "abc123")
        self.assertEqual(tabs[0].title, "Descents — toy")
        self.assertEqual(tabs[0].rev, 7)

        manifest = self.dk.manifest("01a2-tab")
        self.assertEqual(manifest.version, "abc123")
        self.assertIsNotNone(manifest.verb("goto"))

        snapshot = self.dk.snapshot("01a2-tab")
        self.assertEqual(snapshot.rev, 7)
        self.assertEqual([row.id for row in snapshot.rows or ()], ["01a2"])
        self.assertEqual(snapshot.rows[0]["lane"], "pruning")

    def test_a_verb_round_trips_from_the_client_through_the_relay_to_the_tab(self):
        pending = Async(lambda: self.dk.call("01a2-tab", "set-lane", {"id": "01a2", "lane": "held"}, rev=7))
        frame = self.tab.es.next_event("call")
        self.assertEqual(frame["rev"], 7, "the client's rev did not survive the relay")
        self.assertEqual(frame["args"], {"id": "01a2", "lane": "held"})

        self.tab.answer(
            frame["id"],
            {"ok": True, "note": "moved", "snapshot": {"where": "descents", "rev": 8, "rows": []}},
        )
        result = pending.result()
        self.assertTrue(result.ok)
        self.assertEqual(result.note, "moved")
        # The screen AFTER the call, which is the reason acting and observing
        # are one round trip rather than two.
        self.assertEqual(result.snapshot.rev, 8)
        # And it renders for a model without anybody reaching into the dict.
        self.assertIn("rev 8", render_result(result))

    def test_an_apps_own_refusal_arrives_as_a_value_with_the_screen_attached(self):
        pending = Async(lambda: self.dk.call("01a2-tab", "set-lane", {"id": "01a2", "lane": "doing"}))
        frame = self.tab.es.next_event("call")
        self.tab.answer(
            frame["id"],
            {
                "ok": False,
                "refused": "machine-may-not-leave-pruning",
                "hint": "pruning is the human gate",
                "snapshot": SNAP,
            },
        )
        result = pending.result()
        # A refusal is a value, not an exception: it is an outcome the agent is
        # expected to handle, and raising would push every caller into a
        # try/except around the app's own business rules.
        self.assertFalse(result.ok)
        self.assertEqual(result.refused, "machine-may-not-leave-pruning")
        # Not a relay refusal, and the snapshot is how the client can tell: the
        # app said no about a screen somebody looked at.
        self.assertIsNone(result.relay_refusal)
        self.assertIsNotNone(result.snapshot)
        self.assertTrue(result.landed)

    def test_the_three_relay_refusals_reach_the_client_as_what_they_are(self):
        # `no-such-tab` is the only one that proves the call did not happen: it
        # was never forwarded, because there was nowhere to forward it.
        missing = self.dk.call("never-existed", "goto")
        self.assertEqual(missing.relay_refusal, "no-such-tab")
        self.assertIsNone(missing.snapshot)
        self.assertFalse(missing.outcome_unknown)

        # A timeout leaves the outcome UNKNOWN. The tab may have run the verb
        # and failed to answer, so an agent must read the screen before
        # retrying — the reflex this property exists to block is treating a
        # non-answer as a failed step, which is the one move that turns one bulk
        # accept into two.
        wedged = self.dk.call("01a2-tab", "goto")
        self.assertEqual(wedged.relay_refusal, "timeout")
        self.assertTrue(wedged.outcome_unknown)
        self.assertIsNone(wedged.snapshot)
        # The tab did receive that call — it just never answered. Taken off the
        # queue here so the next assertion is about the next call and not this
        # one still sitting there.
        self.tab.es.next_event("call")

        # And the same for a stream that closed under an accepted call.
        pending = Async(lambda: self.dk.call("01a2-tab", "goto"))
        self.tab.es.next_event("call")
        self.tab.es.close()
        gone = pending.result()
        self.assertEqual(gone.relay_refusal, "tab-went-away")
        self.assertTrue(gone.outcome_unknown)

    def test_a_404_from_the_relay_is_a_transport_failure_not_a_refusal(self):
        # /manifest and /snapshot are deliberately NOT Result-shaped, so there
        # is no outcome to report here — only a broken expectation. The client's
        # error policy turns that into an exception, which is the one case where
        # it should.
        with self.assertRaises(TransportError):
            self.dk.manifest("never-existed")
        with self.assertRaises(TransportError):
            self.dk.snapshot("never-existed")

    def test_the_clients_watch_iterator_sees_what_the_person_does(self):
        seen: list[int] = []
        watching = Async(lambda: [seen.append(s.rev) for s in self.dk.watch("01a2-tab", timeout=10)])
        # The opening state, so a watcher of an idle screen knows something.
        wait_for(lambda: seen == [7])

        self.tab.push({"where": "descent 01a2", "rev": 8, "rows": []})
        wait_for(lambda: seen == [7, 8])

        # An agent's own change too, not only a human's: a watcher that learned
        # about half the moves would still have to poll for the rest.
        pending = Async(lambda: self.dk.call("01a2-tab", "goto", {"id": "01a2"}))
        frame = self.tab.es.next_event("call")
        self.tab.answer(frame["id"], {"ok": True, "snapshot": {"where": "descent", "rev": 9}})
        pending.result()
        wait_for(lambda: seen == [7, 8, 9])

        # The iterator ends when the relay closes the stream rather than
        # reconnecting behind the caller's back: "the stream ended" is
        # information an agent needs.
        self.running.relay.close()
        watching.result(timeout=5)

    def test_a_ten_thousand_row_selection_crosses_the_relay_as_three_ids_and_a_count(self):
        # The whole reason `selectedCount` exists, asserted across the real
        # relay rather than in the parser alone. `select-where` is designed to
        # select thousands of rows; a driver that filled `selected` honestly
        # would put tens of kilobytes of ids into the UNCACHED half of every
        # later result, paid for on every turn — and on a table this size
        # straight through this relay's own 1 MiB body limit.
        #
        # So the screen sends three ids and the number 10,000, and both halves
        # have to survive the trip: an agent cannot resolve "this one" from a
        # count, and cannot decide whether a bulk commit is safe from a
        # truncated list. The relay forwards the snapshot byte for byte, and
        # this test is what keeps a future "normalise the snapshot" from
        # quietly dropping the field.
        pending = Async(lambda: self.dk.call("01a2-tab", "select-where", {"where": "lane=pruning"}))
        frame = self.tab.es.next_event("call")
        self.tab.answer(
            frame["id"],
            {
                "ok": True,
                "count": 10_000,
                "snapshot": {
                    "where": "descents",
                    "rev": 8,
                    "rows": [{"id": "01a2"}, {"id": "01b7"}, {"id": "01c3"}],
                    "page": {"index": 0, "size": 3},
                    "selected": ["01a2", "01b7", "01c3"],
                    "selectedCount": 10_000,
                },
            },
        )
        result = pending.result()
        self.assertEqual(result.snapshot.selected_count, 10_000)
        self.assertEqual(result.snapshot.selected, ("01a2", "01b7", "01c3"))
        # And the window it came in: `page` with no `total`, which is the shape
        # a DOM-read table produces and which used to raise here.
        self.assertIsNone(result.snapshot.page.total)

        rendered = render_result(result)
        self.assertIn("10,000", rendered)
        self.assertIn("on screen", rendered)

        # The relay's own reads serve the same snapshot, so an agent that looks
        # before acting is not told a smaller selection than one that acted.
        self.assertEqual(self.dk.snapshot("01a2-tab").selected_count, 10_000)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
