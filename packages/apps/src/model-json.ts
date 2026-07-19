/** Parse a complete model response while tolerating prose or a JSON markdown
 *  fence (the code-edit dialect's tolerance; the tree dialects are wire —
 *  see engine.ts extractWire/extractEdit). */
const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/;

export const parseModelJson = (text: string): { value?: unknown; issues: string[] } => {
  const trimmed = text.trim();
  const fenced = JSON_FENCE.exec(trimmed)?.[1];
  const source = fenced ?? trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  const candidate = start === -1 || end < start ? source : source.slice(start, end + 1);
  try {
    return { value: JSON.parse(candidate) as unknown, issues: [] };
  } catch (error) {
    return {
      issues: [`model output is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`],
    };
  }
};
