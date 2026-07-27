import type { LaneName, LaneResult } from "../runner/types";

export const ALL_LANES: LaneName[] = ["vendo", "thesys-c1", "copilotkit", "tambo"];

export const LANE_LABELS: Record<LaneName, string> = {
  vendo: "Vendo",
  "thesys-c1": "Thesys C1",
  copilotkit: "CopilotKit",
  tambo: "Tambo",
};

/** Permanent asymmetry footnotes (spec: a weak pane must never be misread as
 *  a weak product). */
export const LANE_FOOTNOTES: Record<LaneName, string> = {
  vendo: "live render · @vendoai/ui renderer · working-tree engine",
  "thesys-c1": "their renderer, their theme · same prompt + tool context",
  copilotkit: "registered-components paradigm — drives predefined components, not open-ended generation",
  tambo: "component registry + AI orchestration · their SDK",
};

/** Same counting the CLI summary uses. */
export function repairCount(result: LaneResult | undefined): number {
  if (!result || result.status === "no-key") return 0;
  return (result.events ?? []).filter(
    (event) => event.stage === "repair" || event.stage === "island-repair",
  ).length;
}

export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
