"""
These tests are the specification for the Python client. Each name states the
decision it pins, so a change that looks harmless has to break a named test and
read why the rule exists before deleting it.

Every one of them talks to a real HTTP server on an ephemeral port. See
``fake_relay.py`` for why nothing is mocked at the ``urllib`` level.
"""

from __future__ import annotations

import unittest

import os
import sys

# src layout, run without installing: `uv run python -m unittest discover -s
# tests -t tests` works from a checkout, which is what a contributor does
# before the package exists on an index.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit import Driverkit, ProtocolError, Result, Row, Snapshot, TransportError, render_snapshot

from fake_relay import TAB, FakeRelay, snapshot_frame


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.relay = FakeRelay()
        self.addCleanup(self.relay.stop)
        self.dk = Driverkit(self.relay.url)


class Reads(ClientTest):
    def test_tabs_reads_the_specified_envelope_and_the_id_field_named_tab(self):
        # The specified shape: a {"tabs": [...]} envelope so a later field can
        # be added beside `tabs`, and the id spelled `tab` — the same name the
        # `hello` frame uses, one name for one thing.
        tabs = self.dk.tabs()
        self.assertEqual([t.id for t in tabs], [TAB, "other-tab"])
        first = tabs[0]
        self.assertEqual(first.app, "toy")
        # title and url exist in the protocol for exactly one purpose: answering
        # "which one?" when a person has two tabs open. Dropping them in parsing
        # would make that question unanswerable.
        self.assertEqual(first.title, "Descents — toy")
        self.assertEqual(first.url, "/app/descents")
        # `manifestVersion` is lifted to the top level so a client can tell
        # whether its cached manifest is current in one cheap request, which is
        # the whole reason the version exists.
        self.assertEqual(first.manifest_version, "deadbeef0001")
        self.assertEqual(first.rev, 1)
        self.assertEqual(first.since, "2026-11-25T18:04:11Z")
        # And it round-trips back out in the specified spelling, not the
        # tolerated ones.
        self.assertEqual(first.to_dict()["tab"], TAB)
        self.assertNotIn("id", first.to_dict())

    def test_a_bare_array_still_parses_for_relays_older_than_the_spec(self):
        # The envelope is specified now, but it was not when the endpoint was
        # described in prose, and a relay built against that prose is not
        # wrong-headed enough to refuse to talk to. Tolerated on the way in,
        # never emitted on the way out.
        self.relay.tabs_envelope = False
        self.assertEqual([t.id for t in self.dk.tabs()], [TAB, "other-tab"])

    def test_the_manifest_carries_the_arg_surface_including_oneof_and_optional(self):
        manifest = self.dk.manifest(TAB)
        self.assertEqual(manifest.app, "toy")
        self.assertEqual(manifest.version, "deadbeef0001")

        set_lane = manifest.verb("set-lane")
        assert set_lane is not None
        self.assertEqual(set_lane.args["lane"].one_of, ("doing", "pruning", "held"))
        # `optional` absent means required. Pinned here rather than left to the
        # reader because the default is the strict one and a parser that read
        # `None` as "optional" would make every argument droppable.
        self.assertTrue(set_lane.args["id"].required)
        self.assertFalse(set_lane.args["because"].required)
        self.assertIn("machine-may-not-leave-pruning", set_lane.refuses)

    def test_a_verb_with_no_args_parses_as_no_args_not_as_a_failure(self):
        scroll = self.dk.manifest(TAB).verb("scroll")
        assert scroll is not None
        self.assertEqual(scroll.args, {})
        self.assertEqual(scroll.refuses, ())

    def test_the_snapshot_shows_only_the_screen_and_says_that_more_exists(self):
        snapshot = self.dk.snapshot(TAB)
        self.assertEqual(snapshot.where, "descents")
        self.assertEqual(snapshot.rev, 1)
        self.assertEqual([r.id for r in snapshot.rows or ()], ["01a2"])
        # The agent is handed one row because one row is on screen, and `page`
        # is what tells it the other descent exists at all.
        assert snapshot.page is not None
        self.assertEqual((snapshot.page.index, snapshot.page.size, snapshot.page.total), (0, 1, 2))

    def test_a_row_keeps_its_app_defined_columns_and_round_trips_flat(self):
        row = (self.dk.snapshot(TAB).rows or ())[0]
        self.assertEqual(row["lane"], "pruning")
        # The nested `columns` dict is a Python detail. What crosses the wire is
        # `{id, ...columns}`, and a client that serialised the nested shape would
        # send a row no TypeScript reader could consume.
        self.assertEqual(row.to_dict(), {"id": "01a2", "lane": "pruning"})
        self.assertEqual(Row.from_dict({"id": "x", "lane": "held"}).columns, {"lane": "held"})

    def test_an_absent_page_is_not_invented_from_the_row_count(self):
        # types.ts: the absence of `page` is a claim that the agent is seeing
        # everything. Synthesising `{0, n, n}` would manufacture that claim out
        # of a relay that simply did not make it.
        snapshot = Snapshot.from_dict({"where": "x", "rev": 3, "rows": [{"id": "a"}]})
        self.assertIsNone(snapshot.page)
        self.assertNotIn("page", snapshot.to_dict())

    def test_a_page_with_no_total_parses_rather_than_raising_on_the_commonest_window(self):
        # `total` is OPTIONAL in the TS `Snapshot`, and total-absent is not an
        # edge case: it is what any app reading its rows out of a rendered
        # table produces, because the DOM cannot tell a virtualised grid from a
        # short list. Requiring it here made that snapshot unparseable — a
        # `KeyError` out of `Page.from_dict` before the renderer was reached —
        # so the whole unknown-total branch was dead code from the wire's point
        # of view.
        snapshot = Snapshot.from_dict(
            {"where": "invoices", "rev": 4, "rows": [{"id": "INV-1"}], "page": {"index": 0, "size": 1}}
        )
        assert snapshot.page is not None
        self.assertEqual((snapshot.page.index, snapshot.page.size), (0, 1))
        # None, not 0. A total of 0 is a real answer — an empty window onto an
        # empty whole — and absence means "I do not count".
        self.assertIsNone(snapshot.page.total)
        # And it goes back out the way it came in: omitted rather than null, so
        # a round trip cannot turn "unknown" into a field a stricter reader
        # rejects.
        self.assertEqual(snapshot.to_dict()["page"], {"index": 0, "size": 1})

    def test_a_total_of_zero_survives_as_a_real_answer_and_not_as_absence(self):
        # The reason `from_dict` tests `is None` rather than falsiness. An empty
        # window onto an empty whole is a claim an agent can act on; "I do not
        # count" is not, and conflating them tells the agent to go looking for
        # rows nobody said exist.
        snapshot = Snapshot.from_dict({"where": "x", "rev": 1, "page": {"index": 0, "size": 0, "total": 0}})
        assert snapshot.page is not None
        self.assertEqual(snapshot.page.total, 0)
        self.assertEqual(snapshot.to_dict()["page"]["total"], 0)

    def test_an_unknown_total_renders_as_words_a_model_can_act_on_straight_from_json(self):
        # End to end from JSON, which is the part that was broken. `render.py`
        # already read the total defensively through `getattr`, so this branch
        # LOOKED covered — but nothing could reach it from the wire, because
        # parsing raised first. The assertion is therefore deliberately against
        # a snapshot built from a dict rather than constructed in Python.
        rendered = render_snapshot(
            Snapshot.from_dict(
                {
                    "where": "invoices",
                    "rev": 4,
                    "rows": [{"id": "INV-1"}, {"id": "INV-2"}],
                    "page": {"index": 0, "size": 2},
                }
            )
        )
        self.assertIn("total unknown", rendered)
        # "at least", not a number: the point of the third state is that the
        # renderer must not let a model conclude a record does not exist from a
        # window whose size nobody knows.
        self.assertIn("at least 2", rendered)

    def test_a_selection_carries_its_true_size_beside_the_ids_that_are_on_screen(self):
        # `selected` carries only the ids ON SCREEN, so `select-where` can
        # select thousands without putting tens of kilobytes of ids into the
        # uncached half of every later result — which on a big table goes
        # straight through the relay's 1 MiB body limit. `selectedCount` is the
        # honest size that `selected` therefore cannot be, and dropping it here
        # meant an agent handed three ids and a bulk commit believed three rows
        # were about to change.
        snapshot = Snapshot.from_dict(
            {
                "where": "invoices",
                "rev": 4,
                "rows": [{"id": "INV-1"}],
                "selected": ["INV-1", "INV-2", "INV-3"],
                "selectedCount": 10_000,
            }
        )
        self.assertEqual(snapshot.selected_count, 10_000)
        # The wire name is the contract; `selected_count` is only how Python
        # spells it, so it must go back out as `selectedCount`.
        self.assertEqual(snapshot.to_dict()["selectedCount"], 10_000)
        rendered = render_snapshot(snapshot)
        self.assertIn("10,000", rendered)
        self.assertIn("on screen", rendered)

    def test_the_screen_id_renders_above_the_prose_and_only_when_the_app_has_one(self):
        # `where` carries the filter, the sort and a drill-down's record
        # description, so it moves constantly for reasons that are not
        # navigation. `screen` is the one line on this block that can be
        # compared for equality, which is what makes "did I navigate?"
        # answerable at all. First, because it is the stable fact and the prose
        # is about it. String-for-string with the TS renderer, which is the
        # standing promise about these two files.
        rendered = render_snapshot(
            Snapshot.from_dict(
                {
                    "where": "Acme Industrial \u2014 410 contacts, pending",
                    "screen": "company",
                    "rev": 12,
                    "rows": [{"id": "c-1"}],
                }
            )
        )
        self.assertTrue(rendered.startswith("screen: company\nwhere: Acme Industrial"))
        # The wire name is the contract and a round trip must not lose it.
        self.assertEqual(
            Snapshot.from_dict({"where": "x", "rev": 1, "screen": "a"}).to_dict()["screen"], "a"
        )

        # An app that does not describe its screens renders exactly what it
        # rendered before the field existed. Not cosmetic: this is the uncached
        # half, and a line that says nothing is paid for on every turn.
        plain = Snapshot.from_dict({"where": "contacts", "rev": 12, "rows": [{"id": "c-1"}]})
        self.assertTrue(render_snapshot(plain).startswith("where: contacts (rev 12)"))
        self.assertNotIn("screen:", render_snapshot(plain))
        self.assertNotIn("screen", plain.to_dict())

    def test_an_uncounted_selection_stays_uncounted_rather_than_becoming_its_window(self):
        # Absence means "I do not count", and defaulting it to `len(selected)`
        # would be the library inventing the exact false confidence the field
        # was added to remove.
        snapshot = Snapshot.from_dict({"where": "x", "rev": 1, "selected": ["a", "b"]})
        self.assertIsNone(snapshot.selected_count)
        self.assertNotIn("selectedCount", snapshot.to_dict())

    def test_an_empty_selection_says_the_app_counted_and_got_none_not_nothing_at_all(self):
        # The defect this pins: the selection line used to be printed only when
        # the selection was non-empty, so a screen with nothing selected said
        # NOTHING about selections. Silence cannot be told from "this screen
        # does not report selections", and an absent value reads as a claim —
        # the same class of bug already fixed on ``page`` and on ``rows``.
        #
        # It cost real behaviour, in an eval run rather than in theory: asked
        # to accept the selected contacts with nothing selected, the model said
        # accepting needs a count it had read first and it would not change
        # data blind — obeying this library's own safety rule — then spent two
        # extra steps navigating to other screens hunting for a number the
        # screen could perfectly well have told it.
        rendered = render_snapshot(
            Snapshot.from_dict(
                {"where": "contacts", "rev": 2, "selectedCount": 0, "rows": [{"id": "c-1"}]}
            )
        )
        self.assertIn("selected: none (0 rows; this screen counts the selection)", rendered)
        # `0` is a real answer whether or not the app also sends the (empty)
        # list of on-screen ids, so both spellings render the same sentence.
        self.assertIn(
            "selected: none (0 rows; this screen counts the selection)",
            render_snapshot(
                Snapshot.from_dict(
                    {"where": "contacts", "rev": 2, "selectedCount": 0, "selected": [], "rows": []}
                )
            ),
        )

    def test_a_screen_that_reports_no_selection_at_all_says_so_rather_than_none(self):
        # A DIFFERENT sentence from ``selectedCount: 0``, and keeping them
        # apart is the whole point. `0` is an app that counts; both fields
        # absent is an app that does not report selections, and a model that
        # reads the second as the first commits on a count nobody ever took.
        rendered = render_snapshot(
            Snapshot.from_dict({"where": "settings", "rev": 3, "rows": [{"id": "s-1"}]})
        )
        self.assertIn("(this screen reports no selection)", rendered)
        self.assertNotIn("0 rows", rendered)

    def test_ids_on_screen_with_no_count_is_the_weakest_claim_and_says_only_that(self):
        # The third state, and the one nobody thinks about: the app says which
        # of the ids in front of the model are selected and none of them are,
        # but it does not count, so a row off screen may still be selected.
        # Folding this into "nothing is selected" would assert an empty
        # selection on the strength of one window — the ``page``-absent
        # mistake, in the selection.
        rendered = render_snapshot(
            Snapshot.from_dict(
                {"where": "contacts", "rev": 4, "selected": [], "rows": [{"id": "c-1"}]}
            )
        )
        self.assertIn(
            "selected: none on screen; this screen does not count the selection, so rows off "
            "screen may be selected",
            rendered,
        )
        self.assertNotIn("0 rows", rendered)
        self.assertNotIn("reports no selection", rendered)

    def test_the_three_state_selection_line_never_displaces_a_real_selections_wording(self):
        # The large-selection split is the wording a bulk commit turns on, and
        # the new branch must be unreachable whenever there is anything to say
        # the old way. Pinned here as well because the two now share a branch.
        big = render_snapshot(
            Snapshot.from_dict(
                {
                    "where": "contacts",
                    "rev": 5,
                    "selected": ["c-0", "c-1", "c-2"],
                    "selectedCount": 10_000,
                    "rows": [{"id": "c-0"}],
                }
            )
        )
        self.assertIn("selected: c-0, c-1, c-2\n", big)
        self.assertIn("selected 10,000 rows in all; the 3 ids above are only the ones on screen", big)
        self.assertNotIn("selected: none", big)

        # A selection entirely off screen keeps its own sentence rather than
        # falling into "none": this is the case where "none" would be false.
        off_screen = render_snapshot(
            Snapshot.from_dict({"where": "contacts", "rev": 5, "selectedCount": 1200, "rows": []})
        )
        self.assertIn("selected 1,200 rows in all; none of them are on screen", off_screen)
        self.assertNotIn("selected: none", off_screen)

    def test_an_unknown_field_is_ignored_rather_than_rejected(self):
        # PROTOCOL.md promises a field may be added without a version bump, so a
        # strict parser here would turn an additive relay change into an outage.
        snapshot = Snapshot.from_dict({"where": "x", "rev": 1, "theme": "dark"})
        self.assertEqual(snapshot.where, "x")


