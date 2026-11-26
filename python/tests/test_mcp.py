"""
The specification for the MCP server. The first group is the one that matters:
it pins that the tool list is derived from the manifest, because a regression
there would be invisible — a hardcoded tool list works perfectly until the app
changes, and then it lies.

Each name states the decision it pins; comments say why a rule exists rather
than restating what the line does.
"""

from __future__ import annotations

import io
import json
import unittest

import os
import sys

# src layout, run without installing: `uv run python -m unittest discover -s
# tests -t tests` works from a checkout, which is what a contributor does
# before the package exists on an index.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit import Driverkit, Manifest
from driverkit.types import VerbSpec
from driverkit.mcp_server import (
    LIST_TABS,
    PROTOCOL_VERSION,
    READ_SCREEN,
    McpServer,
    tools_for,
    verb_tool,
)

from fake_relay import MANIFEST, TAB, FakeRelay


def tool(tools, name):
    return next(t for t in tools if t["name"] == name)


class Translation(unittest.TestCase):
    """manifest → MCP tool list. No relay needed: this is a pure function."""

    def setUp(self) -> None:
        self.manifest = Manifest.from_dict(MANIFEST)
        self.tools = tools_for(self.manifest)

    def test_every_verb_in_the_manifest_becomes_exactly_one_tool(self):
        # The reason this library exists. A hardcoded tool list is a second copy
        # of the app's capabilities that drifts the first time an argument is
        # added, and nothing in the running system notices.
        verb_names = [v["name"] for v in MANIFEST["verbs"]]
        self.assertEqual([t["name"] for t in self.tools[: len(verb_names)]], verb_names)
        self.assertEqual(len(self.tools), len(verb_names) + 2)

    def test_a_verb_this_code_has_never_heard_of_still_becomes_a_tool(self):
        # The sharpest form of the rule: a verb invented after this file was
        # written must work with no change here.
        invented = Manifest.from_dict(
            {
                "version": "v",
                "app": "later",
                "verbs": [
                    {
                        "name": "teleport",
                        "describe": "a verb that did not exist when the server was written",
                        "args": {"to": {"type": "string", "describe": "where"}},
                    }
                ],
            }
        )
        teleport = tool(tools_for(invented), "teleport")
        self.assertIn("did not exist", teleport["description"])
        self.assertEqual(teleport["inputSchema"]["required"], ["to"])

    def test_oneof_becomes_a_json_schema_enum_and_not_a_json_schema_oneof(self):
        # The two names look alike and mean different things. The core's `oneOf`
        # is a set of permitted scalars, which is `enum`; JSON Schema's `oneOf`
        # is a set of subschemas, and emitting that would produce a schema that
        # validates anything at all.
        lane = tool(self.tools, "set-lane")["inputSchema"]["properties"]["lane"]
        self.assertEqual(lane["enum"], ["doing", "pruning", "held"])
        self.assertNotIn("oneOf", lane)
        self.assertEqual(lane["type"], "string")
        # The description is the only thing telling a model what a lane IS.
        self.assertEqual(lane["description"], "target lane")

    def test_an_optional_arg_is_omitted_from_required_rather_than_flagged(self):
        # `"optional": true` in a property is ignored by every JSON Schema
        # validator, so an argument marked that way would silently stay
        # mandatory. Omission from `required` is how the schema says it.
        schema = tool(self.tools, "set-lane")["inputSchema"]
        self.assertIn("because", schema["properties"])
        self.assertNotIn("because", schema["required"])
        self.assertEqual(sorted(schema["required"]), ["id", "lane"])
        self.assertNotIn("optional", schema["properties"]["because"])

    def test_the_three_arg_types_map_to_json_schema_types(self):
        self.assertEqual(
            tool(self.tools, "set-zoom")["inputSchema"]["properties"]["factor"]["type"],
            "number",
        )

    def test_a_verb_with_no_args_gets_an_object_schema_not_a_missing_one(self):
        # MCP clients validate against inputSchema; a tool without one is a tool
        # some clients refuse to offer.
        schema = tool(self.tools, "scroll")["inputSchema"]
        self.assertEqual(schema["type"], "object")
        self.assertEqual(schema["required"], [])

    def test_the_refuses_list_reaches_the_tool_description(self):
        # `refuses` lives in the cached half precisely so a well-briefed agent
        # declines to make a call that was always going to be declined. Leaving
        # it out of the description means it learns by making the call, which is
        # the round trip the field exists to avoid.
        description = tool(self.tools, "set-lane")["description"]
        self.assertIn("machine-may-not-leave-pruning", description)
        self.assertIn("no-such-descent", description)
        self.assertIn("move a descent to a lane", description)
        # And it is framed as an ordinary answer, so the model adjusts rather
        # than retrying the identical call.
        self.assertIn("not an error", description)

    def test_a_verb_that_refuses_nothing_says_nothing_about_refusals(self):
        # An empty "May refuse:" line is prompt bytes that carry no information,
        # and it is paid for on every cached turn.
        self.assertNotIn("May refuse", tool(self.tools, "scroll")["description"])

    def test_every_verb_description_says_the_screen_comes_back_with_the_result(self):
        # Otherwise the model's next move is to read a screen it was just given,
        # which spends the round trip that Result's shape was designed to save.
        for verb in MANIFEST["verbs"]:
            self.assertIn("AFTER this runs", tool(self.tools, verb["name"])["description"])

    def test_rev_is_hoisted_into_every_verb_schema_as_an_optional_property(self):
        # `rev` is a field of the call frame, not an app argument, so a model has
        # nowhere to put it unless the schema offers it. Optional, because
        # omitting it is the documented way to opt out of the staleness check.
        schema = tool(self.tools, "goto")["inputSchema"]
        self.assertEqual(schema["properties"]["rev"]["type"], "integer")
        self.assertNotIn("rev", schema["required"])
        self.assertIn("stale", schema["properties"]["rev"]["description"])

    def test_an_apps_own_rev_argument_wins_over_the_hoisted_one(self):
        # If the app named an argument `rev` it means something in that app, and
        # overwriting it would silently change what the verb does.
        manifest = Manifest.from_dict(
            {
                "version": "v",
                "app": "git",
                "verbs": [
                    {
                        "name": "checkout",
                        "describe": "check out a revision",
                        "args": {"rev": {"type": "string", "describe": "a git rev"}},
                    }
                ],
            }
        )
        schema = tool(tools_for(manifest), "checkout")["inputSchema"]
        self.assertEqual(schema["properties"]["rev"]["description"], "a git rev")
        self.assertEqual(schema["required"], ["rev"])

    def test_screen_is_hoisted_into_every_verb_schema_like_rev(self):
        # `screen` is a field of the call frame, not an app argument, so a model
        # has nowhere to put it unless the schema offers it. It catches what
        # `rev` does not: a call that lands on a screen the agent never saw and
        # answers `ok`, which is a different mistake from "the number moved" and
        # has a different fix.
        schema = tool(self.tools, "goto")["inputSchema"]
        self.assertEqual(schema["properties"]["screen"]["type"], "string")
        self.assertNotIn("screen", schema["required"])
        self.assertIn("wrong-screen", schema["properties"]["screen"]["description"])

    def test_an_apps_own_screen_argument_wins_over_the_hoisted_one(self):
        # `go(screen)` is the navigation verb of a real app, so this is the one
        # place where taking the name would break an app's own vocabulary. The
        # same rule as `rev`: the app's meaning wins.
        manifest = Manifest.from_dict(
            {
                "version": "v",
                "app": "nav",
                "verbs": [
                    {
                        "name": "go",
                        "describe": "go to one of the app's screens",
                        "args": {
                            "screen": {
                                "type": "string",
                                "describe": "which screen",
                                "oneOf": ["contacts", "settings"],
                            }
                        },
                    }
                ],
            }
        )
        schema = tool(tools_for(manifest), "go")["inputSchema"]
        self.assertEqual(schema["properties"]["screen"]["enum"], ["contacts", "settings"])
        self.assertEqual(schema["required"], ["screen"])

    def test_a_verbs_screen_is_in_its_description_so_the_call_is_never_made(self):
        # The same argument `refuses` is in the description for: the point of
        # declaring where a verb lives is that a well-briefed model does not
        # call it from somewhere else and then have to recover. The tool list
        # itself does NOT vary with the live screen — that would bust the prompt
        # prefix on every navigation, which is the cost argument.
        manifest = Manifest.from_dict(
            {
                "version": "v",
                "app": "scoped",
                "verbs": [
                    {"name": "next-page", "kind": "read", "describe": "page", "screen": "contacts"},
                    {"name": "clear", "kind": "describe", "describe": "deselect everything"},
                ],
            }
        )
        tools = tools_for(manifest)
        self.assertIn("ONLY ON THE `contacts` SCREEN", tool(tools, "next-page")["description"])
        self.assertIn("refused as `wrong-screen`", tool(tools, "next-page")["description"])
        # A verb that works anywhere says nothing about screens: "works
        # everywhere" on twelve of eighteen verbs is prose nobody reads.
        self.assertNotIn("SCREEN", tool(tools, "clear")["description"])
        # And both verbs are offered, whatever screen the app is on.
        self.assertEqual([t["name"] for t in tools][:2], ["next-page", "clear"])

    def test_a_reversible_commit_reads_differently_from_one_that_cannot_be_undone(self):
        # The failure this exists for: changing a page size and accepting 3,412
        # contacts were both getting *** THIS CHANGES DATA AND MAY BE
        # IRREVERSIBLE ***, and a banner that shows up on a page-size change is
        # a banner a model learns to read past — the same way a person learns to
        # click Yes without reading.
        manifest = Manifest.from_dict(
            {
                "version": "v",
                "app": "scoped",
                "verbs": [
                    {
                        "name": "set-setting",
                        "kind": "commit",
                        "reversible": True,
                        "describe": "turn dense rows on",
                    },
                    {"name": "accept", "kind": "commit", "describe": "accept the selection"},
                ],
            }
        )
        tools = tools_for(manifest)
        undoable = tool(tools, "set-setting")["description"]
        self.assertIn("COMMIT (reversible): this changes data", undoable)
        self.assertIn("can be undone", undoable)
        self.assertNotIn("MAY BE IRREVERSIBLE", undoable)
        # It still says the data changes and the person still sees it:
        # reversible is a claim that there is a way back, not that nobody minds.
        self.assertIn("a change the person will see", undoable)
        # And the irreversible one keeps every asterisk.
        self.assertIn(
            "*** COMMIT: THIS CHANGES DATA AND MAY BE IRREVERSIBLE. ***",
            tool(tools, "accept")["description"],
        )

    def test_reversible_changes_the_description_and_nothing_else(self):
        # Scoped deliberately narrowly: the flag is a sentence in the cached
        # half and an input to a host's confirmation gate. It is not an
        # argument, not a refusal, and it does not touch the schema — a commit
        # is still a commit. On a verb that changes no data it says nothing at
        # all, because there it is a claim about nothing.
        plain = verb_tool(VerbSpec(name="act", describe="act", kind="commit"))
        undoable = verb_tool(VerbSpec(name="act", describe="act", kind="commit", reversible=True))
        self.assertEqual(undoable["inputSchema"], plain["inputSchema"])
        self.assertNotEqual(undoable["description"], plain["description"])

        read = verb_tool(VerbSpec(name="look", describe="look", kind="read", reversible=True))
        self.assertNotIn("reversible", read["description"])
        self.assertIn("READ-ONLY", read["description"])

    def test_the_two_fixed_tools_are_present_and_are_not_verbs(self):
        # read_screen and list_tabs are the protocol's own reads, not app
        # features. No app should have to declare them to be drivable.
        names = [t["name"] for t in self.tools]
        self.assertIn(READ_SCREEN, names)
        self.assertIn(LIST_TABS, names)
        self.assertNotIn(READ_SCREEN, [v["name"] for v in MANIFEST["verbs"]])

    def test_read_screen_warns_that_the_agent_sees_only_what_the_person_sees(self):
        # The most expensive wrong conclusion an agent can reach from a snapshot
        # is "that record does not exist" when it is merely on another page.
        description = tool(self.tools, READ_SCREEN)["description"]
        self.assertIn("off screen", description)

    def test_a_verb_named_like_a_fixed_tool_is_not_shadowed(self):
        manifest = Manifest.from_dict(
            {"version": "v", "app": "odd", "verbs": [{"name": READ_SCREEN, "describe": "the app's own"}]}
        )
        tools = tools_for(manifest)
        self.assertEqual(len([t for t in tools if t["name"] == READ_SCREEN]), 1)
        self.assertEqual(tool(tools, READ_SCREEN)["description"].split("\n")[0], "the app's own")

    def test_an_unknown_arg_type_fails_loudly_instead_of_passing_through(self):
        # The core's three types are a closed set. A fourth means this file is
        # out of date, and a schema no client validates is worse than a crash at
        # startup.
        from driverkit.types import ArgSpec, VerbSpec

        with self.assertRaises(ValueError):
            verb_tool(VerbSpec("x", "d", {"a": ArgSpec(type="date", describe="d")}))


