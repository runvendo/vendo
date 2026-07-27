"use client";

import type { LaneName } from "../runner/types";
import type { PaneComponent } from "../cockpit/pane-props";
import { Cockpit } from "../cockpit/Cockpit";
import { GenericPane } from "../cockpit/GenericPane";

/** The page-level lane → pane mapping (the grid stays generic). Real panes
 *  (VendoPane on the production renderer, competitor SDK panes) replace
 *  GenericPane here as their lanes land. */
const PANES: Record<LaneName, PaneComponent> = {
  vendo: GenericPane,
  "thesys-c1": GenericPane,
  copilotkit: GenericPane,
  tambo: GenericPane,
};

export default function Page() {
  return <Cockpit panes={PANES} />;
}
