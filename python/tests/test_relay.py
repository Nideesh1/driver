"""
These tests are the specification for the Python relay, and they are a port of
``packages/driverkit/test/relay.test.ts`` test for test. Each name states the
decision it pins, so a change that looks harmless has to break a named test and
read why the rule exists before deleting it.

They run against a real ``ThreadingHTTPServer`` on an ephemeral port and speak
real chunked SSE. See ``relay_harness.py`` for why the tab is played by hand
rather than with the shipped client.
"""

from __future__ import annotations

import json
import unittest
import unittest.mock
import urllib.error
import urllib.parse

from relay_harness import (
    SNAP,
    Async,
    RawConnection,
    SseClient,
    Tab,
    call_async,
    get_json,
    post_json,
    up,
    wait_for,
)

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit import serve_relay
from driverkit.auth import TabAuth
from driverkit.relay import RELAY_REFUSALS, Relay
from driverkit.serve_relay import serve

#: A key long enough for TabAuth, for the two tests here that need one.
SECRET = "0" * 32


class RelayTest(unittest.TestCase):
    """One relay per test, with a helper for the two parties."""

    ping_s = 20.0
    timeout_s = 15.0

    def setUp(self) -> None:
        self.running = up(self, ping_s=self.ping_s, timeout_s=self.timeout_s)
        self.relay = self.running.relay
        self.url = self.running.url

    def tab(self, tab_id: str) -> Tab:
        tab = Tab(self.url, tab_id)
        self.assertEqual(tab.es.status, 200, "the tab's stream did not open")
        self.addCleanup(tab.close)
        return tab

    def call(self, tab_id: str, body: object) -> tuple[int, object]:
        quoted = urllib.parse.quote(tab_id, safe="")
        return post_json(f"{self.url}/dk/tabs/{quoted}/call", body)


class RoundTrip(RelayTest):
    def test_a_call_blocks_until_the_matching_result_arrives_and_is_answered_with_it(self):
        one = self.tab("t1")
        one.hello()

        # Correlation is the `id` field and nothing else — not arrival order,
        # not a socket. A tab is free to answer two calls out of order, and must
        # be: the verbs are async and the slow one does not block the fast one.
        pending = call_async(self.url, "t1", {"name": "goto", "args": {"id": "01a2"}})
        frame = one.es.next_event("call")
        self.assertEqual(frame["t"], "call")
        self.assertEqual(frame["name"], "goto")
        self.assertEqual(frame["args"], {"id": "01a2"})
        self.assertRegex(frame["id"], r"^c-\d+$")

        answer = {"ok": True, "note": "opened", "snapshot": {"where": "descent 01a2", "rev": 8}}
        self.assertEqual(one.answer(frame["id"], answer)[0], 202)

        status, body = pending.result()
        # 200 with the Result as the body. The HTTP request did not merely start
        # the call, it IS the call: an agent gets one round trip, not a ticket
        # to poll.
        self.assertEqual(status, 200)
        self.assertEqual(body, answer)

    def test_two_tabs_are_kept_distinct_and_a_call_reaches_the_one_it_was_addressed_to(self):
        a = self.tab("tab-a")
        b = self.tab("tab-b")
        a.hello(app="A", title="A")
        b.hello(app="B", title="B")

        pending = call_async(self.url, "tab-a", {"name": "goto"})
        frame = a.es.next_event("call")
        a.answer(frame["id"], {"ok": True, "snapshot": {"where": "a", "rev": 1}})
        self.assertEqual(pending.result()[1]["snapshot"]["where"], "a")

        # The sharp end of "a tab id is a capability". If a call could leak to
        # the wrong stream it would run as a different human, which is the one
        # thing the security model promises cannot happen.
        self.assertEqual(b.es.seen("call"), 0, "a call addressed to one tab was delivered to another")

        rows = get_json(f"{self.url}/dk/tabs")[1]["tabs"]
        self.assertEqual(sorted(r["tab"] for r in rows), ["tab-a", "tab-b"])
        self.assertEqual(sorted(r["app"] for r in rows), ["A", "B"])

    def test_rev_is_forwarded_untouched_and_a_stale_refusal_comes_back_unchanged(self):
        one = self.tab("t1")
        one.hello()

        pending = call_async(
            self.url, "t1", {"name": "set-lane", "args": {"id": "01a2", "lane": "held"}, "rev": 7}
        )
        frame = one.es.next_event("call")
        # Forwarded only because the agent sent one. The relay has no opinion
        # about staleness: inventing a rev would opt an agent into a check it
        # did not ask for, dropping one would opt it out of a check it did.
        self.assertEqual(frame["rev"], 7)

        stale = {
            "ok": False,
            "refused": "stale",
            "hint": "you acted on rev 7 but the screen is at rev 9; read again",
            "snapshot": {"where": "descents", "rev": 9, "rows": []},
        }
        one.answer(frame["id"], stale)
        # Byte for byte, hint and snapshot included. The hint is the agent's
        # whole instruction — re-read rather than retry — and a relay that
        # summarised it into a bare refusal string would cost a round trip to
        # rediscover.
        self.assertEqual(pending.result()[1], stale)

    def test_a_call_with_no_rev_arrives_with_no_rev_so_omitting_it_still_opts_out(self):
        one = self.tab("t1")
        call_async(self.url, "t1", {"name": "goto"})
        frame = one.es.next_event("call")
        self.assertNotIn("rev", frame, "the relay invented a rev the agent never claimed")

    def test_screen_is_forwarded_untouched_on_exactly_the_same_terms_as_rev(self):
        # This relay does not know which screen a tab is on, does not compare
        # one and does not refuse one: `screen` is the agent's claim and the
        # driver's check. A relay with an opinion about it would be a second set
        # of rules beside the core's. Behaviourally identical to the TypeScript
        # relay, which is the standing promise about these two files.
        one = self.tab("t1")
        one.hello()

        pending = call_async(self.url, "t1", {"name": "next-page", "screen": "contacts"})
        frame = one.es.next_event("call")
        self.assertEqual(frame["screen"], "contacts")

        refused = {
            "ok": False,
            "refused": "wrong-screen",
            "hint": "you believed you were on the `contacts` screen but the app is on `settings`",
            "snapshot": {"where": "settings", "screen": "settings", "rev": 9},
        }
        one.answer(frame["id"], refused)
        # Byte for byte, `snapshot.screen` included: the screen the agent is
        # actually on is the whole fix, and a hop that dropped it would cost a
        # round trip to rediscover.
        self.assertEqual(pending.result()[1], refused)

    def test_a_call_with_no_screen_or_an_empty_one_arrives_with_none(self):
        one = self.tab("t1")
        call_async(self.url, "t1", {"name": "goto"})
        self.assertNotIn(
            "screen", one.es.next_event("call"), "the relay invented a screen nobody claimed"
        )
        # An empty string is dropped rather than forwarded: it is the id of no
        # screen, and no app should be asked to refuse a call over a field a
        # caller left blank.
        call_async(self.url, "t1", {"name": "goto", "screen": ""})
        self.assertNotIn("screen", one.es.next_event("call"))

    def test_a_field_the_relay_has_never_heard_of_reaches_the_agent_anyway(self):
        one = self.tab("t1")
        # `kind` on a verb and `count` on a result are both newer than this
        # relay's first draft, and PROTOCOL.md promises a field can be added
        # without a version bump. That promise is only kept if every hop
        # forwards what it does not understand — so the relay stores and serves
        # frames whole rather than rebuilding them from the fields it knows.
        one.hello(
            manifest={
                "version": "v2",
                "app": "toy",
                "verbs": [{"name": "select-matching", "describe": "select rows", "kind": "describe"}],
            }
        )
        manifest = get_json(f"{self.url}/dk/tabs/t1/manifest")[1]
        self.assertEqual(manifest["verbs"][0]["kind"], "describe")

        pending = call_async(self.url, "t1", {"name": "select-matching"})
        frame = one.es.next_event("call")
        one.answer(
            frame["id"],
            {
                "ok": True,
                "count": 1000,
                "note": "1,000 selected of 3,412 matching",
                "snapshot": {"where": "descents", "rev": 8},
            },
        )
        body = pending.result()[1]
        # The number a human would have to see before pressing a bulk button,
        # and the reason `describe` and `commit` are separate verbs. Dropping it
        # here would be dropping the safety check itself.
        self.assertEqual(body["count"], 1000)
        self.assertIn("3,412", body["note"])


