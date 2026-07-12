import { validateTree } from "@vendoai/core";
import type { Tree } from "@vendoai/core";
import { canonicalize, decodeCjtString, decodeVtl } from "./index.js";
import type { Arm } from "./prompts.js";

/**
 * Shared model-call helpers for the key-gated scripts. Generation isolates raw
 * output-token latency by turning thinking OFF (the generation engine streams a
 * payload; it does not deliberate), which also keeps TTFB meaningful. Documented
 * in DESIGN.md.
 */

/** claude-sonnet-5 defaults to adaptive thinking when omitted — force it off to
 *  measure pure generation. Haiku 4.5 runs thinking-off by omission. */
export function thinkingParam(model: string): { thinking?: { type: "disabled" } } {
  return model.includes("haiku") ? {} : { thinking: { type: "disabled" } };
}

export function extractText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function stripFences(text: string): string {
  const s = text.trim();
  const m = s.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  return m ? m[1]! : s;
}

export interface TreeComplexity {
  nodes: number;
  propKeys: number;
  components: number;
  queries: number;
}

export interface ArmParseResult {
  ok: boolean;
  /** Complexity of a VALID decode — for cross-arm comparability checks. */
  complexity?: TreeComplexity;
  error?: string;
}

export function complexityOf(tree: Tree): TreeComplexity {
  return {
    nodes: tree.nodes.length,
    propKeys: tree.nodes.reduce((sum, n) => sum + (n.props ? Object.keys(n.props).length : 0), 0),
    components: tree.components ? Object.keys(tree.components).length : 0,
    queries: tree.queries?.length ?? 0,
  };
}

/**
 * Decode raw model output per arm and validate. Never throws.
 *
 * The oracle is symmetric across arms: the compact arms use the STRICT decoders
 * (off-grammar output throws), and the readable arm goes through `canonicalize`,
 * which applies the same extension-field rejection the compact encoders live
 * under — so no arm gets validity credit the others would be denied. On success
 * also reports tree complexity, so the latency comparison can flag an arm that
 * "wins" by generating a simpler tree.
 */
export function parseArm(arm: Arm, rawText: string): ArmParseResult {
  try {
    const text = stripFences(rawText);
    let tree: unknown;
    if (arm === "readable") tree = canonicalize(JSON.parse(text));
    else if (arm === "cjt") tree = decodeCjtString(text);
    else tree = decodeVtl(text);
    const result = validateTree(tree);
    if (!result.ok) return { ok: false, error: `validateTree ${result.error.code}: ${result.error.message}` };
    return { ok: true, complexity: complexityOf(result.tree) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
