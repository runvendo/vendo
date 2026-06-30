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
  return {
    async evaluate(ctx: PolicyContext): Promise<ApprovalDecision> {
      try {
        const { text } = await generateText({
          model: judgeModel,
          prompt: buildPrompt(rules, ctx),
        });

        const decision = text.trim().toLowerCase();

        if (VALID_DECISIONS.has(decision)) {
          return decision as ApprovalDecision;
        }

        // Unrecognised token — fail-closed.
        return "deny";
      } catch {
        // Any model error — fail-closed (a broken judge must never allow).
        return "deny";
      }
    },
  };
}
