import type { ComponentType } from "react";
import { z } from "zod";
import { type UINode } from "@vendoai/core";
import { createStubAgent } from "@vendoai/core/testing";
import { VendoProvider } from "@vendoai/react";
import {
  VendoShellProvider,
  VendoPage,
  VendoOverlay,
  VendoSlot,
  createLocalIntegrations,
} from "@vendoai/shell";

/** A stand-in "generated" card so rendered UI nodes look real in the demo. */
function DemoCard({ title }: { title: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--vendo-border)",
        borderRadius: "var(--vendo-radius)",
        padding: 16,
        background: "var(--vendo-surface)",
        boxShadow: "var(--vendo-shadow)",
      }}
    >
      <div style={{ font: "500 10px/1 var(--vendo-font-mono)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--vendo-fg-muted)" }}>
        {title}
      </div>
      <div style={{ fontSize: 27, fontWeight: 700, letterSpacing: "-.02em", marginTop: 7 }}>$1,840</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 7, height: 64, marginTop: 14 }}>
        {[34, 58, 44, 92, 54, 70, 48, 80].map((h, i) => (
          <span key={i} style={{ flex: 1, height: `${h}%`, borderRadius: "4px 4px 0 0", background: "var(--vendo-accent)", opacity: 0.88 }} />
        ))}
      </div>
    </div>
  );
}

const agent = createStubAgent();
const components = [
  { name: "DemoCard", description: "a demo card", propsSchema: z.object({ title: z.string() }), source: "prewired" as const },
];
const impls: Record<string, ComponentType<Record<string, unknown>>> = {
  DemoCard: DemoCard as ComponentType<Record<string, unknown>>,
};

const seededIntegrations = () =>
  createLocalIntegrations([
    { id: "plaid", name: "Plaid", connected: true },
    { id: "stripe", name: "Stripe", connected: true },
    { id: "gmail", name: "Gmail", connected: false },
    { id: "slack", name: "Slack", connected: false },
    { id: "notion", name: "Notion", connected: false },
  ]);

const savedNode: UINode = { id: "ui-saved", kind: "component", source: "prewired", name: "DemoCard", props: { title: "June spending · vendo" } };

const suggestions = ["Show my spending", "Set a budget", "Pay a bill"];

function Section({ title, height, children }: { title: string; height: number; children: React.ReactNode }) {
  return (
    <section style={{ maxWidth: 980, margin: "0 auto 40px" }}>
      <h2 style={{ font: "600 13px/1 'Geist Mono', monospace", letterSpacing: ".08em", textTransform: "uppercase", color: "#8a8c92", margin: "0 0 12px" }}>{title}</h2>
      <div style={{ height, border: "1px solid #e9e9e5", borderRadius: 16, overflow: "hidden", boxShadow: "0 14px 38px rgba(27,30,37,.10)", background: "#fff" }}>
        {children}
      </div>
    </section>
  );
}

export function App() {
  return (
    <div style={{ padding: "48px 24px 120px" }}>
      <h1 style={{ maxWidth: 980, margin: "0 auto 28px", fontSize: 22, fontWeight: 600, letterSpacing: "-.02em" }}>Vendo Shell · live</h1>

      <Section title="Element 01 · VendoPage" height={560}>
        <VendoPage
          agent={agent}
          components={components}
          impls={impls}
          integrations={seededIntegrations()}
          greeting="What do you want to build?"
          suggestions={suggestions}
        />
      </Section>

      <Section title="Element 02 · VendoOverlay (click ‘Ask Maple’)" height={460}>
        <div style={{ position: "relative", height: "100%", background: "#f7f7f6", padding: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ height: 90, background: "#fff", border: "1px solid #ececea", borderRadius: 12 }} />
            ))}
          </div>
          <div style={{ position: "absolute", right: 18, bottom: 18 }}>
            <VendoProvider agent={agent} components={components}>
              <VendoShellProvider impls={impls} integrations={seededIntegrations()}>
                <VendoOverlay launcherLabel="Ask Maple" suggestions={suggestions} greeting="What can I help you build?" />
              </VendoShellProvider>
            </VendoProvider>
          </div>
        </div>
      </Section>

      <Section title="Element 03 · VendoSlot (empty + filled)" height={320}>
        <div style={{ height: "100%", background: "#f7f7f6", padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <VendoProvider agent={agent} components={components}>
            <VendoShellProvider impls={impls} integrations={seededIntegrations()}>
              <VendoSlot vendoId="slot-empty" emptyLabel="Design a vendo here" />
            </VendoShellProvider>
          </VendoProvider>
          <VendoProvider agent={agent} components={components}>
            <VendoShellProvider impls={impls} integrations={seededIntegrations()}>
              <VendoSlot vendoId="slot-filled" savedNode={savedNode} />
            </VendoShellProvider>
          </VendoProvider>
        </div>
      </Section>
    </div>
  );
}