class Calls(ClientTest):
    def test_a_successful_call_returns_the_snapshot_after_it_ran(self):
        before = self.dk.snapshot(TAB).rev
        result = self.dk.call(TAB, "set-lane", {"id": "01b7", "lane": "held"})

        self.assertTrue(result.ok)
        assert result.snapshot is not None
        # One round trip, not two: the whole reason Result carries a snapshot.
        # A client that returned only `ok` would hand that saving back.
        self.assertGreater(result.snapshot.rev, before)

    def test_a_refusal_is_returned_as_a_value_and_does_not_raise(self):
        result = self.dk.call(TAB, "set-lane", {"id": "01a2", "lane": "held"})

        # The human gate. The core refuses this and does not throw, and raising
        # here would re-break that at the language boundary — pushing every
        # caller into try/except around the app's own business rules.
        self.assertFalse(result.ok)
        self.assertEqual(result.refused, "machine-may-not-leave-pruning")
        self.assertIn("human gate", result.hint or "")
        # And a refusal still carries the screen, so the agent can see that
        # nothing moved without a second read.
        assert result.snapshot is not None
        self.assertEqual((result.snapshot.rows or ())[0]["lane"], "pruning")

    def test_a_bad_argument_is_a_refusal_too_and_names_the_accepted_set(self):
        result = self.dk.call(TAB, "set-lane", {"id": "01a2", "lane": "done"})
        self.assertFalse(result.ok)
        self.assertEqual(result.refused, "bad-argument")
        self.assertIn('"held"', result.hint or "")

    def test_an_unknown_verb_is_a_refusal_naming_the_verbs_that_exist(self):
        # The caller may be holding a manifest from an older version of the app.
        result = self.dk.call(TAB, "park")
        self.assertFalse(result.ok)
        self.assertEqual(result.refused, "unknown-verb")
        self.assertIn("set-lane", result.hint or "")

    def test_rev_is_sent_only_when_given_because_omitting_it_opts_out(self):
        self.dk.call(TAB, "scroll")
        self.assertNotIn("rev", self.relay.last_body or {})
        # An explicit `"rev": null` would be a claim about the screen, and the
        # claim we mean to make is none at all.
        self.dk.call(TAB, "scroll", rev=None)
        self.assertNotIn("rev", self.relay.last_body or {})

    def test_a_stale_rev_is_refused_rather_than_applied_to_a_row_never_seen(self):
        seen = self.dk.snapshot(TAB).rev
        self.dk.call(TAB, "set-lane", {"id": "01b7", "lane": "held"})  # a person moved on

        result = self.dk.call(TAB, "set-lane", {"id": "01b7", "lane": "doing"}, rev=seen)
        self.assertFalse(result.ok)
        self.assertEqual(result.refused, "stale")
        self.assertIn("read again", result.hint or "")

    def test_a_non_2xx_status_raises_even_when_the_body_looks_like_a_result(self):
        # The status contract: a refusal arrives as 200 with ok:false, and a
        # relay must not use 4xx to mean "the app said no". Honouring such a
        # body would quietly bless the conflation the contract forbids — and
        # the two want opposite handling, retry-elsewhere versus
        # rephrase-and-retry, so a client that cannot tell them apart will do
        # the wrong one.
        self.relay.mode = "refusal-on-409"
        with self.assertRaises(TransportError):
            self.dk.call(TAB, "set-lane", {"id": "01a2", "lane": "held"})

    def test_a_tab_id_is_escaped_rather_than_pasted_into_the_path(self):
        # A tab id is minted by the tab, so its characters are not this client's
        # to assume, and it is a capability besides — building the path by
        # concatenation is how a caller ends up addressing a tab it did not name.
        result = self.dk.call("a/b", "scroll")
        self.assertIn("/dk/tabs/a%2Fb/call", self.relay.hits)
        self.assertEqual(result.relay_refusal, "no-such-tab")


