---
"@vendoai/store": major
---

**BREAKING:** `workspaceBash()` is removed from `@vendoai/store`, with its
`BashRun` and `WorkspaceBashSetup` types.

It was written as "the canonical in-process bash setup over a workspace" and
then never wired to anything. The only harness that runs real bash runs it
INSIDE a box (`claudeCode()`, where the box's own shell and its own `/tmp` are
real), and the machine-less harness (`vendo()`) hands the model AI-SDK tools,
not a shell — so the `/tmp` alias and the refusal-to-exit-code translation
existed for zero callers, in this repo and in the console.

Nothing in Vendo imported it and it was never documented as public API (absent
from the store README, from `docs/`, and from the archived store contract), so
the realistic blast radius is nil — but it was an exported symbol, and removing
one is a breaking change whether or not anybody held it.
