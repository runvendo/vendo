/**
 * "Try this" suggestion chips (demo-hygiene) — the unscripted prompts that
 * fill the blank-page gap one tier below the scripted scenario cards. Each
 * chip's app is PRE-GENERATED through the real pipeline at seed time
 * (chips-seed.ts) and recorded in a per-subject manifest, so a tap attaches
 * instantly; a missing cache entry falls through to normal live generation.
 *
 * The prompts are the approved demo-live-readiness mockup's five — realistic
 * bank asks, deliberately distinct from the five scripted scenario cards.
 */
import { vendo } from "@/vendo/server";

export interface TryThisChip {
  key: string;
  prompt: string;
}

export const mapleChips: TryThisChip[] = [
  { key: "subs", prompt: "Build me a subscriptions tracker" },
  { key: "dining", prompt: "Where did my dining budget go?" },
  { key: "bills", prompt: "What bills hit next week?" },
  { key: "goal", prompt: "Track my Lisbon savings goal" },
  { key: "cards", prompt: "Break down my card spend" },
];

/** Host (non-reserved) records collection holding one manifest row per
 *  subject: chip key + prompt + the pre-generated app's id. */
export const CHIP_MANIFEST_COLLECTION = "maple_demo_chips";

export interface ChipManifestEntry extends TryThisChip {
  appId: string;
}

export function chipManifestRowId(subject: string): string {
  return `chips_${subject}`;
}

export async function readChipManifest(subject: string): Promise<ChipManifestEntry[]> {
  // A store whose schema hasn't migrated yet (fresh checkout, pre-generation
  // still booting) reads as "no chips", never as an error.
  let record;
  try {
    record = await vendo.store.records(CHIP_MANIFEST_COLLECTION).get(chipManifestRowId(subject));
  } catch {
    return [];
  }
  const data = record?.data as { subject?: string; entries?: ChipManifestEntry[] } | undefined;
  if (record === null || data?.subject !== subject) return [];
  return data.entries ?? [];
}
