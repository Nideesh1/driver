"""
Isolation between people, asserted over real HTTP against a real relay.

These are the tests that matter most in this repository, because the thing they
pin is the thing whose absence is silent: a relay that leaks other people's
tabs works perfectly for one developer and fails only in production, for
everybody, at once.

The shape of every test here is two principals and one question: can the second
one tell that the first one's tab exists? The answer must be no, through every
endpoint, and it must be no in the same words the relay uses for a tab id that
was never minted — because a *different* refusal is an existence oracle, and an
existence oracle over tab ids is how an attacker finds a session to attack.

Real HTTP, like the rest of the relay suite, with the tab played by hand. See
``relay_harness.py`` for why the shipped client is not used: a test that drives
both sides of a contract with one codebase passes happily when both ends agree
on the wrong thing.
"""

from __future__ import annotations

import os
import sys
import unittest
import urllib.parse

from relay_harness import SNAP, SseClient, Tab, call_async, get_json, post_json, up


def _get_with(url: str, headers: dict[str, str]) -> tuple[int, object]:
    """A GET with arbitrary headers, for the ``resolve_principal`` tests.

    The harness's ``get_json`` takes a token because that is what every other
    test needs; the host hook reads a header of the app's own choosing, which
    only these tests care about.
    """
    import json
    import urllib.error
    import urllib.request

    request = urllib.request.Request(url, method="GET")
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        with err:
            return err.code, json.loads(err.read())

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit.auth import TabAuth, mint_anon_credential  # noqa: E402

SECRET = "k" * 40
AUDIENCE = "relay-test"


class AuthTest(unittest.TestCase):
    """One relay with token auth on, and two people using it."""

    anonymous = True
    require_tab_binding = False

    def setUp(self) -> None:
        self.auth = TabAuth(
            secret=SECRET,
            audience=AUDIENCE,
            anonymous=self.anonymous,
            require_tab_binding=self.require_tab_binding,
        )
        self.running = up(self, auth=self.auth)
        self.url = self.running.url
        self.alice = self.auth.mint("user:alice")
        self.bob = self.auth.mint("user:bob")

    def tab(self, tab_id: str, token: str, **kwargs) -> Tab:
        tab = Tab(self.url, tab_id, token, **kwargs)
        self.assertEqual(tab.es.status, 200, "the tab's stream did not open")
        self.addCleanup(tab.close)
        return tab

    def tabs(self, token: str | None) -> list[dict]:
        status, body = get_json(f"{self.url}/dk/tabs", token=token)
        self.assertEqual(status, 200)
        return body["tabs"]

    def leaf(self, tab_id: str, leaf: str, token: str | None) -> tuple[int, object]:
        quoted = urllib.parse.quote(tab_id, safe="")
        return get_json(f"{self.url}/dk/tabs/{quoted}/{leaf}", token=token)

    def call(self, tab_id: str, body: object, token: str | None) -> tuple[int, object]:
        quoted = urllib.parse.quote(tab_id, safe="")
        return post_json(f"{self.url}/dk/tabs/{quoted}/call", body, token=token)