class Passthrough(RelayTest):
    """What the relay must forward without understanding it."""

    def test_a_count_on_a_successful_result_survives_the_relay(self):
        one = self.tab("t1")
        one.hello()
        pending = call_async(self.url, "t1", {"name": "select-where", "args": {"lane": "pruning"}})
        frame = one.es.next_event("call")

        # `count` is how a `describe` verb reports what it matched, and the core
        # now lets a verb return it as a Report. It is the number a human would
        # have to see before pressing a bulk button, and the whole reason
        # `describe` and `commit` are separate verbs — so a hop that dropped it
        # would be dropping the safety the split was bought with, not a field.
        answer = {
            "ok": True,
            "count": 3412,
            "note": "1,000 selected of 3,412 matching",
            "snapshot": {"where": "descents", "rev": 8, "rows": []},
        }
        one.answer(frame["id"], answer)
        status, body = pending.result()
        self.assertEqual(status, 200)
        # Compared whole, not field by field: the relay forwards a Result byte
        # for byte, and asserting only the fields this test knows about is how
        # the next new field gets quietly dropped.
        self.assertEqual(body, answer)

    def test_a_count_of_zero_is_forwarded_rather_than_treated_as_absent(self):
        one = self.tab("t1")
        one.hello()
        pending = call_async(self.url, "t1", {"name": "select-where", "args": {"lane": "held"}})
        frame = one.es.next_event("call")
        # Zero is the answer that stops a bulk commit, so it is the one value
        # that must not be lost to a falsy check.
        one.answer(frame["id"], {"ok": True, "count": 0, "snapshot": SNAP})
        self.assertEqual(pending.result()[1]["count"], 0)


