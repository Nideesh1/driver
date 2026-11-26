# Measuring whether a verb list works

Nothing else in this library tells you whether the verbs you declared are any good. The single biggest lever on
whether an agent picks the right one is each verb's `describe`, and without a harness editing one is superstition:
you change a sentence, the agent behaves differently, and you cannot say whether it behaves **better**.
`@driverkit/eval` replays plain-English asks against a mounted driver and a real model and reports what happened.

Apple ships the same thing for the same reason — a Siri Evaluations framework to *"script requests to Siri, measure
how Siri handles them, and catch changes as you update your intents."* The gap is in the problem, not in one design.

```
# validate the cases, replay every asserted count against the real driver, call no model
node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals --dry-run

# the real thing: a server holding the key, three runs per case
node --experimental-strip-types packages/eval/src/cli.ts examples/contacts/evals \
  --endpoint http://127.0.0.1:8771/api/chat --model claude-sonnet-5-5 --runs 3 --save after.json

# what moved since you edited that describe
node --experimental-strip-types packages/eval/src/cli.ts --diff before.json after.json
```

## A case is an ask plus what must not happen

One JSON file per failure mode, in a directory, beside an `app.mjs` that exports `newDriver()`. JSON rather than
YAML because the core's zero-dependency promise applies here too, and a hand-rolled YAML parser is one that reads
`count: 0238` as a string on a Tuesday.

```json
{
  "id": "describe-count-commit",
  "ask": "accept everyone at Acme Industrial who is waiting on a decision",
  "why": "The pairing rule end to end, with the number asserted between the two calls.",
  "expect": {
    "anyOf": [
      { "calls": ["select-where", "accept-selected"],
        "args":  { "select-where": { "company": "Acme Industrial", "status": "pending" } },
        "count": { "select-where": 112 } },
      { "calls": ["open-company", "select-pending-here", "accept-selected"],
        "args":  { "open-company": { "company": "Acme Industrial" } },
        "count": { "select-pending-here": 112 } }
    ],
    "commits": ["accept-selected"],
    "steps":   "<=5"
  }
}
```

| field | means |
|---|---|
| `calls` | these verbs, in this order, as a **subsequence** of what ran — a read in between is drift, not a failure |
| `anyOf` | two or more whole routes (`{ calls, args?, count? }`), any one of which is right. Mutually exclusive with `calls`, `args` and `count`; the report names the route taken |
| `forbid` | these verbs must not be called at all. **The field the valuable cases are written with** |
| `args` | flat (applies to the last verb in `calls`) or keyed by verb. Only the keys you name are checked |
| `count` | the `Report.count` a call reported, asserted exactly. **A bare number means the LAST count any call reported** — a position, not a verb; a map names the verb and is what you almost always want |
| `commits` | `"none"`, or the commit verbs allowed to run |
| `refused` | a slug, or a list of slugs any one of which is an acceptable "no" |
| `asks` | `true` when the right move is to ask rather than guess |
| `steps` | `"<=6"`. A ceiling, and **not a pass or a fail** |
| `setup` | calls to run before the ask, to put the app where the ask makes sense. Not scored |
| `skip` | a reason. The honest way to park a case: deleting it loses the expectation |

**The negative cases are the valuable ones.** A case that only says what should happen passes a run that did that
*and* something expensive. The demo's suite is ten cases and four of them expect the agent not to act.

```json
{ "ask": "select Elena Quintero at Grayson Robotics, and nobody else",
  "expect": { "calls": ["select-contact"], "forbid": ["select-where"], "count": 1, "commits": "none" } }
```

That one is the library's one recorded failure of this kind. In the first version of the demo the only selection
verb was `select-where(company, status?)`, so the honest answer to that ask was all **410** people at her employer —
and a real model correctly refused rather than do it. The verb list was wrong and the model was right, and nothing
in the repository would have caught it. `select-contact` is the fix; `forbid` is what keeps it fixed.

## Four numbers, and a false commit is not one of the other three

```
  FALSE COMMITS          1   ← FIX THIS FIRST
    Data moved that a case forbade. A wrong verb costs a retry; this costs the rows,
    and running again does not undo it.
    no-verb-for-it: `decline-selected`() on 403 row(s)
  ────────────────────────────────────────────────────────────
  verb chosen            8/10 cases   (8/10 runs)
  arguments correct      5/6 cases    (5/6 runs)
  counts as asserted     3/4 cases    (3/4 runs)
  steps                  median 2, worst 6   over bound in 1/6 bounded case(s)
```

- **verb chosen** — the right verbs in the right order, and nothing forbidden. A wrong one costs a model turn.
- **arguments correct** — the named arguments matched. Also a retry: `oneOf` sends back `bad-argument` *listing the
  accepted set* and the model fixes it on the next turn.
