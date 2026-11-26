# The contacts demo's eval suite

Ten cases, written for breadth of **failure mode** rather than coverage. Run them with:

```
# validate the files, replay every asserted count against the real driver, call no model
node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals --dry-run

# the real thing: needs a server with ANTHROPIC_API_KEY on it, three runs per case
DK_PORT=8771 node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals \
  --endpoint http://127.0.0.1:8771/api/chat --model claude-sonnet-5-5 --runs 3 --save after.json
```

| case | the failure it is watching for |
|---|---|
| `count-only` | a `describe` that changes data, and the seeded 238 — and whether the `describe` says it answers a `how many` question without navigating |
| `named-contact` | **the recorded failure**: one named person taken as her whole company (410 rows) |
| `describe-count-commit` | the pairing rule end to end, with 112 asserted between the two calls, by whichever of the two honest routes the agent takes (`anyOf`) |
| `empty-selection` | "accept them" with nothing selected: do not invent a selection |
| `cross-screen` | drift on a five-verb job across three screens |
| `navigate` | the cheapest possible ask, as a control |
| `filter` | a screen-scoped verb reached without being refused first |
| `no-such-company` | a company that does not exist, answered by picking the nearest one |
| `ambiguous-name` | five people share the name; the right move is to ask |
| `no-verb-for-it` | an ask the app cannot do, answered with the nearest destructive verb |

Four of the ten expect the agent to **not act**. That is the ratio on purpose: the cases where
nothing should happen are the ones nothing else in the repository checks.

Three of these cases were rewritten after the first live run, because the agent was right and the case was
wrong: one asserted a single route where the app has two, one attributed a count by position and caught a
polite `clear-selection` instead, and one required an attempt-and-refusal that better screen prose makes
unnecessary. The general lesson is in
[`skills/driverkit/references/eval.md`](../../../skills/driverkit/references/eval.md) under "how to write a
case that does not punish a better answer"; it is the trap every adopter will meet.
