# @vendoai/cli

Run the CLI against a host Next.js app to write reviewable `.vendo/` config and wire the app.

## Commands

```text
vendo init [dir]      Set up Vendo in a Next.js app.
vendo refresh [dir]   Fill gaps in an existing install and offer new components.
vendo doctor [dir]    Check the install without writing.
vendo sync [dir]      Report generated build artifacts as current.
vendo telemetry <status|enable|disable>   View or change anonymous usage telemetry.
```

`[dir]` defaults to the current directory.

`init` extracts theme, tools, and selected components into `.vendo/`. It also writes the route handler and provider wiring, copies sandbox assets, and adds the prebuild `sync` command. `refresh` runs the same additive pipeline for an existing install. `doctor` checks keys, wiring, `.vendo/` state, storage, scheduler, and telemetry.

### Safe to re-run

`init` and `refresh` keep the current theme, fill tool gaps, and add only newly selected components. They do not overwrite existing files unless you pass `--force`. Running `init` on an existing install uses the catch-up path.

### Component picker

With a provider key and an interactive terminal, `init` and `refresh` can use model-assisted discovery to offer host components. Selected components become descriptor and sandbox-wrapper pairs under `.vendo/components/`. Non-interactive and `--yes` runs skip the picker.

## Providers and model

The model-assisted steps use the first configured provider in this order:

1. `ANTHROPIC_API_KEY`, default model `claude-sonnet-5`
2. `OPENAI_API_KEY`, default model `gpt-5.5`
3. `GOOGLE_GENERATIVE_AI_API_KEY`, default model `gemini-3.5-flash`

`@ai-sdk/anthropic` is a regular dependency. `@ai-sdk/openai` and `@ai-sdk/google` are optional peers and must be installed when selected.

Override the model with `VENDO_CLI_MODEL` or `VENDO_MODEL`; `VENDO_CLI_MODEL` wins. Both accept `provider/model` or a bare model id. Without a provider key, deterministic extraction still runs. Use `--skip-llm` to skip model-assisted route scanning and component discovery explicitly.

## What `init` emits

- `theme.json`: `BrandTokens` extracted from Tailwind or CSS custom properties and validated against the core manifest schema.
- `tools.json`: the host API surface from OpenAPI, or from model-assisted Next.js route scanning when no OpenAPI document is present. Route-scanned tools default to mutating until reviewed.
- `components/`: descriptor and sandbox-wrapper pairs, plus the bundle entry point and Vite config.

## Flags

- `--skip-llm`: skip model-assisted route scanning and component discovery.
- `--force`: overwrite existing generated files after warning.
- `--yes`: run non-interactively and skip the component picker.
- `--local <dir>`: pack local Vendo packages into `./vendor` before installation.
- `--version`: print the CLI version.
