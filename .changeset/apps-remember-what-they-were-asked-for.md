---
"@vendoai/core": patch
"@vendoai/apps": patch
"@vendoai/harnesses": patch
"@vendoai/vendo": patch
---

**Apps remember what they were asked for.** A screen or build run is stateless,
so the ARTIFACT now carries its own context: `AppDocument` gains an additive
`memory` of two parts.

- **`asks`** — every `vendo_make` request that touched this app, VERBATIM and in
  order, the create ask first. Never a paraphrase (a paraphrase drifts the intent
  it exists to preserve) and never the `<context>`-fenced composite an engine is
  briefed with: the memory holds what the PERSON said, so one calling agent's
  background for one call cannot become a standing requirement.
- **`decisions`** — a short block the agent writes through `save_app`'s new
  optional `decisions` field: choices made, constraints found, things ruled out.
  REPLACED on every run that writes one, never appended, because a superseded
  decision presented as a current one is worse than no memory at all.

Both are read back where the next editor actually reads: the edit brain's brief
OPENS with the memory, ahead of the document, and the in-box builder's task
context does the same. Without it an editor meets a deliberately filtered list
and "fixes" it.

Server-written throughout. `AppsRuntime.remember` is the one door that writes
memory (`editor`-gated); a model-authored `memory` is stripped from a generated
document, and an edit pins the stored one. Caps live at that write site rather
than in the schema — the last 20 asks, 1KB of decisions — so a stored row
survives a cap that changes. Reasoning traces, transcripts and tool outputs are
deliberately not stored.
