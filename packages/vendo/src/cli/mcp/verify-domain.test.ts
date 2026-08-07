import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVerifyDomain } from "./verify-domain.js";
import type { Output } from "../shared.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-verify-domain-"));
  cleanup.push(root);
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

describe("vendo mcp verify-domain", () => {
  it("refuses to generate a key without a caller-specified custody path", async () => {
    const root = await fixture();
    const messages = output();

    expect(await runVerifyDomain({
      targetDir: root,
      domain: "example.com",
      output: messages.sink,
    })).toBe(1);

    expect(messages.errors.join("\n")).toContain("Pass --key-out <path>");
    expect(messages.errors.join("\n")).toContain("private key");
  });

  it("writes only the private seed to the explicit path and prints both challenge forms", async () => {
    const root = await fixture();
    const keyDir = await mkdtemp(join(tmpdir(), "vendo-registry-key-"));
    cleanup.push(keyDir);
    const keyOut = join(keyDir, "example.com.hex");
    const messages = output();

    expect(await runVerifyDomain({
      targetDir: root,
      domain: "example.com",
      keyOut,
      output: messages.sink,
    })).toBe(0);

    expect(await readFile(keyOut, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect((await stat(keyOut)).mode & 0o777).toBe(0o600);
    const challengeLines = messages.logs.filter((line) => line.startsWith("v=MCPv1; k=ed25519; p="));
    expect(challengeLines).toHaveLength(2);
    expect(challengeLines[0]).toBe(challengeLines[1]);
    expect(challengeLines[0]).toMatch(/^v=MCPv1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/);
    expect(messages.logs.join("\n")).not.toMatch(/[0-9a-f]{64}/);
  });

  it("writes the equivalent HTTP challenge under an explicitly chosen static directory", async () => {
    const root = await fixture();
    const keyDir = await mkdtemp(join(tmpdir(), "vendo-registry-key-"));
    cleanup.push(keyDir);
    const messages = output();

    expect(await runVerifyDomain({
      targetDir: root,
      domain: "example.com",
      keyOut: join(keyDir, "example.com.hex"),
      writeWellKnown: "public",
      output: messages.sink,
    })).toBe(0);

    const challenge = messages.logs.find((line) => line.startsWith("v=MCPv1;"));
    expect(await readFile(join(root, "public", ".well-known", "mcp-registry-auth"), "utf8"))
      .toBe(`${challenge}\n`);
  });
});
