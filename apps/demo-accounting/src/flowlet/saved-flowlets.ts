/**
 * Pure derivation of saveable flowlets from a thread: every rendered view
 * (generated nodes) becomes a draft, named after the prompt that produced it.
 * The assistant page persists these through the FlowletStore seam (ENG-183).
 */
import type { FlowletDraft, ThreadItem } from "@flowlet/shell";
import { originatingPrompt } from "@flowlet/shell";

const NAME_MAX = 48;

const nameFrom = (prompt: string | undefined, fallback: string): string => {
  const base = prompt?.trim() || fallback;
  return base.length <= NAME_MAX ? base : `${base.slice(0, NAME_MAX - 1).trimEnd()}…`;
};

export function deriveSavedDrafts(items: ThreadItem[], knownIds: ReadonlySet<string>): FlowletDraft[] {
  const drafts: FlowletDraft[] = [];
  for (const item of items) {
    if (item.kind !== "ui") continue;
    const { node } = item;
    if (knownIds.has(node.id) || drafts.some((d) => d.id === node.id)) continue;
    const prompt = originatingPrompt(items, item.key);
    drafts.push({ id: node.id, name: nameFrom(prompt, "Saved view"), node, prompt, pinned: false });
  }
  return drafts;
}