class TransportFailures(ClientTest):
    def test_an_unreachable_relay_raises_rather_than_returning_a_refusal(self):
        # There is no outcome to report: nothing ran and no tab was asked. A
        # synthetic `ok=False` here would be indistinguishable from the app
        # saying no, which is the one distinction a caller must not lose.
        dk = Driverkit("http://127.0.0.1:1", timeout=2)
        with self.assertRaises(TransportError):
            dk.tabs()
        with self.assertRaises(TransportError):
            dk.call(TAB, "scroll")

    def test_an_http_error_with_no_result_in_the_body_raises(self):
        self.relay.mode = "500"
        with self.assertRaises(TransportError):
            self.dk.snapshot(TAB)

    def test_a_body_that_is_not_json_raises_protocol_error_not_transport_error(self):
        # Separated because the two mean different things to a caller: a
        # TransportError is worth retrying and a ProtocolError means the thing
        # answering is not a driverkit relay.
        self.relay.mode = "garbage"
        with self.assertRaises(ProtocolError):
            self.dk.snapshot(TAB)

    def test_json_of_the_wrong_shape_raises_instead_of_parsing_to_empty(self):
        # A Snapshot defaulting to `where="" rev=0` would be handed to a model as
        # if it were a screen. Better to fail where the mistake is.
        self.relay.mode = "wrong-shape"
        with self.assertRaises(ProtocolError):
            self.dk.manifest(TAB)


