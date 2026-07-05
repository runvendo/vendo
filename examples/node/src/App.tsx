/**
 * The client is the exact same surface `flowlet init` wires into Next.js
 * apps: FlowletRoot from `@flowlet/next/client` is plain React (the package
 * imports nothing from Next.js) — launcher pill, Cmd/Ctrl+K overlay, chat,
 * and sandboxed generated views, all talking to the node:http server through
 * Vite's /api/flowlet proxy.
 */
import { FlowletRoot } from "@flowlet/next/client";

export function App() {
  return (
    <FlowletRoot productName="Node Example">
      <main style={{ fontFamily: "system-ui", maxWidth: 560, margin: "80px auto", lineHeight: 1.6 }}>
        <h1>Flowlet on plain node:http</h1>
        <p>
          The Flowlet API is served by <code>server.mjs</code> — a ~30-line{" "}
          <code>node:http</code> server, no Next.js.
        </p>
        <p>
          Hit the launcher pill (or <strong>Cmd/Ctrl+K</strong>) and ask for something visual —
          “show me a dashboard comparing three savings plans.”
        </p>
      </main>
    </FlowletRoot>
  );
}