class Binding(AuthTest):
    def test_a_tab_is_bound_to_the_principal_that_opened_its_stream(self):
        one = self.tab("a-1", self.alice)
        one.hello()
        rows = self.tabs(self.alice)
        self.assertEqual([r["tab"] for r in rows], ["a-1"])
        self.assertEqual(rows[0]["app"], "toy")

    def test_the_credential_may_arrive_as_a_header_a_cookie_or_a_query_parameter(self):
        # Three places, because the page has no choice about which it can use:
        # `EventSource` cannot set a header, so a same-origin page uses the
        # cookie the app set and a cross-origin one has only the query string.
        # An agent uses `Authorization`. All four must work or some deployment
        # cannot connect at all.
        self.tab("h-1", self.alice).hello()
        self.tab("c-1", None, cookie=self.alice).hello()
        self.tab("q-1", None, query_token=self.alice).hello()
        self.assertEqual(sorted(r["tab"] for r in self.tabs(self.alice)), ["c-1", "h-1", "q-1"])

    def test_a_tab_id_two_people_both_minted_is_two_tabs_and_neither_sees_the_other(self):
        # The registry is keyed by (principal, tab id), so a collision is not a
        # conflict to resolve. This matters beyond tidiness: refusing the second
        # stream would tell whoever opened it that the id was taken, which is an
        # existence oracle over tab ids.
        mine = self.tab("same-id", self.alice)
        mine.hello(app="alice-app")
        theirs = self.tab("same-id", self.bob)
        theirs.hello(app="bob-app")

        self.assertEqual([r["app"] for r in self.tabs(self.alice)], ["alice-app"])
        self.assertEqual([r["app"] for r in self.tabs(self.bob)], ["bob-app"])

        # And both tabs are live: neither stream was superseded by the other.
        self.assertFalse(mine.es.closed.is_set())
        self.assertFalse(theirs.es.closed.is_set())

    def test_a_tab_bound_credential_may_open_only_that_tab(self):
        bound = self.auth.mint("user:alice", tab="only-this")
        ok = Tab(self.url, "only-this", bound)
        self.addCleanup(ok.close)
        self.assertEqual(ok.es.status, 200)

        # 403, not `no-such-tab`, and the difference is deliberate: the oracle
        # rule is about ADDRESSING somebody else's tab, and this caller is
        # opening its own with a credential bound elsewhere — which it knows.
        refused = SseClient(f"{self.url}/dk/events?tab=something-else", {"X-DK-Token": bound})
        self.addCleanup(refused.close)
        self.assertEqual(refused.status, 403)


class Listing(AuthTest):
    def test_dk_tabs_never_lists_another_principals_tab(self):
        # The worst thing on this surface before scoping existed: an inventory
        # of a hundred people's sessions, with their titles and URLs attached,
        # served to anybody who could reach the port.
        self.tab("a-1", self.alice).hello(title="Alice's contacts", url="/contacts?who=alice")
        self.tab("b-1", self.bob).hello(title="Bob's contacts")

        alice_rows = self.tabs(self.alice)
        self.assertEqual([r["tab"] for r in alice_rows], ["a-1"])
        self.assertEqual(alice_rows[0]["title"], "Alice's contacts")
        self.assertEqual([r["tab"] for r in self.tabs(self.bob)], ["b-1"])

        # Not a filter applied on the way out: Bob's listing does not mention
        # the existence of a-1 in any field, not as a count and not as a title.
        self.assertNotIn("a-1", repr(self.tabs(self.bob)))
        self.assertNotIn("alice", repr(self.tabs(self.bob)).lower())

    def test_a_tab_bound_credential_lists_only_its_own_tab(self):
        self.tab("a-1", self.alice).hello()
        self.tab("a-2", self.alice).hello()
        narrow = self.auth.mint("user:alice", tab="a-2")
        self.assertEqual([r["tab"] for r in self.tabs(narrow)], ["a-2"])

    def test_the_in_process_registry_still_sees_everything_but_http_does_not(self):
        # `relay.tabs()` is the operator's view — a process embedding the relay
        # may legitimately want to know what is connected. The split is the
        # point: nothing reachable over HTTP uses it.
        self.tab("a-1", self.alice).hello()
        self.tab("b-1", self.bob).hello()
        self.assertEqual(sorted(t["tab"] for t in self.running.relay.tabs()), ["a-1", "b-1"])
        self.assertEqual([r["tab"] for r in self.tabs(self.alice)], ["a-1"])