class VerbKinds(ClientTest):
    """`kind` is what tells an agent a call is irreversible before it makes it."""

    def test_the_manifest_carries_each_verbs_kind(self):
        manifest = self.dk.manifest(TAB)
        self.assertEqual(manifest.verb("scroll").kind, "read")
        self.assertEqual(manifest.verb("select-where").kind, "describe")
        self.assertEqual(manifest.verb("set-lane").kind, "commit")

    def test_a_verb_with_no_kind_stays_unknown_rather_than_being_guessed(self):
        # Both defaults are wrong in a way that costs something. Reading it as
        # `read` tells an agent an irreversible verb is free to try; reading it
        # as `commit` marks every verb of an app written before the field
        # existed as dangerous, and a warning on everything is a warning on
        # nothing. Absent means absent.
        self.assertIsNone(self.dk.manifest(TAB).verb("refresh").kind)

    def test_an_unrecognised_kind_is_dropped_rather_than_trusted(self):
        # A future fourth kind means this client is out of date. Passing a word
        # it does not understand through to a model as if it were a safety
        # claim is the one thing it must not do.
        from driverkit.types import VerbSpec

        self.assertIsNone(VerbSpec.from_dict({"name": "x", "describe": "d", "kind": "nuke"}).kind)

    def test_the_describe_commit_pairing_is_expressible_over_the_wire(self):
        # The pairing rule that makes bulk work safe: the describe verb takes
        # the predicate and reports the count, the commit verb takes no
        # predicate and acts on the selection. Two calls, so a count is always
        # seen before data moves.
        manifest = self.dk.manifest(TAB)
        self.assertEqual(manifest.verb("select-where").args["lane"].type, "string")
        self.assertEqual(manifest.verb("accept-selected").args, {})
        self.assertEqual(manifest.verb("accept-selected").kind, "commit")


