"""
Check the `/api/chat` translation without talking to Anthropic.

    python3 examples/contacts/verify_chat.py

Name resolution does not work in the shell this was built in, and the key is
not mine to spend, so the proxy is pointed at a fake Messages endpoint on
loopback instead. The fake is strict: it asserts the request shape driverkit's
`Think` contract has to become, including the two things most likely to be
wrong —

  * **the tool-result merge.** Anthropic has no `role: "tool"`. Several tool
    turns answering one assistant turn must arrive as ONE user message with
    several `tool_result` blocks; as separate user messages the API rejects
    them. The conversation posted below has a two-call assistant turn
    specifically to exercise that.
  * **the cache breakpoints.** `cache_control` on `system` and on the LAST
    tool, which is where the library's claim that the static half is
    byte-identical across turns either pays off or does not.

Then it checks the response translation the other way: `tool_use` blocks back
to `ToolCall`s with `args` as an object, and an `error` body surfaced as a
clear message rather than a traceback.

This verifies the translation, not the model. Nothing here proves
`claude-sonnet-5-5` fills the arguments well — that needs a key and a network.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

captured: list[dict] = []
mode = {"reply": "tools"}

REPLY_TOOLS = {
    "id": "msg_fake",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-5-5",
    "stop_reason": "tool_use",
    "content": [
        {"type": "text", "text": "Selecting those now."},
        {
            "type": "tool_use",
            "id": "toolu_1",
            "name": "select-where",
            "input": {"company": "Acme Industrial", "status": "new"},
        },
    ],
    "usage": {
        "input_tokens": 11,
        "cache_creation_input_tokens": 2043,
        "cache_read_input_tokens": 0,
        "output_tokens": 57,
    },
}

REPLY_ERROR = {
    "type": "error",
    "error": {"type": "invalid_request_error", "message": "max_tokens: must be >= 1"},
}


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        captured.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if mode["reply"] == "error":
            payload = json.dumps(REPLY_ERROR).encode()
            self.send_response(400)
        else:
            payload = json.dumps(REPLY_TOOLS).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def post(url: str, payload: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


#: A conversation with a two-call assistant turn, which is the case the merge
#: rule exists for.
THINK = {
    "system": "You are driving a live Contacts session.",
    "tools": [
        {
            "name": "search",
            "description": "filter the table",
            "inputSchema": {
                "type": "object",
                "properties": {"q": {"type": "string", "description": "term"}},
                "required": ["q"],
                "additionalProperties": False,
            },
        },
        {
            "name": "select-where",
            "description": "select every contact at one company",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "company": {
                        "type": "string",
                        "description": "the company",
                        "enum": ["Acme Industrial", "Berenson Health"],
                    }
                },
                "required": ["company"],
                "additionalProperties": False,
            },
        },
    ],
    "messages": [
        {"role": "user", "text": "accept everyone at Acme\n\nOn screen now:\nwhere: contacts (rev 1)"},
        {
            "role": "assistant",
            "text": "Reading first.",
            "calls": [
                {"id": "toolu_a", "name": "search", "args": {"q": "Acme"}},
                {"id": "toolu_b", "name": "select-where", "args": {"company": "Acme Industrial"}},
            ],
        },
        {"role": "tool", "callId": "toolu_a", "name": "search", "text": "ok\n\nwhere: contacts"},
        {"role": "tool", "callId": "toolu_b", "name": "select-where", "text": "ok\ncount: 433 matched"},
    ],
}


def main() -> int:
    fake = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    fake.daemon_threads = True
    threading.Thread(target=fake.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    fake_url = f"http://127.0.0.1:{fake.server_address[1]}"

    env = dict(os.environ)
    env.update(
        {
            "DK_PORT": "0",
            "DK_LLM_BASE": fake_url,
            # Not a real key and never sent anywhere but loopback. The point of
            # the check is that it does not come back out.
            "ANTHROPIC_API_KEY": "test-key-not-real",
            "DK_MAX_TOKENS": "1234",
            "DK_MODEL": "claude-sonnet-5-5",
        }
    )
    # Port 0 would be useful but the server prints the bound port, so a fixed
    # free-ish one keeps this simple to read.
    env["DK_PORT"] = "8792"
    proc = subprocess.Popen(
        [sys.executable, "-I", str(HERE / "server.py")],
        env=env,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = "http://127.0.0.1:8792"

    failures = 0

    def check(name: str, fn) -> None:
        nonlocal failures
        try:
            fn()
            print(f"  ok    {name}")
        except AssertionError as err:
            failures += 1
            print(f"  FAIL  {name}\n        {err}")

    try:
        for _ in range(100):
            try:
                post(f"{base}/api/chat", {"messages": []})
                break
            except OSError:
                time.sleep(0.05)

        status, reply = post(f"{base}/api/chat", THINK)

        def translated() -> dict:
            assert captured, "the proxy never called the upstream"
            return captured[-1]["body"]

        check("the upstream is /v1/messages with the version header", lambda: (
            assert_eq(captured[-1]["path"], "/v1/messages"),
            assert_eq(captured[-1]["headers"].get("anthropic-version"), "2023-06-01"),
            assert_eq(captured[-1]["headers"].get("x-api-key"), "test-key-not-real"),
        ))

        check("model, max_tokens and the system block come from the environment", lambda: (
            assert_eq(translated()["model"], "claude-sonnet-5-5"),
            assert_eq(translated()["max_tokens"], 1234),
            assert_eq(translated()["system"][0]["text"], THINK["system"]),
        ))

        check("cache_control sits on system and on the LAST tool only", lambda: (
            assert_eq(translated()["system"][0]["cache_control"], {"type": "ephemeral"}),
            assert_eq("cache_control" in translated()["tools"][0], False),
            assert_eq(translated()["tools"][-1]["cache_control"], {"type": "ephemeral"}),
        ))

        check("ToolSpec.inputSchema becomes input_schema, enum intact", lambda: (
            assert_eq(translated()["tools"][1]["name"], "select-where"),
            assert_eq(
                translated()["tools"][1]["input_schema"]["properties"]["company"]["enum"],
                ["Acme Industrial", "Berenson Health"],
            ),
            assert_eq("parameters" in translated()["tools"][1], False),
        ))

        check("the assistant turn becomes text + one tool_use block per call", lambda: (
            assert_eq(translated()["messages"][1]["role"], "assistant"),
            assert_eq(
                [b["type"] for b in translated()["messages"][1]["content"]],
                ["text", "tool_use", "tool_use"],
            ),
            assert_eq(translated()["messages"][1]["content"][1]["id"], "toolu_a"),
            assert_eq(
                translated()["messages"][1]["content"][2]["input"],
                {"company": "Acme Industrial"},
            ),
        ))

        check("two tool turns MERGE into one user message with two tool_results", lambda: (
            assert_eq(len(translated()["messages"]), 3),
            assert_eq(translated()["messages"][2]["role"], "user"),
            assert_eq(
                [b["type"] for b in translated()["messages"][2]["content"]],
                ["tool_result", "tool_result"],
            ),
            assert_eq(
                [b["tool_use_id"] for b in translated()["messages"][2]["content"]],
                ["toolu_a", "toolu_b"],
            ),
        ))

        check("the person's own turn is NOT absorbed into the merge", lambda: (
            assert_eq(translated()["messages"][0]["role"], "user"),
            assert_eq(translated()["messages"][0]["content"][0]["type"], "text"),
        ))

        check("the reply comes back as ThinkResult with args as an object", lambda: (
            assert_eq(status, 200),
            assert_eq(reply["text"], "Selecting those now."),
            assert_eq(len(reply["calls"]), 1),
            assert_eq(reply["calls"][0]["id"], "toolu_1"),
            assert_eq(reply["calls"][0]["name"], "select-where"),
            assert_eq(reply["calls"][0]["args"], {"company": "Acme Industrial", "status": "new"}),
        ))

        check("nothing in the reply resembles a key", lambda: assert_eq(
            "test-key-not-real" in json.dumps(reply), False
        ))

        mode["reply"] = "error"
        err_status, err_body = post(f"{base}/api/chat", THINK)
        check("an upstream error is a clear message, not a crash", lambda: (
            assert_eq(err_status, 502),
            assert_in("invalid_request_error", err_body["error"]),
            assert_in("max_tokens", err_body["error"]),
            assert_eq("test-key-not-real" in json.dumps(err_body), False),
        ))

        bad_status, bad_body = post(f"{base}/api/chat", {"system": "s", "tools": [], "messages": []})
        check("an empty conversation is a 400 with a reason", lambda: (
            assert_eq(bad_status, 400),
            assert_in("messages", bad_body["error"]),
        ))

        # ---- DK_LLM_IP ---------------------------------------------------
        # A hostname that cannot resolve, pinned to loopback. If the pin works
        # the request arrives and the Host header still names the hostname; if
        # it does not, this is a DNS failure and a 502.
        mode["reply"] = "tools"
        pinned_env = dict(env)
        pinned_env.update(
            {
                "DK_PORT": "8793",
                "DK_LLM_BASE": f"http://contacts-demo.invalid:{fake.server_address[1]}",
                "DK_LLM_IP": "127.0.0.1",
            }
        )
        pinned = subprocess.Popen(
            [sys.executable, "-I", str(HERE / "server.py")],
            env=pinned_env,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            for _ in range(100):
                try:
                    post("http://127.0.0.1:8793/api/chat", {"messages": []})
                    break
                except OSError:
                    time.sleep(0.05)
            pin_status, pin_body = post("http://127.0.0.1:8793/api/chat", THINK)
            check("DK_LLM_IP reaches a host that cannot be resolved, Host kept", lambda: (
                assert_eq(pin_status, 200),
                assert_eq(pin_body["calls"][0]["name"], "select-where"),
                assert_in("contacts-demo.invalid", captured[-1]["headers"].get("Host", "")),
            ))
        finally:
            pinned.terminate()
            try:
                pinned.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pinned.kill()
    finally:
        proc.terminate()
        try:
            stdout, _ = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout = ""
        fake.shutdown()
        fake.server_close()

    print("\nthe server's own log of those requests:")
    for line in (stdout or "").splitlines():
        if line.startswith("chat:"):
            print(f"  {line}")
        if "test-key-not-real" in line:
            failures += 1
            print(f"  FAIL  the key appeared in a log line: {line}")

    print(f"\n{12 - failures}/12 checks passed" + (f" — {failures} FAILED" if failures else ""))
    return 1 if failures else 0


def assert_eq(got, want) -> None:
    assert got == want, f"got {got!r}, wanted {want!r}"


def assert_in(needle: str, haystack: str) -> None:
    assert needle in haystack, f"{needle!r} not in {haystack!r}"


if __name__ == "__main__":
    raise SystemExit(main())
