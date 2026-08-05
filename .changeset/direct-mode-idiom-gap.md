---
"@vendoai/core": patch
"@vendoai/apps": patch
---

Closes the two gaps behind #822's defect 1 (the canonical "compare weather in
three cities" dashboard failing persistently on the BYO default model):

- **The brain's direct-mode prompt now teaches the wire's real constraints.**
  `brainPrompt` had almost no dialect-syntax teaching for a direct (single-shot)
  answer — the fill-worker prompt had it, but a "tiny ask" never reaches a
  worker. The model reached for JS idioms the wire rejects: a method-call tool
  name (`cities.map`, `Math.round`), braces as text interpolation, and a loop
  variable with no declared query behind it. `brainPrompt`'s rules now say so
  explicitly, and that a fixed small set of named rows reads by array
  position off its query, never a loop.
- **A direct answer that fails to compile now gets a retry.** `conductCreate`
  had a fix-it loop for every other outcome (`checkAndFix`, bounded at
  `FIX_ROUNDS`) except this one: a direct answer with ANY compile mistake
  (unknown tool, braces-in-text, an undeclared reference) returned
  `kind: "failure"` on the very first try, with no chance to self-heal from
  the compiler's own message. It now retries up to `FIX_ROUNDS` times, feeding
  the brain its own wire and exactly what was wrong with it — the same
  teaching-sentence discipline `fixInstruction` already uses.
- **The wire's "unknown-reference" issue now names the declared queries**, the
  same way "unknown tool" already lists the real tools — a retry (from either
  fix above) gets something to pick from instead of guessing again.