class Counts(ClientTest):
    def test_a_describe_verb_reports_a_count_of_what_it_matched(self):
        result = self.dk.call(TAB, "select-where", {"lane": "pruning"})
        self.assertTrue(result.ok)
        # The number a human would have to see before pressing a bulk button.
        self.assertEqual(result.count, 1)
        self.assertEqual(result.note, "1 selected of 1 matching")
        self.assertEqual((result.snapshot or Snapshot("", 0)).selected, ("01a2",))

    def test_count_reports_what_matched_not_what_fitted_under_a_limit(self):
        # A client that read `count` as "how many I selected" would report a
        # limit's worth and hide the real size of the match, which is the one
        # number the limit exists to protect against.
        result = self.dk.call(TAB, "select-where", {"lane": "doing", "limit": 0})
        self.assertEqual(result.count, 1)
        self.assertIsNone((result.snapshot or Snapshot("", 0)).selected)

    def test_a_verb_that_matches_nothing_still_reports_a_count(self):
        result = self.dk.call(TAB, "select-where", {"lane": "held"})
        self.assertEqual(result.count, 0)

    def test_count_is_read_only_from_a_successful_result(self):
        # `count` is ok:true territory in the type. A refusal carrying one is a
        # relay doing something undefined, and taking its word for it would put
        # a number in front of a model that nothing stands behind.
        self.assertIsNone(Result.from_dict({"ok": False, "refused": "no", "count": 9}).count)
        self.assertIsNone(Result.from_dict({"ok": True, "count": True}).count)
        self.assertEqual(Result.from_dict({"ok": True, "count": 7}).to_dict()["count"], 7)

    def test_a_verb_that_matched_nothing_differs_from_one_that_counted_nothing(self):
        # count=0 and count absent are different claims: "I looked and found
        # none" versus "I do not report counts". Collapsing them would let a
        # model conclude a read verb had matched zero rows.
        self.assertEqual(Result.from_dict({"ok": True, "count": 0}).count, 0)
        self.assertIsNone(Result.from_dict({"ok": True}).count)


