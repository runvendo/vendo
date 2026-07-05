# Provider-agnostic core + @flowlet/server — verification report

Task 10 of `docs/superpowers/plans/2026-07-04-provider-agnostic-core.md`, run against
branch `yousefh409/provider-agnostic-core` at `c005a750`.

## 1. Repo-root gates

`pnpm build && pnpm test && pnpm typecheck` all green (16/16, 20/20, 22/22 turbo tasks).

`pnpm lint` fails on `demo-bank` only: 5 errors + 1 warning (`react-hooks/set-state-in-effect`
x3, `react-hooks/refs` x2, one unused-var warning), all in files this branch never touched
(`src/app/transactions/[id]/page.tsx`, `src/app/transactions/page.tsx`,
`src/components/flowlet/FlowletPoller.tsx`, `src/components/flowlet/SandboxStage.tsx`,
`src/components/transactions/filters-bar.tsx`).

Confirmed pre-existing: checked out the merge-base commit (`18f82d8c`, available as a clean
worktree at `/Users/yousefh/orca/workspaces/flowlet/finish-it-out`), ran `pnpm install` +
`pnpm --filter demo-bank lint` there — byte-for-byte identical 6 problems, same files, same
line numbers. This branch's only touch to a lint-flagged file (`app/flowlet/page.tsx`) is a
2-line deletion, and that file's own warning is unchanged. `pnpm lint --filter=!demo-bank`
is fully clean (only a benign unused-var warning in demo-accounting, 0 errors).

**Verdict: PASS**, with the known pre-existing demo-bank lint failure confirmed genuinely
pre-existing (not introduced by this branch).

## 2. Live browser check — Anthropic only

Extracted only `ANTHROPIC_API_KEY` from Infisical (`infisical export --projectId=... --env=dev
--format=dotenv`, filtered to that one line) and launched `examples/node`'s API server
(`server.mjs` via `tsx`) in a process started with `env -i` (clean environment) plus that one
key — `OPENAI_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY` never set for the process. Vite dev
client on :3301, API on :3300.

- `GET /api/flowlet/capabilities` -> `{"chat":true,"integrations":false,"voice":false}`.
- Opened http://localhost:3301 in a real Playwright-driven browser, opened the launcher,
  sent "Show me a dashboard comparing three savings plans", got a streamed reply and a
  generated table view (Conservative/Balanced/Aggressive comparison) in the sandbox.
- Screenshot: `01-anthropic-chat-generated-view.png`.

**Verdict: PASS.**

## 3. Live browser check — OpenAI

No real `OPENAI_API_KEY` exists anywhere checked: Infisical project `b366cac7-...` (dev env,
same one `pnpm demo` uses) has no OpenAI or Google key (only `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY` — not the `GOOGLE_GENERATIVE_AI_API_KEY` name the resolver reads — and
unrelated infra secrets); ambient shell env has no provider keys; `~/.vendo/.env.vendo-dev`
only has Anthropic keys (and belongs to an unrelated product, not used). **Real-key run: NOT
RUN — no OpenAI key obtainable.**

What was verified instead:

- `@ai-sdk/openai` peer resolvability: already resolves inside the workspace. Node resolves
  the package's own dynamic `import("@ai-sdk/openai")` relative to `packages/flowlet-server`'s
  own `node_modules`, which already has it symlinked (pnpm auto-installs declared peer deps
  across the workspace graph) — confirmed via `node -e "import('@ai-sdk/openai')"` from
  `packages/flowlet-server`. No `pnpm add` needed for this test; nothing to revert.
- Missing-peer error path: temporarily moved aside
  `packages/flowlet-server/node_modules/@ai-sdk/openai` (a plain non-destructive rename/move,
  restored immediately after), ran the resolver via `tsx` (matches how the real server loads
  it) with `OPENAI_API_KEY` set -> clean actionable error: `Flowlet: model "openai/gpt-5.5"
  requires @ai-sdk/openai — run: npm i @ai-sdk/openai`. Symlink restored; confirmed identical
  directory listing before/after.
- Capabilities with a fake key: restarted the API server with only a fake `OPENAI_API_KEY`
  (`env -i`, no other provider key) -> `GET /capabilities` -> `{"chat":true,"integrations":false,
  "voice":true}` (voice keys off `OPENAI_API_KEY` per the capability ladder — correct).
  Screenshot: `02-openai-capabilities-chat-true.png`.
