// Prompt + parsing helpers for the real-LLM e2e gate. Kept out of the spec so
// the test body stays focused on render + a11y assertions.

import { VENDO_GENUI_VERSION } from "@vendoai/core";

/**
 * System prompt: states the exact Vendo GenUI v1 shape, restricts the model
 * to the small allowed catalog (so unknown components can't slip in), and asks
 * for JSON only. Deliberately explicit/example-driven to keep the LLM on-format.
 */
export const SYSTEM_PROMPT = `You generate UI as a single JSON object in the "Vendo GenUI v1" format. Output ONLY the JSON object — no prose, no explanation, no markdown code fences.

SHAPE (exact):
{
  "formatVersion": "${VENDO_GENUI_VERSION}",   // must be this exact string
  "root": "<id of the root node>",
  "nodes": [ /* a FLAT array of node objects (not nested) */ ],
  "data": { /* optional object; props may reference it via { "$path": "/pointer" } */ }
}

NODE (exact):
{
  "id": "<unique string>",
  "component": "<one of the allowed component names below>",
  "source": "prewired" | "host",
  "props": { /* optional, see catalog */ },
  "children": [ "<child id>", ... ]   // optional, array of OTHER node ids
}

ALLOWED CATALOG — use ONLY these component names, nothing else:
- Stack  (source "prewired") — vertical layout container. Use "children".
- Row    (source "prewired") — horizontal layout container. Use "children".
- Text   (source "prewired") — props: { "text": string, "as"?: string }.
- Card   (source "host")     — props: { "title": string, "body": string }.

RULES:
- formatVersion MUST be exactly "${VENDO_GENUI_VERSION}".
- "root" MUST equal the id of one node in "nodes".
- "nodes" is a flat array. Express hierarchy via "children" (arrays of ids), NOT by nesting node objects.
- Use ONLY the four component names above with their listed source.
- Output the JSON object and nothing else.`;

export const USER_REQUEST =
  'Build a welcome card titled "Account Summary" with a short one-sentence body, laid out inside a Stack with a heading Text (text "Welcome back") above the card.';

/**
 * Defensively extract the first balanced top-level {...} object from raw model
 * text: strips ```json fences, then scans for the first '{' and walks to its
 * matching '}' (ignoring braces inside strings). Returns the JSON substring.
 */
export function extractJsonObject(raw: string): string {
  let s = raw.trim();
  // Strip markdown fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  if (start === -1) throw new Error(`no JSON object found in model output: ${raw.slice(0, 200)}`);

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced JSON object in model output: ${raw.slice(0, 200)}`);
}
