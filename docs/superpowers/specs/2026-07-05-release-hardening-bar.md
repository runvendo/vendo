> Historical session record (frozen). Describes the repo at its date; may not match current code.

# Release Hardening Bar (draft — pending Yousef's edits)

What "release-ready" means for the OSS surface. Every finding from the hardening audit
is judged against this list. If it doesn't block an item here, it's post-launch.

## Scope

**In:** the 12 publishable packages (`packages/*`), the `vendo init` install flow, and public docs.
**Out (for this effort):** demo apps except as test beds, the Gmail clone, cloud runtime, enterprise features.

## Critical flows — must work flawlessly

1. **Install:** `vendo init` on a fresh Next.js App Router app → route handler, provider wrap,
   env example, sandbox assets — with only an `ANTHROPIC_API_KEY`. Deterministic path (no key) also works.
2. **First render:** embedded agent answers a prompt and renders generated UI in the sandbox, brand-native.
3. **Host tools:** agent calls a host OpenAPI tool as the user; approval/consent flow for gated tools.
4. **Automations:** create → approve → run (scheduled and run-now) → survives server restart (PGlite and Postgres).
5. **Saved vendos:** save, reopen from library, live refresh.
6. **Remix / edit view:** pin edits apply fast and correctly.
7. **Voice:** connect, speak, get refreshed views; clean disconnect.
8. **MCP client:** connect an external MCP server, use its tools with approvals.
9. **Provider choice:** the above works with OpenAI and Google keys, not just Anthropic.

## Quality bar

- `pnpm typecheck`, `pnpm test`, `pnpm lint` green on main.
- No silent failures on critical paths: errors surface to the user in friendly form, never raw in the DOM, and fail closed.
- Public API surface (exports, config options, handler signatures) is coherent across packages and matches the docs.
- No secrets, keys, or internal URLs in published package output.

## UI consistency bar

- All shell surfaces (tabbed page, overlay, slot, stage) match Brand.md tokens in host apps.
- Components render consistently in light and dark, inside the sandbox.
- Loading/thinking/error/empty states exist and look intentional on every surface.
- Consent and approval cards are visually unified (ApprovalCard everywhere).

## Exit check

One full manual pass of flows 1–9 in a real browser, screenshots attached, after the last fix wave merges.
