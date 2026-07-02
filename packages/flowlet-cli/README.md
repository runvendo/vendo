# @flowlet/cli

The one-click dev tool (ENG-197). Run against a host codebase; writes only into `.flowlet/`, never touches existing code.

```
flowlet init [dir] [--skip-llm] [--force]   extract theme, tools, components
flowlet publish [dir]                       stub until the registry ships (ENG-198)
```

`flowlet init` emits the three Decision-3 artifacts:

- `theme.json` — `BrandTokens`, from Tailwind v4 `@theme` / CSS custom properties / Tailwind v3 JS config, validated against `@flowlet/core`'s `manifestThemeSchema`. Unmappable slots fall back to defaults and are flagged in the report.
- `tools.json` — the host API surface as manifest tools (frozen `@flowlet/core` schemas: `{mutating, dangerous, idempotent?}` annotations, `{type:"http", method, path}` bindings). OpenAPI spec when present (deterministic); LLM route scan of Next.js `app/api/**/route.ts` as fallback. Developer-editable; invalid entries are dropped with warnings, never emitted.
- `components/` — descriptor + sandbox wrapper pairs (`RegisteredComponent`, `source: "host"`) discovered by LLM analysis, plus `entry.ts` (fills the `window.__FLOWLET_HOST__` bundle contract) and `vite.config.mts` (`flowletHostPreset` + re-rooted host tsconfig aliases). Generated TSX is syntax-checked; one repair round-trip on failure.

LLM steps need `ANTHROPIC_API_KEY` (model override: `FLOWLET_CLI_MODEL`, default `claude-sonnet-4-6`); without it, `init` runs the deterministic extractors and reports what was skipped.

`flowlet publish` validates `.flowlet/tools.json` and prints the sha256 a real publish would key on. The cloud registry is ENG-198; embedded hosts read `.flowlet/` from disk and never need publish.

Ground-truth run + fidelity report: `docs/superpowers/specs/2026-07-02-flowlet-eng197-extraction-fidelity-findings.md`.
