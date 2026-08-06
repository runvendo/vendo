/**
 * The harness slot, named by env.
 *
 *   unset               → slot empty; composition serves the default `vendo()`
 *   claude-code         → `harness: claudeCode()` on a real sandbox machine
 *   claude-code-local   → `harness: claudeCode({ machine: "local" })`
 *   context-e2e         → `harness: vendo({ contextWindowTokens })`, a seat that
 *                         believes its window is small
 *
 * `instant` was a fourth option and is gone with the harness itself
 * (blueprint §14.1): two engines and no third.
 *
 * The shipped demo leaves it unset, so this file changes nothing about what a
 * visitor gets. It exists because measuring one harness column against another
 * needs the SAME composed wire underneath, and because a host being ABLE to
 * commit `harness: claudeCode()` is the thing the SDK's optional-peer layout is
 * for: `@anthropic-ai/claude-agent-sdk` is not in this app's dependencies and is
 * not in its build graph. Only `claude-code-local` reaches for it, at runtime,
 * and says so plainly if it is not installed.
 */
import { vendo } from "@vendoai/harnesses";
import { claudeCode } from "@vendoai/harnesses/claude-code";
import type { createVendo } from "@vendoai/vendo/server";

type HarnessSlot = Pick<Parameters<typeof createVendo>[0], "harness">;

/**
 * The window `context-e2e` tells the seat it has (fixtures/context-e2e).
 *
 * Small enough that a browser session trips the compaction trigger after a
 * couple of real messages instead of the couple of hundred a 200k window would
 * need; large enough that Maple's own prompt — instructions, the guard's
 * directions and the whole host tools block — does not trip it on turn one, so
 * the trip that the suite observes is one the conversation caused.
 *
 * It goes on the HARNESS and nowhere else: the window is a fact about a model,
 * not a product decision `createVendo` composes.
 */
const CONTEXT_E2E_WINDOW_TOKENS = 32_000;

export function namedHarness(): HarnessSlot | Record<string, never> {
  switch (process.env.MAPLE_HARNESS) {
    case "claude-code": return { harness: claudeCode() };
    case "claude-code-local": return { harness: claudeCode({ machine: "local" }) };
    case "context-e2e": return { harness: vendo({ contextWindowTokens: CONTEXT_E2E_WINDOW_TOKENS }) };
    default: return {};
  }
}
