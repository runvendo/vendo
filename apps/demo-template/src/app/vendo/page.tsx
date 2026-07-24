import { DemoPanel } from "@/components/demo-panel";
import { loadDemoConfig } from "@/lib/demo-config-loader";
import { getCapsGuard } from "@/server/caps";

// ============================================================================
// PLUMBING — RESTYLE, DON'T REWIRE, PER PROSPECT.
// The panel page: a server component so demo.config and the caps guard are
// read server-side, composed client-side by DemoPanel. Creator agents may
// restyle the panel (in DemoPanel/globals.css), but this page's wiring is
// LOAD-BEARING: it must stay a force-dynamic server component that loads
// demo.config, calls the guard's non-consuming peekRefusal(), and passes
// prospect/ctaUrl/beats/initialRefusal into DemoPanel — dropping any of these
// leaves the fenced chrome components mounted but dead.
// ============================================================================

// Caps counters move per request — never prerender a stale limit state.
export const dynamic = "force-dynamic";
export default async function VendoTabPage() {
  const config = loadDemoConfig();
  const refusal = await getCapsGuard().peekRefusal();
  return (
    <DemoPanel
      prospect={config.prospect}
      ctaUrl={config.ctaUrl}
      beats={config.beats}
      initialRefusal={refusal === null ? null : refusal.body.vendoDemo}
    />
  );
}