class NotAnOracle(AuthTest):
    """Another person's tab must be indistinguishable from one that never existed."""

    def setUp(self) -> None:
        super().setUp()
        self.hers = self.tab("a-1", self.alice)
        self.hers.hello()

    def test_manifest_and_snapshot_answer_the_same_thing_for_foreign_and_absent(self):
        for leaf in ("manifest", "snapshot"):
            with self.subTest(leaf=leaf):
                foreign = self.leaf("a-1", leaf, self.bob)
                absent = self.leaf("never-minted", leaf, self.bob)
                self.assertEqual(foreign[0], 404)
                self.assertEqual(foreign[1]["error"], "no-such-tab")
                # Byte for byte, hint included. A hint naming the tab in one
                # case and not the other is the oracle the status code was
                # chosen to avoid.
                self.assertEqual(foreign, absent)

    def test_a_foreign_tab_with_no_manifest_does_not_answer_no_manifest(self):
        # The ordering trap. A tab that has opened its stream but not yet sent
        # `hello` answers `no-manifest` to its OWNER — a real and documented
        # window. Answering that to a stranger would confirm the tab exists.
        quiet = self.tab("a-2", self.alice)  # no hello()
        self.assertEqual(self.leaf("a-2", "manifest", self.alice)[1]["error"], "no-manifest")
        self.assertEqual(self.leaf("a-2", "manifest", self.bob)[1]["error"], "no-such-tab")
        self.assertEqual(
            self.leaf("a-2", "manifest", self.bob), self.leaf("nope", "manifest", self.bob)
        )
        quiet.close()

    def test_watch_answers_the_same_thing_for_foreign_and_absent(self):
        foreign = self.leaf("a-1", "watch", self.bob)
        absent = self.leaf("never-minted", "watch", self.bob)
        self.assertEqual(foreign[0], 404)
        self.assertEqual(foreign[1]["error"], "no-such-tab")
        self.assertEqual(foreign, absent)

    def test_a_cross_principal_watch_never_receives_a_snapshot(self):
        # The stronger form: not only is the subscription refused, a watcher
        # that somehow attached cannot be fed by the other principal's pushes.
        # Alice's own watcher gets the frame; Bob gets no stream to get it on.
        mine = SseClient(
            f"{self.url}/dk/tabs/a-1/watch", {"Authorization": f"Bearer {self.alice}"}
        )
        self.addCleanup(mine.close)
        self.assertEqual(mine.status, 200)
        # A new watcher is sent the current screen immediately, so the first
        # frame is the one that already existed. The push is the second.
        self.assertEqual(mine.next_event("snapshot")["snapshot"]["rev"], SNAP["rev"])
        self.hers.push({**SNAP, "rev": 9})
        self.assertEqual(mine.next_event("snapshot")["snapshot"]["rev"], 9)

        theirs = SseClient(
            f"{self.url}/dk/tabs/a-1/watch", {"Authorization": f"Bearer {self.bob}"}
        )
        self.addCleanup(theirs.close)
        self.assertEqual(theirs.status, 404)

    def test_a_cross_principal_call_is_refused_as_no_such_tab_not_as_forbidden(self):
        # 200 with a WireResult, exactly as for a tab id that was never minted.
        # A 403 here would turn /call into a membership test for other people's
        # tab ids, and an agent would also have to handle a third outcome shape.
        foreign = self.call("a-1", {"name": "goto"}, self.bob)
        absent = self.call("never-minted", {"name": "goto"}, self.bob)
        self.assertEqual(foreign[0], 200)
        self.assertEqual(foreign[1]["refused"], "no-such-tab")
        self.assertNotIn("snapshot", foreign[1])
        self.assertEqual(foreign, absent)

        # And nothing reached Alice's tab: no `call` frame was written to it.
        self.assertEqual(self.hers.es.seen("call"), 0)

    def test_a_tab_bound_credential_addressing_another_tab_gets_no_such_tab(self):
        self.tab("a-2", self.alice).hello()
        bound = self.auth.mint("user:alice", tab="a-1")
        self.assertEqual(self.leaf("a-2", "snapshot", bound)[1]["error"], "no-such-tab")
        self.assertEqual(self.call("a-2", {"name": "goto"}, bound)[1]["refused"], "no-such-tab")


