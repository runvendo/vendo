# genbench

Answers "why not build this in-house?" with numbers.

It runs hand-written prompts through contenders — the real Vendo pipeline today,
raw-Claude baselines later — against one fictional banking product defined
entirely in JSON, scores what comes back with deterministic checks, and measures
time and money. Every contender gets the same model, the same tools, the same
schemas and the same design brief, because that equivalence is the whole claim.

## Run it

```sh
pnpm build                                  # genbench reads the built @vendoai/* dists
ANTHROPIC_API_KEY=… pnpm genbench run --prompt spend-overview
```

Each case writes `runs/<run>/<contender>/<case>/`:

| file | what it is |
| --- | --- |
| `artifact.vendo` | the document the contender actually saved |
| `screenshot.png` | that document rendered through the product's own compile + the Kit |
| `result.json` | the five floor verdicts, timings, tokens and dollars |

and one `runs/<run>/preview.html` — the screenshots side by side under their
verdicts and numbers. It opens automatically on macOS.

Flags: `--prompt <id>` for one case, `--models sonnet,opus,haiku`,
`--lane build` (deferred).

## The world

`world.json` is the entire product: identity, a `VendoTheme`, a plain-English
style rubric, and ~4 tools. A tool that declares `data` returns rows and is
graded `read`; one that only declares `takes` mutates and is graded `write`.
Input schemas are derived from `takes` (a name → type map), output schemas from
the example rows.

**Money is in integer cents**, as the Kit's `format="money"` and the demo host
both expect. This is load-bearing: a world authored in dollars lets a 100×
scale error slip past the fabrication check, which is exactly the bug the
regression test in `src/floor.test.ts` pins down.

`cases.json` holds the prompts. A case may override any tool's data — that is
how the empty state is tested — and its `pass` lines are the correctness rubric
a pinned judge will grade in a later slice.

## The floor

Five deterministic checks, no model involved:

- **delivered** — an artifact came back at all
- **renders** — the compiled screen painted at least one element
- **valid** — the product's *own* checks floor blocks nothing in the saved bytes.
  Not the same as "something painted": the agent can save again after its last
  good view, and the seam keeps the older screen
- **honestData** — every number and date on screen is a value a tool returned,
  or a sum, count, min, max or mean of one numeric field across one tool's rows.
  Nothing else is allowed
- **wiredActions** — every tool the tree names exists, and its arguments fit the
  derived input schema

## Known limits

Charts and generated islands are client-only, so they leave an empty band in a
server-rendered screenshot. Every result counts them (`clientOnly`, `islands`)
and the preview says so out loud, so the gap is never silent — but a shot with a
chart in it does understate what the product built.
