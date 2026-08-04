"use client";

// The cockpit chrome sheet lives on this route, not in the root layout, so the
// /embed/<host> documents the Vendo pane frames stay free of it (see layout).
import "./globals.css";
import type { LaneName } from "../runner/types";
import type { PaneComponent } from "../cockpit/pane-props";
import { Cockpit } from "../cockpit/Cockpit";
import { VendoPane } from "../cockpit/VendoPane";
import ThesysPane from "../cockpit/panes/ThesysPane";
import CopilotKitPane from "../cockpit/panes/CopilotKitPane";
import TamboPane from "../cockpit/panes/TamboPane";

/** The page-level lane → pane mapping (the grid stays generic): the Vendo
 *  pane is the real production runtime, competitor panes render with their
 *  own SDKs. Tests inject their own pane maps, so this stays page-only. */
const PANES: Record<LaneName, PaneComponent> = {
  vendo: VendoPane,
  "thesys-c1": ThesysPane,
  copilotkit: CopilotKitPane,
  tambo: TamboPane,
};

export default function Page() {
  return <Cockpit panes={PANES} />;
}
