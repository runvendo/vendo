---
"@vendoai/vendo": minor
"@vendoai/harnesses": minor
---

The selection law leaves a way out: the migration surface for "env keys are
credentials, config selects".

`vendo init` writes the `models:` line again. It resolved the key through the
runtime credential ladder, which by design stopped answering for a bare provider
key — so the one thing that turns a host's existing key into explicit config
became unreachable, and the detection now reads the environment directly. The
`--byo` paste is covered too: that key arrives during the cloud step, after the
composition was planned and before anything is written, so the run re-renders
the composition it authored instead of saving a key that selects nothing. The
closing summary no longer advises setting a model key on a run that just wrote
one.

The provider init writes an import for is the provider it installs. `ensureProviderDeps`
asked the runtime credential which `@ai-sdk/*` package the host needs, and a bare
provider key is `rung: "none"` — so a fresh host with only `OPENAI_API_KEY` (or a
Google key) had an `@ai-sdk/openai` import written into its route and nothing
installed to satisfy it, and the app could not build. It now covers both answers:
what a runtime turn loads, and what this run actually wrote.

`vendo sync --ai` stops telling a developer to set the key they already set. Its
credential gate ran on the runtime resolver alone, so a machine whose only
credential is `ANTHROPIC_API_KEY` was told "set ANTHROPIC_API_KEY" while the
harnesses that authenticate with exactly that key were never probed. The gate now
also reads the provider keys a rung runs on, which is what makes the message
honest: it can only be reached when every credential it names is genuinely
absent.

`claudeCode({ machine: "local" })` fails loudly with no model. That machine
REPLACES the subprocess environment, so a deployment whose only credential was a
provider key now hands the session nothing — intended, but it used to die deep
inside the SDK. It names both ways out, explicit endpoint first: the
`VENDO_INFERENCE_URL` + `VENDO_INFERENCE_KEY` pair, or `VENDO_API_KEY` for the
Cloud gateway.

The `mastra-agent` example composes its models explicitly instead of expecting
the environment to pick one, and the docs that still described env-resolved
selection say what the code does.
