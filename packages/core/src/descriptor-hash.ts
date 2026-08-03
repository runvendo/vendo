import { canonicalJson } from "./jcs.js";
import { sha256Hex } from "./sha256.js";
import type { ToolDescriptor } from "./tools.js";

/** 01-core §4 */
export function descriptorHash(descriptor: ToolDescriptor): string {
  const preimage: Record<string, unknown> = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    risk: descriptor.risk,
  };
  if (descriptor.critical !== undefined) preimage.critical = descriptor.critical;
  // Embedded-agent design §12: `title` is what a PERSON approved on the card, so
  // a retitle must invalidate grants exactly like a rename — otherwise the words
  // someone consented to can be changed under a still-valid grant. Included only
  // when defined, the same rule `critical` follows, so every grant minted before
  // titles existed keeps matching instead of being silently revoked.
  if (descriptor.title !== undefined) preimage.title = descriptor.title;
  return `sha256:${sha256Hex(canonicalJson(preimage))}`;
}

/** Characters that occupy no visible space on a card, so they cannot be what
 *  distinguishes two actions: zero-width space/joiner/non-joiner, the BOM, and
 *  the LTR/RTL marks and embedding controls. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;

/**
 * How a title reads to a PERSON. Two labels that render identically are the same
 * label, whatever their bytes: the consent card's job is to tell two actions
 * apart, and a reader cannot see case, padding, a zero-width space, or whether an
 * accent was composed or decomposed.
 *
 * NFKC first (so full-width and other compatibility forms fold together), then
 * invisibles are dropped, then every whitespace run collapses to one space.
 */
const titleKey = (title: string): string =>
  title
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/** Embedded-agent design §12 — two actions must never read identically on a
 *  consent card. Returns one entry per colliding title, naming the tools, so the
 *  caller can fail boot with a message that says which tools to fix. Empty means
 *  the deployment is clean. */
export function duplicateToolTitles(
  descriptors: readonly ToolDescriptor[],
): Array<{ title: string; tools: string[] }> {
  const byTitle = new Map<string, { title: string; tools: string[] }>();
  for (const descriptor of descriptors) {
    if (descriptor.title === undefined) continue;
    // A title that normalises to nothing is NOT skipped: two tools whose labels
    // both render blank are exactly as indistinguishable as two that read the
    // same, so they belong in the same group. (A single blank title falls back to
    // the tool name and is merely ugly, not ambiguous, so it never collides.)
    const key = titleKey(descriptor.title);
    const found = byTitle.get(key);
    if (found === undefined) byTitle.set(key, { title: descriptor.title, tools: [descriptor.name] });
    else found.tools.push(descriptor.name);
  }
  return [...byTitle.values()].filter((entry) => entry.tools.length > 1);
}
