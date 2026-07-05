/**
 * The voice session brief (context-engineering spec §4): a structured,
 * per-block-capped replacement for the raw text tail a voice session used to
 * get. Assembled client-side from what the shell already holds — thread items
 * (text, tool parts), visible `data-ui` payloads (provenance from their own
 * `queries`), and the saved-vendo gallery — and rendered to plain text into
 * the existing `VoiceSessionInit.context` slot (no driver protocol change).
 */
import { isGeneratedNode, type GeneratedPayload, type UINode } from "@vendoai/core";
import type { ThreadItem } from "../use-vendo-thread";
import type { Vendo } from "../seams/store";

/** Per-block character caps + a total budget (connect-time tokens are real). */
const CAPS = {
  tail: 2_000,
  views: 800,
  tools: 800,
  flows: 400,
  total: 3_600,
} as const;

const TAIL_TURNS = 16;
const TOOL_DIGESTS = 6;

/** One-line shape digest of a tool result — counts, not payloads. Descends
 *  two object levels so wrapped results ({ok, data:{rows:[…]}}) stay legible. */
function digestValue(value: unknown, depth = 0): string {
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (value && typeof value === "object") {
    if (depth >= 2) return "object";
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 4);
    const parts = entries.map(([k, v]) => `${k}: ${digestValue(v, depth + 1)}`);
    return `{ ${parts.join(", ")} }`;
  }
  return typeof value;
}

function describeView(node: UINode): string {
  if (!isGeneratedNode(node)) {
    const name = (node as { name?: string }).name;
    return name ? `a host "${name}" card` : "a host card";
  }
  const payload = node.payload as GeneratedPayload;
  const components = payload.nodes.map((n) => n.component);
  const table = payload.nodes.find((n) => n.component === "Table");
  const titleNode = payload.nodes.find(
    (n) => n.component === "Text" && typeof n.props?.["text"] === "string",
  );
  const title =
    (titleNode?.props?.["text"] as string | undefined) ??
    (payload.nodes.find((n) => typeof n.props?.["title"] === "string")?.props?.[
      "title"
    ] as string | undefined);
  // Data-bound tables carry rows as { $path } into payload.data — resolve the
  // pointer so refreshable views still report a row count.
  let rows = table?.props?.["rows"];
  if (rows && typeof rows === "object" && !Array.isArray(rows)) {
    const pointer = (rows as { $path?: string }).$path;
    if (typeof pointer === "string") {
      let current: unknown = payload.data;
      for (const raw of pointer.split("/").slice(1)) {
        const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        current =
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[key]
            : undefined;
      }
      rows = current;
    }
  }
  const rowCount = Array.isArray(rows) ? `${rows.length} rows` : undefined;
  const query = payload.queries?.[0];
  const provenance = query ? `from ${query.tool} ${JSON.stringify(query.input ?? {})}` : undefined;
  const kind = table ? "a table" : `a view (${[...new Set(components)].slice(0, 4).join(", ")})`;
  return [kind, title ? `titled "${title}"` : undefined, rowCount, provenance]
    .filter(Boolean)
    .join(", ");
}

export interface VoiceSessionBriefInput {
  items: ThreadItem[];
  flows?: Vendo[];
}

/**
 * Render the brief, or "" when there is nothing to carry over. Block order:
 * conversation tail → on-screen views → recent tool results → saved vendos,
 * each individually capped, the whole thing budget-capped.
 */
export function voiceSessionBrief(input: VoiceSessionBriefInput): string {
  const blocks: string[] = [];

  const tailLines: string[] = [];
  for (const item of input.items.slice(-TAIL_TURNS)) {
    if (item.kind === "text" && item.text.trim()) {
      tailLines.push(`${item.role}: ${item.text.trim()}`);
    }
  }
  if (tailLines.length) {
    blocks.push(`Conversation so far:\n${tailLines.join("\n").slice(-CAPS.tail)}`);
  }

  const viewLines = input.items
    .filter((item): item is Extract<ThreadItem, { kind: "ui" }> => item.kind === "ui")
    .map((item) => `- ${describeView(item.node)}`);
  if (viewLines.length) {
    blocks.push(
      `On screen (already visible — refer to these, don't re-show or re-fetch them):\n${viewLines
        .join("\n")
        .slice(0, CAPS.views)}`,
    );
  }

  const toolLines = input.items
    .filter((item): item is Extract<ThreadItem, { kind: "tool" }> => item.kind === "tool")
    .filter((item) => item.output !== undefined)
    .slice(-TOOL_DIGESTS)
    .map(
      (item) =>
        `- ${item.toolName} ${JSON.stringify(item.input ?? {})} → ${digestValue(item.output)}`,
    );
  if (toolLines.length) {
    blocks.push(
      `Data already fetched this conversation (reuse it instead of re-fetching):\n${toolLines
        .join("\n")
        .slice(0, CAPS.tools)}`,
    );
  }

  if (input.flows?.length) {
    const flowLines = input.flows.map((f) => `- "${f.name}" (id ${f.id})`);
    blocks.push(
      `The user's saved views (open one with open_saved_vendo when asked):\n${flowLines
        .join("\n")
        .slice(0, CAPS.flows)}`,
    );
  }

  return blocks.join("\n\n").slice(0, CAPS.total);
}