class Serving(unittest.TestCase):
    def setUp(self) -> None:
        self.relay = FakeRelay()
        self.addCleanup(self.relay.stop)
        self.server = McpServer(Driverkit(self.relay.url), TAB)

    def call(self, method, params=None, message_id=1):
        return self.server.handle(
            {"jsonrpc": "2.0", "id": message_id, "method": method, "params": params or {}}
        )

    def text(self, reply):
        return reply["result"]["content"][0]["text"]

    def test_initialize_states_the_version_this_server_speaks(self):
        result = self.call("initialize", {"protocolVersion": "1999-01-01"})["result"]
        # Not echoed back: the spec has the server state what it actually
        # speaks and lets the client disconnect if that will not do.
        self.assertEqual(result["protocolVersion"], PROTOCOL_VERSION)
        self.assertIn("toy", result["serverInfo"]["name"])
        self.assertIn("read_screen", result["instructions"])

    def test_tools_list_comes_from_the_live_manifest(self):
        tools = self.call("tools/list")["result"]["tools"]
        verbs = [v["name"] for v in MANIFEST["verbs"]]
        self.assertEqual([t["name"] for t in tools][: len(verbs)], verbs)

    def test_the_manifest_is_fetched_once_and_the_snapshot_every_time(self):
        # The static half is cacheable by contract; the dynamic half is not,
        # because a person at the keyboard can move the screen between any two
        # calls. Caching them the same way is the cost argument reversed.
        self.call("tools/list")
        self.call("tools/list")
        self.call("tools/call", {"name": READ_SCREEN})
        self.call("tools/call", {"name": READ_SCREEN})
        self.assertEqual(self.relay.hits[f"/dk/tabs/{TAB}/manifest"], 1)
        self.assertEqual(self.relay.hits[f"/dk/tabs/{TAB}/snapshot"], 2)

    def test_read_screen_renders_the_screen_as_text_not_json(self):
        text = self.text(self.call("tools/call", {"name": READ_SCREEN}))
        # JSON spends a large share of an uncached, re-read-every-turn payload on
        # punctuation and on repeating each column name per row.
        self.assertNotIn("{", text)
        self.assertIn("where: descents (rev 1)", text)
        self.assertIn("01a2", text)
        self.assertIn("lane", text)
        self.assertIn("rows 1-1 of 2", text)
        # Said in words, because "of 2" alone reads to a model as "I have both".
        self.assertIn("more rows exist off screen", text)

    def test_a_verb_result_carries_the_post_call_snapshot_not_just_ok(self):
        reply = self.call("tools/call", {"name": "goto", "arguments": {"id": "01b7"}})
        text = self.text(reply)
        self.assertTrue(text.startswith("ok"))
        # Throwing the snapshot away would make the model read the screen it was
        # just handed — the exact round trip Result's shape exists to save.
        self.assertIn("where: descent 01b7 (rev 2)", text)
        self.assertIn("selected: 01b7", text)
        self.assertFalse(reply["result"]["isError"])

    def test_a_refusal_is_rendered_as_an_answer_and_is_not_an_mcp_error(self):
        reply = self.call(
            "tools/call", {"name": "set-lane", "arguments": {"id": "01a2", "lane": "held"}}
        )
        # isError in MCP means the tool could not run. This one ran and the
        # answer was no, which is information the model must act on; flagging it
        # invites a client to hide it or a model to retry unchanged.
        self.assertFalse(reply["result"]["isError"])
        text = self.text(reply)
        self.assertIn("refused: machine-may-not-leave-pruning", text)
        self.assertIn("human gate", text)
        # The screen is still shown, so the agent can see nothing moved.
        self.assertIn("01a2", text)
        self.assertIn("pruning", text)

    def test_rev_is_pulled_out_of_the_arguments_and_sent_as_the_staleness_claim(self):
        self.call("tools/call", {"name": "goto", "arguments": {"id": "01b7", "rev": 1}})
        body = self.relay.last_body or {}
        # It travels in the call frame, beside name and args, never inside args
        # — a verb handed an argument it never declared would ignore it and the
        # staleness check would silently never happen.
        self.assertEqual(body["rev"], 1)
        self.assertEqual(body["args"], {"id": "01b7"})

    def test_screen_is_pulled_out_of_the_arguments_and_sent_as_the_screen_claim(self):
        # It travels in the call frame, beside `name`, `args` and `rev`, never
        # inside `args` — a verb handed an argument it never declared would
        # ignore it, and the check would silently never happen. Junk is dropped
        # rather than sent: a number is not a screen id, and this path has no
        # screen in hand to quote back at the model.
        self.call(
            "tools/call", {"name": "goto", "arguments": {"id": "01b7", "screen": "descents"}}
        )
        body = self.relay.last_body or {}
        self.assertEqual(body["screen"], "descents")
        self.assertEqual(body["args"], {"id": "01b7"})

        self.call("tools/call", {"name": "goto", "arguments": {"id": "01b7", "screen": 7}})
        body = self.relay.last_body or {}
        self.assertNotIn("screen", body)
        self.assertEqual(body["args"], {"id": "01b7"})

    def test_a_stale_rev_from_the_model_comes_back_as_a_refusal_it_can_read(self):
        self.call("tools/call", {"name": "scroll"})  # the screen moves on
        text = self.text(self.call("tools/call", {"name": "goto", "arguments": {"id": "01b7", "rev": 1}}))
        self.assertIn("refused: stale", text)
        self.assertIn("read again", text)

    def test_list_tabs_names_the_tab_this_server_drives(self):
        # The point of the tool is answering "which one?", so it has to say which
        # one it is already holding.
        text = self.text(self.call("tools/call", {"name": LIST_TABS}))
        self.assertIn("Descents — toy", text)
        self.assertIn("other-tab", text)
        self.assertIn("this server drives this one", text)

    def test_an_unknown_tool_is_an_mcp_error_that_names_what_exists(self):
        reply = self.call("tools/call", {"name": "park"})
        self.assertTrue(reply["result"]["isError"])
        self.assertIn("set-lane", self.text(reply))

    def test_a_transport_failure_is_a_jsonrpc_error_not_a_tool_result(self):
        # Nothing ran, so there is no outcome to report to the model. Rendering
        # it as tool text would make a dead relay look like the app saying no.
        broken = McpServer(Driverkit("http://127.0.0.1:1", timeout=2), TAB)
        reply = broken.handle({"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
        self.assertEqual(reply["error"]["code"], -32603)
        self.assertIn("unreachable", reply["error"]["message"])

    def test_a_notification_gets_no_reply_at_all(self):
        # A JSON-RPC notification has no id and must get no response. Answering
        # one hangs clients, which see a reply they have no request for.
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "method": "whatever/unknown"}))

    def test_an_unknown_method_with_an_id_is_method_not_found(self):
        self.assertEqual(self.call("tools/unheard-of")["error"]["code"], -32601)

    def test_ping_is_answered_because_clients_use_it_as_a_liveness_check(self):
        self.assertEqual(self.call("ping")["result"], {})


