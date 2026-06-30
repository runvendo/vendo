import { useState, type ComponentType } from "react";
import type { FlowletAgent, RegisteredComponent } from "@flowlet/core";
import { FlowletProvider } from "@flowlet/react";
import { FlowletShellProvider } from "../context";
import type { FlowletStore } from "../seams/store";
import type { FlowletIntegrations } from "../seams/integrations";
import type { FlowletTheme } from "../theme";
import { FlowletThread } from "../FlowletThread";

export interface FlowletPageProps {
  agent: FlowletAgent;
  components: RegisteredComponent[];
  store?: FlowletStore;
  integrations?: FlowletIntegrations;
  impls?: Record<string, ComponentType<Record<string, unknown>>>;
  theme?: FlowletTheme;
  greeting?: string;
  suggestions?: string[];
}

interface Tab { id: string; title: string; }

let tabSeq = 0;
const newTab = (): Tab => ({ id: `tab-${++tabSeq}`, title: "New flowlet" });

export function FlowletPage(props: FlowletPageProps) {
  const { agent, components, store, integrations, impls, theme, greeting, suggestions } = props;
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);

  const addTab = () => {
    const tab = newTab();
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
  };

  return (
    <div className="fl-page">
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
        <button type="button" className="fl-tab" aria-label="New tab" onClick={addTab}>＋</button>
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} hidden={tab.id !== activeId} style={{ flex: 1, minHeight: 0 }}>
          <FlowletProvider agent={agent} components={components}>
            <FlowletShellProvider store={store} integrations={integrations} impls={impls} theme={theme}>
              <FlowletThread greeting={greeting} suggestions={suggestions} />
            </FlowletShellProvider>
          </FlowletProvider>
        </div>
      ))}
    </div>
  );
}