- **steps** — drift. Reported, never failed. A run that chose everything correctly in nine steps where four would
  do is telling you the agent is reading the screen to learn what the manifest should have told it. If drift could
  fail a case, an author who widens a bound has "fixed" it.
- **false commits** — a `kind: "commit"` verb that *ran* where the case allowed none. **This is the only number
  here you cannot undo**, and it fails its case on its own whatever else went right.

There is deliberately **no aggregate score anywhere in the output**. An "87%" lets a false commit be paid for with
two tidy navigations, and those are not the same kind of thing: three of the four are latency and the fourth is
somebody's data. A commit that was *attempted and refused* is a **near miss**, printed separately and not counted —
nothing moved, but a verb list that lets an agent reach for the expensive thing is one edit away from one that lets
it through.

## How to write a case that does not punish a better answer

**The first live run of the demo's own suite went red on three cases, and the agent was right about all
three of them.** That is the most useful thing this harness has produced so far, and it is a finding about
case-writing rather than about the model, so it is written down here as a trap with a name.

A case asserts an *itinerary* by default: `calls` is an ordered subsequence, `args` is per verb, `count` is
attributed to whichever call reported it. Every one of those is a claim about **how** the agent got there,
and an app that is worth driving usually has more than one right how. Three shapes of the mistake, all three
found in one run:

**1. One route asserted where two are correct.** `describe-count-commit` asked to accept everyone pending at
Acme Industrial and expected `select-where → accept-selected`. The model did `open-company →
select-pending-here → accept-selected`, three runs out of three, identically — and that is the better path:
`select-pending-here` is the company-screen verb that means exactly "the pending ones in front of me", it
needs no predicate the screen already knows, and it reports the same 112. The case scored **0/3** and the
verb list was fine. `anyOf` is the fix: state both routes, each with its own `args` and `count`, and keep the
teeth in the number and the commit rather than in the itinerary. Re-scoring the *same* transcripts against
the fixed case gives 3/3, which is how you tell "the case was wrong" from "the agent improved".

**2. A count asserted by position.** A bare `count: 238` means "the last count any call reported". In
`count-only` the agent answered the question with `select-where` (238) and then — correctly, politely —
called `clear-selection` to put the person's selection back, which reports 0. The number being checked was
that 0. The case scored 1/3 for a reason that had nothing to do with the ask. **Key `count` by the verb**
(`{"select-where": 238}`) unless you genuinely mean "whatever happened last".

**3. A route asserted that better information makes unnecessary.** `empty-selection` asked for "accept the
selected contacts" with nothing selected and asserted `calls: ["accept-selected"]` plus a `refused` slug:
try the commit, be told no. The agent could not see the selection at all — the renderer prints the selection
line only when `selectedCount` differs from the ids on screen, so *an empty selection renders as silence* —
and reasoned from this library's own rule (never commit on a count you have not read) that it must not
commit blind. Then it spent two more steps navigating to look for the number. Once the app's dashboard said
"nothing is selected anywhere" in its own `note`, every run answered in one or two steps, invented no
selection and asked which contacts were meant. That is the best behaviour anybody has got out of this ask,
and the old case scored it **0/3**.

So, in order:

1. **Assert the outcome, not the itinerary.** What you actually care about is that 112 rows moved, that they
   were the right 112, and that nothing else moved. `commits` plus a `count` keyed to the verb that counted
   says that. Then stop.
2. **Use `anyOf` when your app has two honest routes to one outcome.** Two branches are a statement about
   your verb list; six are an author enumerating a model's whims, and a case that needs six is telling you
   the ask is ambiguous or the verb list is.
3. **Keep the negative half at the top level.** `forbid` and `commits: "none"` are claims about the run and
   survive any route. They are where a case's teeth belong: `empty-selection` without its `refused` still
   fails the run that invents a selection, which was always the failure worth catching.
4. **Never assert the agent's manners.** A case that requires an attempt-and-refusal, a particular screen on
   the way, or a read before acting is asserting etiquette. If better information or a smarter verb removes
   the step, your case goes red for the improvement.
5. **When a case goes red, read the transcript before touching a `describe`.** The transcripts are saved;
   `--save` writes them. Two of the three failures above were visible in four lines of transcript, and one
   of them (the `clear-selection` count) would have been *invisible* in a report that printed a tick.

The counter-rule, so that none of this is read as "loosen the case until it passes": **a case must still be
able to fail the expensive way.** The number must be read and asserted, a commit on the wrong number of rows
must fail, and a commit that was not allowed must fail whatever route produced it. `anyOf` widens *which
path*, never *what moved*. If widening a case would let a false commit through, you are not fixing a case,
you are deleting it.

