import type {
  AppId,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  bundleOf,
  type AppDocument,
} from "../../contract/index.js";
import { appVersionHash } from "./version-hash.js";
import { seedComponentName } from "@vendoai/core";
import { type SeedBaseline } from "../../contract/index.js";
import { unifiedDiff } from "../persistence/unified-diff.js";

/**
 * 06-apps §8–§9 — the reviewable ship-diff for one app version: everything the
 * app would ship into the host page relative to the captured host baselines.
 * This is the artifact a human approver reads before minting an
 * `InClientApproval` (OSS computes and verifies; Cloud's review console
 * displays it and mints). Additive runtime surface — not part of the frozen
 * 06 §1 method table.
 */
export interface ShipDiff {
  appId: AppId;
  /** `appVersionHash` of the reviewed version — the hash an approval pins. */
  versionHash: string;
  /** Pinned host slots: the net diff of the fork against the captured baseline. */
  pins: ShipDiffPin[];
  /** Generated components with no host baseline: reviewed as pure additions. */
  generated: ShipDiffGenerated[];
}

export interface ShipDiffPin {
  slot: string;
  /** The generated-component name the fork ships under (`seedComponentName`). */
  component: string;
  /** The baseline hash the pin was forked from (`Pin.base`). */
  baseHash: string;
  /** The hash of the currently captured host baseline, when one exists. */
  baselineHash?: string;
  /**
   * True when the host component changed under the pin (baseline hash no
   * longer matches `baseHash`) or the baseline is missing entirely — the
   * approver is not looking at the source the fork was made from.
   */
  drifted: boolean;
  /** Unified diff from the captured host source to the shipped fork source. */
  diff: string;
}

export interface ShipDiffGenerated {
  component: string;
  /** Unified diff from nothing — the entire shipped source, as additions. */
  diff: string;
}

/**
 * Compute the ship-diff of an app version against the captured host baselines.
 * Pure over its inputs so Cloud's console and tests can reuse it verbatim.
 */
export const computeShipDiff = (
  doc: AppDocument,
  baselines: readonly SeedBaseline[],
): ShipDiff => {
  const seed = doc.seed;
  const pins: ShipDiffPin[] = seed === undefined ? [] : [(() => {
    const component = seedComponentName(seed.component);
    const baseline = baselines.find((candidate) => candidate.slot === seed.component);
    return {
      slot: seed.component,
      component,
      baseHash: seed.baseline,
      ...(baseline === undefined ? {} : { baselineHash: baseline.hash }),
      drifted: baseline?.hash !== seed.baseline,
      // The remix IS its screen, so the shipped side is `app.tsx` and the base
      // side is the host's LIVE capture — an approver reads what the person's
      // code does against the component it stands in for, not against a hash.
      diff: unifiedDiff(
        `${seed.component}/${SCREEN_FILE}`,
        baseline?.source ?? "",
        doc.source?.[SCREEN_FILE]?.text ?? "",
      ),
    };
  })()];
  const pinnedComponents = new Set(pins.map((pin) => pin.component));
  const generated = Object.entries(doc.components ?? {})
    .filter(([name]) => !pinnedComponents.has(name))
    .map(([name, entry]): ShipDiffGenerated => ({
      component: name,
      diff: unifiedDiff(`generated/${name}.tsx`, "", bundleOf(entry).source),
    }));
  return {
    appId: doc.id,
    versionHash: appVersionHash(doc),
    pins,
    generated,
  };
};
