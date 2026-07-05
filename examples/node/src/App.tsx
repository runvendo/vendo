/**
 * The client is the exact same surface `vendo init` wires into Next.js
 * apps: VendoRoot from `@vendoai/next/client` is plain React (the package
 * imports nothing from Next.js) — launcher pill, Cmd/Ctrl+K overlay, chat,
 * and sandboxed generated views, all talking to the node:http server through
 * Vite's /api/vendo proxy.
 */
import { VendoRoot } from "@vendoai/next/client";

export function App() {
  return (
    <VendoRoot productName="Node Example">
      <main style={{ fontFamily: "system-ui", maxWidth: 560, margin: "80px auto", lineHeight: 1.6 }}>
        <h1>Vendo on plain node:http</h1>
        <p>
          The Vendo API is served by <code>server.mjs</code> — a ~30-line{" "}
          <code>node:http</code> server, no Next.js.
        </p>
        <p>
          Hit the launcher pill (or <strong>Cmd/Ctrl+K</strong>) and ask for something visual —
          “show me a dashboard comparing three savings plans.”
        </p>
      </main>
    </VendoRoot>
  );
}
