"""
Prove the type-stripper by running the library's own test suite through it.

`tsstrip.py` is the one piece of this example that could be subtly wrong in a
way no page would reveal — a mis-stripped expression produces JavaScript that
parses and misbehaves. So it is not reviewed, it is executed: every `.ts` file
under `packages/` is stripped, written to a mirror tree as `.js` with its `.ts`
import specifiers rewritten, and the unit tests are run against the mirror by
plain Node with no type-stripping flag of its own.

    python3 examples/contacts/verify_strip.py

The suite is then run a second time from source, and the two outcomes are
compared: the same number of tests, the same ones passing, the same ones
failing, the same ones skipped. The comparison, rather than a bare "no
failures", is the check — a library test that is red while somebody is editing
a package says nothing about the stripper, and failing here on its account
would only teach a reader to ignore this script. A test that passes from source
and fails, errors or skips itself against the stripped output is the finding.

A pass therefore means the stripped bytes the browser receives behave
identically to the `.ts` sources under `node --experimental-strip-types`.
Nothing under `packages/` is touched; the mirror is written to a temporary
directory.

THE MIRROR'S SHAPE. It is `<tmp>/packages/<pkg>/…`, the same shape as the
repository, and not a flattened copy, because the suite does not only import
its neighbours by relative path:

  * `packages/driverkit/test/controls.test.ts` imports the bare specifier
    `driverkit`, which resolves only through the workspace link in
    `node_modules` and the package's own `exports`. The repository's
    `node_modules` is symlinked into the mirror so it resolves there to the
    same built `dist/` file it resolves to from source.
  * `packages/driverkit/test/packaging.test.ts` reads the `package.json`
    manifest relative to its own URL and loads `dist/` in a child `node`. The
    manifest and `dist/` are copied in beside the stripped sources.
  * `packages/driverkit/test/cross-impl.test.ts` runs the Python implementation
    from `<root>/python/src`, which is symlinked in for the same reason — a
    test that skips itself in the mirror and runs from source is a hole in the
    comparison, not a pass.

`dist/` is therefore excluded from the strip sweep: those are `.d.ts` build
outputs, not sources the dev server ever serves, and the mirror's copy of
`dist/` has to stay byte-identical for the packaging test to mean anything.

Ahead of the suite come the regression cases in `CASES`, which pin the
constructs that have broken the scanner before — a conditional type next to a
ternary, an annotated method with an empty body, a generic arrow, a chained
assertion, chained modifiers. They are inline strings on purpose: a library
file that happens to contain one today may not tomorrow.
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

PACKAGE_DIRS = ("driverkit",)

#: `(label, source, expected)`. `expected` is compared after each line has its
#: runs of whitespace collapsed, because a deleted span leaves its spaces
#: behind on purpose; the line *count* is compared exactly, since preserving it
#: is what keeps a browser stack trace pointing at the real line.
CASES: list[tuple[str, str, str]] = [
    (
        # The `as string` ends at the ternary's `:`. Reading that `:` as part
        # of a conditional type ate the whole else-arm of this expression in
        # `packages/driverkit/src/browser/connect.ts`.
        "an assertion in a ternary arm",
        'const mint =\n'
        '  typeof token === "function"\n'
        '    ? token\n'
        '    : token !== undefined\n'
        '      ? () => token as string\n'
        '      : anonymous\n'
        '        ? () => mintAnon()\n'
        '        : null;\n',
        'const mint =\n'
        ' typeof token === "function"\n'
        ' ? token\n'
        ' : token !== undefined\n'
        ' ? () => token\n'
        ' : anonymous\n'
        ' ? () => mintAnon()\n'
        ' : null;\n',
    ),
    (
        # The other side of the same coin: here the `?` and `:` really are a
        # conditional type's, and both belong to the span that goes.
        "a conditional type in an assertion and an annotation",
        'const w = z as A extends B ? C : D;\n'
        'const v: A extends B ? C : D = q;\n'
        'type Pick<T> = T extends string ? 1 : 2;\n',
        'const w = z ;\n'
        'const v = q;\n'
        '\n',
    ),
    (
        # An empty `{}` body in a return-type position. `void {}` is not a
        # type, so the `{` can only be the body.
        "annotated members with empty bodies",
        'class K {\n'
        '  clear(): void {}\n'
        '  get size(): number {}\n'
        '  set size(v: number) {}\n'
        '  reset = (): void => {};\n'
        '  shape(): { a?: string } {}\n'
        '}\n',
        'class K {\n'
        ' clear() {}\n'
        ' get size() {}\n'
        ' set size(v ) {}\n'
        ' reset = () => {};\n'
        ' shape() {}\n'
        '}\n',
    ),
    (
        # A `{` that genuinely does open a type, so that the rule above is not
        # just "a `{` ends the type".
        "an object type as a return type, with a body after it",
        'function h(): { a?: string } { return { a: "x" }; }\n'
        'function k(): () => void { return () => {}; }\n',
        'function h() { return { a: "x" }; }\n'
        'function k() { return () => {}; }\n',
    ),
    (
        # A type-parameter list where no operand precedes the `<`, so it cannot
        # be a less-than: `packages/driverkit/src/controls/controls.ts`.
        "a generic arrow in an object literal",
        'const o = {\n'
        '  map: <T extends object>(x: T): T => x,\n'
        '  n: a < b ? 1 : 2,\n'
        '};\n',
        'const o = {\n'
        ' map: (x ) => x,\n'
        ' n: a < b ? 1 : 2,\n'
        '};\n',
    ),
    (
        # A chained assertion whose last link is an object type: the `as` keeps
        # the type unfinished, so the `{` is still a type.
        "a chained assertion to an object type",
        'const g = (f as unknown as { go?: () => void }).go;\n',
        'const g = (f ).go;\n',
    ),
    (
        # Two modifiers in a row: `packages/driverkit/src/relay/auth.ts`.
        "chained member modifiers",
        'class E extends Error {\n'
        '  override readonly name = "E";\n'
        '  private readonly n: number = 0;\n'
        '  private static readonly z: number = 1;\n'
        '}\n',
        'class E extends Error {\n'
        ' name = "E";\n'
        ' n = 0;\n'
        ' static z = 1;\n'
        '}\n',
    ),
    (
        # `as` inside a specifier clause renames a binding; erasing it leaves
        # the module with no such binding at all:
        # `packages/driverkit/src/widget/widget.ts`.
        "an aliased import is not an assertion",
        'import { load as loadIt, type Gone, save } from "./m.ts";\n'
        'import * as ns from "./n.ts";\n'
        'export { loadIt as load };\n'
        'export const w = ns as unknown as { go: () => void };\n'
        'if ((import.meta as unknown as { main?: boolean }).main) save();\n',
        'import { load as loadIt, save } from "./m.ts";\n'
        'import * as ns from "./n.ts";\n'
        'export { loadIt as load };\n'
        'export const w = ns ;\n'
        'if ((import.meta ).main) save();\n',
    ),
    (
        # A binding pattern is not a block, so its `:` renames rather than
        # annotating: `packages/driverkit/src/controls/controls.ts`.
        "a renaming destructuring pattern",
        'const { controls: list, hidden } = enumerate();\n'
        'for (const { id: key } of list) use(key, hidden);\n',
        'const { controls: list, hidden } = enumerate();\n'
        'for (const { id: key } of list) use(key, hidden);\n',
    ),
]


class Outcome:
    """What one `node --test` run says, reduced to what is comparable."""

    __slots__ = ("total", "passed", "failed", "skipped")

    def __init__(self, tap: str) -> None:
        def count(label: str) -> int:
            m = re.search(rf"^# {label} (\d+)$", tap, re.M)
            return int(m.group(1)) if m else -1

        self.total = count("tests")
        self.passed = count("pass")
        #: Names, not a count: which tests failed is the part worth comparing.
        self.failed = {
            m.group(1).strip()
            for m in re.finditer(r"^not ok \d+ - (.*)$", tap, re.M)
        }
        self.skipped = {
            m.group(1).strip()
            for m in re.finditer(r"^ok \d+ - (.*?) # SKIP", tap, re.M)
        }

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Outcome):
            return NotImplemented
        return (
            self.total == other.total
            and self.passed == other.passed
            and self.failed == other.failed
            and self.skipped == other.skipped
        )

    def __str__(self) -> str:
        return (
            f"{self.total} tests, {self.passed} pass, {len(self.failed)} fail, "
            f"{len(self.skipped)} skipped"
        )

    def diff(self, baseline: Outcome) -> str:
        lines = []
        if self.total != baseline.total:
            lines.append(f"ran {self.total} tests, source ran {baseline.total}")
        for name in sorted(self.failed - baseline.failed):
            lines.append(f"fails only against stripped output: {name}")
        for name in sorted(baseline.failed - self.failed):
            lines.append(f"fails only from source: {name}")
        for name in sorted(self.skipped - baseline.skipped):
            lines.append(f"skipped only against stripped output: {name}")
        for name in sorted(baseline.skipped - self.skipped):
            lines.append(f"skipped only from source: {name}")
        return "\n".join(lines)


def _run(argv: list[str], cwd: pathlib.Path) -> Outcome:
    run = subprocess.run(argv, capture_output=True, text=True, cwd=cwd)
    outcome = Outcome(run.stdout)
    if outcome.total < 0:
        print(run.stdout[-4000:], file=sys.stderr)
        print(run.stderr[-4000:], file=sys.stderr)
        raise SystemExit("node --test produced no summary")
    return outcome


def _norm(text: str) -> str:
    return "\n".join(re.sub(r"\s+", " ", line).strip() for line in text.splitlines())


def check_cases(tmp: pathlib.Path) -> int:
    bad = 0
    for label, src, want in CASES:
        got = strip_types(src)
        if _norm(got) != _norm(want):
            bad += 1
            print(f"CASE {label}\n  want {_norm(want)!r}\n  got  {_norm(got)!r}", file=sys.stderr)
            continue
        if got.count("\n") != src.count("\n"):
            bad += 1
            print(f"CASE {label}: line count moved", file=sys.stderr)
            continue
        probe = tmp / "case.mjs"
        probe.write_text(got)
        check = subprocess.run(["node", "--check", str(probe)], capture_output=True, text=True)
        if check.returncode != 0:
            bad += 1
            print(f"CASE {label} does not parse\n{check.stderr}", file=sys.stderr)
    if bad:
        print(f"{bad} regression case(s) failed", file=sys.stderr)
        return 1
    print(f"cases: {len(CASES)} regression cases strip as expected")
    return 0


def main() -> int:
    out = pathlib.Path(tempfile.mkdtemp(prefix="dk-strip-"))
    try:
        if check_cases(out):
            return 1

        sources = [
            p
            for p in sorted((ROOT / "packages").rglob("*.ts"))
            if "dist" not in p.relative_to(ROOT / "packages").parts
            # A `.d.ts` is declarations and nothing else, so a type stripper
            # erases the whole file and what is left -- `declare module "x" {`
            # -- is not JavaScript. The dev server never serves one either: a
            # browser asks for the `.ts` modules, not for their ambient
            # declarations. (`test/uri-templates.d.ts` is the only one.)
            and not p.name.endswith(".d.ts")
        ]
        if not sources:
            print("no sources found", file=sys.stderr)
            return 2

        for src in sources:
            dst = out / src.relative_to(ROOT).with_suffix(".js")
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                code = strip_types(src.read_text())
            except Exception as err:  # noqa: BLE001
                print(f"STRIP FAILED {src.relative_to(ROOT)}: {err}", file=sys.stderr)
                return 1
            dst.write_text(SPEC.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}.js{m.group(2)}", code))

        # The repository's shape around the stripped sources: the manifest and
        # built `dist/` the packaging test reads, and the workspace link that a
        # bare `driverkit` specifier resolves through.
        (out / "package.json").write_text('{"type":"module"}\n')
        for dir_ in PACKAGE_DIRS:
            pkg = out / "packages" / dir_
            pkg.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / "packages" / dir_ / "package.json", pkg / "package.json")
            dist = ROOT / "packages" / dir_ / "dist"
            if dist.is_dir():
                shutil.copytree(dist, pkg / "dist", dirs_exist_ok=True)
        for sibling in ("node_modules", "python"):
            # `node_modules` for the bare specifiers; `python` because
            # `packages/driverkit/test/cross-impl.test.ts` puts `<root>/python/src`
            # on a child interpreter's PYTHONPATH and skips itself without it.
            if (ROOT / sibling).is_dir():
                (out / sibling).symlink_to(ROOT / sibling, target_is_directory=True)

        # 1. Every stripped file must be syntactically valid JavaScript.
        stripped = sorted(
            p for p in out.rglob("*.js") if "dist" not in p.relative_to(out).parts
        )
        bad = 0
        for js in stripped:
            check = subprocess.run(
                ["node", "--check", str(js)], capture_output=True, text=True
            )
            if check.returncode != 0:
                bad += 1
                print(f"SYNTAX {js.relative_to(out)}\n{check.stderr}", file=sys.stderr)
        if bad:
            print(f"{bad} stripped file(s) are not valid JavaScript", file=sys.stderr)
            return 1
        print(f"syntax: {len(stripped)} stripped files parse as plain JS")

        # 2. The library's own tests, run against the stripped output, and the
        #    same suite run from source. The comparison is between the two
        #    runs, not against "no failures": a library test that is red while
        #    somebody edits a package is not evidence about the stripper, and
        #    making it fail here would only teach a reader to ignore this
        #    script. A test that passes from source and fails, errors or skips
        #    itself against the stripped output is the finding.
        mirrored = _run(
            ["node", "--test", *sorted(str(p) for p in out.rglob("packages/*/test/*.test.js"))],
            out,
        )
        from_source = _run(
            [
                "node", "--experimental-strip-types", "--test",
                *sorted(str(p) for p in ROOT.glob("packages/*/test/*.test.ts")),
            ],
            ROOT,
        )
        print(f"stripped:    {mirrored}")
        print(f"from source: {from_source}")
        if mirrored != from_source:
            print(f"\n{mirrored.diff(from_source)}", file=sys.stderr)
            print("STRIPPED OUTPUT AND SOURCE DISAGREE", file=sys.stderr)
            return 1
        if from_source.failed:
            print(
                "\nthe two agree, but the suite is red from source too -- "
                f"{len(from_source.failed)} test(s) are failing in the library "
                "itself, which this script does not judge:",
            )
            for name in sorted(from_source.failed):
                print(f"  {name}")
        print("\nstripped output behaves exactly as the `.ts` sources do.")
        return 0
    finally:
        shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
