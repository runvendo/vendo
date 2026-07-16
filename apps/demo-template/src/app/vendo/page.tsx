import { DemoPanel } from "@/components/demo-panel";
import { loadDemoConfig } from "@/lib/demo-config-loader";
import { getCapsGuard } from "@/server/caps";

// Caps counters move per request — never prerender a stale limit state.
export const dynamic = "force-dynamic";

// The panel page: a server component so demo.config and the caps guard are
// read server-side, composed client-side by DemoPanel (chrome + chips +
// VendoRoot + VendoThread).
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
