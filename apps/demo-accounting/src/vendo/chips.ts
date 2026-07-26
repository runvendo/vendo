/**
 * "Try this" suggestion chips (demo-hygiene) — the unscripted prompts that
 * fill the blank-page gap one tier below the scripted scenario cards. Each
 * chip's app is PRE-GENERATED through the real pipeline at seed time
 * (chips-seed.ts) and recorded in a per-subject manifest, so a tap attaches
 * instantly; a missing cache entry falls through to normal live generation.
 *
 * Prompts are grounded in what Cadence actually tracks — client documents,
 * deadlines, activity, the team — and deliberately distinct from the four
 * scripted scenario cards. Mirrors demo-bank's chips module.
 */
import { vendo } from "./server"

export interface TryThisChip {
  key: string
  prompt: string
}

export const cadenceChips: TryThisChip[] = [
  { key: "deadlines", prompt: "What filing deadlines hit next week?" },
  { key: "quiet", prompt: "Which clients have gone quiet lately?" },
  { key: "turnaround", prompt: "Track our document turnaround time" },
  { key: "onepager", prompt: "Build a one-page status view per client" },
  { key: "workload", prompt: "Show my team's workload this month" },
]

/** Host (non-reserved) records collection holding one manifest row per
 * subject: chip key + prompt + the pre-generated app's id. */
export const CHIP_MANIFEST_COLLECTION = "cadence_demo_chips"

export interface ChipManifestEntry extends TryThisChip {
  appId: string
}

export function chipManifestRowId(subject: string): string {
  return `chips_${subject}`
}

export async function readChipManifest(subject: string): Promise<ChipManifestEntry[]> {
  // A store whose schema hasn't migrated yet (fresh checkout, pre-generation
  // still booting) reads as "no chips", never as an error.
  let record
  try {
    record = await vendo.store.records(CHIP_MANIFEST_COLLECTION).get(chipManifestRowId(subject))
  } catch {
    return []
  }
  const data = record?.data as { subject?: string; entries?: ChipManifestEntry[] } | undefined
  if (record === null || data?.subject !== subject) return []
  return data.entries ?? []
}
