"use client";
/**
 * DEV HARNESS (see page.tsx) — the client half. ChromeRoot supplies the host
 * theme variables and the chrome stylesheet the shimmer reads, exactly as the
 * agent surface does; TreeView is the production renderer, unmodified.
 */
import { ChromeRoot } from "@vendoai/ui/chrome";
import { TreeView, type WalkTree } from "@vendoai/ui/tree";
import { VendoRoot } from "@/components/vendo/VendoRoot";

const noAction = async () => ({ status: "ok" as const, output: null });

function Variant({ label, tree }: { label: string; tree: WalkTree }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }} data-harness-variant={label}>
      <h2 style={{ font: "600 13px/1.2 system-ui, sans-serif", letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.5 }}>
        {label}
      </h2>
      <TreeView tree={tree} components={{}} onAction={noAction} />
    </section>
  );
}

export function SkeletonHarness({ tabbed, single }: { tabbed: WalkTree; single: WalkTree }) {
  return (
    <VendoRoot>
      <ChromeRoot>
        <div style={{ display: "flex", flexDirection: "column", gap: 48, maxWidth: 880, margin: "0 auto", padding: 32 }}>
          <Variant label="Tabbed skeleton" tree={tabbed} />
          <Variant label="Single surface" tree={single} />
        </div>
      </ChromeRoot>
    </VendoRoot>
  );
}