## Three runs, and a rate rather than a tick

A model is a sampler. One draw reported as a verdict would be the most misleading thing this tool could do, so a
case's headline is `2/3` and a case is green only if **every** run passed. Three is the smallest n that tells
"always" from "sometimes" from "never", and sometimes is not a pass — it is the shape of a `describe` the model has
to guess at. `--runs 1` is allowed and prints a banner saying the number is one draw.

The rate is also what makes diff mode worth having: `1/3 → 3/3` is the commonest shape of a `describe` that got
better, and with ticks it is invisible.

## Diff mode is the actual workflow

Editing a `describe` is the loop this exists for: change the sentence, re-run, see whether selection improved.

```
  FALSE COMMITS          1 → 0
  ────────────────────────────────────────────────────────────
  better      named-contact              0/3 → 3/3
  fewer steps cross-screen               3/3 → 3/3   steps 7 → 4 (-3)
  REGRESSED   navigate                   3/3 → 1/3
```

It exits non-zero on a regression or a **new** false commit, and it says so out loud when the manifest version did
not change between the two runs — because then nothing below it is attributable to your edit, only to sampling. It
says the same when the model changed. Save a baseline before you touch a `describe`
(`--save before.json`), then `--baseline before.json` on the next run to get the report and the diff together.

## It costs money, so it is not a CI check

- **`--dry-run` is the part that belongs in CI.** It validates every case against the live manifest — the verb
  exists, the argument exists and typechecks, the case does not forbid a commit it also expects — and then
  **replays the expected path against the real driver with no model in it** and compares the counts. If the case
  says 112 and the app says 111, that is **fixture drift**, reported as an error, because the number in the file no
  longer describes the app and every count assertion in the suite is now measuring something else. It also lists
  the verbs no case mentions, which is the list of things nothing is watching.
- Running live with `CI` set in the environment is refused unless you pass `--allow-ci`. A verb list that works
  four times in five would make your build red on a Tuesday.
- **Caching** is keyed on (case, manifest version, model, run index), so an unchanged case costs nothing the second
  time, a changed verb list invalidates everything — which is correct, the verb list is what is being measured —
  and raising `--runs` from 3 to 5 reuses the three you paid for and buys two.
  **What is NOT in that key: the system prompt, and anything in the uncached half.** `Manifest.version`
  fingerprints the cached half, so editing `systemPrompt`'s prose, or a screen's `note`, or anything else a
  `visible()` returns leaves the key identical and the cache will hand you back the old transcripts as if you had
  measured your edit. Pass `--no-cache` for those experiments, and treat a diff with no round trips in it as no
  evidence at all.
- A **plan and cost line** prints before the first call: how many runs, how many cached, and the honest upper bound
  of `--max-steps` round trips each. No price is quoted; this package cannot know what your model costs.

## Assertions are exact, which is why the fixture is seeded

238, 410, 112 and 3,412 are assertable numbers because `examples/contacts/app/data.js` generates the same table
every time. Keep that discipline: a count assertion against random data is noise, and a count that drifts should
fail loudly, because it means somebody changed the fixture and the eval has been measuring the wrong thing since.

## Bring your own model, as everywhere else

`runSuite` takes a `think`-shaped function, and the CLI's default is `backendThink("/api/chat")` against the app's
own backend — which already authenticates the person and already holds the key. **This package never reads an API
key, never forwards one and never logs one.** It runs headless against a mounted driver, not a browser, with
`pace: 0`: the demo's store is DOM-free for exactly this reason.

It passes **no `onBeforeCommit`**, and that is the most important line in the harness. A gate would veto exactly the
calls the eval exists to count and report zero false commits forever while the verb list that invites them stayed
broken. Every run gets a fresh driver over fresh data, so the dangerous call is free to happen and costs a fixture
in memory.

## Writing a suite for your own app

1. `evals/app.mjs` exporting `newDriver()` — a freshly mounted driver over freshly built data, every call.
2. One case per failure mode you can name, starting with the ones where **nothing should happen**: an ambiguous ask,
   an empty selection, a thing the app cannot do, a record that does not exist. Breadth of failure mode beats case
   count; ten cases that each catch a different mistake are worth more than forty that catch one.
3. `--dry-run` until it is clean. Every error there is one you would otherwise have paid a model to find.
4. `--runs 3 --save before.json`. Then edit the `describe` you are suspicious of and `--baseline before.json`.
5. Expect the eval to find something about your verb list rather than about the model. That is what it is for:
   the first run of the demo's own suite found that `accept-selected` requires a counted plan token and
   `decline-selected`, which is just as destructive, does not.