class Refusals(RelayTest):
    timeout_s = 0.3

    def test_a_call_to_a_tab_that_is_not_connected_is_refused_in_the_shape_of_every_other_answer(self):
        status, body = self.call("never-existed", {"name": "goto"})
        # 200, not 404, and `{ok: false}` rather than `{error}`. An agent must
        # be able to read "that did not happen" with the same code path whether
        # the reason was a business rule or a closed window; a status-code
        # branch in front of the body is a branch that will be wrong on the
        # rarest path.
        self.assertEqual(status, 200)
        self.assertIs(body["ok"], False)
        self.assertEqual(body["refused"], "no-such-tab")
        self.assertIn("/dk/tabs", body["hint"], "the refusal did not say how to recover")
        # No `snapshot` at all, and its absence is the signal that tells this
        # apart from an app's own refusal. Nothing ran and nobody looked, so
        # there is no screen to report — and an invented one would be read as
        # "the app has no rows", a lie about the app rather than about the call.
        self.assertNotIn("snapshot", body, "the relay invented a screen nobody looked at")

    def test_a_tab_that_never_answers_times_out_rather_than_holding_the_request_open(self):
        one = self.tab("wedged")
        one.hello()

        # The stream is open and the tab is listening; it simply never POSTs.
        # That is what a page whose JavaScript died looks like from here, and it
        # is why the timeout cannot be inferred from the socket.
        status, body = self.call("wedged", {"name": "goto"})
        self.assertEqual(status, 200)
        self.assertIs(body["ok"], False)
        self.assertEqual(body["refused"], "timeout")
        self.assertIn("0.3s", body["hint"])

        # No snapshot, even though the relay HAS the tab's last one. Attaching
        # it would read as "here is the screen after your call", and this is the
        # one case where nobody can say that: the tab may have run the verb and
        # died before answering, so a `commit` that times out has an unknown
        # outcome and the agent must go and look.
        self.assertNotIn("snapshot", body, "a timeout implied a screen it cannot know")
        self.assertEqual(
            get_json(f"{self.url}/dk/tabs/wedged/snapshot")[1]["rev"],
            7,
            "the tab's last snapshot is still readable, just not implied",
        )

    def test_a_late_result_is_dropped_not_delivered_to_a_request_that_already_answered(self):
        one = self.tab("slow")
        one.hello()
        self.assertEqual(self.call("slow", {"name": "goto"})[1]["refused"], "timeout")
        frame = one.es.next_event("call")

        # Answering now must be a no-op rather than an error: the tab did
        # nothing wrong, it was just slow, and a 500 here would make a slow verb
        # look like a broken one. The relay accepts the frame and says it was
        # not expected.
        status, body = one.answer(frame["id"], {"ok": True, "snapshot": {"where": "late", "rev": 9}})
        self.assertEqual(status, 202)
        self.assertIn("no call", body["note"])

    def test_a_result_frame_with_a_payload_that_is_not_an_object_leaves_the_call_pending(self):
        one = self.tab("t1")
        one.hello()
        pending = call_async(self.url, "t1", {"name": "goto"})
        frame = one.es.next_event("call")

        # Rejected as a bad frame, and the pending call is NOT settled with it.
        # Settling would answer the agent a body that is not a WireResult,
        # which is the one promise /call makes; a client forced to handle a
        # third shape handles it badly. So the call runs out its deadline and
        # ends as an honest `timeout` — no answer arrived, which is exactly
        # what happened.
        status, body = one._post({"t": "result", "id": frame["id"], "result": "nope"})
        self.assertEqual((status, body["error"]), (400, "bad-frame"))

        answer = pending.result()[1]
        self.assertEqual(answer["refused"], "timeout")
        self.assertIn("ok", answer, "the agent got something that was not a WireResult")
        self.assertNotIn("snapshot", answer)

    def test_a_tab_leaves_the_registry_when_its_stream_closes(self):
        one = self.tab("going")
        one.hello()
        self.assertEqual(len(self.relay.tabs()), 1)

        one.es.close()
        wait_for(lambda: len(self.relay.tabs()) == 0)

        # And the next call is a clean "no such tab" rather than a timeout. The
        # protocol has no queue on purpose: a call landing against a screen
        # nobody is looking at is worse than a failure the agent can act on now.
        self.assertEqual(self.call("going", {"name": "goto"})[1]["refused"], "no-such-tab")

    def test_every_relay_refusal_is_one_of_the_closed_set_and_none_carries_a_screen(self):
        seen = []
        bodies = []

        status, body = self.call("nobody-home", {"name": "goto"})
        seen.append(body["refused"])
        bodies.append(body)

        wedged = self.tab("wedged")
        wedged.hello()
        body = self.call("wedged", {"name": "goto"})[1]
        seen.append(body["refused"])
        bodies.append(body)

        leaving = self.tab("leaving")
        leaving.hello()
        inflight = call_async(self.url, "leaving", {"name": "goto"})
        leaving.es.next_event("call")
        leaving.es.close()
        body = inflight.result()[1]
        seen.append(body["refused"])
        bodies.append(body)

        # A closed set is what lets a client tell "your app said no" — rephrase
        # and retry — from "your call never landed" — reconnect, or pick another
        # tab. If the relay could mint a new slug, every client would have to
        # treat the unknown ones as one or the other, and both guesses are wrong
        # half the time.
        self.assertEqual(sorted(seen), sorted(RELAY_REFUSALS))
        for body in bodies:
            self.assertNotIn("snapshot", body)


class StreamLoss(RelayTest):
    timeout_s = 10.0

    def test_calls_in_flight_fail_at_once_when_the_stream_drops(self):
        one = self.tab("dropping")
        one.hello()

        pending = call_async(self.url, "dropping", {"name": "goto"})
        one.es.next_event("call")
        one.es.close()

        # The answer was already knowable, so making the agent wait ten seconds
        # for it would spend its context on a question nobody was going to
        # answer.
        status, body = pending.result(timeout=5.0)
        self.assertIs(body["ok"], False)
        self.assertEqual(body["refused"], "tab-went-away")
        self.assertNotIn("snapshot", body)

    def test_a_second_stream_for_one_tab_id_is_a_reconnect_not_a_second_tab(self):
        first = self.tab("same-id")
        first.hello(title="before")

        second = self.tab("same-id")
        second.hello(title="after")
        wait_for(lambda: len(self.relay.tabs()) == 1)

        # The id is minted by the tab precisely so a reconnect resumes the
        # identity: an agent holding this id across a blip must not be told the
        # window closed. `hello` upserts, so the later one wins — the app may
        # have navigated.
        self.assertEqual(self.relay.tabs()[0]["title"], "after")
        # The superseded stream is hung up rather than left to leak.
        self.assertTrue(first.es.closed.wait(timeout=2), "the old stream was left open")

        # And the old stream's close must not take the live record with it.
        call_async(self.url, "same-id", {"name": "goto"})
        self.assertEqual(second.es.next_event("call")["name"], "goto")

    def test_calls_in_flight_carry_across_a_reconnect(self):
        one = self.tab("blinking")
        one.hello()
        pending = call_async(self.url, "blinking", {"name": "goto"})
        frame = one.es.next_event("call")

        # The stream blinked; the verb is still running in the page. Failing the
        # call here would turn a recovered hiccup into an error the agent has to
        # handle, so the pending call moves to the new stream's record and the
        # tab can answer on the new connection.
        again = self.tab("blinking")
        again.hello()
        self.assertEqual(again.answer(frame["id"], {"ok": True, "snapshot": SNAP})[0], 202)
        self.assertIs(pending.result()[1]["ok"], True)

    def test_a_rejected_result_frame_can_be_followed_by_a_good_one(self):
        # The stronger statement about leaving the call pending: the tab can
        # simply send the frame again, correctly, and the agent gets its answer.
        # A relay that consumed the pending call on the way to rejecting the
        # frame would have made a recoverable mistake unrecoverable.
        one = self.tab("t1")
        one.hello()
        pending = call_async(self.url, "t1", {"name": "goto"})
        frame = one.es.next_event("call")

        self.assertEqual(one._post({"t": "result", "id": frame["id"], "result": 7})[0], 400)
        self.assertFalse(pending.done, "the call was answered with a frame the relay rejected")

        answer = {"ok": True, "note": "second try", "snapshot": SNAP}
        self.assertEqual(one.answer(frame["id"], answer)[0], 202)
        self.assertEqual(pending.result()[1], answer)

    def test_close_hangs_up_every_stream_and_fails_everything_in_flight(self):
        one = self.tab("t1")
        one.hello()
        pending = call_async(self.url, "t1", {"name": "goto"})
        one.es.next_event("call")

        self.relay.close()
        body = pending.result()[1]
        self.assertEqual(body["refused"], "tab-went-away")
        self.assertIn("shutting down", body["hint"])
        self.assertEqual(self.relay.tabs(), [])
        self.assertTrue(one.es.closed.wait(timeout=2))
        # Idempotent: a shutdown path that throws on a second call is one that
        # gets wrapped in try/except everywhere it is used.
        self.relay.close()
        # And a relay that has been closed says so rather than quietly
        # accepting work it will never do.
        self.assertEqual(get_json(f"{self.url}/dk/tabs")[0], 503)