class ResultFrames(AuthTest):
    def test_a_tab_cannot_answer_another_principals_call(self):
        hers = self.tab("a-1", self.alice)
        hers.hello()
        theirs = self.tab("b-1", self.bob)
        theirs.hello()

        pending = call_async(self.url, "a-1", {"name": "goto"}, token=self.alice)
        frame = hers.es.next_event("call")

        # Bob's tab POSTs a result for Alice's call, naming her tab. 409
        # `no-such-tab` — the same answer as a tab that is not connected, which
        # is the oracle rule applied to the tab's own endpoint.
        status, body = post_json(
            f"{self.url}/dk/result?tab=a-1",
            {"t": "result", "id": frame["id"], "result": {"ok": True, "snapshot": SNAP}},
            token=self.bob,
        )
        self.assertEqual((status, body["error"]), (409, "no-such-tab"))

        # Alice's call is untouched and still answerable by Alice's tab.
        hers.answer(frame["id"], {"ok": True, "snapshot": {**SNAP, "rev": 11}})
        self.assertEqual(pending.result()[1]["snapshot"]["rev"], 11)

    def test_one_persons_tab_cannot_answer_their_other_tabs_call(self):
        # Within one principal the registry key does not separate them, so what
        # holds is that `pending` is per-tab-record and call ids are unique
        # across the relay. A `result` for the other tab's call finds nothing to
        # settle and is dropped as a late answer — not an error, because a late
        # answer is exactly what it looks like.
        one = self.tab("a-1", self.alice)
        one.hello()
        two = self.tab("a-2", self.alice)
        two.hello()

        pending = call_async(self.url, "a-1", {"name": "goto"}, token=self.alice)
        frame = one.es.next_event("call")

        status, body = post_json(
            f"{self.url}/dk/result?tab=a-2",
            {"t": "result", "id": frame["id"], "result": {"ok": True, "snapshot": SNAP}},
            token=self.alice,
        )
        self.assertEqual(status, 202)
        self.assertIn("no call", body.get("note", ""))
        self.assertFalse(pending.done, "a-2 answered a call that was issued to a-1")

        one.answer(frame["id"], {"ok": True, "snapshot": {**SNAP, "rev": 12}})
        self.assertEqual(pending.result()[1]["snapshot"]["rev"], 12)

    def test_a_hello_for_another_principals_tab_cannot_rewrite_it(self):
        hers = self.tab("a-1", self.alice)
        hers.hello(app="toy", title="Alice")
        status, body = post_json(
            f"{self.url}/dk/result",
            {"t": "hello", "tab": "a-1", "app": "not-toy", "title": "Bob was here"},
            token=self.bob,
        )
        self.assertEqual((status, body["error"]), (409, "no-such-tab"))
        self.assertEqual(self.tabs(self.alice)[0]["title"], "Alice")