class RelayRefusals(ClientTest):
    """A call that never reached a tab is a third thing, neither an app refusal
    nor a transport failure."""

    def test_no_such_tab_arrives_as_a_result_with_no_snapshot(self):
        result = self.dk.call("ghost-tab", "scroll")
        # Returned, not raised: it is an ordinary WireResult body.
        self.assertFalse(result.ok)
        self.assertEqual(result.refused, "no-such-tab")
        # And the snapshot is absent, never an invented empty one — a blank
        # table would tell an agent the app has no rows.
        self.assertIsNone(result.snapshot)
        self.assertEqual(result.relay_refusal, "no-such-tab")
        self.assertFalse(result.landed)

    def test_an_apps_own_refusal_is_not_mistaken_for_a_relay_refusal(self):
        # The distinction a client must not lose: "your app said no" means
        # rephrase and retry, "your call never landed" means reconnect or pick
        # another tab. The present snapshot is what separates them.
        result = self.dk.call(TAB, "set-lane", {"id": "01a2", "lane": "held"})
        self.assertIsNone(result.relay_refusal)
        self.assertTrue(result.landed)
        self.assertIsNotNone(result.snapshot)

    def test_a_timeout_is_not_a_promise_the_call_did_not_happen(self):
        # The tab may have run the verb and died before answering. Unknown is
        # not failed, and collapsing the two is how a bulk accept gets made
        # twice.
        self.relay.mode = "timeout"
        result = self.dk.call(TAB, "accept-selected")
        self.assertEqual(result.relay_refusal, "timeout")
        self.assertTrue(result.outcome_unknown)
        self.assertTrue(result.landed, "a timeout was treated as proof nothing ran")

    def test_tab_went_away_is_unknown_too_because_a_stream_can_close_late(self):
        # It reads like a clean failure and is not one. The call was accepted,
        # the verb may have run, and the answer died with the stream — so it
        # sits in the same bucket as `timeout`, not beside `no-such-tab`.
        self.relay.mode = "tab-went-away"
        result = self.dk.call(TAB, "accept-selected")
        self.assertEqual(result.relay_refusal, "tab-went-away")
        self.assertTrue(result.outcome_unknown)
        self.assertTrue(result.landed, "a closed stream was treated as proof nothing ran")

    def test_only_no_such_tab_proves_the_call_did_not_happen(self):
        # The whole closed set at once, because the classification is the point
        # and it is one line of code to get backwards. `no-such-tab` was never
        # forwarded — there was nowhere to forward it. The other two were
        # accepted and went unanswered.
        verdicts = {}
        for slug in ("no-such-tab", "tab-went-away", "timeout"):
            result = Result.from_dict({"ok": False, "refused": slug})
            verdicts[slug] = (result.landed, result.outcome_unknown)
        self.assertEqual(
            verdicts,
            {
                "no-such-tab": (False, False),
                "tab-went-away": (True, True),
                "timeout": (True, True),
            },
        )

    def test_a_reserved_core_refusal_is_not_a_relay_refusal(self):
        # `stale`, `unknown-verb`, `bad-argument`, `unmounted` and `threw` are
        # reserved alongside the relay's three, but they come from the app's
        # own driver and arrive WITH a screen. Reading one as "your call never
        # landed" would send an agent off to reconnect when all it has to do is
        # read again.
        for slug in ("stale", "unknown-verb", "bad-argument", "unmounted", "threw"):
            result = Result.from_dict(
                {"ok": False, "refused": slug, "snapshot": {"where": "x", "rev": 1}}
            )
            self.assertIsNone(result.relay_refusal, slug)
            self.assertTrue(result.landed, slug)
            self.assertFalse(result.outcome_unknown, slug)

    def test_a_missing_snapshot_alone_is_enough_to_flag_a_relay_refusal(self):
        # Both documented signals are accepted, because requiring both means
        # one sloppy relay turns "your call never landed" into "your app said
        # no" — the most expensive confusion this client can make.
        result = Result.from_dict({"ok": False, "refused": "something-new"})
        self.assertEqual(result.relay_refusal, "something-new")