class Stdio(unittest.TestCase):
    def setUp(self) -> None:
        self.relay = FakeRelay()
        self.addCleanup(self.relay.stop)

    def test_the_stdio_loop_speaks_newline_delimited_jsonrpc(self):
        stdin = io.StringIO(
            "\n".join(
                [
                    json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
                    json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                    "",  # blank lines happen and are not an error
                    json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                ]
            )
            + "\n"
        )
        stdout = io.StringIO()
        McpServer(Driverkit(self.relay.url), TAB).serve(stdin, stdout)

        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        # Two in, two out: the notification produced nothing, and the ids line up
        # in order so a client can match them.
        self.assertEqual([r["id"] for r in replies], [1, 2])

    def test_an_unparseable_line_is_a_parse_error_and_does_not_kill_the_loop(self):
        stdin = io.StringIO('{"not json\n' + json.dumps({"jsonrpc": "2.0", "id": 5, "method": "ping"}) + "\n")
        stdout = io.StringIO()
        McpServer(Driverkit(self.relay.url), TAB).serve(stdin, stdout)

        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(replies[0]["error"]["code"], -32700)
        self.assertEqual(replies[1]["id"], 5)


class Kinds(unittest.TestCase):
    """`kind` in the tool description. This is the difference between a call
    that is free to try and one that is irreversible, and nothing else in an
    MCP tool definition can say it."""

    def setUp(self) -> None:
        self.tools = tools_for(Manifest.from_dict(MANIFEST))

    def test_a_commit_verb_is_unmistakable(self):
        # The failure mode this exists for: asked to "select the top 1000 rows
        # and bulk accept", an agent that cannot tell `select` from `accept`
        # discovers the difference by doing it, and the discovery costs a
        # thousand accepted rows. A screenshot cannot tell them apart, and
        # neither can an OpenAPI spec, which says what a call takes and not
        # what it costs you.
        description = tool(self.tools, "accept-selected")["description"]
        self.assertIn("COMMIT", description)
        self.assertIn("IRREVERSIBLE", description)
        self.assertIn("CHANGES DATA", description)

    def test_the_kind_comes_before_the_mechanical_notes(self):
        # A model skimming the first lines of a description must not be able to
        # miss that a verb commits, so the kind sits straight after what the
        # verb does and ahead of everything about results and refusals.
        paragraphs = tool(self.tools, "set-lane")["description"].split("\n\n")
        self.assertEqual(paragraphs[0], "move a descent to a lane")
        self.assertIn("COMMIT", paragraphs[1])

    def test_a_commit_verb_is_pointed_at_the_describe_verb_that_counts_first(self):
        # The pairing rule is the thing that makes bulk work safe, and it is
        # useless if only the library knows it.
        description = tool(self.tools, "accept-selected")["description"]
        self.assertIn("`describe` verb first", description)
        self.assertIn("count", description)

    def test_a_read_verb_is_declared_free_to_call(self):
        # Worth saying explicitly: an agent that treats every verb as dangerous
        # asks a human before scrolling, and a human who is asked about
        # scrolling stops reading the questions.
        description = tool(self.tools, "scroll")["description"]
        self.assertIn("READ-ONLY", description)
        # No DATA and no COUNT, and deliberately not "changes nothing": a
        # `read` may move the person's screen, which `scroll` does.
        self.assertIn("changes no data and reports no count", description)
        self.assertIn("navigating is a read", description)
        self.assertNotIn("COMMIT", description)

    def test_a_describe_verb_points_at_the_count_it_returns(self):
        description = tool(self.tools, "select-where")["description"]
        self.assertIn("DESCRIBE", description)
        self.assertIn("changes no data", description)
        self.assertIn("count", description)

    def test_a_verb_with_no_kind_gets_no_safety_claim_invented_for_it(self):
        # An app written before `kind` existed. Claiming either way would be
        # this server making up a guarantee the app never gave.
        description = tool(self.tools, "refresh")["description"]
        for word in ("COMMIT", "READ-ONLY", "DESCRIBE"):
            self.assertNotIn(word, description)
        self.assertIn("reload the board", description)

    def test_the_server_instructions_name_the_three_kinds(self):
        relay = FakeRelay()
        self.addCleanup(relay.stop)
        server = McpServer(Driverkit(relay.url), TAB)
        instructions = server.handle(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        )["result"]["instructions"]
        # Said once up front as well as per tool, because the per-tool note is
        # only read for the tool a model already decided to call.
        for word in ("READ-ONLY", "DESCRIBE", "COMMIT"):
            self.assertIn(word, instructions)
        self.assertIn("count", instructions)