class Credentials(AuthTest):
    def test_no_credential_is_a_401_with_a_challenge_and_not_an_anonymous_session(self):
        # Silently treating an unidentified caller as a fresh anonymous visitor
        # was the tempting shape: it is wrong twice over, because a user whose
        # token lapsed would quietly become a stranger and lose their tabs, and
        # an agent with a misconfigured key would be told "you have no tabs"
        # rather than "your key is wrong".
        status, body = get_json(f"{self.url}/dk/tabs")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "no-credential")

    def test_every_way_a_credential_can_fail_gives_one_slug(self):
        # On purpose. "The signature verified but the audience was wrong" tells
        # a forger the forgery worked, and a legitimate client's move is the
        # same in every case: mint a fresh token and retry once.
        import json as _json

        expired = self.auth.mint("user:alice", ttl_s=-3600)
        wrong_audience = TabAuth(secret=SECRET, audience="relay-other").mint("user:alice")
        wrong_key = TabAuth(secret="x" * 40, audience=AUDIENCE).mint("user:alice")
        prefix, payload, _sig = self.alice.split(".")
        tampered = f"{prefix}.{payload}.AAAAAAAA"
        bad_payload = "dkt1.bm90LWpzb24.AAAA"

        for name, credential in (
            ("expired", expired),
            ("wrong audience", wrong_audience),
            ("forged with another key", wrong_key),
            ("tampered signature", tampered),
            ("undecodable payload", bad_payload),
            ("not a token at all", "hunter2"),
        ):
            with self.subTest(case=name):
                status, body = get_json(f"{self.url}/dk/tabs", token=credential)
                self.assertEqual(status, 401)
                self.assertEqual(body["error"], "bad-credential")
                self.assertEqual(body["hint"], "present a fresh tab token")
                # And nothing about the real reason leaks through the body.
                self.assertNotIn("audience", _json.dumps(body))
                self.assertNotIn("expired", _json.dumps(body))

    def test_a_bad_credential_on_call_is_a_401_rather_than_a_wire_result(self):
        # Not a violation of "every answer from /call is a WireResult": a
        # non-2xx means no WireResult was produced at all, which is exactly what
        # happened. Nothing was asked of any tab. A VALID credential for the
        # wrong tab is the other case and is a 200 WireResult — see NotAnOracle.
        status, body = self.call("a-1", {"name": "goto"}, "hunter2")
        self.assertEqual(status, 401)
        self.assertNotIn("refused", body)

    def test_an_unidentified_caller_learns_nothing_about_the_route_surface(self):
        # Identity before routing. A 405 or a 404 here would let a caller we
        # will not serve map the surface anyway.
        self.assertEqual(post_json(f"{self.url}/dk/tabs", {})[0], 401)
        self.assertEqual(get_json(f"{self.url}/dk/nonsense")[0], 401)

    def test_an_expired_token_does_not_disconnect_a_tab_that_is_still_open(self):
        # THE MID-SESSION EXPIRY RULE. The stream is authenticated once, at
        # open, and the binding it made lasts as long as the stream. A relay
        # that hung up at `exp` would disconnect every tab in the deployment
        # once per token lifetime, mid-verb, while a person watched.
        short = self.auth.mint("user:alice", ttl_s=1, tab="a-1")
        tab = self.tab("a-1", short)
        tab.hello()

        # The credential is now dead for a NEW request — the relay has no
        # clock to wind, so the token is minted already expired for the second
        # half of this test.
        dead = self.auth.mint("user:alice", ttl_s=-3600, tab="a-1")
        tab.token = dead

        # The stream is still live, the tab is still listed to its owner, and a
        # call still reaches it.
        self.assertFalse(tab.es.closed.is_set())
        self.assertEqual([r["tab"] for r in self.tabs(self.alice)], ["a-1"])
        pending = call_async(self.url, "a-1", {"name": "goto"}, token=self.alice)
        frame = tab.es.next_event("call")

        # What the tab CANNOT do is answer, because `/dk/result` is a new
        # request and carries its own credential. This is the symptom a page
        # must handle, and `connect`'s token getter is what handles it: refresh
        # and re-send the same bytes.
        self.assertEqual(tab.answer(frame["id"], {"ok": True, "snapshot": SNAP})[0], 401)

        tab.token = self.auth.mint("user:alice", tab="a-1")
        tab.answer(frame["id"], {"ok": True, "snapshot": {**SNAP, "rev": 14}})
        self.assertEqual(pending.result()[1]["snapshot"]["rev"], 14)


