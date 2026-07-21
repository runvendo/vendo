import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevCredential } from "../dev-creds/resolve.js";
import { AUTH_MD_URL, agentKeyPointerLines, runCloudStep, upsertEnvLocal } from "./cloud-init.js";

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
  it("reports a present, well-formed VENDO_API_KEY", async () => {
    const messages = output();
    const result = await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: false,
      credential: envKey,
      cloudProbe: async () => ({ present: true, ok: true, unlocks: ["x"] }),
    });
    expect(result.keyValid).toBe(true);
    expect(messages.logs.some((l) => l.includes("VENDO_API_KEY present and well-formed"))).toBe(true);
  });

  it("one calm line + the auth.md agent pointer when no key and the ladder wants one", async () => {
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
    // The agent path is self-contained: discovery URL, the ceremony command,
    // and both fallbacks (agent-install-dx Layer 2, key-mint integration).
    const joined = messages.logs.join("\n");
    for (const line of agentKeyPointerLines()) expect(joined).toContain(line);
    expect(joined).toContain(AUTH_MD_URL);
    expect(joined).toContain("vendo login");
    expect(joined).toContain("--cloud-key");
    expect(joined).toContain("--byo");
  });

  it("--byo suppresses the agent pointer (an explicit BYO choice is final)", async () => {
    const messages = output();
    const result = await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: false,
      byo: true,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: vi.fn(async () => true), // must never be consulted
    });
    expect(result.wroteEnvLocal).toBe(false);
    const joined = messages.logs.join("\n");
    expect(joined).not.toContain(AUTH_MD_URL);
    expect(joined).toContain("vendo login"); // the calm human pointer stays
  });

  it("an unshown (non-TTY) decline emits the agent pointer; a real TTY decline stays calm", async () => {
    const agentRun = output();
    await runCloudStep({
      root: await tempRoot(),
      output: agentRun.sink,
      yes: false,
      isTty: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => false,
    });
    expect(agentRun.logs.join("\n")).toContain(AUTH_MD_URL);

    const humanRun = output();
    await runCloudStep({
      root: await tempRoot(),
      output: humanRun.sink,
      yes: false,
      isTty: true,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => false,
    });
    expect(humanRun.logs.join("\n")).toContain("Skipped — run `vendo login`");
    expect(humanRun.logs.join("\n")).not.toContain(AUTH_MD_URL);
  });

  it("runs the claim ceremony on accept and reports the landed key", async () => {
    const root = await tempRoot();
    const messages = output();
    const deviceLogin = vi.fn(async () => {
      await upsertEnvLocal(root, "VENDO_API_KEY", goodKey);
      return 0;
    });
    const result = await runCloudStep({
      root,
      output: messages.sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      deviceLogin,
    });
    expect(deviceLogin).toHaveBeenCalledOnce();
    expect(result).toEqual({ keyPresent: true, keyValid: true, wroteEnvLocal: true });
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain(`VENDO_API_KEY=${goodKey}`);
  });

  it("runs the REAL default ceremony against a scripted console and lands the key", async () => {
    const root = await tempRoot();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === "https://cloud.test/api/v1/agent/claim") {
        return Response.json({
          claim_token: `vct_${"b".repeat(64)}`,
          user_code: "BCDF-GHJK",
          verification_uri: "https://cloud.test/claim",
          verification_uri_complete: "https://cloud.test/claim?code=BCDF-GHJK",
          expires_in: 600,
          interval: 5,
        });
      }
      expect(request.url).toBe("https://cloud.test/api/v1/oauth/token");
      return Response.json({ access_token: goodKey, token_type: "Bearer", scope: "dev-mode" });
    }) as unknown as typeof fetch;
    const messages = output();
    const result = await runCloudStep({
      root,
      output: messages.sink,
      yes: false,
      isTty: false,
      credential: noKey,
      apiUrl: "https://cloud.test",
      fetchImpl,
      sleep: async () => {},
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
    });
    expect(result).toEqual({ keyPresent: true, keyValid: true, wroteEnvLocal: true });
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain(`VENDO_API_KEY=${goodKey}`);
    // init drives the ceremony inline — no standalone re-run hint.
    expect(messages.logs.join("\n")).not.toContain("Re-run `vendo init`");
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
      deviceLogin: async () => {
        await upsertEnvLocal(root, "VENDO_API_KEY", goodKey);
        return 0;
      },
    });
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain("FOO=bar");
    expect(envLocal).toContain(`VENDO_API_KEY=${goodKey}`);
    expect(envLocal).not.toContain("VENDO_API_KEY=old");
  });

  it("reports a ceremony that did not complete without changing init's exit code", async () => {
    const messages = output();
    const result = await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      deviceLogin: async () => 1,
    });
    expect(result).toEqual({ keyPresent: false, keyValid: false, wroteEnvLocal: false });
    expect(messages.errors.join("\n")).toContain("run `vendo login`");
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
