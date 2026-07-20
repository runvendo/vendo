/**
 * Wave 7 H2 browser-evidence harness: mounts the REAL @vendoai/ui AppFrame
 * (source import, bundled by esbuild) around a REAL scaffold server running
 * on :8123, with a scripted keepalive seam so the machine-sleep transition
 * can be driven deterministically for screenshots:
 *   ping → "awake" while the fake machine is up (idle timer ride),
 *   [simulate idle sleep] → next activity ping → "woke" → resuming cover →
 *   reopen lands a fresh machine URL (?wake=2) → the frame comes back.
 */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppFrame } from "../../../../packages/ui/dist/tree/frames.js";

const APP_URL = "http://127.0.0.1:8123/";
const machine = { asleep: false };
window.__sleepMachine = () => { machine.asleep = true; };

function Harness() {
  const [url, setUrl] = useState(`${APP_URL}?wake=1`);
  const [log, setLog] = useState(["(move the mouse to generate user activity)"]);
  const push = (line) => setLog((old) => [...old.slice(-5), `${new Date().toISOString().slice(11, 19)} ${line}`]);
  const keepalive = useMemo(() => ({
    intervalMs: 1000,
    ping: async () => {
      if (machine.asleep) {
        push("POST /apps/:id/machine/ping → { state: \"woke\" } — machine had slept, URL stale");
        return { state: "woke" };
      }
      push("POST /apps/:id/machine/ping → { state: \"awake\" } — idle timer re-armed");
      return { state: "awake" };
    },
    reopen: async () => {
      push("re-open in flight (wake-on-open)…");
      await new Promise((resolve) => setTimeout(resolve, 4000));
      machine.asleep = false;
      setUrl(`${APP_URL}?wake=2`);
      push("open() → fresh machine URL (?wake=2)");
    },
  }), []);
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 20, maxWidth: 960, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 2px" }}>Wave 7 H2 — served-app iframe keepalive (real AppFrame)</h2>
      <p style={{ color: "#666", margin: "0 0 10px", fontSize: 14 }}>
        The embed pings the machine on user activity; a woke ping shows the resuming cover and re-opens for the fresh URL.
      </p>
      <button style={{ marginBottom: 8 }} onClick={() => window.__sleepMachine()}>simulate idle sleep (machine TTL)</button>
      <pre data-testid="log" style={{ background: "#f4f4f5", border: "1px solid #e3e3e6", borderRadius: 8, padding: 10, fontSize: 12, minHeight: 96 }}>
        {log.join("\n")}
      </pre>
      <div style={{ border: "1px solid #e3e3e6", borderRadius: 10, overflow: "hidden" }}>
        <AppFrame surface={{ kind: "http", url }} keepalive={keepalive} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