class Anonymous(AuthTest):
    def test_two_anonymous_visitors_are_isolated_from_each_other(self):
        # "Anonymous" is not one bucket. Two independent browser secrets are
        # two principals, and the registry key is the principal, so the second
        # visitor cannot see, list, read or drive the first one's screen.
        first, second = mint_anon_credential(), mint_anon_credential()
        mine = self.tab("v-1", first)
        mine.hello(title="my screen")
        theirs = self.tab("v-2", second)
        theirs.hello(title="their screen")

        self.assertEqual([r["tab"] for r in self.tabs(first)], ["v-1"])
        self.assertEqual([r["tab"] for r in self.tabs(second)], ["v-2"])
        self.assertEqual(self.leaf("v-1", "snapshot", second)[1]["error"], "no-such-tab")
        self.assertEqual(self.call("v-1", {"name": "goto"}, second)[1]["refused"], "no-such-tab")
        self.assertEqual(mine.es.seen("call"), 0)

    def test_an_anonymous_visitor_is_isolated_from_a_logged_in_one(self):
        visitor = mint_anon_credential()
        self.tab("a-1", self.alice).hello()
        self.tab("v-1", visitor).hello()
        self.assertEqual([r["tab"] for r in self.tabs(visitor)], ["v-1"])
        self.assertEqual(self.leaf("a-1", "manifest", visitor)[1]["error"], "no-such-tab")

    def test_the_same_secret_resumes_the_same_anonymous_principal(self):
        # So a reconnect — which `connect` does by re-opening the stream — gets
        # its own tabs back rather than becoming a new stranger.
        visitor = mint_anon_credential()
        self.tab("v-1", visitor).hello()
        self.assertEqual([r["tab"] for r in self.tabs(visitor)], ["v-1"])
        self.assertEqual([r["tab"] for r in self.tabs(visitor)], ["v-1"])


class AnonymousRefused(AuthTest):
    anonymous = False

    def test_an_app_where_everyone_is_logged_in_can_refuse_anonymous(self):
        # There, an anonymous credential can only be somebody probing.
        status, body = get_json(f"{self.url}/dk/tabs", token=mint_anon_credential())
        self.assertEqual((status, body["error"]), (401, "bad-credential"))
        self.assertEqual([r["tab"] for r in self.tabs(self.alice)], [])


class StrictBinding(AuthTest):
    require_tab_binding = True

    def test_an_unbound_token_is_refused_when_the_relay_requires_binding(self):
        status, body = get_json(f"{self.url}/dk/tabs", token=self.auth.mint("user:alice"))
        self.assertEqual((status, body["error"]), (401, "bad-credential"))
        bound = self.auth.mint("user:alice", tab="a-1")
        self.assertEqual(get_json(f"{self.url}/dk/tabs", token=bound)[0], 200)


class Unconfigured(unittest.TestCase):
    """The single-developer path: no auth, no tokens, no setup, unchanged."""

    def setUp(self) -> None:
        self.running = up(self)
        self.url = self.running.url

    def test_an_unconfigured_loopback_relay_needs_no_credential_at_all(self):
        # Backward compatibility is not a courtesy here. Auth is something you
        # turn on, and a library that made a dev loop configure keys first is a
        # library people route around.
        tab = Tab(self.url, "t1")
        self.addCleanup(tab.close)
        self.assertEqual(tab.es.status, 200)
        self.assertEqual(tab.hello()[0], 202)

        status, body = get_json(f"{self.url}/dk/tabs")
        self.assertEqual((status, [r["tab"] for r in body["tabs"]]), (200, ["t1"]))
        self.assertEqual(get_json(f"{self.url}/dk/tabs/t1/manifest")[0], 200)

        pending = call_async(self.url, "t1", {"name": "goto"})
        frame = tab.es.next_event("call")
        tab.answer(frame["id"], {"ok": True, "snapshot": SNAP})
        self.assertEqual(pending.result()[1]["ok"], True)

    def test_a_stray_credential_against_an_unconfigured_relay_is_simply_ignored(self):
        # Not an error: with no `auth` there is nothing to verify it against,
        # and refusing it would make a client that always sends one unable to
        # talk to a dev relay.
        tab = Tab(self.url, "t1", "dkt1.whatever.whatever")
        self.addCleanup(tab.close)
        self.assertEqual(tab.es.status, 200)
        self.assertEqual(tab.hello()[0], 202)
        self.assertEqual(
            [r["tab"] for r in get_json(f"{self.url}/dk/tabs", token="nonsense")[1]["tabs"]],
            ["t1"],
        )


