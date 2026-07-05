/**
 * Tool-input JSON repair for long generated payloads.
 *
 * Failure mode, reproduced live (PR #28): when render_view carries a big
 * generated component, the model sometimes emits RAW control characters
 * (newlines/tabs) inside JSON string literals. The ai SDK then keeps the
 * unparsable input as a string, and the NEXT loop step 400s at the provider
 * ("tool_use.input: Input should be an object"), killing the whole turn.
 *
 * Fix, applied at the engine level (replacing the old normalizeHistory `{}`
 * coercion — repairable history keeps its data instead of being blanked):
 *  - wrapStream: repair each streamed `tool-call` part's input so the first
 *    attempt parses and executes;
 *  - transformParams: belt-and-braces — any assistant `tool-call` prompt part
 *    whose input survived as an unparsable string is repaired (or emptied)
 *    before it reaches the provider, so a turn can never 400 on resend.
 *
 * The repair is deliberately narrow: escape control characters INSIDE string
 * literals. No other JSON surgery.
 */
import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider";

const CONTROL_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** Escape raw control characters that appear inside JSON string literals. */
export function escapeControlCharsInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch < " ") {
        out += CONTROL_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** Return a parsable variant of a stringified tool input, or null. */
export function repairToolInputText(text: string): string | null {
  try {
    JSON.parse(text);
    return text;
  } catch {
    /* fall through to repair */
  }
  const repaired = escapeControlCharsInJsonStrings(text);
  try {
    JSON.parse(repaired);
    console.warn("[vendo] repaired malformed tool-input JSON (raw control chars in strings)");
    return repaired;
  } catch {
    return null;
  }
}

type PromptPart = { type?: string; input?: unknown; args?: unknown };

/** Repair a prompt-side tool-call part whose input survived as a string. */
function repairPromptPart(part: PromptPart): PromptPart {
  if (part.type !== "tool-call") return part;
  for (const key of ["input", "args"] as const) {
    const value = part[key];
    if (typeof value !== "string") continue;
    const repaired = repairToolInputText(value);
    if (repaired) return { ...part, [key]: JSON.parse(repaired) };
    // Unrepairable: send an empty object rather than 400 the whole turn — the
    // paired tool result already tells the model its input was invalid.
    console.warn("[vendo] dropped unrepairable tool-input JSON from prompt");
    return { ...part, [key]: {} };
  }
  return part;
}

export const jsonRepairMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",

  transformParams: async ({ params }) => {
    const prompt = params.prompt?.map((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
      return { ...message, content: message.content.map((p) => repairPromptPart(p as PromptPart)) };
    });
    return { ...params, ...(prompt ? { prompt: prompt as typeof params.prompt } : {}) };
  },

  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const transformed = stream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(part, controller) {
          if (part.type === "tool-call" && typeof part.input === "string") {
            const repaired = repairToolInputText(part.input);
            if (repaired && repaired !== part.input) {
              controller.enqueue({ ...part, input: repaired });
              return;
            }
          }
          controller.enqueue(part);
        },
      }),
    );
    return { stream: transformed, ...rest };
  },
};
