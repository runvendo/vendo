import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useEffect, useRef, useState } from "react";

interface McpBootstrap {
  appId: string;
  resourceUri: string;
  mimeType: string;
  html: string;
  toolInput: { arguments: { appId: string } };
  toolResult: CallToolResult;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await response.text() || `request failed (${response.status})`);
  return await response.json() as T;
}

/** Test-only MCP Apps host surface. The iframe is the shipped shim resource;
 * AppBridge is the official ext-apps host half; calls are proxied through the
 * test control endpoint to one real SDK client connected to the real door. */
export function McpAppsHost() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bootstrap, setBootstrap] = useState<McpBootstrap>();
  const [status, setStatus] = useState("Connecting a real MCP client…");
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void fetch("/__test/mcp/open", { method: "POST" })
      .then((response) => jsonResponse<McpBootstrap>(response))
      .then((value) => {
        if (active) setBootstrap(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!bootstrap || !frame?.contentWindow) return;

    let active = true;
    const bridge = new AppBridge(
      null,
      { name: "Vendo Playwright MCP Apps host", version: "1.0.0" },
      { serverTools: {} },
    );
    bridge.oncalltool = async (params) => jsonResponse<CallToolResult>(await fetch("/__test/mcp/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    }));
    bridge.onsizechange = ({ height }) => {
      if (height !== undefined) frame.style.height = `${Math.max(420, Math.min(760, height + 8))}px`;
    };
    bridge.oninitialized = () => {
      void (async () => {
        await bridge.sendToolInput(bootstrap.toolInput);
        await bridge.sendToolResult(bootstrap.toolResult);
        if (active) setStatus("Rendered from resources/read through the real MCP door");
      })().catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    };

    void (async () => {
      await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
      if (active) frame.srcdoc = bootstrap.html;
    })().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      active = false;
      void bridge.close();
    };
  }, [bootstrap]);

  return (
    <main style={{ minHeight: "100vh", padding: "36px 24px", background: "#eef2ff", color: "#171a2b" }}>
      <section
        data-testid="mcp-apps-card"
        data-resource-uri={bootstrap?.resourceUri}
        data-resource-mime-type={bootstrap?.mimeType}
        style={{
          width: "min(760px, 100%)",
          margin: "0 auto",
          padding: 20,
          border: "1px solid #cbd3f6",
          borderRadius: 18,
          background: "rgba(255, 255, 255, 0.92)",
          boxShadow: "0 20px 60px rgba(53, 65, 130, 0.16)",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <header style={{ display: "grid", gap: 6, marginBottom: 16 }}>
          <span style={{ color: "#52609a", fontSize: 12, fontWeight: 750, letterSpacing: "0.08em" }}>
            EXT-APPS HOST HARNESS
          </span>
          <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.025em" }}>Real-client Apps ride-along</h1>
          <span data-testid="mcp-host-status" style={{ color: error ? "#a21d2b" : "#596078", fontSize: 13 }}>
            {error ?? status}
          </span>
          {bootstrap ? (
            <code style={{ color: "#4253a4", fontSize: 12 }}>
              {bootstrap.resourceUri} · {bootstrap.mimeType}
            </code>
          ) : null}
        </header>
        <iframe
          ref={frameRef}
          id="mcp-apps-shim"
          title="Vendo MCP Apps shim"
          sandbox="allow-scripts"
          style={{ display: "block", width: "100%", minHeight: 420, border: 0, borderRadius: 12 }}
        />
      </section>
    </main>
  );
}
