/** The J7 page: the shipped Vendo React surface — `VendoRoot` + the chrome
 *  `<VendoThread />` — plus a headless `useApps` probe, all driving the REAL
 *  composed umbrella wire (proxied to the loopback server) same-origin.
 *
 *  The principal rides `x-vendo-test-user: user_ada` on the client headers; the
 *  wire server resolves it to the principal AND injects the matching host session
 *  cookie so present host-tool calls execute for real (04 §4).
 */
import { createVendoClient, useApps, VendoRoot } from "@vendoai/vendo/react";
import { ActivityPanel, VendoThread } from "@vendoai/ui/chrome";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(window.location.search);
const TEST_USER = params.get("user") ?? "user_ada";
const threadId = params.get("thread") ?? "thr_j7";

const client = createVendoClient({
  baseUrl: "/api/vendo",
  headers: { "x-vendo-test-user": TEST_USER },
});

/** A minimal headless surface over `useApps` — proves the apps hook lists an app
 *  the composed generation engine produced (the create call rides the same wire
 *  and consumes a scripted generation turn). */
function AppsProbe() {
  const { apps, create } = useApps();
  return (
    <section aria-label="Apps probe" data-testid="apps-probe">
      <h2>Apps</h2>
      <button
        type="button"
        data-testid="apps-create"
        onClick={() => void create("Build me a greeting card").catch(() => undefined)}
      >
        Create app
      </button>
      <ul data-testid="apps-list">
        {apps.map((app) => (
          <li key={app.id} data-app-id={app.id}>{app.name}</li>
        ))}
      </ul>
    </section>
  );
}

function Page() {
  return (
    <VendoRoot client={client}>
      <main style={{ display: "grid", gap: 24, padding: 24, maxWidth: 900, margin: "0 auto" }}>
        <section aria-label="Thread" data-testid="thread-surface" style={{ minHeight: 360 }}>
          <VendoThread threadId={threadId} greeting="What can I help you build?" />
        </section>
        <ActivityPanel />
        <AppsProbe />
      </main>
    </VendoRoot>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("browser harness root is missing");
createRoot(root).render(<Page />);
