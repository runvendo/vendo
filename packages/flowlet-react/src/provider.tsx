import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createRegistry, type ComponentRegistry, type RegisteredComponent, type FlowletAgent } from "@flowlet/core";
import { createLocalTransport, type LocalTransport } from "./transport";

interface FlowletContextValue {
  registry: ComponentRegistry;
  local: LocalTransport;
}

const FlowletContext = createContext<FlowletContextValue | null>(null);

export interface FlowletProviderProps {
  agent: FlowletAgent;
  components: RegisteredComponent[];
  children: ReactNode;
}

export function FlowletProvider({ agent, components, children }: FlowletProviderProps) {
  const registry = useMemo(() => createRegistry(components), [components]);
  const local = useMemo(() => createLocalTransport(agent), [agent]);
  const value = useMemo<FlowletContextValue>(() => ({ registry, local }), [registry, local]);
  return <FlowletContext.Provider value={value}>{children}</FlowletContext.Provider>;
}

export function useFlowletContext(): FlowletContextValue {
  const ctx = useContext(FlowletContext);
  if (!ctx) throw new Error("useFlowletContext must be used within a FlowletProvider");
  return ctx;
}