class Counts(unittest.TestCase):
    def setUp(self) -> None:
        self.relay = FakeRelay()
        self.addCleanup(self.relay.stop)
        self.server = McpServer(Driverkit(self.relay.url), TAB)

    def call(self, name, arguments=None):
        reply = self.server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )
        return reply["result"]["content"][0]["text"]

    def test_a_count_is_rendered_on_its_own_line_near_the_top(self):
        text = self.call("select-where", {"lane": "pruning"})
        lines = text.splitlines()
        self.assertTrue(lines[0].startswith("ok"))
        self.assertTrue(lines[1].startswith("count: 1 matched"))

    def test_a_count_is_rendered_with_thousands_separators(self):
        # 1000 and 10000 look alike at a glance, and that glance is the one
        # that costs the most. Rendered directly, since the toy app cannot hold
        # a thousand descents.
        from driverkit import Result, Snapshot, render_result

        text = render_result(
            Result(ok=True, count=10000, snapshot=Snapshot(where="x", rev=1)), kind="describe"
        )
        self.assertIn("count: 10,000 matched", text)

    def test_the_count_is_framed_as_the_number_to_check_before_committing(self):
        # The whole reason describe and commit are separate verbs. A count the
        # model reads as trivia is a count it will not check.
        text = self.call("select-where", {"lane": "pruning"})
        self.assertIn("before committing", text)
        self.assertIn("commit verb", text)

    def test_a_verb_with_no_count_says_nothing_about_counts(self):
        self.assertNotIn("count:", self.call("scroll"))


