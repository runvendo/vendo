/**
 * `@vendoai/agents/claude-code` — the builder engine, from the one package a
 * host installed.
 *
 * A subpath rather than a root export for the reason it is one in
 * `@vendoai/harnesses`: the Claude Agent SDK reaches Node built-ins, and the
 * root barrel is bundled for Worker targets through `packages/vendo/src/server.ts`
 * (portability-gate.mjs). Everything here is a re-export — one definition, in
 * harnesses.
 */
export { claudeCode, type ClaudeCodeOptions } from "@vendoai/harnesses/claude-code";
