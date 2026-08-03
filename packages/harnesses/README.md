# @vendoai/harnesses

Runs any harness safely, and ships `vendo()` — the default in-process thinker.

Who thinks is a swappable adapter. A harness receives a `Turn` (the canonical
transcript, guarded tools, skills, the workspace, model seats) and yields a
closed event vocabulary; this package builds the turn, maps the guard's outcomes,
mirrors tool calls onto the wire, persists the transcript, and puts the app's view
on screen the moment its file parses.

We own state, tools, checks, guard, and skills. The harness owns thinking — and
orchestration is thinking.

Read [Tools and safety](https://docs.vendo.run/concepts/tools-and-safety).
