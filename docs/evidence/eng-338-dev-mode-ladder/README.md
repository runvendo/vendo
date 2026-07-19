# ENG-338 — dev-mode model-credential ladder: E2E evidence

Clean-room verification of the wave-2 ladder (install-dx design §2). All runs
on 2026-07-16, macOS, node 24, claude CLI 2.1.211 (claude.ai login), codex-cli
0.144.4 (ChatGPT login). A fresh handcrafted Next 16 app was installed from
locally packed tarballs of every `@vendoai/*` package plus `vendoai` (no
registry), then `npx vendo init --yes` ran against it.

## Rung matrix

| rung | pin | transcript | outcome |
|---|---|---|---|
| env key (anthropic) | `VENDO_DEV_CREDENTIAL=env-key:anthropic` + key from the canonical env file | `transcript-rung-env-key.txt` | native loop over `@ai-sdk/anthropic` → `claude-sonnet-4-6`; full reply |
| claude session | keys unset, `VENDO_DEV_ALLOW_SESSIONS=1` (natural ladder pick) | `transcript-rung-claude.txt` | rider over the Claude Code login; presents as Vendo's agent; lists exactly the vendo tool surface |
| codex session | keys unset, `VENDO_DEV_CREDENTIAL=codex-session` | `transcript-rung-codex.txt` | rider over the ChatGPT login in a private CODEX_HOME (no personal MCP config rides along) |
| none | keys unset, `VENDO_DEV_CREDENTIAL=none` | `transcript-rung-none.txt` | wire shows the generic error part; the server log carries the full honest ladder instructions |

Other captures:

- `transcript-init.txt` — `vendo init --yes` in the clean room: ladder step
  states the found claude session and the consent path; finale hint printed.
- `transcript-finale.txt` — the REAL init finale on the claude rung (TTY
  prompts seamed to yes, everything else live): consent recorded, dev server
  started, browser open captured, adaptive seed picked `on-brand-ui`, and the
  agent introduced itself and executed a real `vendo_apps_create` — a live
  generated app, zero API keys on the machine.
- `transcript-live-riders.txt` — `packages/dev-riders/src/live.test.ts` riding
  both real logins, each with a bridged tool executed through a 2 s parked
  executor (the approval-park shape).

## Reproduce

```sh
# pack every workspace package into tarballs, install into a fresh Next app,
# then: npx vendo init --yes
node run-rung.mjs <label> "<prompt>"   # starts `npm run dev`, waits for
                                       # /api/vendo/status, POSTs one turn,
                                       # prints the streamed reply
node finale-demo.mjs                   # drives the real init finale
```

Rungs are pinned with `VENDO_DEV_CREDENTIAL` (`env-key:anthropic|openai|google`,
`claude-session`, `codex-session`, `vendo-cloud`, `none`); session-rung consent
comes from `vendo init` or `VENDO_DEV_ALLOW_SESSIONS=1`. Session rungs stay
refused when `NODE_ENV=production` even when pinned.

No key material appears in any transcript (keys are sourced from the canonical
env file, never echoed).
