import { useMemo, useState, type ComponentType } from "react";
import { FluidThemeProvider, LiquidTabs } from "fluidkit";
import type { FlowletAgent, RegisteredComponent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import type { FlowletStore } from "../seams/store";
import type { FlowletIntegrations } from "../seams/integrations";
import { brandToFluidTheme, type FluidConfig } from "../brand-to-fluid-theme";
import { themeToStyle, type FlowletTheme } from "../theme";
import { FlowletThread } from "../FlowletThread";

export interface FlowletPageProps {
  agent: FlowletAgent;
  components: RegisteredComponent[];
  store?: FlowletStore;
  integrations?: FlowletIntegrations;
  impls?: Record<string, ComponentType<Record<string, unknown>>>;
  theme?: FlowletTheme;
  /** Opaque `--flowlet-*` var map from the host brand; applied inline on `.flowlet-root`. */
  cssVars?: Record<string, string>;
  /** Liquid character knobs (material/intensity) for fluidkit chrome. */
  fluid?: FluidConfig;
  greeting?: string;
  suggestions?: string[];
}

interface Tab { id: string; title: string; }

let tabSeq = 0;
const newTab = (): Tab => ({ id: `tab-${++tabSeq}`, title: "New flowlet" });

export function FlowletPage(props: FlowletPageProps) {
  const { agent, components, store, integrations, impls, theme, cssVars, fluid, greeting, suggestions } = props;
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);

  const addTab = () => {
    const tab = newTab();
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
  };

  // The tab bar lives OUTSIDE the per-pane shell providers, so it needs its
  // own fluid-theme mount to render brand-native.
  const fluidTheme = useMemo(() => brandToFluidTheme(theme, fluid), [theme, fluid]);

  return (
    <FluidThemeProvider theme={fluidTheme}>
      <div className="flowlet-root fl-page" style={{ ...themeToStyle(theme), ...cssVars }}>
        <div className="fl-tabbar">
          {/* LiquidTabs owns only the selectable bar; panes stay always-mounted
              below (each holds a live chat thread LiquidTabs' own panels would
              unmount), and the non-tab ＋ action renders beside the bar. */}
          <LiquidTabs
            size="sm"
            items={tabs.map((tab) => ({ id: tab.id, label: tab.title }))}
            value={activeId}
            onChange={setActiveId}
          />
          <button type="button" className="fl-tab fl-tab-new" aria-label="New tab" onClick={addTab}>＋</button>
        </div>
        <div className="fl-page-body">
          {tabs.map((tab) => (
            <div key={tab.id} className="fl-page-pane" hidden={tab.id !== activeId}>
              <FlowletProvider agent={agent} components={components}>
                <FlowletShellProvider store={store} integrations={integrations} impls={impls} theme={theme} cssVars={cssVars} fluid={fluid}>
                  <FlowletThread greeting={greeting} suggestions={suggestions} />
                </FlowletShellProvider>
              </FlowletProvider>
            </div>
          ))}
        </div>
      </div>
    </FluidThemeProvider>
  );
}