class Reads(RelayTest):
    def test_tabs_reports_the_manifest_version_not_the_manifest(self):
        one = self.tab("t1")
        one.hello()

        row = get_json(f"{self.url}/dk/tabs")[1]["tabs"][0]
        self.assertEqual(
            sorted(row), sorted(["app", "manifestVersion", "rev", "since", "tab", "title", "url"])
        )
        self.assertEqual(row["manifestVersion"], "abc123")
        self.assertEqual(row["rev"], 7)
        # The id key is `tab`, spelled as in the `hello` frame — not `id`, which
        # would collide in a reader's head with a call id and a row id.
        self.assertEqual(row["tab"], "t1")
        self.assertNotIn("id", row, "the id key was spelled two ways")
        # ISO 8601, not epoch millis: a human reads this in a "which tab?"
        # prompt, and it crosses into clients whose JSON numbers are floats.
        self.assertRegex(row["since"], r"^\d{4}-\d{2}-\d{2}T[\d:.]+Z$")
        # Listing tabs is the cheap call an agent makes often. Inlining every
        # manifest would make the frequent call the expensive one, and the
        # version is all a cache needs to know its copy is still current.
        self.assertNotIn("verbs", json.dumps(row), "the whole manifest rode along on the list")

    def test_the_manifest_and_snapshot_halves_are_served_separately_and_say_so_when_absent(self):
        one = self.tab("t1")

        # Before `hello` there is nothing to serve, and the honest answer is a
        # 404. Returning an empty manifest would be a claim that the app has no
        # verbs, and an empty snapshot a claim that the screen is blank.
        status, body = get_json(f"{self.url}/dk/tabs/t1/manifest")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "no-manifest")
        self.assertEqual(get_json(f"{self.url}/dk/tabs/t1/snapshot")[0], 404)

        one.hello()
        manifest = get_json(f"{self.url}/dk/tabs/t1/manifest")[1]
        self.assertEqual(manifest["version"], "abc123")
        self.assertNotIn("01a2", json.dumps(manifest), "live data leaked into the cacheable half")

        # The dynamic half tracks the pushes a person's clicking produces.
        self.assertEqual(get_json(f"{self.url}/dk/tabs/t1/snapshot")[1]["rev"], 7)
        one.push({"where": "descent 01a2", "rev": 8})
        wait_for(lambda: get_json(f"{self.url}/dk/tabs/t1/snapshot")[1]["rev"] == 8)

        # A missing tab here is NOT Result-shaped, unlike /call. A Result is the
        # outcome of a call; wrapping "no such tab" in one would hand the agent
        # a snapshot that describes nothing.
        status, body = get_json(f"{self.url}/dk/tabs/nope/snapshot")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "no-such-tab")
        self.assertNotIn("ok", body)

    def test_hello_upserts_field_by_field_rather_than_replacing_the_record(self):
        one = self.tab("t1")
        one.hello()
        # A reconnect after the app navigated: the new `hello` carries a title
        # and a url and nothing else. The fields it does carry win; the fields
        # it leaves out are left alone, because the manifest did not change just
        # because the page did.
        post_json(
            f"{self.url}/dk/result",
            {"t": "hello", "tab": "t1", "title": "Settings — toy", "url": "/app/settings"},
        )
        row = self.relay.tabs()[0]
        self.assertEqual(row["title"], "Settings — toy")
        self.assertEqual(row["url"], "/app/settings")
        self.assertEqual(row["app"], "toy", "an absent field cleared one the relay already had")
        self.assertEqual(row["manifestVersion"], "abc123")


class Streaming(RelayTest):
    ping_s = 0.03

    def test_the_stream_opens_with_a_comment_and_keeps_sending_them(self):
        one = self.tab("t1")
        # The first comment is what makes the browser fire `open` now rather
        # than when the first real frame happens to arrive — and `open` is where
        # the page sends `hello`, so without it a loaded tab is connected and
        # unidentifiable.
        wait_for(lambda: one.es.comments and one.es.comments[0] == "driverkit")

        # A comment, not a frame: a client that has never heard of `ping`
        # ignores it for free, which is what lets the keep-alive be added
        # without a version bump.
        wait_for(lambda: one.es.comments.count("ping") >= 2)
        self.assertEqual(one.es.headers["content-type"], "text/event-stream; charset=utf-8")
        self.assertNotIn("content-length", one.es.headers, "a stream cannot have a length")

    def test_watch_is_the_tabs_own_sse_shape_pings_included_and_404s_for_an_unknown_tab(self):
        one = self.tab("watched")
        one.hello()
        watcher = SseClient(f"{self.url}/dk/tabs/watched/watch")
        self.addCleanup(watcher.close)

        # Same opening comment, same `: ping` comment lines, same named events
        # as /dk/events. One parser serves both directions rather than two that
        # drift.
        wait_for(lambda: watcher.comments.count("ping") >= 2)
        self.assertEqual(watcher.comments[0], "driverkit")

        # A subscription to a screen that does not exist is answered, not held
        # open: 404 tells the client to re-read /dk/tabs instead of waiting on a
        # stream that may never carry anything.
        status, body = get_json(f"{self.url}/dk/tabs/ghost/watch")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "no-such-tab")


