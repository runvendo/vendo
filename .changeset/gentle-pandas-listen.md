---
"@vendoai/vendo": minor
---

`vendo init` states facts and links out. Every instruction it used to print —
the `<VendoProvider>` mount paste, the AI SDK and Mastra loop snippets, the MCP
client steps, the doctor gate, the agent tail — was a second copy of something
the docs already carry, and a terminal cannot keep a copy correct. The run now
ends on four computed lines: what it wired, what it detected, the guard posture
it left, and one URL for the use case you picked. `--agent` receives the same
facts as structured JSON (`wrote`, `detected`, `guardPosture`, `continueUrl`)
instead of `pasteEdits`.

A backend agent is a real answer to the first question now (`--use-case
backend`), so `vendo doctor` stops demanding a mounted UI from a server-side
install and the run points at the backend quickstart.

The models question decides the wiring. Choosing Vendo Cloud no longer writes
`anthropic("claude-sonnet-4-6")` into your composition because an
`ANTHROPIC_API_KEY` happened to be in your shell — the runtime resolves the
model from `VENDO_API_KEY`, so nothing is written. Choosing your own key writes
the provider line as before. Init records the key its wiring actually reads, and
`vendo doctor`'s E-MODEL-001 now names that one variable instead of listing
three provider keys the resolver never consults.

Nothing prompts after the up-front questions. "Where does this app run in dev?"
moved ahead of the AI pass, the uncertain-theme-slot review is gone (uncertain
slots keep what was extracted and the run says which), and the zod-floor bump
prints its command rather than asking. Every stage spinner carries elapsed time,
and the AI pass says up front that it can take several minutes.

`vendo init --check` / `--no-check` are removed: doctor is a standalone command,
and init succeeds or fails on its own work.
