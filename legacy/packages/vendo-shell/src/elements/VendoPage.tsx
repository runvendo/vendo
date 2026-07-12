import { useState, type ComponentType } from "react";
import type { VendoAgent, RegisteredComponent } from "@vendoai/core";
import { VendoProvider } from "@vendoai/react";
import { VendoShellProvider } from "../context";
import type { VendoIntegrations } from "../seams/integrations";
import { themeToStyle, type VendoTheme } from "../theme";
import { useMobileTakeover } from "../use-mobile-takeover";
import { VendoThread } from "../VendoThread";

export interface VendoPageProps {
  agent: VendoAgent;
  components: RegisteredComponent[];
  integrations?: VendoIntegrations;
  impls?: Record<string, ComponentType<Record<string, unknown>>>;
  theme?: VendoTheme;
  /** Opaque `--vendo-*` var map from the host brand; applied inline on `.vendo-root`. */
  cssVars?: Record<string, string>;
  greeting?: string;
  suggestions?: string[];
}

interface Tab { id: string; title: string; }

let tabSeq = 0;
const newTab = (): Tab => ({ id: `tab-${++tabSeq}`, title: "New vendo" });

export function VendoPage(props: VendoPageProps) {
  const { agent, components, integrations, impls, theme, cssVars, greeting, suggestions } = props;
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);
  // Below 768px the page presents full-screen over the host layout (the
  // Intercom takeover) — the host's mobile layout is covered, not our problem.
  const takeover = useMobileTakeover();

  const addTab = () => {
    const tab = newTab();
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
  };

  return (
    <div
      className={takeover ? "vendo-root fl-page fl-takeover" : "vendo-root fl-page"}
      style={{ ...themeToStyle(theme), ...cssVars }}
    >
      <div className="fl-tabbar" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className="fl-tab"
            onClick={() => setActiveId(tab.id)}
          >
            {tab.title}
          </button>
        ))}
        <button type="button" className="fl-tab fl-tab-new" aria-label="New tab" onClick={addTab}>＋</button>
      </div>
      <div className="fl-page-body">
        {tabs.map((tab) => (
          <div key={tab.id} className="fl-page-pane" hidden={tab.id !== activeId}>
            <VendoProvider agent={agent} components={components}>
              <VendoShellProvider integrations={integrations} impls={impls} theme={theme} cssVars={cssVars}>
                <VendoThread greeting={greeting} suggestions={suggestions} />
              </VendoShellProvider>
            </VendoProvider>
          </div>
        ))}
      </div>
    </div>
  );
}
