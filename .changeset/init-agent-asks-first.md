---
"@vendoai/vendo": minor
---

`vendo init --agent` asks first and then writes, instead of printing a plan nobody could act on.

Init has one personality in every mode now: it detects, asks, logs in, and writes. Agent mode only changes how the questions TRAVEL. Init emits them as JSON, the coding agent relays them in chat, the answers come back as flags on a re-run, and that run writes.

The first `--agent` call runs detection and, if anything a person must decide is still open, prints ONE object and touches nothing: `{"status": "questions", "detected": {…}, "questions": [{id, prompt, options}]}`. Each prompt is chat copy an agent relays verbatim, and each option carries the literal thing the agent does to pick it, a `flag` for the re-run or a `command` to run before it. There is no select-vs-confirm machinery: yes/no is two options. The set is use-case, auth and models, plus the sign-in posture and the service key once the use case is MCP. A call that already carries every answer skips the question pass and writes in one go.

Both passes exit 0. `status` is what a caller branches on, the same idea as `doctor --json`. The write pass ends in a receipt: `{"status": "written", root, useCase, wrote, pasteEdits, tools, riskRecommendations, judgment}`. `judgment` is always `{"status": "delegated"}` with the checklist of what the catalog still needs, because the caller IS a coding agent and agent mode may not spawn another one underneath it.

**The read-only plan dump is retired.** There is no mode that prints code diffs and stops, and there is no `--plan` flag. No new flags were added for any of this either: `--use-case`, `--auth`, `--cloud-key`, `--byo`, `--posture` and `--service-key` all already existed and already validated.

Nothing mechanical is ever relayed. The deploy URL, the zod floor, the theme slots and the live check take the same defaults `--yes` gives them and show up in the diff. The interactive terminal flow is unchanged.

Two wording fixes ride along: `--byo` now states what your own key needs instead of pointing back at `vendo login`, which made the opt-out read as a detour rather than a first-class path; and the packaged `vendo-setup` skill teaches the new flow.
