import type { ComponentType } from "react";
import type { HostName, LaneName, LaneResult } from "../runner/types";

/** One lane's result plus the run it belongs to. The id travels with the
 *  result because the Vendo pane renders the run by reference — it frames
 *  `/embed/<host>?run=<id>` (see VendoPane) rather than rendering the
 *  document in the cockpit's own document. */
export interface PaneRun {
  result: LaneResult;
  runId: string;
}

/** Contract between the cockpit grid and every lane's pane component.
 *  The grid stays generic: page.tsx maps LaneName → pane component, so
 *  lane panes and the grid can land independently. */
export interface PaneProps extends PaneRun {
  lane: LaneName;
  /** Which demo host the run targeted. Panes get the NAME only: the fixture's
   *  catalog/tools/shapes/theme and its executors are server-side (fixtures/,
   *  /api/tools, /embed/<host>) and never cross into the browser. */
  host: HostName;
  /** Split-compare: a second run rendered beside the first (read-only). */
  compare?: PaneRun;
}

export type PaneComponent = ComponentType<PaneProps>;
