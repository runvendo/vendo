/**
 * The harness slot, named by env — lane F's `MAPLE_HARNESS=instant` switch
 * extended to the third harness.
 *
 *   unset               → slot empty; composition serves the default `vendo()`
 *   instant             → `harness: instant()`
 *   claude-code         → `harness: claudeCode()` on a real sandbox machine
 *   claude-code-local   → `harness: claudeCode({ machine: "local" })`
 *
 * The shipped demo leaves it unset, so this file changes nothing about what a
 * visitor gets. It exists because measuring one harness column against another
 * needs the SAME composed wire underneath, and because a host being ABLE to
 * commit `harness: claudeCode()` is the thing the SDK's optional-peer layout is
 * for: `@anthropic-ai/claude-agent-sdk` is not in this app's dependencies and is
 * not in its build graph. Only `claude-code-local` reaches for it, at runtime,
 * and says so plainly if it is not installed.
 */
import { claudeCode } from "@vendoai/harnesses/claude-code";
import { instant } from "@vendoai/vendo/server";
import type { createVendo } from "@vendoai/vendo/server";

type HarnessSlot = Pick<Parameters<typeof createVendo>[0], "harness">;

export function namedHarness(): HarnessSlot | Record<string, never> {
  switch (process.env.MAPLE_HARNESS) {
    case "instant": return { harness: instant() };
    case "claude-code": return { harness: claudeCode() };
    case "claude-code-local": return { harness: claudeCode({ machine: "local" }) };
    default: return {};
  }
}