class Watch(RelayTest):
    def test_watch_delivers_a_tabs_snapshot_pushes_to_every_watcher(self):
        one = self.tab("watched")
        one.hello()

        # Two watchers, because an agent beside a human beside another agent is
        # the case this endpoint exists for. A single-slot registry would make
        # the second one silently blind rather than refuse it, which is the
        # worse failure.
        a = SseClient(f"{self.url}/dk/tabs/watched/watch")
        b = SseClient(f"{self.url}/dk/tabs/watched/watch")
        self.addCleanup(a.close)
        self.addCleanup(b.close)

        # The current screen arrives at once. A watcher that attached to an idle
        # page would otherwise know nothing until the next click, and would have
        # to fetch /snapshot anyway — which is the poll this endpoint exists to
        # remove.
        for es in (a, b):
            first = es.next_event("snapshot")
            self.assertEqual(first["tab"], "watched")
            self.assertEqual(first["snapshot"]["rev"], 7, "a watcher was not told what is on screen now")

        one.push({"where": "descent 01a2", "rev": 8})
        # Without this the `snapshot` push reaches the relay and stops there,
        # and the shared-presence case the frame exists for is unreachable
        # through the documented surface.
        for es in (a, b):
            got = es.next_event("snapshot")
            self.assertEqual(got["t"], "snapshot")
            self.assertEqual(got["snapshot"]["rev"], 8)
            self.assertEqual(got["tab"], "watched", "a watch frame did not say which tab moved")

    def test_watch_also_reports_a_change_an_agent_caused_and_stays_quiet_when_nothing_moved(self):
        one = self.tab("watched")
        one.hello()
        es = SseClient(f"{self.url}/dk/tabs/watched/watch")
        self.addCleanup(es.close)
        es.next_event("snapshot")  # the opening state

        pending = call_async(self.url, "watched", {"name": "set-lane"})
        frame = one.es.next_event("call")
        one.answer(frame["id"], {"ok": True, "snapshot": {"where": "descents", "rev": 9}})
        pending.result()

        # A watcher that learned only about human-caused moves would still have
        # to poll for the rest, which is the cost the endpoint was added to
        # remove.
        self.assertEqual(es.next_event("snapshot")["snapshot"]["rev"], 9)

        # But a refusal that moved nothing stays quiet: the rev did not change,
        # so there is nothing to tell anyone. A heartbeat on every call would
        # make the stream noisier than the polling it replaced.
        refusing = call_async(self.url, "watched", {"name": "set-lane"})
        again = one.es.next_event("call")
        one.answer(
            again["id"],
            {
                "ok": False,
                "refused": "machine-may-not-leave-pruning",
                "snapshot": {"where": "descents", "rev": 9},
            },
        )
        refusing.result()
        self.assertEqual(es.seen("snapshot"), 0, "an unchanged screen was broadcast anyway")

    def test_a_watcher_survives_the_tab_reloading_which_is_one_of_the_things_it_watches_for(self):
        one = self.tab("watched")
        one.hello()
        es = SseClient(f"{self.url}/dk/tabs/watched/watch")
        self.addCleanup(es.close)
        es.next_event("snapshot")

        # The page reloads: the stream drops, the tab record dies with it, and
        # the same id comes back. A watcher kept inside the tab record would
        # have died too — and the reload is exactly what a watcher is there to
        # see, so it has to outlive it.
        one.es.close()
        wait_for(lambda: self.relay.tabs() == [])
        again = self.tab("watched")
        again.hello(snapshot={"where": "descents", "rev": 11, "rows": []})

        self.assertEqual(es.next_event("snapshot")["snapshot"]["rev"], 11)
        self.assertFalse(es.closed.is_set(), "the watcher was hung up when the tab reloaded")


class Malformed(RelayTest):
    def test_a_frame_the_relay_cannot_place_is_rejected_without_taking_anything_else_down(self):
        one = self.tab("t1")
        one.hello()

        # Each of these is a different pinned slug, and the differences are
        # the point: a tab author has to be able to tell "my frame is wrong"
        # from "the relay has moved on".
        for frame, status, error in (
            # An unknown `t` could never be accepted by anybody.
            ({"t": "nonsense"}, 400, "bad-frame"),
            # Discriminator fine, payload missing. The trap this guards is
            # trusting the payload because `t` was checked.
            ({"t": "snapshot"}, 400, "bad-frame"),
            ({"t": "result", "id": "c-1", "result": "nope"}, 400, "bad-frame"),
        ):
            got, body = post_json(f"{self.url}/dk/result?tab=t1", frame)
            self.assertEqual((got, body["error"]), (status, error), frame)

        # 409, not 400: the frame was fine and the relay's state is what made
        # it unacceptable, so the tab may reasonably reconnect and retry. A 400
        # here would tell a correct tab it has a bug.
        status, body = post_json(f"{self.url}/dk/result?tab=ghost", {"t": "snapshot", "snapshot": SNAP})
        self.assertEqual((status, body["error"]), (409, "no-such-tab"))

        self.assertEqual(post_json(f"{self.url}/dk/result?tab=t1", b"{not json")[1]["error"], "bad-frame")

        # No `?tab=` and no `tab` field: unroutable even in principle, because
        # POST /dk/result has no path parameter and the relay serves many tabs.
        status, body = post_json(f"{self.url}/dk/result", {"t": "snapshot", "snapshot": SNAP})
        self.assertEqual((status, body["error"]), (400, "unplaceable"))
        self.assertEqual(
            get_json(f"{self.url}/dk/events")[0], 400, "a stream with no ?tab= is unroutable"
        )

        # Still serving. In a relay this is the difference between one malformed
        # POST and every open tab losing its stream.
        self.assertEqual(len(self.relay.tabs()), 1)
        self.assertFalse(one.es.closed.is_set())
        call_async(self.url, "t1", {"name": "goto"})
        self.assertEqual(one.es.next_event("call")["name"], "goto")

    def test_a_malformed_call_is_a_transport_failure_not_a_refusal(self):
        one = self.tab("t1")
        one.hello()

        # No `name`, so there is no verb to have said no. Answering {ok:false}
        # would teach an agent to look for a slug the closed set does not
        # contain, and would make it rephrase a request that never reached an
        # app. A non-2xx is the honest answer: no WireResult was produced at all.
        status, body = self.call("t1", {"args": {"id": "01a2"}})
        self.assertEqual(status, 400)
        self.assertNotIn("ok", body, "a malformed request was dressed as a refusal")
        self.assertEqual(body["error"], "bad-request")

        # And the tab was never bothered with it.
        self.assertEqual(one.es.seen("call"), 0)
        self.assertEqual(get_json(f"{self.url}/dk/tabs/t1/snapshot")[1]["rev"], 7)

    def test_the_wrong_method_on_a_real_route_is_405_and_an_unknown_one_is_404(self):
        for status, body in (
            get_json(f"{self.url}/dk/result"),
            post_json(f"{self.url}/dk/tabs", {}),
            post_json(f"{self.url}/dk/events", {}),
            post_json(f"{self.url}/dk/tabs/t1/snapshot", {}),
        ):
            self.assertEqual((status, body["error"]), (405, "bad-method"))

        # A route the relay does not have, as opposed to one called wrongly.
        # Two different slugs because they are two different mistakes: one is a
        # client using the wrong verb on something real, the other is a client
        # addressing something that was never there.
        for status, body in (
            get_json(f"{self.url}/dk/nonsense"),
            get_json(f"{self.url}/dk/tabs/t1/nonsense"),
            get_json(f"{self.url}/dk/tabs/t1/snapshot/extra"),
        ):
            self.assertEqual((status, body["error"]), (404, "no-route"))

        # And `/dk/events` with nothing to route on is `bad-request`, which is
        # neither of those: the route exists and the method is right.
        status, body = get_json(f"{self.url}/dk/events")
        self.assertEqual((status, body["error"]), (400, "bad-request"))

    def test_a_path_outside_the_relay_is_the_hosts_business_not_the_relays(self):
        # The standalone server owns the whole URL space, so there it is a 404.
        # What matters is which code decided: `handle` returns None and the
        # server answers, because an embedded relay that 404'd every unknown
        # path would shadow the app it was embedded in.
        status, body = get_json(f"{self.url}/app/descents")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "not-found")