class Watching(ClientTest):
    """`GET /dk/tabs/:tab/watch` — the agent's end of the snapshot push frame."""

    def test_watch_yields_a_snapshot_per_frame_and_ends_with_the_stream(self):
        self.relay.watch_frames = [snapshot_frame("descent 01a2", 8), snapshot_frame("descents", 9)]
        screens = list(self.dk.watch(TAB))
        self.assertEqual([(s.where, s.rev) for s in screens], [("descent 01a2", 8), ("descents", 9)])
        # It ends rather than reconnecting: an agent that reconnects silently
        # can watch a screen for minutes after the tab it cared about went
        # away, and "the stream ended" is something its caller needs to know.

    def test_watch_ignores_the_keepalive_comments(self):
        # The 20s ping is an SSE comment line, which exists to stop a proxy
        # closing an idle stream. Delivering it as data would hand the caller a
        # junk snapshot every twenty seconds.
        self.relay.watch_frames = [": ping\n\n", snapshot_frame("descents", 2), ": ping\n\n"]
        self.assertEqual([s.rev for s in self.dk.watch(TAB)], [2])

    def test_watch_skips_a_frame_it_does_not_recognise_instead_of_dying(self):
        # Unknown frames are ignored by contract, so a field or a frame type
        # can be added without a version bump. A watcher that raised on one
        # would turn that additive promise into an outage.
        self.relay.watch_frames = [
            'data: {"t":"something-new","x":1}\n\n',
            "data: not json at all\n\n",
            snapshot_frame("descents", 5),
        ]
        self.assertEqual([s.rev for s in self.dk.watch(TAB)], [5])

    def test_watch_joins_a_frame_split_across_several_data_lines(self):
        # SSE allows it and the values join with newlines. A parser that kept
        # only the last line would silently truncate the first payload large
        # enough to be split.
        self.relay.watch_frames = ['data: {"t":"snapshot","snapshot":\ndata: {"where":"x","rev":4}}\n\n']
        self.assertEqual([s.rev for s in self.dk.watch(TAB)], [4])

    def test_watch_drops_an_unterminated_final_frame(self):
        # A half-written snapshot is not a screen.
        self.relay.watch_frames = [snapshot_frame("descents", 3), 'data: {"t":"snap']
        self.assertEqual([s.rev for s in self.dk.watch(TAB)], [3])

    def test_watch_raises_a_transport_error_rather_than_ending_quietly(self):
        # An empty iterator and a dead relay look identical to a caller, and
        # only one of them means "the person stopped clicking".
        dk = Driverkit("http://127.0.0.1:1", timeout=2)
        with self.assertRaises(TransportError):
            list(dk.watch(TAB))

    def test_watch_asks_for_an_event_stream_and_tells_proxies_not_to_cache(self):
        # Both headers earn their place: a relay may serve JSON or SSE off the
        # same router, and a caching proxy that holds a frame back makes a live
        # stream arrive in bursts, which is worse than polling.
        self.relay.watch_frames = [snapshot_frame("descents", 1)]
        list(self.dk.watch(TAB))
        self.assertEqual(self.relay.last_headers["accept"], "text/event-stream")
        self.assertEqual(self.relay.last_headers["cache-control"], "no-cache")


if __name__ == "__main__":
    unittest.main()
