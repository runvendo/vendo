# Credits

Vendo adapts small, well-chosen pieces from open-source projects rather than
reinventing them. Every port carries an attribution comment at the site of use
naming the source file and license; this page is the roll-up. Thank you to the
authors below.

## pi-mono — MIT © Mario Zechner

<https://github.com/badlogic/pi-mono>

- The compaction summary skeleton and update skeleton
  (`packages/agent/src/harness/compaction/compaction.ts:428-498`) →
  `packages/harnesses/src/vendo/compaction.ts`
- The summary-as-user-message projection (`packages/agent/src/harness/messages.ts:4-10`) →
  `packages/harnesses/src/vendo/compaction.ts`
- The context-overflow error pattern set (`packages/ai/src/utils/overflow.ts`) →
  `packages/harnesses/src/vendo/overflow.ts`

## Cline — Apache-2.0 © Cline Bot Inc.

<https://github.com/cline/cline>

- The compaction trigger ratios and preserved-tail budget
  (`sdk/packages/core/src/extensions/context/compaction-shared.ts:15-19`) →
  `packages/harnesses/src/vendo/compaction.ts`
- Counting the tools block into the prompt estimate (`compaction.ts:300-304`) →
  `packages/harnesses/src/vendo/compaction.ts`
- The summarization cut-point rules (`compaction-shared.ts:326-359`) →
  `packages/harnesses/src/vendo/compaction.ts`

## Gemini CLI — Apache-2.0 © Google LLC

<https://github.com/google-gemini/gemini-cli>

- The summarizer's prompt-injection security rule
  (`packages/core/src/prompts/snippets.ts:897-905`) →
  `packages/harnesses/src/vendo/compaction.ts`
- Operating-manual lessons — acting vs asking, tool output as untrusted data
  (`packages/core/src/prompts/snippets.ts`) → the `How you work` section of
  `packages/vendo/src/prompt.ts` (adapted, not copied)

## executor — MIT © Rhys Sullivan

<https://github.com/UsefulSoftwareCo/executor>

- The tool-search lexical scorer: normalize/tokenize pipeline, per-field bonus
  tiers, token-coverage gate and ranking bonuses
  (`packages/core/execution/src/tool-invoker.ts`) →
  `packages/harnesses/src/vendo/tool-search.ts`

## OpenAI Codex CLI — Apache-2.0 © OpenAI

<https://github.com/openai/codex>

- Operating-manual lessons — persistence, plan-then-act, verification
  (`codex-rs/core/gpt_5_1_prompt.md`) → the `How you work` section of
  `packages/vendo/src/prompt.ts` (adapted, not copied)

## just-bash — Apache-2.0 © Vercel Labs

<https://github.com/vercel-labs/just-bash>

- The `IFileSystem` interface, vendored verbatim (v3.2.0,
  `dist/fs/interface.d.ts`) so `@vendoai/core` carries the shape without the
  interpreter → `packages/core/src/filesystem.ts`
- The interpreter itself is a regular dependency of the packages that run
  bash over workspace files.
