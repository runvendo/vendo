/**
 * DOM baseline snapshot (VendoRemix, 2026-07-04 spec). Serializes a wrapped
 * host component's rendered DOM into the sanitized string the agent remixes
 * from. Fixed contract, not configurable:
 *
 * - Included: tag names, `class`, `role`, `aria-*`, visible text, structure.
 * - Excluded: form values, hidden elements, `data-*`, inline handlers,
 *   script/style/iframe/noscript subtrees.
 * - Caps: depth 12 and 32 KB, both truncating with a visible marker.
 *
 * Captured only when the user opens the anchor's scoped overlay — never
 * ambiently. Output goes INTO a prompt string; it is never re-injected into
 * the page, so serialization is the whole job.
 */

export const SNAPSHOT_MAX_DEPTH = 12;
export const SNAPSHOT_MAX_BYTES = 32 * 1024;

const DROP_TAGS = new Set(["script", "style", "iframe", "noscript", "object", "embed", "template"]);
/** Elements whose text content is user-entered, not layout. */
const VALUE_TAGS = new Set(["textarea", "select"]);

function isHidden(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  const style = (element as HTMLElement).style;
  if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  if (typeof getComputedStyle === "function") {
    try {
      const computed = getComputedStyle(element);
      if (computed.display === "none" || computed.visibility === "hidden") return true;
    } catch {
      /* detached element — inline checks above already ran */
    }
  }
  return false;
}

function keptAttributes(element: Element): string {
  const parts: string[] = [];
  for (const attr of element.attributes) {
    const name = attr.name.toLowerCase();
    if (name === "class" || name === "role" || name.startsWith("aria-")) {
      if (name === "aria-hidden") continue; // hidden subtrees are dropped whole
      parts.push(`${name}="${attr.value.replace(/"/g, "&quot;")}"`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function serialize(node: Node, depth: number, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) {
      out.push(text.slice(0, budget.left));
      budget.left -= text.length;
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROP_TAGS.has(tag) || isHidden(element)) return;
  if (depth > SNAPSHOT_MAX_DEPTH) {
    if (out[out.length - 1] !== "…") out.push("…");
    return;
  }

  const open = `<${tag}${keptAttributes(element)}>`;
  out.push(open);
  budget.left -= open.length;

  // Form values are user data, not layout: keep the element, drop the value.
  if (!VALUE_TAGS.has(tag)) {
    for (const child of element.childNodes) {
      if (budget.left <= 0) break;
      serialize(child, depth + 1, out, budget);
    }
  }

  const close = `</${tag}>`;
  out.push(close);
  budget.left -= close.length;
}

/** Serialize `root` per the snapshot contract. */
export function snapshotElement(root: Element): string {
  const out: string[] = [];
  const budget = { left: SNAPSHOT_MAX_BYTES };
  serialize(root, 0, out, budget);
  let result = out.join("");
  if (budget.left <= 0) {
    result = `${result.slice(0, SNAPSHOT_MAX_BYTES)}\n[truncated]`;
  }
  return result;
}