class CallsThatNeverLanded(unittest.TestCase):
    """A relay refusal is neither the app saying no nor a dead relay."""

    def setUp(self) -> None:
        self.relay = FakeRelay()
        self.addCleanup(self.relay.stop)
        self.server = McpServer(Driverkit(self.relay.url), TAB)

    def reply(self, name, arguments=None):
        return self.server.handle(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )["result"]

    def test_a_timed_out_commit_says_the_outcome_is_unknown_and_not_to_retry(self):
        # The expensive case, and the reason PROTOCOL.md spells the semantics
        # out: the tab may have run the verb and died before answering. A
        # model told "that failed" retries, and a retried bulk accept accepts
        # a thousand rows twice.
        self.relay.mode = "timeout"
        text = self.reply("accept-selected")["content"][0]["text"]
        self.assertIn("timeout", text)
        self.assertIn("UNKNOWN", text)
        self.assertIn("DO NOT retry", text)
        self.assertIn("Read the screen first", text)

    def test_a_timed_out_read_verb_is_settled_by_reading_again(self):
        # Same slug, different advice, because the cost of being wrong is not
        # the same. Telling a model not to retry a scroll would strand it.
        self.relay.mode = "timeout"
        text = self.reply("scroll")["content"][0]["text"]
        self.assertIn("UNKNOWN", text)
        self.assertNotIn("DO NOT retry", text)
        self.assertIn("cheap and safe", text)

    def test_a_timeout_is_not_an_mcp_error_because_unknown_is_not_failed(self):
        # Clients commonly render an isError result as a failed step for the
        # model to retry. That is exactly the wrong move here, so the unknown
        # outcome comes back as an ordinary result whose text does the work.
        self.relay.mode = "timeout"
        self.assertFalse(self.reply("accept-selected")["isError"])

    def test_a_closed_stream_gets_the_same_do_not_retry_advice_for_a_commit(self):
        # `tab-went-away` reads like a clean failure and is not one: the stream
        # can close after the verb ran. Advising a retry here would double the
        # commit just as surely as advising it after a timeout.
        self.relay.mode = "tab-went-away"
        text = self.reply("accept-selected")["content"][0]["text"]
        self.assertIn("UNKNOWN", text)
        self.assertIn("DO NOT retry", text)

    def test_each_unknown_slug_says_why_in_its_own_words(self):
        # Same verdict, different next move: a tab that went quiet may answer
        # the next call, a tab whose connection closed may not be there at all.
        self.relay.mode = "timeout"
        self.assertIn("went quiet", self.reply("scroll")["content"][0]["text"])
        self.relay.mode = "tab-went-away"
        self.assertIn("connection then closed", self.reply("scroll")["content"][0]["text"])

    def test_only_no_such_tab_is_an_mcp_error(self):
        # isError means the tool could not run, and this is the one relay
        # refusal where that is true: nothing to reason about and nothing the
        # model can rephrase, so the next move is to list the tabs.
        self.relay.mode = "no-such-tab"
        no_such_tab = self.reply("scroll")
        self.assertTrue(no_such_tab["isError"])
        self.assertIn("never forwarded", no_such_tab["content"][0]["text"])

        # The other two are unknown, not failed, and a client that renders an
        # isError result as a failed step invites exactly the retry that
        # double-commits.
        for mode in ("timeout", "tab-went-away"):
            self.relay.mode = mode
            self.assertFalse(self.reply("accept-selected")["isError"], mode)

    def test_an_unknown_outcome_does_not_also_claim_nothing_ran(self):
        # The two sentences have to agree. "nothing ran and nobody looked" is
        # true of `no-such-tab` only, and under an unknown outcome it
        # contradicts the line above it — a model reading both believes the
        # reassuring one and retries the commit.
        self.relay.mode = "timeout"
        unknown = self.reply("accept-selected")["content"][0]["text"]
        self.assertNotIn("nothing ran", unknown)
        self.assertIn("no snapshot", unknown)

        self.relay.mode = "no-such-tab"
        never = self.reply("accept-selected")["content"][0]["text"]
        self.assertIn("nothing ran and nothing changed", never)

    def test_a_relay_refusal_never_renders_an_invented_empty_screen(self):
        # Its absence is the signal. A blank table would tell the model the app
        # has no rows, which is the one reading PROTOCOL.md forbids.
        self.relay.mode = "tab-went-away"
        text = self.reply("scroll")["content"][0]["text"]
        self.assertIn("no snapshot", text)
        self.assertNotIn("where:", text)

    def test_a_relay_refusal_reads_differently_from_an_apps_own_refusal(self):
        # An agent that reads `no-such-tab` as a business rule will rephrase
        # its arguments and try forever.
        app_said_no = self.reply("set-lane", {"id": "01a2", "lane": "held"})["content"][0]["text"]
        self.relay.mode = "tab-went-away"
        never_landed = self.reply("scroll")["content"][0]["text"]
        self.assertTrue(app_said_no.startswith("refused:"))
        self.assertTrue(never_landed.startswith("the call did not complete:"))


