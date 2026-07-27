import type { ComponentType } from "react";
import type { HostFixture, LaneName, LaneResult } from "../runner/types";

/** Contract between the cockpit grid and every lane's pane component.
 *  The grid stays generic: page.tsx maps LaneName → pane component, so
 *  lane panes and the grid can land independently. */
export interface PaneProps {
  lane: LaneName;
  result: LaneResult;
  host: HostFixture;
  /** Split-compare: a second result rendered beside the first (read-only). */
  compareWith?: LaneResult;
}

export type PaneComponent = ComponentType<PaneProps>;
