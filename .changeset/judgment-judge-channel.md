---
"@vendoai/vendo": minor
---

Add the judgment channel: a judge pass, an independent skeptic, and the human
gate on loosenings (`packages/vendo/src/cli/judge/`).

`runJudgmentPass()` reads the deterministic `.vendo/tools.json`, asks a model to
grade it, then asks a SECOND independent run to tear that answer apart, and
writes only what survives into `.vendo/judgments.json`. Not yet wired into
`init`/`sync`/`try` — that is the next change; this one adds the module and its
tests.

The shape follows from one failure mode: a single model pass allowed to grade
capability will confidently justify a grade the code does not support, in either
direction. An over-tight grade silently breaks a working product; a loose one
hands out capability. So:

- the JUDGE proposes, and every proposal costs a VERBATIM quote from the
  handler. No quote, no proposal — rejected at parse and counted in the
  narrative, never discarded silently. One bad proposal cannot fail a whole
  batch of twenty.
- the SKEPTIC is a second run (fresh conversation, same engine) whose only job
  is to check each field against the real source, including whether the quoted
  evidence appears in the file at all. It rejects hardenings as readily as
  loosenings.
- anything the skeptic never examined gets exactly ONE re-ask and is then
  REJECTED, with an honest count. Unexamined never means applied. A proposal
  whose every field is rejected writes no entry at all, so a discredited quote
  is never recorded as provenance.
- survivors route through the direction rule in `@vendoai/actions`: hardenings
  and prose apply themselves; loosenings either aggregate into ONE review diff
  (`loosenings: "review"`) or park as `pending` (`loosenings: "queue"`).

Risk may now move in BOTH directions and a wake-up (`disabled: false`) may be
proposed for a scanner-disabled tool — the old clamp could only refuse those,
so a real finding evaporated into a log line.

The engine ladder merges the two that existed (enrichment's resolver and init's
selection) into one: the credential gate runs first so a keyless repo never
probes a harness, an `--engine` pin never falls back to another provider, and
availability is swept across the whole ladder so the unavailable-pin message can
name the real alternatives. Keyless degrades to one calm line
(`judgment: structural-only …`) with zero errors.

Every model-originated string and every evidence snippet is treated as untrusted
repo content and stripped of C0/C1/DEL control characters before it reaches a
terminal — including the review diff, which is exactly what an attacker would
want to spoof.

Also dedupes `askYesNo`: the copy in `cli/extract/extraction.ts` is removed in
favor of the existing one in `cli/shared.ts` (which additionally guards against
blocking on a non-TTY stdin). Importers updated; no call-site behavior change
for interactive runs.
