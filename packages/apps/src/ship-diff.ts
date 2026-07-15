import type { AppDocument, AppId } from "@vendoai/core";
import { appVersionHash } from "./version-hash.js";
import { pinComponentName, type PinBaseline } from "./pins.js";
import { unifiedDiff } from "./unified-diff.js";

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
  /** The generated-component name the fork ships under (`pinComponentName`). */
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
  baselines: readonly PinBaseline[],
): ShipDiff => {
  const pins = (doc.pins ?? []).map((pin): ShipDiffPin => {
    const component = pinComponentName(pin.slot);
    const baseline = baselines.find((candidate) => candidate.slot === pin.slot);
    const shipped = doc.components?.[component] ?? "";
    return {
      slot: pin.slot,
      component,
      baseHash: pin.base,
      ...(baseline === undefined ? {} : { baselineHash: baseline.hash }),
      drifted: baseline?.hash !== pin.base,
      diff: unifiedDiff(`${pin.slot}/${component}.tsx`, baseline?.source ?? "", shipped),
    };
  });
  const pinnedComponents = new Set(pins.map((pin) => pin.component));
  const generated = Object.entries(doc.components ?? {})
    .filter(([name]) => !pinnedComponents.has(name))
    .map(([name, source]): ShipDiffGenerated => ({
      component: name,
      diff: unifiedDiff(`generated/${name}.tsx`, "", source),
    }));
  return {
    appId: doc.id,
    versionHash: appVersionHash(doc),
    pins,
    generated,
  };
};
