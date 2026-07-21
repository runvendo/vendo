import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTelemetry } from "./client.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    version: "9.9.9",
    home: undefined as string | undefined,
    config: { anonymousId: "id-1", optedOut: false, noticeShown: true },
    env: {} as Record<string, string | undefined>,
    runtime: false,
    posthogKey: "phc_test",
    fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe("createTelemetry.track", () => {
  it("posts an allowlisted event to PostHog", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(String(url)).toContain("us.i.posthog.com");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("init_started");
    expect(body.distinct_id).toBe("id-1");
    expect(body.properties.framework).toBe("next");
    expect(body.properties.vendoVersion).toBe("9.9.9");
  });

  it("does not post when consent is denied", async () => {
    const deps = makeDeps({ env: { DO_NOT_TRACK: "1" } });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not post when no PostHog key is configured", async () => {
    const deps = makeDeps({ posthogKey: undefined });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("drops keys outside the event allowlist", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next", sourceCode: "secret" } as never);
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.sourceCode).toBeUndefined();
    expect(body.properties.framework).toBe("next");
  });

  it("caps oversized string values on an allowed key (review)", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "a".repeat(5000) });
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.framework.length).toBeLessThanOrEqual(512);
  });

  it("drops object/array values even on an allowed key (review)", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: { nested: "secret" } } as never);
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.framework).toBeUndefined();
  });

  it("includes projectIdHash and packageManager base props on every event", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vendo-tele-client-"));
    try {
      mkdirSync(join(cwd, ".git"));
      writeFileSync(join(cwd, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/a/b.git\n');
      const deps = makeDeps({
        cwd,
        env: { npm_config_user_agent: "pnpm/9.1.0 npm/? node/v20.11.0 darwin arm64" },
      });
      const t = createTelemetry(deps);
      await t.track("agent_run", {});
      const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
      expect(body.properties.packageManager).toBe("pnpm");
      expect(body.properties.projectIdHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits projectIdHash and packageManager when no source exists", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vendo-tele-client-"));
    try {
      const deps = makeDeps({ cwd });
      const t = createTelemetry(deps);
      await t.track("agent_run", {});
      const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
      expect("projectIdHash" in body.properties).toBe(false);
      expect("packageManager" in body.properties).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("never throws when fetch rejects", async () => {
    const deps = makeDeps({ fetchImpl: vi.fn().mockRejectedValue(new Error("network")) });
    const t = createTelemetry(deps);
    await expect(t.track("agent_run", {})).resolves.toBeUndefined();
  });

  it("returns after the telemetry timeout when fetch never settles", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ fetchImpl: vi.fn(() => new Promise(() => {})) });
      const t = createTelemetry(deps);
      const tracked = t.track("init_started", { framework: "next" });

      await vi.advanceTimersByTimeAsync(1500);

      await expect(tracked).resolves.toBeUndefined();
      expect(deps.fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

const CLOUD_KEY = `vnd_${"0123456789abcdef".repeat(2)}01234567`; // 40 hex chars

function sentProps(deps: ReturnType<typeof makeDeps>): Record<string, unknown> {
  const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
  return body.properties as Record<string, unknown>;
}

describe("cloud lane (VENDO_API_KEY)", () => {
  it("marks every event with cloud + cloudKeyHash when a valid key is set", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("agent_run", {});
    const props = sentProps(deps);
    expect(props.cloud).toBe(true);
    // Unsalted sha256 of the key itself — the console joins on this hash.
    expect(props.cloudKeyHash).toBe(createHash("sha256").update(CLOUD_KEY).digest("hex"));
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["too short", "vnd_abc123"],
    ["uppercase hex", `vnd_${"A".repeat(40)}`],
    ["non-hex chars", `vnd_${"g".repeat(40)}`],
    ["wrong prefix", `phc_${"a".repeat(40)}`],
    ["trailing junk", `vnd_${"a".repeat(40)}x`],
  ])("stays anonymous when the key is %s", async (_label, key) => {
    const deps = makeDeps({ env: { VENDO_API_KEY: key } });
    const t = createTelemetry(deps);
    await t.track("agent_run", {});
    const props = sentProps(deps);
    expect("cloud" in props).toBe(false);
    expect("cloudKeyHash" in props).toBe(false);
  });

  it("accepts cloud-only props on any event when the lane is active", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("init_completed", {
      framework: "next",
      projectName: "maple-bank",
      repoHost: "github.com",
      connectionsConfigured: 3,
      detectMs: 1200,
      engineMs: 800,
    });
    const props = sentProps(deps);
    expect(props.framework).toBe("next");
    expect(props.projectName).toBe("maple-bank");
    expect(props.repoHost).toBe("github.com");
    expect(props.connectionsConfigured).toBe(3);
    expect(props.detectMs).toBe(1200);
    expect(props.engineMs).toBe(800);
  });

  it("strips cloud-only props when the lane is inactive, even if callers pass them", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_completed", { framework: "next", projectName: "maple-bank", detectMs: 5 });
    const props = sentProps(deps);
    expect(props.framework).toBe("next");
    expect("projectName" in props).toBe(false);
    expect("detectMs" in props).toBe(false);
  });

  it("still drops non-allowlisted keys when the lane is active", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("agent_run", { sourceCode: "secret" } as never);
    expect("sourceCode" in sentProps(deps)).toBe(false);
  });

  it("callers cannot spoof cloud or cloudKeyHash", async () => {
    // Inactive lane: the caller-passed markers are stripped outright.
    const anon = makeDeps();
    await createTelemetry(anon).track("agent_run", { cloud: true, cloudKeyHash: "ff" } as never);
    expect("cloud" in sentProps(anon)).toBe(false);
    expect("cloudKeyHash" in sentProps(anon)).toBe(false);

    // Active lane: producer-set values win over caller-passed ones.
    const cloud = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    await createTelemetry(cloud).track("agent_run", { cloud: false, cloudKeyHash: "ff" } as never);
    const props = sentProps(cloud);
    expect(props.cloud).toBe(true);
    expect(props.cloudKeyHash).toBe(createHash("sha256").update(CLOUD_KEY).digest("hex"));
  });

  it("consent beats cloud: an opted-out user with a valid key sends nothing", async () => {
    const deps = makeDeps({ env: { DO_NOT_TRACK: "1", VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("init_failed", { errorDetail: "boom" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("scrubs errorDetail as defense-in-depth even when the caller forgot to", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("init_failed", {
      errorDetail: `ENOENT /Users/alice/app/vendo.json for alice@example.com key ${CLOUD_KEY}`,
    });
    const detail = sentProps(deps).errorDetail as string;
    expect(detail).toBe("ENOENT [path] for [email] key [secret]");
  });

  it("bounds cloud prop values like any other prop", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("agent_run", {
      projectName: "a".repeat(5000),
      servedApps: { nested: "secret" },
    } as never);
    const props = sentProps(deps);
    expect((props.projectName as string).length).toBeLessThanOrEqual(512);
    expect("servedApps" in props).toBe(false);
  });
});
