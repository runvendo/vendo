import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexSessionRider } from "./codex.js";

const stub = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures", "stub-codex.mjs");

function stubRider(): CodexSessionRider {
  return new CodexSessionRider({ command: process.execPath, args: [stub], isolateHome: false });
}

describe("CodexSessionRider against a protocol stub", () => {
  it("handshakes, registers dynamic tools, and streams a text turn", async () => {
    const rider = stubRider();
    try {
      await rider.start({
        system: "You are the test agent.",
        tools: [{ name: "vendo_echo", description: "Echo.", inputSchema: { type: "object" } }],
        onToolCall: async () => ({ text: "unused", ok: true }),
      });
      expect(rider.model).toBe("stub-model");
      const deltas: string[] = [];
      const result = await rider.runTurn("hello", (delta) => deltas.push(delta));
      expect(deltas).toEqual(["Hello ", "from stub."]);
      expect(result.text).toBe("Hello from stub.");
    } finally {
      await rider.dispose();
    }
  });

  it("routes a dynamic tool call through the bridge and parks on a slow executor", async () => {
    const rider = stubRider();
    const calls: Array<{ tool: string; args: unknown }> = [];
    try {
      await rider.start({
        system: "sys",
        tools: [{ name: "vendo_echo", description: "Echo.", inputSchema: { type: "object" } }],
        onToolCall: async (call) => {
          calls.push(call);
          // Simulated approval park: the response is deliberately delayed and
          // the protocol simply waits (request/response, no timeout).
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { text: JSON.stringify({ status: "ok", output: { echoed: "yes" } }), ok: true };
        },
      });
      const started = Date.now();
      const result = await rider.runTurn("please use the tool", () => {});
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      expect(calls).toEqual([{ tool: "vendo_echo", args: { value: "from-stub" } }]);
      expect(result.text).toContain('tool said: {"status":"ok"');
    } finally {
      await rider.dispose();
    }
  });

  it("denies harness command approvals", async () => {
    const rider = stubRider();
    try {
      await rider.start({ system: "sys", tools: [], onToolCall: async () => ({ text: "", ok: true }) });
      const result = await rider.runTurn("try the shell", () => {});
      expect(result.text).toContain("approval: denied");
    } finally {
      await rider.dispose();
    }
  });

  it("isolates the subprocess in a private CODEX_HOME carrying only the login", async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), "vendo-codex-src-"));
    await writeFile(join(sourceHome, "auth.json"), JSON.stringify({ token: "fake" }));
    // Personal config MUST NOT ride along.
    await writeFile(join(sourceHome, "config.toml"), "[mcp_servers.gmail]\ncommand='leak'\n");
    const rider = new CodexSessionRider({ command: process.execPath, args: [stub], sourceHome });
    try {
      await rider.start({ system: "sys", tools: [], onToolCall: async () => ({ text: "", ok: true }) });
      const result = await rider.runTurn("report home", () => {});
      const home = result.text.slice("home=".length);
      expect(home).not.toBe("");
      expect(home).not.toBe(sourceHome);
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8"))).toEqual({ token: "fake" });
      // The personal config never rides along; a minimal generated one does.
      const config = await readFile(join(home, "config.toml"), "utf8");
      expect(config).not.toContain("mcp_servers");
      expect(config).toContain("web_search = false");
      await rider.dispose();
      // The copied credentials are cleaned up with the session.
      await expect(readFile(join(home, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rider.dispose();
    }
  });

  it("degrades with a clear message when the binary is absent", async () => {
    const rider = new CodexSessionRider({ command: "definitely-not-codex-binary" });
    await expect(
      rider.start({ system: "sys", tools: [], onToolCall: async () => ({ text: "", ok: true }) }),
    ).rejects.toThrow(/needs the `definitely-not-codex-binary` CLI/);
  });
});
