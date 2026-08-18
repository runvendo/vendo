---
"@vendoai/vendo": patch
---

A human typing `npx vendo init` is a human, not a script. `npx`/`npm exec` runs
its target as a synthetic package script literally named `npx`, and the CLI read
any `npm_lifecycle_event` as proof a lifecycle hook had started the run — so the
command every doc prints came up mute: the use-case question, the auth confirm,
the deploy URL and the AI-grading consent were all skipped and the run silently
took "embedded". Only that one synthetic name is exempt now; real hooks
(`predev`, `postinstall`, any `npm run …`) keep their exemption, and the TTY
requirement is unchanged, so CI and piped runs stay as quiet as they were.
