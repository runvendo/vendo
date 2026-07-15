import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runServerJson } from "./server-json.js";
import type { Output } from "../shared.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(manifest: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-server-json-"));
  cleanup.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@acme/maple",
    description: "Maple banking tools",
    version: "1.2.3",
    ...manifest,
  }));
  return root;
}

function output(): { sink: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    sink: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  };
}

describe("vendo mcp server-json", () => {
  it("derives registry identity from package.json and explicit discovery inputs", async () => {
    const root = await fixture();
    const messages = output();

    expect(await runServerJson({
      targetDir: root,
      domain: "example.com",
      url: "https://mcp.example.com/api/vendo/mcp",
      output: messages.sink,
    })).toBe(0);

    expect(JSON.parse(await readFile(join(root, "server.json"), "utf8"))).toEqual({
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "com.example/maple",
      description: "Maple banking tools",
      version: "1.2.3",
      remotes: [{ type: "streamable-http", url: "https://mcp.example.com/api/vendo/mcp" }],
    });
    expect(messages.logs).toEqual(["Wrote server.json for com.example/maple"]);
    expect(messages.errors).toEqual([]);
  });

  it("prompts for domain and public URL when flags are missing", async () => {
    const root = await fixture();
    const prompt = vi.fn()
      .mockResolvedValueOnce("example.com")
      .mockResolvedValueOnce("https://example.com/api/vendo/mcp");

    expect(await runServerJson({ targetDir: root, prompt, output: output().sink })).toBe(0);
    expect(prompt.mock.calls.map(([question]) => question)).toEqual([
      "Registry domain (for example example.com): ",
      "Public MCP URL: ",
    ]);
  });

  it("validates namespace and remote URL binding before writing", async () => {
    const root = await fixture();
    const messages = output();

    expect(await runServerJson({
      targetDir: root,
      domain: "example.com",
      url: "https://elsewhere.test/api/vendo/mcp",
      output: messages.sink,
    })).toBe(1);

    await expect(readFile(join(root, "server.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(messages.errors.join("\n")).toContain("example.com or one of its subdomains");
  });

  it("refuses to overwrite server.json unless --force was passed", async () => {
    const root = await fixture();
    const original = "{\n  \"handEdited\": true\n}\n";
    await writeFile(join(root, "server.json"), original);
    const messages = output();

    expect(await runServerJson({
      targetDir: root,
      domain: "example.com",
      url: "https://example.com/api/vendo/mcp",
      output: messages.sink,
    })).toBe(1);
    expect(await readFile(join(root, "server.json"), "utf8")).toBe(original);
    expect(messages.errors).toEqual(["server.json already exists; pass --force to overwrite it"]);

    expect(await runServerJson({
      targetDir: root,
      domain: "example.com",
      url: "https://example.com/api/vendo/mcp",
      force: true,
      output: output().sink,
    })).toBe(0);
  });

  it("reports pinned-schema validation failures without writing", async () => {
    const root = await fixture({ description: "x".repeat(101) });
    const messages = output();

    expect(await runServerJson({
      targetDir: root,
      domain: "example.com",
      url: "https://example.com/api/vendo/mcp",
      output: messages.sink,
    })).toBe(1);
    expect(messages.errors.join("\n")).toContain("server.json is invalid");
    expect(messages.errors.join("\n")).toContain("100 characters");
    await expect(readFile(join(root, "server.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
