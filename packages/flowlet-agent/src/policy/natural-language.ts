/**
 * Natural-language guardrail layer for the Flowlet policy engine.
 *
 * Sends the active plain-English rules plus the tool-call context to a judge
 * language model and maps its response to an ApprovalDecision.
 *
 * Implementation choice — generateText vs generateObject:
 *   We use `generateText` (not `generateObject`) so that MockLanguageModelV3
 *   from `ai/test` can drive the judge in unit tests without requiring a
 *   full structured-output / tool-call round-trip. The judge prompt constrains
 *   the model to return ONLY one of the three decision tokens; the implementation
 *   parses and validates that token, falling back to "deny" on anything else.
 */

import { generateText, type LanguageModel } from "ai";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";

const VALID_DECISIONS = new Set<string>(["allow", "approve", "deny"]);

function buildPrompt(rules: string[], ctx: PolicyContext): string {
  return [
    "You are a security guardrail judge. Evaluate whether the following tool call",
    "should be allowed, require human approval, or be denied outright.",
    "",
    "Rules (apply ALL of them):",
    ...rules.map((r, i) => `  ${i + 1}. ${r}`),
    "",
    `Tool name: ${ctx.toolName}`,
    `Tool input: ${JSON.stringify(ctx.input)}`,
    "",
    'Respond with EXACTLY one word — no punctuation, no explanation:',
    '  "allow"   — no rule is implicated; proceed automatically.',
    '  "approve" — a rule says this kind of action needs human approval.',
    '  "deny"    — a rule forbids this action outright.',
  ].join("\n");
}

/**
 * Build a policy layer that consults a judge language model against a set of
 * plain-English rules. Fail-closed: any model error or unrecognised response
 * returns "deny".
 *
 * @param rules      Plain-English guardrail rules, applied to every tool call.
 * @param judgeModel The language model used as the judge.
 */
export function naturalLanguagePolicy(
  rules: string[],
  judgeModel: LanguageModel,
): ApprovalPolicy {
  // Memoise the judge's result so the (now always re-evaluating) deterministic
  // layers do not provoke a duplicate LLM call for an identical input. The
  // `rules` are fixed per policy instance, so the key is just the call shape.
  // Only SUCCESSFUL decisions are stored — a transient judge failure must not
  // be cached as a permanent "deny".
  const memo = new Map<string, ApprovalDecision>();

  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      const key = JSON.stringify([ctx.toolName, ctx.input]);
      const cached = memo.get(key);
      if (cached !== undefined) return cached;

      try {
        const { text } = await generateText({
          model: judgeModel,
          prompt: buildPrompt(rules, ctx),
        });

        const decision = text.trim().toLowerCase();

        const result: ApprovalDecision = VALID_DECISIONS.has(decision)
          ? (decision as ApprovalDecision)
          : "deny"; // Unrecognised token — fail-closed.

        // Store only a successful evaluation (the model responded).
        memo.set(key, result);
        return result;
      } catch {
        // Any model error — fail-closed (a broken judge must never allow), and
        // do NOT cache: a transient failure must not poison future calls.
        return "deny";
      }
    },
  };
}