class Oversized(RelayTest):
    """The body limit, and the thing that makes a 413 worth sending."""

    def test_a_body_megabytes_over_the_limit_is_answered_413_and_the_sender_reads_it(self):
        # Several megabytes over, deliberately. A body just over the limit
        # cannot test this: it fits in one socket write, so the sender is
        # finished before the response is written and reads the 413 whatever
        # the server does with the connection. Only a body far larger than the
        # socket buffers keeps the sender writing while the server decides.
        #
        # What this catches: answering 413 and hanging up without reading the
        # body resets the connection mid-upload, the sender takes
        # ECONNRESET/EPIPE on its own socket and never reads the status at all.
        # A sender that cannot learn WHY it failed retries byte for byte, which
        # is the opposite of what a limit is for. So the request below must come
        # back as a status, not as an exception.
        body = json.dumps({"name": "goto", "pad": "x" * (6 << 20)}).encode()
        self.assertGreater(len(body), 6 << 20)
        status, answer = self.call("t1", body)
        self.assertEqual(status, 413)
        self.assertEqual(answer["error"], "too-large")

        # And the server is still serving on a fresh connection afterwards: the
        # oversized request was refused, not fatal.
        self.assertEqual(get_json(f"{self.url}/dk/tabs")[0], 200)

    def test_a_tab_frame_over_the_limit_is_refused_the_same_way(self):
        # The limit is the transport's, not the endpoint's. A snapshot this big
        # is a bug in the app's `visible()` rather than a limit to raise, and
        # the tab needs to be told so rather than left guessing at a reset.
        one = self.tab("t1")
        one.hello()
        frame = {"t": "snapshot", "tab": "t1", "snapshot": {"where": "x" * (5 << 20), "rev": 9}}
        status, body = post_json(f"{self.url}/dk/result?tab=t1", frame)
        self.assertEqual((status, body["error"]), (413, "too-large"))
        # The old snapshot is untouched: nothing was half-applied.
        self.assertEqual(get_json(f"{self.url}/dk/tabs/t1/snapshot")[1]["rev"], 7)

    def test_above_the_abort_backstop_the_connection_is_dropped_instead(self):
        # Reading a body politely is only correct while it is plausibly a
        # mistake. Far above the limit, reading all of it is the attack
        # succeeding, so the sender gets nothing. Patched down rather than
        # tested at 64 MiB, because the assertion is about the behaviour and
        # not about how long a test takes to write 64 MiB.
        with unittest.mock.patch.object(serve_relay, "ABORT_BODY", 2 << 20):
            body = json.dumps({"name": "goto", "pad": "x" * (6 << 20)}).encode()
            with self.assertRaises((OSError, urllib.error.URLError)):
                self.call("t1", body)
        # Still serving, on a new connection.
        self.assertEqual(get_json(f"{self.url}/dk/tabs")[0], 200)