if __name__ == "__main__":
    unittest.main()


class SharedCore(unittest.TestCase):
    """Both MCP servers must expose the same tools, so there is one generator."""

    def test_the_stdio_server_re_exports_the_shared_generator_rather_than_its_own(self):
        # Two servers ship in this package: the hand-rolled stdio one, which has
        # no dependencies and is the path that runs today, and the FastMCP one,
        # which needs an optional extra. A tool list written twice is two tool
        # lists, and the second is wrong the first time somebody adds a verb
        # kind — so this pins that there is one.
        from driverkit import mcp_core, mcp_server

        self.assertIs(mcp_server.tools_for, mcp_core.tools_for)
        self.assertIs(mcp_server.verb_tool, mcp_core.verb_tool)
        self.assertIs(mcp_server.arg_schema, mcp_core.arg_schema)
        self.assertIs(mcp_server.READ_SCREEN, mcp_core.READ_SCREEN)

    def test_the_instructions_a_client_is_given_come_from_one_place_too(self):
        # Half the safety story is in that text: read the screen before acting,
        # quote the `rev` back, COMMIT changes data. Two copies would be two
        # safety stories, and the one that drifts is the one nobody is reading
        # when it matters.
        from driverkit.mcp_core import instructions_for

        manifest = Manifest.from_dict(MANIFEST)
        relay = FakeRelay()
        self.addCleanup(relay.stop)
        server = McpServer(Driverkit(relay.url), TAB)
        reply = server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertEqual(reply["result"]["instructions"], instructions_for(manifest))

    def test_the_apps_own_briefing_reaches_the_mcp_instructions_after_the_safety_rules(self):
        # The gap this closes is the one place the two halves of driverkit
        # disagreed. A widget could be handed `instructions` through `drive()`;
        # an agent arriving here could not. So an app with something to say
        # about itself — "this app has screens, and `go` reaches those" — had to
        # repeat it in every snapshot's `note`, in the uncached half, paid for
        # on every turn, for a sentence that never changes.
        from driverkit.mcp_core import instructions_for

        briefed = Manifest.from_dict(
            dict(MANIFEST, instructions="this app has screens: descents and lanes.")
        )
        text = instructions_for(briefed)
        self.assertIn("this app has screens: descents and lanes.", text)
        # Last, not first: an app's own note is an addition to the safety rules
        # and not a replacement for them, and a client prepending this text has
        # a model read it in order.
        self.assertLess(
            text.index("Never commit on a selection"), text.index("this app has screens")
        )
        # And an app that says nothing gets exactly the text it got before the
        # field existed.
        self.assertEqual(instructions_for(Manifest.from_dict(MANIFEST)), text.rsplit("\n\n", 1)[0])

    def test_the_briefing_is_static_and_survives_a_round_trip_as_the_manifest(self):
        # It is in the cached half because it never changes. The wire name is
        # the contract, and an absent one is omitted rather than sent as null —
        # the TS core fingerprints a shape that leaves it out, and a round trip
        # through this class must not turn "the app said nothing" into a field.
        briefed = Manifest.from_dict(dict(MANIFEST, instructions="two screens"))
        self.assertEqual(briefed.to_dict()["instructions"], "two screens")
        self.assertNotIn("instructions", Manifest.from_dict(MANIFEST).to_dict())
        # The verb→screen mapping is static too and round-trips beside it;
        # which screen is LIVE is on the snapshot and must never be in here.
        verb = VerbSpec.from_dict(
            {"name": "page", "describe": "page", "screen": "contacts", "reversible": True}
        )
        self.assertEqual(verb.screen, "contacts")
        self.assertEqual(verb.to_dict()["screen"], "contacts")
        self.assertEqual(verb.to_dict()["reversible"], True)
        plain = VerbSpec.from_dict({"name": "page", "describe": "page"})
        self.assertIsNone(plain.screen)
        self.assertIsNone(plain.reversible)
        self.assertNotIn("screen", plain.to_dict())
        self.assertNotIn("reversible", plain.to_dict())

    def test_a_verb_on_several_screens_round_trips_in_the_shape_it_was_sent_in(self):
        # Both shapes, and the shape is preserved rather than normalised. The
        # manifest is the cached half and its bytes are what `version`
        # fingerprints, so turning "contacts" into ["contacts"] on a round trip
        # would move the version of every app that names one screen — and tell
        # every agent holding a cached copy it had gone stale when nothing about
        # the app had changed.
        two = VerbSpec.from_dict(
            {"name": "page", "describe": "page", "screen": ["contacts", "company"]}
        )
        self.assertEqual(two.screen, ("contacts", "company"))
        self.assertEqual(two.to_dict()["screen"], ["contacts", "company"])
        one = VerbSpec.from_dict({"name": "page", "describe": "page", "screen": "contacts"})
        self.assertEqual(one.to_dict()["screen"], "contacts")
        # A tuple and not a list, for the reason `refuses` is one: the dataclass
        # is frozen and therefore hashable, and one mutable field takes that
        # away.
        self.assertIsInstance(two.screen, tuple)
        # A list the wire left empty becomes "the app said nothing", because the
        # core refuses `screen: []` where the app mounts precisely on the
        # grounds that "works nowhere" is nobody's intention — so a reader that
        # met one anyway would be inventing a claim out of a mistake. Entries
        # that are not screen ids go the same way rather than being coerced:
        # `str(None)` is the screen id "None", which is a screen no app has.
        for sent in ([], [None, 3], "", ["", None]):
            empty = VerbSpec.from_dict({"name": "page", "describe": "page", "screen": sent})
            self.assertIsNone(empty.screen, sent)
            self.assertNotIn("screen", empty.to_dict())

    def test_a_verb_on_several_screens_names_them_all_in_its_description(self):
        # Naming one of two is worse than naming none: a model told `next-page`
        # is ONLY ON THE `contacts` SCREEN navigates away from the company list
        # it was already standing on, to do something it could have done where
        # it was. Byte-identical with the TS half, which has the same test.
        manifest = Manifest.from_dict(
            {
                "version": "v",
                "app": "two-list",
                "verbs": [
                    {
                        "name": "next-page",
                        "kind": "read",
                        "describe": "page",
                        "screen": ["contacts", "company"],
                    },
                    {
                        "name": "sort",
                        "kind": "read",
                        "describe": "sort",
                        "screen": ["contacts", "company", "companies"],
                    },
                    # The single-string wording must not acquire a comma or a
                    # plural because the field can now hold a list: this is the
                    # sentence every existing app's cached prefix contains.
                    {"name": "search", "kind": "read", "describe": "find", "screen": "contacts"},
                ],
            }
        )
        tools = tools_for(manifest)
        self.assertIn(
            "ONLY ON THE `contacts` AND `company` SCREENS.", tool(tools, "next-page")["description"]
        )
        self.assertIn(
            "ONLY ON THE `contacts`, `company` AND `companies` SCREENS.",
            tool(tools, "sort")["description"],
        )
        self.assertIn("ONLY ON THE `contacts` SCREEN.", tool(tools, "search")["description"])
        # What follows the first sentence is mechanics and not a claim about
        # this verb, so it is the same sentence in all three.
        for name in ("next-page", "sort", "search"):
            self.assertIn("refused as `wrong-screen`", tool(tools, name)["description"])


