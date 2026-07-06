# @vendoai/cli

The one-click dev tool (ENG-197). Run against a host Next.js app; writes reviewable config into `.vendo/`, wires the app, and never rewrites your existing code without certainty.

## Commands

```
vendo init [dir]      Set up Vendo in a Next.js app (run once). Interactive.
vendo refresh [dir]   Catch up an existing install; offers only what is new.
vendo doctor [dir]    Check the install (read-only).
vendo sync [dir]      Capture wrapped-component source + rebuild the sandbox (runs in your build).
vendo publish [dir]   Validate and (soon) publish the manifest — stub until ENG-198.
vendo telemetry <status|enable|disable>   View or change anonymous usage telemetry.
```

`[dir]` defaults to the current directory.

`init` sets up: it extracts theme, tools, and components into `.vendo/` and wires the app (route handler, provider, sandbox assets, prebuild `sync`). It is interactive — it prompts for a provider key, offers a picker of host components to wrap, and a picker of widgets to make remixable. `refresh` is the catch-up: the same additive pipeline, run whenever your app has grown, offering only what is new. `doctor` is a read-only health check. `sync` is silent build-time maintenance that `init` wires into your `prebuild`.

### Safe to re-run

`init` and `refresh` share one additive code path: your theme is kept, tools are gap-filled, only new components are wrapped, only unanchored widgets are offered. Nothing is overwritten. Run `init` on an already-wired app and it behaves like `refresh`. Added a provider key later, or grew your API? Just re-run — `vendo refresh` (or `vendo init`) picks up what changed. `--force` replaces existing `.vendo/` and sandbox files, and warns before overwriting.

### The two pickers and remix anchors

With a provider key present and an interactive terminal, `init`/`refresh` open two pickers:

- **Components** — host components discovered by LLM analysis, wrapped as descriptor + sandbox-wrapper pairs under `.vendo/components/` so generated UI can compose them.
- **Remix** — widget-shaped client components your end users might want to customize. Each pick is wrapped in a `<VendoRemix id label>` anchor in your source, so users can remix that widget on your live site. Because it edits your source, this step is human-gated: it is skipped under `--yes` and in non-TTY/CI runs (which print a by-hand hint instead). `vendo sync` captures baselines for wrapped widgets on your next build; an anchor without a `context` prop falls back to a DOM-snapshot baseline.

### Health check

`vendo doctor` reports on keys, model override, wiring, `.vendo/` state, storage, scheduler, and telemetry. It never writes. Hard failures (missing route handler or vendo-root, unwrapped layout, uninstalled dependency, an override naming an unknown provider while a key is set) exit non-zero; degraded-but-functional conditions are warnings.

## Providers and model

The CLI's LLM-assisted steps read the same three provider keys as the runtime, in this precedence:

1. `ANTHROPIC_API_KEY` — default model `claude-sonnet-5`
2. `OPENAI_API_KEY` — default model `gpt-5.5`
3. `GOOGLE_GENERATIVE_AI_API_KEY` — default model `gemini-3.5-flash`

`@ai-sdk/anthropic` is a regular dependency; `@ai-sdk/openai` and `@ai-sdk/google` are optional peers — resolving to one without its package installed fails fast with an actionable `npm i` hint, not a silent fallback.

Override the model with `VENDO_CLI_MODEL` (CLI-only) or `VENDO_MODEL` (shared); `VENDO_CLI_MODEL` wins. Both accept `provider/model` (picks the provider outright) or a bare model id (applied to whichever provider key is set). A model id alone is not a credential: with zero provider keys the LLM steps are skipped and the deterministic extractors still run.

Without a key, `init` runs the deterministic extractors (theme tokens, OpenAPI tools, `.vendo/README.md`, Next.js wiring) and reports what it skipped, or pass `--skip-llm` to skip the assisted steps explicitly.

## What `init` emits

- `theme.json` — `BrandTokens`, from Tailwind v4 `@theme` / CSS custom properties / Tailwind v3 JS config, validated against `@vendoai/core`'s `manifestThemeSchema`. Unmappable slots fall back to defaults and are flagged in the report.
- `tools.json` — the host API surface as manifest tools (frozen `@vendoai/core` schemas: `{mutating, dangerous, idempotent?}` annotations, `{type:"http", method, path}` bindings). OpenAPI spec when present (deterministic); LLM route scan of Next.js `app/api/**/route.ts` as fallback (route-scanned tools are all marked mutating so they fail closed until you review them). Developer-editable; invalid entries are dropped with warnings.
- `components/` — descriptor + sandbox wrapper pairs (`RegisteredComponent`, `source: "host"`), plus `entry.ts` (`window.__VENDO_HOST__` bundle contract) and `vite.config.mts` (`vendoHostPreset` + re-rooted host tsconfig aliases). Generated TSX is syntax-checked with one repair round-trip on failure.

## Flags

- `--skip-llm` — skip LLM-assisted steps (route scan, component/remix discovery)
- `--force` — overwrite existing `.vendo/` files (init/refresh; warns first)
- `--yes` — non-interactive: no prompts; resolve keys from env / `.env.local` only; skip the pickers (source edits stay human-gated)
- `--local <dir>` — pack local `@vendoai` packages from a Vendo monorepo into `./vendor`
- `--version` — print the CLI version

`vendo publish` validates `.vendo/tools.json` and prints the sha256 a real publish would key on. The cloud registry is ENG-198; embedded hosts read `.vendo/` from disk and never need publish.
