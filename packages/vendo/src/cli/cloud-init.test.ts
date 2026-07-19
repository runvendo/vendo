import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevCredential } from "../dev-creds/resolve.js";
import { AUTH_MD_URL, agentKeyPointerLines, mintStarterAllowance, runCloudStep } from "./cloud-init.js";

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

describe("mintStarterAllowance", () => {
  /** A fake logged-in machine: ~/.vendo/cloud-session.json carries the user
   *  session the contract authenticates with. */
  async function loggedInHome(): Promise<string> {
    const home = await tempRoot();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".vendo"), { recursive: true });
    await writeFile(
      join(home, ".vendo", "cloud-session.json"),
      JSON.stringify({ access_token: "user-jwt", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    );
    return home;
  }

  it("mints against the documented console contract with user-session auth", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return Response.json({ key: goodKey, meter: { runs: { included: 1000, remaining: 1000 } } });
    }) as unknown as typeof fetch;

    const key = await mintStarterAllowance({
      apiUrl: "https://cloud.test",
      env: {},
      home: await loggedInHome(),
      fetchImpl,
    });
    expect(key).toBe(goodKey);
    expect(requests[0]).toEqual({
      url: "https://cloud.test/api/v1/keys",
      method: "POST",
      authorization: "Bearer user-jwt",
      body: { purpose: "dev-mode" },
    });
  });

  it("returns null (graceful degradation) when an older console 404s the endpoint", async () => {
    const fetchImpl = (async () =>
      Response.json({ error: { code: "not-found", message: "no such route" } }, { status: 404 })
    ) as unknown as typeof fetch;
    const key = await mintStarterAllowance({
      apiUrl: "https://cloud.test",
      env: {},
      home: await loggedInHome(),
      fetchImpl,
    });
    expect(key).toBeNull();
  });

  it("propagates real errors instead of degrading", async () => {
    const fetchImpl = (async () =>
      Response.json({ error: { code: "unavailable", message: "Console is down." } }, { status: 503 })
    ) as unknown as typeof fetch;
    await expect(mintStarterAllowance({
      apiUrl: "https://cloud.test",
      env: {},
      home: await loggedInHome(),
      fetchImpl,
    })).rejects.toThrow(/console is down/i);
  });
});

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
    expect(joined).toContain("vendo cloud device-login");
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
    expect(joined).toContain("vendo cloud login"); // the calm human pointer stays
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
    expect(humanRun.logs.join("\n")).toContain("Skipped — run `vendo cloud login`");
    expect(humanRun.logs.join("\n")).not.toContain(AUTH_MD_URL);
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

  it("mints through the REAL default mint path against a mocked console and writes .env.local", async () => {
    const root = await tempRoot();
    const home = await tempRoot();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".vendo"), { recursive: true });
    await writeFile(
      join(home, ".vendo", "cloud-session.json"),
      JSON.stringify({ access_token: "user-jwt", expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    );
    const consoleFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://cloud.test/api/v1/keys");
      expect(request.headers.get("authorization")).toBe("Bearer user-jwt");
      expect(await request.json()).toEqual({ purpose: "dev-mode" });
      return Response.json({ key: goodKey, meter: { runs: { included: 1000, remaining: 1000 } } });
    }) as unknown as typeof fetch;

    const result = await runCloudStep({
      root,
      output: output().sink,
      yes: false,
      credential: noKey,
      apiUrl: "https://cloud.test",
      home,
      fetchImpl: consoleFetch,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      promptEmail: async () => "dev@example.com",
      login: async () => 0,
    });
    expect(consoleFetch).toHaveBeenCalledOnce();
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
    expect(messages.errors.some((l) => l.includes("does not serve the dev-mode starter allowance"))).toBe(true);
  });

  it("surfaces a mint failure (e.g. the console's starter-key cap) without throwing out of init", async () => {
    const messages = output();
    const result = await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      promptEmail: async () => "dev@example.com",
      login: async () => 0,
      mint: async () => {
        throw new Error("This organization already has 10 active dev-mode starter keys.");
      },
    });
    expect(result).toEqual({ keyPresent: false, keyValid: false, wroteEnvLocal: false });
    expect(messages.errors.some((l) => l.includes("10 active dev-mode starter keys"))).toBe(true);
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
