"""
Fetch the demo from a running server and run it.

    python3 examples/contacts/server.py &
    python3 examples/contacts/verify_app.py http://127.0.0.1:8770

This walks the import graph over HTTP starting at `check.mjs`, so every module
in the mirror is the exact bytes the browser would have been served — the
library's `.ts` sources with the server's type-stripping already applied. Then:

  1. every fetched module must be valid JavaScript (`node --check`),
  2. `check.mjs` runs against the mirror and against the server's live relay.

The rename to `.js` and the specifier rewrite are the only edits, and they
exist because Node routes on the file extension where a browser routes on the
response's content type. That difference is the one thing this harness cannot
reproduce, and it is also the one thing `curl -w '%{content_type}'` can check
directly.
"""

from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

#: `check.mjs` is executed; `app.js` is only fetched and parsed, because it
#: needs a `document` and there is no browser here. Including it means the
#: widget's and `connect`'s stripped bytes are checked too, which is most of
#: what the page loads and none of what `check.mjs` imports.
ENTRIES = ["/examples/contacts/check.mjs", "/examples/contacts/app/app.js"]

#: Static `import`/`export … from "…"` specifiers. Dynamic imports with a
#: computed specifier are not resolvable here and the demo has none.
SPEC = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*(['"])([^'"]+)\1""")


def fetch(url: str) -> tuple[int, str, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get("Content-Type", ""), err.read()


def main() -> int:
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8770").rstrip("/")
    out = pathlib.Path(tempfile.mkdtemp(prefix="dk-app-"))

    try:
        pending = list(ENTRIES)
        seen: dict[str, str] = {}
        content_types: dict[str, str] = {}

        while pending:
            path = pending.pop()
            if path in seen:
                continue
            status, kind, raw = fetch(base + path)
            if status != 200:
                print(f"FETCH {status} {path}", file=sys.stderr)
                return 1
            text = raw.decode("utf-8")
            seen[path] = text
            content_types[path] = kind
            here = urllib.parse.urlsplit(path).path
            for _, spec in SPEC.findall(text):
                if not spec.startswith((".", "/")):
                    continue  # a bare specifier: node builtin or package
                target = urllib.parse.urljoin(here, spec)
                if target not in seen:
                    pending.append(target)

        print(f"fetched {len(seen)} modules from {base}")
        for path in sorted(seen):
            flag = "" if path.endswith(".ts") else " "
            print(f"  {content_types[path]:<32} {path}{flag}")

        # Mirror, renaming `.ts` to `.js` and rewriting the specifiers to match.
        def rename(path: str) -> str:
            return path[:-3] + ".js" if path.endswith(".ts") else path

        def rewrite(text: str) -> str:
            return re.sub(
                r"""((?:\bfrom|\bimport)\s*\(?\s*)(['"])([^'"]+)\.ts\2""",
                lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}.js{m.group(2)}",
                text,
            )

        for path, text in seen.items():
            target = out / rename(path).lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(rewrite(text))
        (out / "package.json").write_text('{"type":"module"}\n')

        # The mirror needs the repo's `node_modules` to resolve ONE bare
        # specifier: `packages/widget/src/widget.ts` imports `@driverkit/agent`
        # by name, because the widget depends on the agent package at runtime
        # rather than only for its types. A browser resolves that through the
        # import map in `index.html`; Node resolves it by walking up for a
        # `node_modules`, and the mirror lives in a temp directory with none
        # above it. Symlinked rather than copied: it is only ever read, and the
        # workspace links in it point back here anyway.
        links = pathlib.Path(__file__).resolve().parents[2] / "node_modules"
        if links.is_dir():
            (out / "node_modules").symlink_to(links, target_is_directory=True)
        else:
            print(f"no node_modules at {links}: run `npm install` first", file=sys.stderr)
            return 1

        bad = 0
        for js in sorted(out.rglob("*.js")) + sorted(out.rglob("*.mjs")):
            run = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True)
            if run.returncode != 0:
                bad += 1
                print(f"SYNTAX {js.relative_to(out)}\n{run.stderr}", file=sys.stderr)
        if bad:
            return 1
        print(f"\nall {len(seen)} fetched modules parse as plain JavaScript\n")

        run = subprocess.run(
            ["node", str(out / "examples/contacts/check.mjs"), base],
            text=True,
        )
        return run.returncode
    finally:
        shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