class FastMcpOptional(unittest.TestCase):
    """The optional module must not be able to break the one that works."""

    def test_importing_the_fastmcp_server_without_fastmcp_installed_does_not_raise(self):
        # `fastmcp` is an extra, and the module is written on a machine where it
        # could not be installed. Importing `driverkit` or this module must
        # still work, or the dependency-free path is not dependency-free.
        from driverkit import fastmcp_server

        self.assertIn(fastmcp_server.FASTMCP_AVAILABLE, (True, False))

    def test_every_entry_point_fails_with_an_install_hint_and_not_a_traceback(self):
        from driverkit import fastmcp_server

        if fastmcp_server.FASTMCP_AVAILABLE:  # pragma: no cover - not on this machine
            self.skipTest("fastmcp is installed; this pins the absent case")
        with self.assertRaises(RuntimeError) as caught:
            fastmcp_server.build_server(relay_url="http://127.0.0.1:1", auth=None, tab="t")
        self.assertIn("fastmcp", str(caught.exception))
        self.assertIn("driverkit.mcp_server", str(caught.exception))
        # stderr captured: the hint is for a person at a terminal, not for the
        # test runner's output.
        import contextlib

        with contextlib.redirect_stderr(io.StringIO()) as noise:
            self.assertEqual(fastmcp_server.main(["--tab", "t", "--audience", "a"]), 2)
        self.assertIn("fastmcp", noise.getvalue())

    def test_the_stdio_server_does_not_import_fastmcp_even_transitively(self):
        # The guarantee that matters: `driverkit-mcp` must not acquire a
        # dependency because a sibling module has one.
        import importlib
        import sys as _sys

        for name in [n for n in list(_sys.modules) if n.startswith("driverkit")]:
            del _sys.modules[name]
        importlib.import_module("driverkit.mcp_server")
        self.assertNotIn("driverkit.fastmcp_server", _sys.modules)
