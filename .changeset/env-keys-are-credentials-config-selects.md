---
"@vendoai/apps": minor
"@vendoai/agents": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
---

**Breaking.** Third-party provider keys no longer select adapters. Pass the
adapter explicitly (`vendo init` now writes it for you) or set `VENDO_API_KEY`.

Env keys are credentials; config selects. A key lying around in the environment
used to choose which sandbox a deployment ran on, which provider it billed, and
which account every app machine's inference went to — decided by nothing anyone
wrote down. `VENDO_API_KEY` is now the only environment variable that fills an
adapter slot you left unset. Every ladder reads the same way: explicit config,
then `VENDO_API_KEY`, then an honest failure that names both ways out.

- **Sandbox.** `E2B_API_KEY` no longer selects the e2b venue. It is the
  credential an explicit `sandbox: e2bSandbox()` reads when you pass no inline
  `apiKey`, and `e2bSandbox()` now refuses at boot — rather than at the first
  box build — when the optional `e2b` package does not resolve from the project.
  An unset `sandbox` slot composes the Cloud sandbox with `VENDO_API_KEY`, or
  nothing. `selectSandbox` drops its e2b rung and its `e2bSpecifier` parameter;
  the `"e2b"` venue string stays in the `/status` union for older wires, but an
  explicit adapter reports `"custom"` like any other.
- **Agent model.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
  `GOOGLE_GENERATIVE_AI_API_KEY` select nothing. They are read by the
  `@ai-sdk/*` provider you construct and pass in `models`. With no `models` and
  no `VENDO_API_KEY`, the first turn says exactly that instead of quietly riding
  a key you set for something else.
- **Box inference.** The `VENDO_INFERENCE_URL` + `VENDO_INFERENCE_KEY` pair wins
  as a pair — both halves or neither — then `VENDO_API_KEY` rides the Cloud
  gateway, then the box gets no inference door. The `ANTHROPIC_API_KEY` rung is
  gone from both `boxInference()` and the Claude Code harness's
  `inferenceEnv()`: a provider key in the deployment's environment used to point
  every box at `api.anthropic.com` and bill that account.
- **Doctor.** `E-LIVE-007` is retired — with no key-selected venue there is no
  such thing as a venue the operator did not ask for, and the boot refusal is
  earlier and louder than a probe. The code stays in the append-only registry
  and keeps its verify-page anchor. `E-LIVE-004` now names the two ways out.

`VENDO_DEV_CREDENTIAL` still pins a credential rung, and is now the only way to
reach an `env-key` rung at all — but it is internal, Vendo's own E2E rung matrix
and escape hatch, not a host knob, and it can change without notice. Your app's
model belongs in `models`.
