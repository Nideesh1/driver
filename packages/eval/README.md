# @driverkit/eval

Does this app's verb list actually work? Replay plain-English asks against a mounted driver and a real model, and
report four numbers that are deliberately not one number.

```
node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals --dry-run
node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals --runs 3 --save after.json
node --experimental-strip-types packages/eval/src/cli.ts --diff before.json after.json
```

A case is an ask plus what should happen, as JSON:

```json
{
  "id": "named-contact",
  "ask": "select Elena Quintero at Grayson Robotics, and nobody else",
  "expect": { "calls": ["select-contact"], "forbid": ["select-where"], "count": 1, "commits": "none" }
}
```

`calls` asserts one ordered route, and an app usually has more than one right route: `anyOf` holds two or more
whole routes (`{ calls, args?, count? }`) and the run passes if any of them happened, with the teeth left in
`count`, `commits` and `forbid`. Reach for the outcome before the route — see
[**how to write a case that does not punish a better answer**](../../skills/driverkit/references/eval.md), which
is where the first live run of the demo's suite put three of its findings.

The four numbers are **verb chosen**, **arguments correct**, **steps taken** and **commits that should not have
happened**. Only the last costs you anything you cannot get back, so it is printed first, on its own, and there is
no aggregate score anywhere in the output. Three runs per case by default, reported as a rate: a model is a
sampler, and a verb list that works two times in three is a finding rather than a pass.

`--dry-run` validates the cases against the live manifest and **replays every asserted count against the real
driver with no model**, so a number that has drifted is reported as a fixture change rather than as a model
regression. That is the part that belongs in CI; the live run does not — it costs real model calls.

Full documentation: [`skills/driverkit/references/eval.md`](../../skills/driverkit/references/eval.md).
The demo's own suite: [`examples/contacts/evals`](../../examples/contacts/evals).

This package exports its source rather than a `dist`, and is not in `tsconfig.build.json`. It is a development tool
run out of a checkout; nothing installs it and nothing imports it at runtime. It is typechecked with everything
else by the repo-wide `tsconfig.json`.
