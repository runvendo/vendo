import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevCredential } from "../dev-creds/resolve.js";
import { runCloudStep } from "./cloud-init.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-cloud-init-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function output(): { logs: string[]; errors: string[]; sink: { log(m: string): void; error(m: string): void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (m) => logs.push(m), error: (m) => errors.push(m) } };
}

const noKey: DevCredential = { rung: "none" };
const envKey: DevCredential = { rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" };
const goodKey = `vnd_${"a".repeat(40)}`;

describe("runCloudStep", () => {
  it("states the plan when VENDO_API_KEY is valid", async () => {
    const messages = output();
    const result = await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: false,
      credential: envKey,
      cloudProbe: async () => ({ present: true, ok: true, plan: { id: "pro", name: "Pro", status: "active" }, capabilities: ["sharing"], unlocks: ["x"] }),
    });
    expect(result.keyValid).toBe(true);
    expect(messages.logs.some((l) => l.includes("VENDO_API_KEY valid (plan: Pro)"))).toBe(true);
  });

  it("one calm line + a pointer when no key and the ladder wants one", async () => {
    const messages = output();
    const result = await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: true, // non-interactive: never prompt
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance"] }),
    });
    expect(result.wroteEnvLocal).toBe(false);
    expect(messages.logs.some((l) => l.includes("A key unlocks a starter allowance"))).toBe(true);
    expect(messages.logs.some((l) => l.includes("vendo cloud login"))).toBe(true);
  });

  it("logs in, mints a starter allowance, and writes .env.local", async () => {
    const root = await tempRoot();
    const login = vi.fn(async () => 0);
    const mint = vi.fn(async () => goodKey);
    const messages = output();
    const result = await runCloudStep({
      root,
      output: messages.sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      promptEmail: async () => "dev@example.com",
      login,
      mint,
    });
    expect(login).toHaveBeenCalledWith("dev@example.com");
    expect(mint).toHaveBeenCalledOnce();
    expect(result.wroteEnvLocal).toBe(true);
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain(`VENDO_API_KEY=${goodKey}`);
  });

  it("upserts into an existing .env.local without clobbering other keys", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env.local"), "FOO=bar\nVENDO_API_KEY=old\n");
    await runCloudStep({
      root,
      output: output().sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      promptEmail: async () => "dev@example.com",
      login: async () => 0,
      mint: async () => goodKey,
    });
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain("FOO=bar");
    expect(envLocal).toContain(`VENDO_API_KEY=${goodKey}`);
    expect(envLocal).not.toContain("VENDO_API_KEY=old");
  });

  it("degrades gracefully when the starter allowance endpoint is absent", async () => {
    const root = await tempRoot();
    const messages = output();
    const result = await runCloudStep({
      root,
      output: messages.sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      promptEmail: async () => "dev@example.com",
      login: async () => 0,
      mint: async () => null,
    });
    expect(result.wroteEnvLocal).toBe(false);
    expect(messages.errors.some((l) => l.includes("starter allowance is not available yet"))).toBe(true);
  });

  it("does not offer login when the ladder already has a key rung", async () => {
    const confirm = vi.fn(async () => true);
    const messages = output();
    await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: false,
      credential: envKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm,
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});
