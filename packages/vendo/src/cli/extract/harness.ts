import { z } from "zod";

/**
 * The ExtractionHarness seam (install-dx v1, brainstorm 2026-07-18): Vendo
 * owns the instructions, the deterministic validation, and the artifact
 * contract; a world-class coding agent does the reading. Everything above
 * this seam is vendor-neutral — swapping the harness (Claude Agent SDK today,
 * anything tomorrow) is a config change, not an architecture change.
 */

/** One drafted polish entry for an extracted tool. The AI pass proposes;
 *  deterministic guards in extraction.ts decide what applies. */
export const draftToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).max(500),
  risk: z.enum(["read", "write", "destructive"]).optional(),
  critical: z.boolean().optional(),
  /** false = wake a statically-unclassifiable tool (needs reasoning). */
  disabled: z.boolean().optional(),
  reasoning: z.string().max(500).optional(),
});
export type DraftTool = z.infer<typeof draftToolSchema>;

export const extractionDraftSchema = z.object({
  /** One-paragraph product brief drafted from the codebase. */
  brief: z.string().min(1).max(4000),
  tools: z.array(draftToolSchema),
  /** API surfaces the static extractor missed — surfaced to the dev, not
   *  written anywhere (adding tools is future work on the sync side). */
  missedSurfaces: z.array(z.string().max(300)).optional(),
});
export type ExtractionDraft = z.infer<typeof extractionDraftSchema>;

export interface ExtractionRunInput {
  root: string;
  /** The complete staged instructions, composed by extraction.ts. */
  instructions: string;
  env: Record<string, string | undefined>;
  /** Live narration line (surface discoveries, files being read). */
  onProgress?: (line: string) => void;
}

export interface ExtractionHarness {
  /** Stable identifier ("claude-agent-sdk"). */
  id: string;
  /** A short human label of the credential this harness would use
   *  ("your Claude Code login", "your ANTHROPIC_API_KEY"), or null when the
   *  harness cannot run on this machine. */
  availability(input: { root: string; env: Record<string, string | undefined> }): Promise<string | null>;
  /** Run the instructions and return the agent's final text (extraction.ts
   *  parses and validates; the harness never interprets the draft). */
  run(input: ExtractionRunInput): Promise<string>;
}

/** Extract the draft JSON from an agent's final text: prefer a fenced block,
 *  fall back to the widest braces span. Throws on unparseable output. */
export function parseDraft(text: string): ExtractionDraft {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return extractionDraftSchema.parse(JSON.parse(candidate));
}
