/**
 * Pure derivation of saveable vendos from a thread: every rendered view
 * (generated nodes) becomes a draft, named after the prompt that produced it.
 * The assistant page persists these through the VendoStore seam (ENG-183).
 */
import type { VendoDraft, ThreadItem } from "@vendoai/shell";
import { originatingPrompt, stampHostComponents } from "@vendoai/shell";
import { cadenceComponents } from "./components";

const NAME_MAX = 48;

const nameFrom = (prompt: string | undefined, fallback: string): string => {
  const base = prompt?.trim() || fallback;
  return base.length <= NAME_MAX ? base : `${base.slice(0, NAME_MAX - 1).trimEnd()}…`;
};

export function deriveSavedDrafts(items: ThreadItem[], knownIds: ReadonlySet<string>): VendoDraft[] {
  const drafts: VendoDraft[] = [];
  for (const item of items) {
    if (item.kind !== "ui") continue;
    const { node } = item;
    if (knownIds.has(node.id) || drafts.some((d) => d.id === node.id)) continue;
    const prompt = originatingPrompt(items, item.key);
    drafts.push({
      id: node.id,
      name: nameFrom(prompt, "Saved view"),
      node,
      prompt,
      pinned: false,
      // Registry-version stamp (ENG-186): reopen diffs it to surface drift.
      components: stampHostComponents(node, cadenceComponents),
    });
  }
  return drafts;
}
