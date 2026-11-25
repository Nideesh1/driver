"""
Prove the type-stripper by running the library's own test suite through it.

`tsstrip.py` is the one piece of this example that could be subtly wrong in a
way no page would reveal — a mis-stripped expression produces JavaScript that
parses and misbehaves. So it is not reviewed, it is executed: every `.ts` file
under `packages/` is stripped, written to a mirror tree as `.js` with its `.ts`
import specifiers rewritten, and the 364 unit tests are run against the mirror
by plain Node with no type-stripping flag of its own.

    python3 examples/contacts/verify_strip.py

A pass means the stripped bytes the browser receives behave identically to the
`.ts` sources under `node --experimental-strip-types`. Nothing under
`packages/` is touched; the mirror is written to a temporary directory.
"""

from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from tsstrip import strip_types  # noqa: E402

SPEC = re.compile(r'(from\s*|import\s*\(\s*)(["\'])([^"\']+)\.ts\2')


def main() -> int:
    out = pathlib.Path(tempfile.mkdtemp(prefix="dk-strip-"))
    try:
        sources = sorted((ROOT / "packages").rglob("*.ts"))
        if not sources:
            print("no sources found", file=sys.stderr)
            return 2

        for src in sources:
            rel = src.relative_to(ROOT / "packages")
            dst = out / rel.with_suffix(".js")
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                code = strip_types(src.read_text())
            except Exception as err:  # noqa: BLE001
                print(f"STRIP FAILED {rel}: {err}", file=sys.stderr)
                return 1
            dst.write_text(SPEC.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}.js{m.group(2)}", code))

        (out / "package.json").write_text('{"type":"module"}\n')

        # 1. Every stripped file must be syntactically valid JavaScript.
        bad = 0
        for js in sorted(out.rglob("*.js")):
            check = subprocess.run(
                ["node", "--check", str(js)], capture_output=True, text=True
            )
            if check.returncode != 0:
                bad += 1
                print(f"SYNTAX {js.relative_to(out)}\n{check.stderr}", file=sys.stderr)
        if bad:
            print(f"{bad} stripped file(s) are not valid JavaScript", file=sys.stderr)
            return 1
        print(f"syntax: {len(list(out.rglob('*.js')))} stripped files parse as plain JS")

        # 2. The library's own tests, run against the stripped output.
        tests = sorted(str(p) for p in out.rglob("test/*.test.js"))
        run = subprocess.run(
            ["node", "--test", *tests], capture_output=True, text=True, cwd=out
        )
        tail = "\n".join(run.stdout.strip().splitlines()[-18:])
        print(tail)
        if run.returncode != 0:
            print(run.stderr[-4000:], file=sys.stderr)
            print("TESTS FAILED against stripped output", file=sys.stderr)
            return 1
        print("\nstripped output passes the library's own test suite.")
        return 0
    finally:
        shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
