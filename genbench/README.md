# genbench

Answers "why not build this in-house?" with numbers.

It runs hand-written prompts through contenders — the real Vendo pipeline and a
raw-Claude baseline today, `claude-code` next — against one fictional banking
product defined entirely in JSON, scores what comes back with deterministic
checks, and measures time and money. Every contender gets the same model, the
same tools, the same schemas and the same design brief, because that equivalence
is the whole claim.

## The contenders

| contender | what it is |
| --- | --- |
| `vendo` | the real product: the screen assembler, the guard, the apps runtime, the compiler and the Kit. Its artifact is a `.vendo` document, and the page is that document mounted through the product's own renderer |
| `diy` | the in-house build: ONE `streamText` call, one HTML document, no product. Its artifact IS the page — no compile, no Kit, no mount |

Both are handed the same thing, and that is asserted rather than asserted-to-be:
`src/diy.test.ts` compares the prompt the diy driver really put on the wire
against the design brief the vendo driver composes (`hostDesignBrief`), the
descriptors its registry serves, and the responses that registry really returns
— byte for byte. If either side drifts, the test fails and the comparison is
void. It is the benchmark's credibility, so it is the first test to read.

Both pages then carry the SAME injected recorder (`seam` in `src/render.ts`), so
`window.vendo.callTool` means one thing whoever wrote the page, and the same
screenshot, the same click probe and the same floor code run after that point.

Every contender for a case runs **at once**. They share the browser and nothing
else — a page each, a meter each, a clock each — and one contender's crash or
five-minute timeout is recorded as its own failure without touching its
siblings. Column order is the declaration order in `DRIVERS`, never the order
they finished.

## Run it

```sh
pnpm build                                  # genbench reads the built @vendoai/* dists
ANTHROPIC_API_KEY=… pnpm genbench run --prompt spend-overview
```

Each case writes `runs/<run>/<contender>/<case>/`:

| file | what it is |
| --- | --- |
| `artifact.vendo` | the document the contender actually saved (vendo only — for a contender that writes HTML, `page.html` IS the artifact) |
| `page.html` | the real screen: for vendo a root, the payload and the product's own renderer bundled in; for diy the document it wrote. This is the only way pixels are made |
| `screenshot.png` | that page, shot once it has settled |
| `result.json` | the five floor verdicts, the click trace, console errors, timings, tokens and dollars |

and one `runs/<run>/preview.html`, which is where a person actually looks:

- **one section per case**, its prompt as the heading
- **a column per contender**, in a fixed order, each live and scrollable under
  its own verdicts and numbers, with the judge's screenshot demoted to a
  thumbnail
- **the world-data panel** — collapsed: every tool the case's screens could
  call, what it does, and the exact response it answers with, overrides
  applied. It is what makes any number on any screen checkable by eye
- **the tool-call feed** — pinned to the bottom. Press anything in any embedded
  screen and the call it fired lands there, tagged with the contender whose
  frame fired it: `14:32:05 · diy-sonnet · cancel_transfer {id: tr_1}`. A
  control that fires nothing writes nothing, which is the same verdict the floor
  reaches

It opens automatically on macOS and stays one static file — no server, offline,
forever. A contender that outruns its five-minute budget is recorded
`failure: "timeout"`; its siblings finish normally.

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
  good view, and the seam keeps the older screen. A contender with no compile
  step has nothing to block, so for `diy` this check collapses onto `delivered`
  — the checks that do the work on a hand-written page are `renders`,
  `honestData` and `wiredActions`, and all three are the same code
- **honestData** — every number and date on screen is a value a tool returned,
  or a sum, count, min, max or mean of one numeric field across one tool's rows.
  Nothing else is allowed
- **wiredActions** — the probe pressed every control on the page and every call
  that fired names a real tool with schema-valid arguments. A control that fires
  nothing fails: naming a tool in a document is not being wired to it, which is
  the difference `src/probe.test.ts` exists to keep honest

## What honestData does not read

Two things are cut out of the text the fabrication check grades, both of them
things a chart writes to measure with rather than to say. The cut is made in the
browser, by hiding the containers before reading `document.body.innerText` and
restoring them before the screenshot, so the *picture* is untouched:

- **`.recharts-cartesian-axis-tick-labels`** — the scale. A chart of the
  spending case draws `$0.00 / $750.00 / $1,500.00 / $2,250.00 / $3,000.00` down
  its axis, and not one of those is a value any tool returned. Graded, every
  honest chart fails; ungraded, the check keeps its meaning everywhere else.
- **`#recharts_measurement_span`** — an offscreen scratch pad at `top:-20000px`
  holding the last string recharts sized. No human has ever seen it, and
  `innerText` reports it anyway.

**The cost, stated plainly:** the exclusion is a whole tick layer, so the
category axis goes with the scale. A number or date that appears **only** on a
chart axis and nowhere else on the screen is therefore not graded. Everything
else still is — a fabricated number in the screen's own copy fails exactly as
before. `src/axis.test.ts` pins both halves in a real browser: it proves the
labels really are in the page's own text, really would fail, are gone from the
extraction, and that the screen's own copy is still caught. It fails loudly if
recharts ever moves that text.

## Known limits

`world.json` names **Onest**, the face the product itself vendors
(`packages/ui/src/chrome/onest-font.gen.ts`), so the style rubric asks for the
brand's real typeface rather than a font this repo has nothing to do with. The
page still loads no webfont — a shot must not depend on what a CDN felt like
serving — and `ONEST_FONT_CSS` is not on any public entry of `@vendoai/ui`, so
Onest resolves to the system sans stack, exactly as `Inter` did. **The
typography line of the style rubric is therefore still not gradeable from
pixels.** Every contender is shot in the same face, which is what comparability
needs.

Changing the font changed `world.hash`, so runs from before this slice do not
compare with runs after it.

The probe presses one control per fresh page, so a screen with many controls
costs many reloads. Multi-step flows are only followed one step past a
`[role=dialog]` confirmation.
