import { ClaudeSessionRider, type ClaudeRiderOptions } from "./claude.js";
import { CodexSessionRider, type CodexRiderOptions } from "./codex.js";
import type { RiderSession } from "./types.js";

/**
 * Tool-less one-shot generation over a rider (install-dx design §2): the
 * second consumer shape beside the chat loop — apps generation, extraction
 * `--deep`, doctor's real turn, and the init finale's terminal reply all
 * forward one prompt into a fresh session and take the text back. Sessions
 * are NOT reused across generations: each call must see no prior context.
 */
export interface RiderGenerateInput {
  system: string;
  prompt: string;
  onTextDelta?: (delta: string) => void;
}

async function generateWith(session: RiderSession, input: RiderGenerateInput): Promise<string> {
  try {
    await session.start({ system: input.system, tools: [], onToolCall: async () => ({ text: "No tools are available.", ok: false }) });
    const result = await session.runTurn(input.prompt, input.onTextDelta ?? (() => {}));
    return result.text;
  } finally {
    await session.dispose().catch(() => undefined);
  }
}

export function claudeGenerate(input: RiderGenerateInput, options: ClaudeRiderOptions = {}): Promise<string> {
  return generateWith(new ClaudeSessionRider(options), input);
}

export function codexGenerate(input: RiderGenerateInput, options: CodexRiderOptions = {}): Promise<string> {
  return generateWith(new CodexSessionRider(options), input);
}