class Embedding(AuthTest):
    def test_a_path_the_relay_does_not_own_is_still_declined_rather_than_401d(self):
        # Load-bearing for the deployment PROTOCOL.md recommends. `handle`
        # returns None for a path that is not ours so the relay can sit in
        # front of the app it is embedded in — and that must happen BEFORE the
        # credential check, or a relay with auth on would 401 every one of the
        # host app's own routes, including its login page.
        for path in ("/", "/app/descents", "/dk", "/dkstuff", "/api/dk-token"):
            with self.subTest(path=path):
                self.assertIsNone(
                    self.running.relay.handle("GET", path, peer="127.0.0.1"),
                    "the relay claimed a path it does not own",
                )
        # And a /dk path with no credential is still refused.
        self.assertEqual(
            self.running.relay.handle("GET", "/dk/tabs", peer="127.0.0.1").status, 401
        )


class ResolvePrincipal(unittest.TestCase):
    """The embedded door: an app that already has sessions just says who it is."""

    def test_a_host_hook_resolves_the_principal_with_no_token_anywhere(self):
        # The deployment PROTOCOL.md recommends is a relay inside the app's own
        # server, which already knows who the browser is. Making it mint a token
        # to tell itself would be a process calling itself over HTTP.
        def whoami(headers):
            seat = headers.get("x-app-user")
            return f"user:{seat}" if seat else None

        running = up(self, resolve_principal=whoami)
        url = running.url

        alice = Tab(url, "a-1", None, cookie=None)
        self.addCleanup(alice.close)
        # The hook reads `x-app-user`, which the harness does not send, so this
        # stream is... refused. The hook is the only door here: no header, no
        # answer, and no `auth` to fall through to.
        self.assertEqual(alice.es.status, 401)

        status, body = get_json(f"{url}/dk/tabs")
        self.assertEqual((status, body["error"]), (401, "no-credential"))

        # With the header the app's proxy sets, the same request is Alice.
        seated = SseClient(f"{url}/dk/events?tab=a-1", {"X-App-User": "alice"})
        self.addCleanup(seated.close)
        self.assertEqual(seated.status, 200)
        status, body = _get_with(f"{url}/dk/tabs", {"X-App-User": "alice"})
        self.assertEqual((status, [r["tab"] for r in body["tabs"]]), (200, ["a-1"]))
        # And another seat sees none of it.
        status, body = _get_with(f"{url}/dk/tabs", {"X-App-User": "bob"})
        self.assertEqual((status, body["tabs"]), (200, []))

    def test_the_hook_falling_through_hands_the_request_to_the_token_path(self):
        # So one relay can serve logged-in users from the app's session and
        # anonymous visitors from a minted credential.
        auth = TabAuth(secret=SECRET, audience=AUDIENCE)
        running = up(self, auth=auth, resolve_principal=lambda _headers: None)
        self.assertEqual(get_json(f"{running.url}/dk/tabs", token=auth.mint("u"))[0], 200)
        self.assertEqual(get_json(f"{running.url}/dk/tabs")[0], 401)

    def test_a_hook_that_throws_is_an_unidentified_caller_and_not_a_500(self):
        def broken(_headers):
            raise RuntimeError("the app's session store is down")

        seen: list[BaseException] = []
        running = up(self, resolve_principal=broken, on_error=seen.append)
        status, body = get_json(f"{running.url}/dk/tabs")
        self.assertEqual((status, body["error"]), (401, "no-credential"))
        self.assertTrue(seen, "the hook's failure was swallowed entirely")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
