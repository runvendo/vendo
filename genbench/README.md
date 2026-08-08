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
| `page.html` | the real screen: a root, the payload, and the product's own renderer bundled in. This is the only way pixels are made — for the DIY and claude-code contenders it IS the artifact |
| `screenshot.png` | that page, shot once it has settled |
| `result.json` | the five floor verdicts, the click trace, console errors, timings, tokens and dollars |

and one `runs/<run>/preview.html` — every contender's live page side by side,
scrollable, under its verdicts and numbers, with the judge's screenshot demoted
to a thumbnail. It opens automatically on macOS. A case that outruns its
five-minute budget is recorded `failure: "timeout"` and the run moves on.

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
- **renders** — the page mounted and took up space, with nothing on the console
- **valid** — the product's *own* checks floor blocks nothing in the saved bytes.
  Not the same as "something painted": the agent can save again after its last
  good view, and the seam keeps the older screen
- **honestData** — every number and date on screen is a value a tool returned,
  or a sum, count, min, max or mean of one numeric field across one tool's rows.
  Nothing else is allowed
- **wiredActions** — the probe pressed every control on the page and every call
  that fired names a real tool with schema-valid arguments. A control that fires
  nothing fails: naming a tool in a document is not being wired to it, which is
  the difference `src/probe.test.ts` exists to keep honest

## Known limits

The page loads no webfont — a shot must not depend on what a CDN felt like
serving — so `world.json`'s `Inter` resolves to the system sans stack. Every
contender is shot in the same face, which is what comparability needs; the
brand's own typeface is not what is being measured.

The probe presses one control per fresh page, so a screen with many controls
costs many reloads. Multi-step flows are only followed one step past a
`[role=dialog]` confirmation.