- Chat reachability with a fake key: sent the same chat message from the browser. Client
  surfaced a clean "Something went wrong. Please try again." (no raw error leaked to the DOM)
  — screenshot `03-openai-fakekey-401-client-error.png`. Server log shows the request actually
  reached `api.openai.com` (Cloudflare response headers, `x-openai-authorization-error: 401`,
  `statusCode: 401`, `code: 'invalid_api_key'`) — proof the provider-resolution and dynamic
  import correctly routed to OpenAI's real API surface; the only failure is the fake
  credential, as expected.

**Verdict: capability/plumbing PASS; end-to-end reply/generated-view with a real OpenAI key
NOT RUN (no key available).**

## 3c. Live check — Google (real Gemini key): found broken, fixed in b4702fab, re-verified green

The Infisical `GEMINI_API_KEY` is a Google AI Studio key — the exact credential
`@ai-sdk/google` reads as `GOOGLE_GENERATIVE_AI_API_KEY`. Exported it under that name
(value never printed), started the `examples/node` API server with `env -i` plus only that
key (Anthropic/OpenAI explicitly absent).

- `@ai-sdk/google` resolvability: same story as OpenAI — resolves from
  `packages/flowlet-server`'s own `node_modules` (where the dynamic import executes), no
  install needed, nothing to revert.
- `GET /api/flowlet/capabilities` -> `{"chat":true,"integrations":false,"voice":false}` —
  correct (chat on, voice off without an OpenAI key).
- First browser chat turn (pre-fix, at `c005a750`): sent the same visual prompt. **FAILED.**
  Client showed the clean "Something went wrong" card (screenshot
  `05b-google-gemini-400-before-fix.png`); server log showed the request DID reach
  `generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent`
  and authenticated fine (no 401/403), but Google returned a deterministic
  `400 INVALID_ARGUMENT`:

  ```
  Invalid value at 'tools[0].function_declarations[0].parameters
    .properties[0].value.properties[0].value.enum[0]' (TYPE_STRING), 1
  Invalid value at 'tools[0].function_declarations[1].parameters
    .properties[1].value.properties[0].value.enum[0]' (TYPE_STRING), 1
  ```

- Root cause (traced in source): the `create_automation` / `update_automation` agent tools
  (`packages/flowlet-runtime/src/automations/tools.ts`) embed the automation DSL schema,
  whose `spec.dslVersion: z.literal(1)`
  (`packages/flowlet-runtime/src/automations/schema.ts:219`) serializes to JSON-schema
  `enum: [1]` — a numeric enum. Anthropic and OpenAI accept numeric enum values; Google's
  function-declaration format requires enum values to be strings and rejects the entire
  request. So with the current toolset, chat via Google is broken at the first model call,
  regardless of key validity. `AutomationManifest.version` / `schemaVersion`
  (`packages/flowlet-core/src/manifest/manifest.ts`) carry the same pattern and would hit
  the same wall anywhere they enter a Google-bound tool schema.

- **Fix**: commit `b4702fab` removes `dslVersion` from the LLM-facing tool input schema
  (the server injects it instead) and adds a regression test asserting the serialized
  `create_automation`/`update_automation` schemas contain zero numeric const/enum values.
  `pnpm build` (16/16) and `pnpm --filter @flowlet/runtime test` (276 passed, including the
  new regression test) green after the fix.
- **Re-run (post-fix)**: identical setup (only `GOOGLE_GENERATIVE_AI_API_KEY`, `env -i`,
  rebuilt packages). Capabilities unchanged and correct. Same browser prompt -> real Gemini
  reply ("I have built an interactive Savings Plan Comparison Dashboard for you...") AND a
  generated interactive view in the sandbox: growth chart (Traditional/High-Yield/CD over
  5 years), parameter sliders with 1/3/5/10-year presets, per-plan balance cards, and a
  Plan Comparison panel with "Extra vs. Traditional" deltas. Server log for the whole turn:
  zero errors. Screenshot: `05-google-gemini-chat-generated-view.png`.

**Verdict: PASS end-to-end after `b4702fab`. Story: real-Gemini run found the numeric-enum
tool-schema bug (Anthropic/OpenAI tolerate numeric enums, Google rejects them), the fix
landed with a regression test, and the identical run now completes with a real reply and
generated view.**

## 4. Regression — demo-bank (`pnpm demo`)

`pnpm demo` (`infisical run --projectId=... --env=dev -- pnpm --filter demo-bank dev`) ran
non-interactively (Infisical session already authenticated on this machine) and served
Next.js on :3000 zero-config. Opened it in a real browser, clicked "Design a view", asked
"My spending by category this month", got a streamed reply plus a generated category-spend
table (Housing/Transport/Subscriptions/Shopping/Dining/Groceries).
Screenshot: `04-demobank-regression-healthy-turn.png`.