class ChunkedBodies(RelayTest):
    """A request body with no ``Content-Length``.

    This whole class is one bug, found by running a demo app against this relay
    rather than by reading the code. ``http.server`` de-chunks nothing, so a
    handler that reads ``Content-Length`` and nothing else reads ZERO bytes from
    a chunked request — and then leaves the chunk framing in the socket, where
    it is parsed as the next request on a keep-alive connection:
    ``Parse Error: Expected HTTP/, RTSP/ or ICE/``. One wrong answer, and every
    later request on that socket destroyed.

    ``relay_asgi`` has never had it, because an ASGI server de-chunks before the
    app sees a byte. That asymmetry is why the tests sit here rather than beside
    the ASGI ones: this is the only adapter that has to do the decoding itself.
    """

    def setUp(self) -> None:
        super().setUp()
        self.wire = RawConnection(self.url)
        self.addCleanup(self.wire.close)

    def test_a_chunked_call_is_answered_from_its_body_and_not_from_an_empty_one(self):
        one = self.tab("t1")
        one.hello()

        pending = Async(
            lambda: self.wire.post_chunked(
                "/dk/tabs/t1/call", {"name": "goto", "args": {"where": "c-9"}, "rev": 7}
            )
        )
        frame = one.es.next_event("call")
        # The assertion that matters: the relay read the body. Before the fix
        # the `name` was missing because the body was zero bytes, so no `call`
        # frame ever reached the tab and this line timed out.
        self.assertEqual(frame["name"], "goto")
        self.assertEqual(frame["args"], {"where": "c-9"})
        self.assertEqual(frame["rev"], 7)

        one.answer(frame["id"], {"ok": True, "note": "opened", "snapshot": SNAP})
        status, answer = pending.result()
        self.assertEqual(status, 200)
        self.assertEqual(answer["note"], "opened")

    def test_a_chunked_tab_frame_is_accepted_so_a_streaming_page_can_answer_at_all(self):
        # The tab's half matters more than the agent's: a page POSTing a result
        # through `fetch` with no `content-length` is the common case, and a
        # result dropped here is an answer the agent waits out the full deadline
        # for while it already exists.
        one = self.tab("t1")
        status, body = self.wire.post_chunked(
            "/dk/result?tab=t1", {"t": "hello", "tab": "t1", "app": "toy"}
        )
        self.assertEqual((status, body["ok"]), (202, True))
        self.assertEqual(get_json(f"{self.url}/dk/tabs")[1]["tabs"][0]["app"], "toy")

    def test_the_connection_survives_a_chunked_request_and_serves_the_next_one_on_it(self):
        # The second request is the whole test. An undrained body does not break
        # the request it belonged to in any visible way — that one gets a
        # plausible-looking 400 — it breaks whatever is parsed off the socket
        # next. A suite that opens a fresh connection per request cannot see
        # this at all, which is why `RawConnection` exists.
        one = self.tab("t1")
        one.hello()

        status, body = self.wire.post_chunked("/dk/result?tab=t1", {"t": "snapshot", "tab": "t1", "snapshot": {"where": "descents", "rev": 8, "rows": []}})
        self.assertEqual(status, 202)

        # Same socket, no reconnect. Before the fix this raised a BadStatusLine
        # built out of the leftover chunk framing.
        status, listing = self.wire.get("/dk/tabs")
        self.assertEqual(status, 200)
        self.assertEqual(listing["tabs"][0]["rev"], 8)

        # And a third, because one survivor could be luck in how the bytes
        # happened to land in the buffer.
        status, again = self.wire.post_chunked("/dk/result?tab=t1", {"t": "snapshot", "tab": "t1", "snapshot": {"where": "descents", "rev": 9, "rows": []}})
        self.assertEqual(status, 202)
        self.assertEqual(self.wire.get("/dk/tabs")[1]["tabs"][0]["rev"], 9)

    def test_a_chunked_body_over_the_limit_is_413_even_though_its_size_was_unknown(self):
        # With a `Content-Length` the size is known before a byte is read. Here
        # it can only be learned by adding the chunks up, so the decision lands
        # partway through a body already in flight — and the answer still has to
        # be the 413 PROTOCOL.md pins rather than a reset the sender cannot
        # read. Big chunks, so this does not take a second to write.
        body = json.dumps({"name": "goto", "pad": "x" * (2 << 20)}).encode()
        status, answer = self.wire.post_chunked("/dk/tabs/t1/call", body, chunk_size=64 << 10)
        self.assertEqual(status, 413)
        self.assertEqual(answer["error"], "too-large")

    def test_chunk_framing_the_relay_cannot_decode_is_400_and_the_connection_goes(self):
        # 400 because PROTOCOL.md's split is that a 400 is a frame no relay
        # could ever have accepted, and framing this broken is exactly that.
        #
        # The connection has to close, and that is not a detail: every byte
        # after the point the framing stopped making sense is of unknown
        # purpose, so there is no position at which to begin reading the next
        # request. A keep-alive socket whose next boundary is unknown can only
        # produce nonsense, so it is better to make the sender reconnect.
        status, body = self.wire.send_raw(
            "/dk/result?tab=t1",
            {"Content-Type": "application/json", "Transfer-Encoding": "chunked"},
            b"zz\r\nnot-a-size\r\n0\r\n\r\n",
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "bad-request")
        # Still serving everyone else: one sender's broken framing is not fatal
        # to the relay, only to its own connection.
        self.assertEqual(get_json(f"{self.url}/dk/tabs")[0], 200)

    def test_a_content_length_that_is_not_a_number_is_400_rather_than_a_dead_handler(self):
        # Same reasoning as the broken chunk framing, and found while fixing it:
        # the old `int(self.headers.get("Content-Length"))` raised ValueError
        # out of `do_POST`, which `http.server` turns into a dropped connection
        # with no status at all. A sender that gets nothing back cannot tell a
        # relay that refused it from a relay that crashed.
        status, body = self.wire.send_raw(
            "/dk/result?tab=t1",
            {"Content-Type": "application/json", "Content-Length": "banana"},
            b"",
        )
        self.assertEqual((status, body["error"]), (400, "bad-request"))

    def test_a_refused_method_still_drains_its_body_so_the_socket_stays_usable(self):
        # A route that answers 405 has no use for the body, which is exactly the
        # trap: "we are refusing this anyway" is a reason to skip reading it and
        # the reason the next request on the connection is destroyed. The
        # refusal is not allowed to take the socket with it.
        self.tab("t1")
        status, body = self.wire.send_raw(
            "/dk/tabs",
            {"Content-Type": "application/json", "Content-Length": "19"},
            b'{"t":"not-a-frame"}',
        )
        self.assertEqual(status, 405)
        self.assertEqual(body["error"], "bad-method")
        self.assertEqual(self.wire.get("/dk/tabs")[0], 200)


