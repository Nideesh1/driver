"""
The Python relay's audit records, and they are a port of the relay half of
``packages/driverkit/test/audit.test.ts`` test for test.

There are two independent implementations of this protocol and a difference
between them is a difference nobody finds until an operator switches, so what
these pin is not only that the Python relay emits records but that it emits THE
SAME records: the same six keys, the same four outcomes, times in milliseconds
since the epoch because that is what ``Date.now()`` is and an operator reading
both logs must not have to convert one.

What the relay deliberately does NOT record is as pinned as what it does. It
never copies the driver's verdict, because a copy of somebody else's decision is
a second source of truth that can disagree with the first.
"""

from __future__ import annotations

import os
import sys
import threading
import unittest

from relay_harness import Tab, call_async, post_json, up

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))


#: The field names the TypeScript `RelayAuditEvent` has, and the whole of them.
#: Spelled out rather than derived, because the point of the assertion is to
#: fail when one implementation grows a field the other has not.
FIELDS = ["at", "ms", "outcome", "principal", "tab", "verb"]


class AuditTest(unittest.TestCase):
    """One relay per test, with its records collected off the hook."""

    def setUp(self) -> None:
        self.seen: list[dict] = []
        self.lock = threading.Lock()

        def on_audit(event):
            # Appended under a lock: the relay answers calls on its own request
            # threads, so a host's hook is called from whichever one settled the
            # call, and a test that assumed otherwise would be flaky rather than
            # wrong. Worth stating here because it is also what an adopter's own
            # sink has to know.
            with self.lock:
                self.seen.append(dict(event))

        self.errors: list[BaseException] = []
        self.running = up(
            self, ping_s=20.0, timeout_s=15.0, on_audit=on_audit, on_error=self.errors.append
        )
        self.url = self.running.url

    def tab(self, tab_id: str) -> Tab:
        tab = Tab(self.url, tab_id)
        self.assertEqual(tab.es.status, 200, "the tab's stream did not open")
        self.addCleanup(tab.close)
        return tab

    def test_the_relay_records_who_asked_which_no_in_page_hook_can_know(self):
        # The one fact the relay cannot help knowing and a driver cannot learn:
        # a call arrived from outside, and from which principal. A driver sees a
        # call and has no idea whether it came from the panel in front of a
        # person or from somebody else's agent holding a token.
        one = self.tab("t1")
        one.hello()

        pending = call_async(self.url, "t1", {"name": "accept-selected"})
        frame = one.es.next_event("call")
        one.answer(frame["id"], {"ok": True, "snapshot": {"where": "contacts", "rev": 2}})
        self.assertEqual(pending.result()[0], 200)

        self.assertEqual(len(self.seen), 1)
        event = self.seen[0]
        self.assertEqual(sorted(event), FIELDS)
        self.assertEqual(event["verb"], "accept-selected")
        self.assertEqual(event["tab"], "t1")
        # The unconfigured loopback relay is one principal and says so, rather
        # than implying an identity nobody established.
        self.assertEqual(event["principal"], "local")
        # `delivered`, and nothing more. What the app decided is in the driver's
        # own record, in the process where it was decided — so the two logs are
        # not two countings of one commit.
        self.assertEqual(event["outcome"], "delivered")
        # Milliseconds, and integers, like `Date.now()`. A float here would be a
        # field two implementations spell differently in the same log file.
        self.assertIsInstance(event["at"], int)
        self.assertIsInstance(event["ms"], int)
        self.assertGreater(event["at"], 1_600_000_000_000)
        self.assertGreaterEqual(event["ms"], 0)

    def test_the_relay_never_copies_the_drivers_verdict_into_its_own_record(self):
        # The relay has the WireResult in its hand and deliberately does not
        # read it. A relay that logged `ok` for a call whose tab died mid-commit
        # would be asserting an outcome nobody observed.
        one = self.tab("t2")
        one.hello()

        pending = call_async(self.url, "t2", {"name": "accept-selected"})
        frame = one.es.next_event("call")
        one.answer(
            frame["id"],
            {
                "ok": False,
                "refused": "nothing-selected",
                "snapshot": {"where": "contacts", "rev": 2},
            },
        )
        self.assertEqual(pending.result()[1]["refused"], "nothing-selected")

        self.assertEqual(self.seen[0]["outcome"], "delivered", "a refusal still reached the tab")
        self.assertNotIn("nothing-selected", str(self.seen[0]))

    def test_a_call_for_a_tab_nobody_owns_is_recorded_here_because_nowhere_else_will(self):
        # Nothing reached a tab, so no audit hook anywhere else in the library
        # will ever hear about this call. An agent working through tab ids it
        # does not own leaves its marks only in the relay's log, which is the
        # reason three of the four outcomes exist at all.
        status, body = post_json(f"{self.url}/dk/tabs/ghost/call", {"name": "accept-selected"})
        self.assertEqual(status, 200)
        self.assertEqual(body["refused"], "no-such-tab")
        self.assertEqual(len(self.seen), 1)
        self.assertEqual(self.seen[0]["outcome"], "no-such-tab")
        self.assertEqual(self.seen[0]["tab"], "ghost")
        self.assertEqual(self.seen[0]["verb"], "accept-selected")

    def test_a_call_that_arrives_with_no_verb_name_is_not_an_audit_record(self):
        # It is not a call: there is no verb to have been asked for, so the relay
        # answers 400 rather than a WireResult, and a record naming no verb would
        # be a line in an audit log that says nothing. This log is a record of
        # calls and not an HTTP access log — the host's server already has one of
        # those.
        status, _ = post_json(f"{self.url}/dk/tabs/ghost/call", {"args": {"id": "x"}})
        self.assertEqual(status, 400)
        self.assertEqual(self.seen, [])

    def test_a_relay_audit_hook_that_throws_goes_to_on_error_and_never_to_the_caller(self):
        # A 500 because the logging backend is down would turn an audit trail
        # into an outage. `on_error` is where everything else this relay cannot
        # help goes, so there is no second error channel to reason about.
        errors: list[BaseException] = []

        def boom(_event):
            raise RuntimeError("the collector is down")

        running = up(self, ping_s=20.0, on_audit=boom, on_error=errors.append)
        status, body = post_json(f"{running.url}/dk/tabs/ghost/call", {"name": "look"})
        self.assertEqual(status, 200)
        self.assertEqual(body["refused"], "no-such-tab")
        self.assertEqual(len(errors), 1)
        self.assertIn("collector is down", str(errors[0]))

    def test_a_stream_that_drops_under_a_call_in_flight_is_recorded_as_the_relays_own_outcome(self):
        # The fourth outcome, and the one where the record is at its least
        # certain: `tab-went-away` means the verb MAY have run, so this line is
        # the only evidence anything was attempted — the driver's own hook may
        # have emitted a record for it in a page that is now gone, or may not. A
        # relay that wrote `ok` or `failed` here would be inventing the half
        # nobody observed.
        one = self.tab("dropping")
        one.hello()

        pending = call_async(self.url, "dropping", {"name": "accept-selected"})
        one.es.next_event("call")
        one.close()

        self.assertEqual(pending.result()[1]["refused"], "tab-went-away")
        self.assertEqual(len(self.seen), 1)
        self.assertEqual(self.seen[0]["outcome"], "tab-went-away")
        self.assertEqual(self.seen[0]["verb"], "accept-selected")

    def test_a_relay_with_no_hook_behaves_exactly_as_it_did(self):
        # The same additive claim the core's `onAudit` makes. An embedded relay
        # that was never asked for records must be the relay it was: no clock
        # read, no record built.
        running = up(self, ping_s=20.0)
        status, body = post_json(f"{running.url}/dk/tabs/ghost/call", {"name": "look"})
        self.assertEqual(status, 200)
        self.assertEqual(body["refused"], "no-such-tab")


class AuditDeadlineTest(unittest.TestCase):
    """One record per call, even when the deadline and a late answer race."""

    def test_one_record_per_call_even_when_the_deadline_and_a_late_answer_race(self):
        # The guard that makes it one is the same `pending.result is not None`
        # check that makes the HTTP response one, so a tab answering after its
        # call timed out cannot produce a second outcome for a call that has
        # already been answered. Two lines for one call is how an audit trail
        # starts double-counting commits.
        seen: list[dict] = []
        running = up(self, ping_s=20.0, timeout_s=0.05, on_audit=lambda e: seen.append(dict(e)))
        one = Tab(running.url, "t3")
        self.addCleanup(one.close)
        one.hello()

        pending = call_async(running.url, "t3", {"name": "accept-selected"})
        frame = one.es.next_event("call")
        self.assertEqual(pending.result()[1]["refused"], "timeout")
        # The late answer, which the relay drops rather than resurrecting.
        one.answer(frame["id"], {"ok": True, "snapshot": {"where": "contacts", "rev": 2}})

        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["outcome"], "timeout")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