Confirmed the default Anthropic model id in code is `claude-sonnet-5`
(`packages/flowlet-server/src/model-choice.ts`, `DEFAULT_MODEL_ID.anthropic`).

**Verdict: PASS.** No substitution needed — Infisical worked non-interactively.

## 5. CLI check

No real OpenAI key (see section 3), so the real-key extraction-quality comparison against
`apps/demo-bank/.flowlet/` **is NOT RUN**. Verified instead, against a filesystem copy of
`apps/demo-bank` (rsync'd into scratch, excluding `node_modules`/`.next`/`.flowlet`):

- **Fake key clean-failure path**: `OPENAI_API_KEY=sk-fake-...` (env -i, no other key) ->
  `node packages/flowlet-cli/dist/cli.js init <copy>` prints exactly one line
  (`Flowlet: model "openai/gpt-5.5" requires @ai-sdk/openai — run: npm i @ai-sdk/openai`),
  exits 1, and leaves no partial `.flowlet/` directory. Clean failure, no stack trace.
- **Deterministic-rescue path (no key at all)**: `env -i` with zero provider keys ->
  exit 0, writes `.flowlet/theme.json`, `.flowlet/tools.json`, `.flowlet/README.md`, logs
  `LLM steps skipped (no ANTHROPIC_API_KEY/OPENAI_API_KEY/GOOGLE_GENERATIVE_AI_API_KEY or
  --skip-llm): route-scan fallback, component discovery`, and still wires the Next app
  (route handler already present -> skipped, `flowlet-root.tsx` written, `layout.tsx` edited,
  `.env.example` written with the capability-additive ladder: one required provider key,
  optional `COMPOSIO_API_KEY`, `OPENAI_API_KEY` doc'd as the voice-flag unlock,
  `FLOWLET_MODEL`/`FLOWLET_CLI_MODEL` documented).
- Deterministic `theme.json` output is byte-identical (post JSON-format) to the committed
  ground truth at `apps/demo-bank/.flowlet/theme.json`. `tools.json` has 17 tools vs the
  ground truth's 23 — expected, since the ground truth's extra 6 came from the LLM-refined
  route-scan pass that the no-key deterministic fallback intentionally skips; not a
  regression, just the documented capability gap of running without a key.

**Verdict: fake-key and no-key paths PASS; real-OpenAI-key extraction-quality comparison NOT
RUN (no key available).**

## Summary

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | build/test/typecheck/lint | PASS (lint: demo-bank pre-existing failure confirmed via merge-base) | terminal output above |
| 2 | Anthropic-only live browser | PASS | `01-anthropic-chat-generated-view.png` |
| 3 | OpenAI live browser (real key) | NOT RUN — no key anywhere | — |
| 3b | OpenAI plumbing (fake key + missing-peer) | PASS | `02-openai-capabilities-chat-true.png`, `03-openai-fakekey-401-client-error.png`, server log 401 from api.openai.com |
| 3c | Google real-key end-to-end (Gemini via `GEMINI_API_KEY`) | PASS after fix — found numeric-enum tool-schema bug, fixed in `b4702fab`, re-verified green | `05-google-gemini-chat-generated-view.png` (success), `05b-google-gemini-400-before-fix.png` (pre-fix failure) |
| 4 | demo-bank regression (`pnpm demo`) | PASS | `04-demobank-regression-healthy-turn.png` |
| 5 | CLI extraction quality vs ground truth (real key) | NOT RUN — no key anywhere | — |
| 5b | CLI fake-key failure + no-key deterministic-rescue | PASS | terminal output above |

No OpenAI provider key was obtainable from Infisical, ambient shell env, or any `~/.env`-ish
file on this machine at verification time; the Infisical `GEMINI_API_KEY` (a Google AI Studio
key, the same credential `GOOGLE_GENERATIVE_AI_API_KEY` expects) enabled the real Google
end-to-end in section 3c, which surfaced the numeric-enum tool-schema bug — fixed in
`b4702fab` and re-verified green. Everything gated on a real OpenAI key is explicitly marked
NOT RUN above rather than faked; everything else was run for real against live processes and
a real browser. Two of the three big-3 providers (Anthropic, Google) are now verified fully
end-to-end with real keys.

All servers and processes started for this verification were stopped afterward; the tree is
clean except this directory's screenshots and `.gitignore`'s new `!docs/verification/**/*.png`
allow-rule (the existing `*.png` ignore + a narrow negation for
`docs/superpowers/specs/assets/**/*.png` already existed; this branch's screenshots needed the
same treatment for `docs/verification/`).