class Security(unittest.TestCase):
    """The checks that are about the peer rather than the bytes.

    These call ``handle`` directly, with no socket at all. That is the reason it
    takes a ``peer`` argument instead of reading one off a request object: the
    guard is testable, and an adapter that forgot to pass the peer fails closed.
    """

    def test_a_caller_that_is_not_on_loopback_is_refused_unless_the_relay_allows_it(self):
        # Checked per request rather than by binding, because an embedded relay
        # does not own the listening socket and cannot choose the interface. A
        # tab's own session is the only authority there is, so a reachable relay
        # is someone else driving a logged-in browser.
        closed = Relay()
        self.addCleanup(closed.close)
        remote = closed.handle("GET", "/dk/tabs", peer="10.0.0.5")
        self.assertEqual(remote.status, 403)
        self.assertEqual(json.loads(remote.body)["error"], "forbidden")

        for address in ("127.0.0.1", "::1", "::ffff:127.0.0.1", "127.1.2.3"):
            local = closed.handle("GET", "/dk/tabs", peer=address)
            self.assertEqual(local.status, 200, f"{address} should count as loopback")

        # An unknown peer is not proven local, so it is refused. A Unix socket,
        # or a proxy that dropped the address, are both cases where the relay
        # cannot tell — and "cannot tell" must not resolve to "allowed".
        self.assertEqual(closed.handle("GET", "/dk/tabs", peer=None).status, 403)

        # And turning it on now REQUIRES saying how callers are identified. The
        # old one-flag version of this test is the combination the flag exists
        # to prevent: an exposed relay that cannot tell its callers apart hands
        # every connected tab to every one of them.
        with self.assertRaises(ValueError) as caught:
            Relay(allow_remote=True)
        self.assertIn("auth=", str(caught.exception))
        self.assertIn("PROTOCOL.md", str(caught.exception))

        allowed = Relay(allow_remote=True, auth=TabAuth(secret=SECRET, audience="test"))
        self.addCleanup(allowed.close)
        # Remote and identified: the peer check passes and the credential check
        # is what answers now. No credential is a 401, not a 200.
        unknown = allowed.handle("GET", "/dk/tabs", peer="10.0.0.5")
        self.assertEqual(unknown.status, 401)
        self.assertEqual(json.loads(unknown.body)["error"], "no-credential")
        self.assertEqual(
            allowed.handle(
                "GET",
                "/dk/tabs",
                peer="10.0.0.5",
                headers={"Authorization": f"Bearer {allowed._auth.mint('u1')}"},
            ).status,
            200,
        )

    def test_handle_declines_paths_it_does_not_own_so_it_can_sit_in_front_of_an_app(self):
        relay = Relay()
        self.addCleanup(relay.close)
        # None rather than a 404 is what makes embedding possible.
        self.assertIsNone(relay.handle("GET", "/app/descents", peer="127.0.0.1"))
        self.assertIsNone(relay.handle("GET", "/", peer="127.0.0.1"))
        # The trailing slash is required, so a host app that owns `/dk` itself
        # — or `/dkstuff` — keeps it.
        self.assertIsNone(relay.handle("GET", "/dk", peer="127.0.0.1"))
        self.assertIsNone(relay.handle("GET", "/dkstuff", peer="127.0.0.1"))
        # But a /dk path with the wrong method is ours and is answered. Note it
        # is answered even for a remote peer — the guard runs first, so a path
        # we own never leaks its existence to a caller we would refuse.
        self.assertEqual(relay.handle("GET", "/dk/result", peer="127.0.0.1").status, 405)
        # The query arrives in whatever shape the adapter has it: a raw string,
        # a mapping, or pairs. One of the three is what every HTTP library
        # hands you, and converting it is not the caller's errand.
        for query in ("", {}, [], None):
            self.assertEqual(
                relay.handle("GET", "/dk/events", query, peer="127.0.0.1").status,
                400,
                f"{query!r} should read as no ?tab=",
            )
        self.assertEqual(
            relay.handle("GET", "/dk/events", "?tab=t1", peer="127.0.0.1").status, 200
        )
        self.assertEqual(
            relay.handle("GET", "/dk/events", {"tab": "t2"}, peer="127.0.0.1").status, 200
        )
        self.assertEqual(
            relay.handle("GET", "/dk/events", [("tab", "t3")], peer="127.0.0.1").status, 200
        )
        self.assertEqual(sorted(t["tab"] for t in relay.tabs()), ["t1", "t2", "t3"])

    def test_serve_will_not_bind_a_public_interface_on_its_own(self):
        # Two deliberate acts, not one. Binding 0.0.0.0 is something people do
        # by reflex to reach a dev server from a phone; here it publishes the
        # ability to drive whoever has a tab open, so reflex must not be enough.
        # Raised before any socket exists: a misconfiguration that surfaced
        # later would be one somebody forgot to check, and the failure mode of
        # forgetting is a listening public port.
        with self.assertRaises(ValueError) as caught:
            serve(host="0.0.0.0", port=0)
        self.assertIn("allow_remote", str(caught.exception))
        self.assertIn("PROTOCOL.md", str(caught.exception))

        # allow_remote alone is no longer enough either: the relay refuses to
        # exist without a way to tell callers apart, so the insecure-but-exposed
        # combination cannot be reached by adding one flag at a time.
        with self.assertRaises(ValueError) as caught:
            serve(host="0.0.0.0", port=0, allow_remote=True)
        self.assertIn("auth=", str(caught.exception))

        running = serve(
            host="0.0.0.0",
            port=0,
            allow_remote=True,
            auth=TabAuth(secret=SECRET, audience="test"),
            start=False,
        )
        self.addCleanup(running.stop)
        self.assertTrue(running.relay.allow_remote)


class Concurrency(RelayTest):
    def test_one_tab_holding_a_stream_does_not_block_another_tabs_request(self):
        # The reason the standalone server is a ThreadingHTTPServer. On the
        # single-threaded one the first `/dk/events` body — which never ends —
        # would wedge every other request forever, and the relay would deadlock
        # against itself before any agent made a call.
        one = self.tab("t1")
        one.hello()
        two = self.tab("t2")
        two.hello()
        self.assertEqual(len(get_json(f"{self.url}/dk/tabs")[1]["tabs"]), 2)

        # Two calls in flight on two tabs, answered out of order. A relay that
        # correlated on anything but `id` would hand one tab's answer to the
        # other's request.
        first = call_async(self.url, "t1", {"name": "goto"})
        second = call_async(self.url, "t2", {"name": "goto"})
        f1 = one.es.next_event("call")
        f2 = two.es.next_event("call")
        two.answer(f2["id"], {"ok": True, "snapshot": {"where": "two", "rev": 2}})
        one.answer(f1["id"], {"ok": True, "snapshot": {"where": "one", "rev": 1}})
        self.assertEqual(first.result()[1]["snapshot"]["where"], "one")
        self.assertEqual(second.result()[1]["snapshot"]["where"], "two")

    def test_call_ids_are_unique_across_concurrent_calls_on_one_tab(self):
        one = self.tab("t1")
        one.hello()
        pendings = [call_async(self.url, "t1", {"name": "goto", "args": {"n": i}}) for i in range(5)]
        frames = [one.es.next_event("call") for _ in range(5)]
        self.assertEqual(len({f["id"] for f in frames}), 5, "two calls shared an id")
        # Answered in reverse, because the verbs are async and the slow one must
        # not block the fast one.
        for frame in reversed(frames):
            one.answer(frame["id"], {"ok": True, "note": frame["id"], "snapshot": SNAP})
        self.assertEqual(
            sorted(p.result()[1]["note"] for p in pendings), sorted(f["id"] for f in frames)
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
