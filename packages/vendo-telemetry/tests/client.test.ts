import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTelemetry } from "../src/client.js";

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
    const [url, init] = deps.fetchImpl.mock.calls[0]!;
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
    const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.properties.sourceCode).toBeUndefined();
    expect(body.properties.framework).toBe("next");
  });

  it("caps oversized string values on an allowed key (review)", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "a".repeat(5000) });
    const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
    expect(body.properties.framework.length).toBeLessThanOrEqual(512);
  });

  it("drops object/array values even on an allowed key (review)", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: { nested: "secret" } } as never);
    const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
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
      await t.track("error_class", {});
      const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
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
      await t.track("error_class", {});
      const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
      expect("projectIdHash" in body.properties).toBe(false);
      expect("packageManager" in body.properties).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("never throws when fetch rejects", async () => {
    const deps = makeDeps({ fetchImpl: vi.fn().mockRejectedValue(new Error("network")) });
    const t = createTelemetry(deps);
    await expect(t.track("error_class", {})).resolves.toBeUndefined();
  });

  it("sends to a VENDO_POSTHOG_HOST override instead of the shipped cloud", async () => {
    const deps = makeDeps({ env: { VENDO_POSTHOG_HOST: "https://posthog.internal:8000" } });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(String(deps.fetchImpl.mock.calls[0]![0])).toBe("https://posthog.internal:8000/capture/");
  });

  it("falls back to the shipped cloud when the override is unusable", async () => {
    const deps = makeDeps({ env: { VENDO_POSTHOG_HOST: "not a url" } });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(String(deps.fetchImpl.mock.calls[0]![0])).toContain("us.i.posthog.com");
  });

  it("still posts when cwd resolution fails", async () => {
    // The real shape: a dev server whose working directory was deleted under
    // it, so getcwd() fails. deps.cwd is unset, so projectProps resolves the
    // default itself and throws inside the client's constructor. The spy is
    // released before the await so nothing else in the run sees a broken cwd.
    const deps = makeDeps();
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_cwd");
    });
    let t;
    try {
      t = createTelemetry(deps);
    } finally {
      cwdSpy.mockRestore();
    }
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
    // Project props are simply absent; the event still carries the base props.
    expect(body.properties.projectIdHash).toBeUndefined();
    expect(body.properties.vendoVersion).toBe("9.9.9");
  });

  it("swallows an event name outside the allowlist instead of throwing at the caller", async () => {
    // An untyped JS caller can name an event the allowlist has never heard of.
    // Looking up its prop allowlist yields undefined and filtering throws —
    // which must never reach the build or dev server that called track().
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await expect(t.track("not_a_real_event" as never, { framework: "next" })).resolves.toBeUndefined();
    expect(deps.fetchImpl).not.toHaveBeenCalled();
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

/**
 * The default transport — no injected fetchImpl, a real socket. It exists
 * because Node's global fetch keeps a connecting socket alive after an abort,
 * which held `vendo init` open for ten seconds past its summary on a
 * captive-portal network. The socket is unref'd, so the timeout is the only
 * bound; `packages/vendo/src/cli/telemetry-exit.test.ts` proves the exit
 * guarantee on the real CLI process.
 */
describe("default transport (no fetchImpl)", () => {
  it("posts the capture body over a real socket", async () => {
    const bodies: string[] = [];
    const server = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const deps = makeDeps({
        fetchImpl: undefined,
        env: { VENDO_POSTHOG_HOST: `http://127.0.0.1:${port}` },
      });
      await createTelemetry(deps).track("init_started", { framework: "next" });
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]!).event).toBe("init_started");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("follows a capture redirect, the way fetch did (review: proxied self-hosts move)", async () => {
    const bodies: string[] = [];
    const destination = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationPort = (destination.address() as { port: number }).port;
    const proxy = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(308, { location: `http://127.0.0.1:${destinationPort}/capture/` });
      response.end();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
      const deps = makeDeps({
        fetchImpl: undefined,
        env: { VENDO_POSTHOG_HOST: `http://127.0.0.1:${proxyPort}` },
      });
      await createTelemetry(deps).track("init_started", { framework: "next" });
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]!).event).toBe("init_started");
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => destination.close(() => resolve()));
    }
  });

  it("returns on the timeout when the endpoint accepts the connection and never answers", async () => {
    const held: Socket[] = [];
    const blackHole = createSocketServer((socket) => {
      socket.on("error", () => {});
      held.push(socket);
    });
    await new Promise<void>((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
    const port = (blackHole.address() as { port: number }).port;
    try {
      const deps = makeDeps({
        fetchImpl: undefined,
        // https against a server that never speaks TLS: the handshake hangs,
        // which is the exact captive-portal shape.
        env: { VENDO_POSTHOG_HOST: `https://127.0.0.1:${port}` },
      });
      const started = Date.now();
      await expect(createTelemetry(deps).track("init_started", { framework: "next" }))
        .resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => blackHole.close(() => resolve()));
    }
  }, 15_000);
});

const CLOUD_KEY = `vnd_${"0123456789abcdef".repeat(2)}01234567`; // 40 hex chars

function sentProps(deps: ReturnType<typeof makeDeps>): Record<string, unknown> {
  const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
  return body.properties as Record<string, unknown>;
}

describe("cloud lane (VENDO_API_KEY)", () => {
  it("marks every event with cloud + cloudKeyHash when a valid key is set", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("error_class", {});
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
    await t.track("error_class", {});
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
      detectMs: 1200,
      engineMs: 800,
    });
    const props = sentProps(deps);
    expect(props.framework).toBe("next");
    expect(props.projectName).toBe("maple-bank");
    expect(props.repoHost).toBe("github.com");
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
    await t.track("error_class", { sourceCode: "secret" } as never);
    expect("sourceCode" in sentProps(deps)).toBe(false);
  });

  it("callers cannot spoof cloud or cloudKeyHash", async () => {
    // Inactive lane: the caller-passed markers are stripped outright.
    const anon = makeDeps();
    await createTelemetry(anon).track("error_class", { cloud: true, cloudKeyHash: "ff" } as never);
    expect("cloud" in sentProps(anon)).toBe(false);
    expect("cloudKeyHash" in sentProps(anon)).toBe(false);

    // Active lane: producer-set values win over caller-passed ones.
    const cloud = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    await createTelemetry(cloud).track("error_class", { cloud: false, cloudKeyHash: "ff" } as never);
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

  it("never lets the raw key into the serialized request body", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    // errorDetail even carries the key itself — the scrubbed hash-only
    // markers are all that may reach the wire.
    await t.track("init_failed", { errorDetail: `401: key ${CLOUD_KEY} rejected` });
    const rawBody = (deps.fetchImpl.mock.calls[0]![1] as { body: string }).body;
    expect(rawBody).not.toContain(CLOUD_KEY);
  });

  it("bounds cloud prop values like any other prop", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("error_class", {
      projectName: "a".repeat(5000),
      errorDetail: { nested: "secret" },
    } as never);
    const props = sentProps(deps);
    expect((props.projectName as string).length).toBeLessThanOrEqual(512);
    expect("errorDetail" in props).toBe(false);
  });
});

describe("internal lane (VENDO_INTERNAL)", () => {
  it.each([["1"], ["true"]])("marks every event with internal: true when VENDO_INTERNAL=%s", async (value) => {
    const deps = makeDeps({ env: { VENDO_INTERNAL: value } });
    const t = createTelemetry(deps);
    await t.track("error_class", {});
    expect(sentProps(deps).internal).toBe(true);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["false", "false"],
    ["arbitrary text", "yes"],
  ])("omits the internal key when VENDO_INTERNAL is %s", async (_label, value) => {
    const deps = makeDeps({ env: { VENDO_INTERNAL: value } });
    const t = createTelemetry(deps);
    await t.track("error_class", {});
    expect("internal" in sentProps(deps)).toBe(false);
  });

  it("callers cannot spoof internal", async () => {
    // Flag unset: the caller-passed marker is stripped outright.
    const external = makeDeps();
    await createTelemetry(external).track("error_class", { internal: true } as never);
    expect("internal" in sentProps(external)).toBe(false);

    // Flag set: the producer-set value wins over a caller-passed one.
    const internal = makeDeps({ env: { VENDO_INTERNAL: "1" } });
    await createTelemetry(internal).track("error_class", { internal: false } as never);
    expect(sentProps(internal).internal).toBe(true);
  });

  it("does not weaken consent: opt-outs still send nothing with the flag set", async () => {
    const deps = makeDeps({ env: { VENDO_INTERNAL: "1", DO_NOT_TRACK: "1" } });
    const t = createTelemetry(deps);
    await t.track("error_class", {});
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("composes with the cloud lane markers", async () => {
    const deps = makeDeps({ env: { VENDO_INTERNAL: "1", VENDO_API_KEY: CLOUD_KEY } });
    const t = createTelemetry(deps);
    await t.track("error_class", {});
    const props = sentProps(deps);
    expect(props.internal).toBe(true);
    expect(props.cloud).toBe(true);
  });
});

/** The log record's attributes, flattened. OTLP carries every value as a
 *  string, which is also how PostHog stores them — so these assertions read
 *  the wire exactly as the Logs explorer will. */
function sentAttributes(deps: ReturnType<typeof makeDeps>): Record<string, string> {
  const body = JSON.parse((deps.fetchImpl.mock.calls[0]![1] as { body: string }).body);
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  return Object.fromEntries(
    (record.attributes as { key: string; value: { stringValue: string } }[])
      .map((a) => [a.key, a.value.stringValue]),
  );
}

describe("logs lane (LOG_EVENTS)", () => {
  it("sends an operational event to the logs endpoint as OTLP, not to capture", async () => {
    const deps = makeDeps();
    await createTelemetry(deps).track("doctor_run", { failures: 2, warnings: 1, wired: true });

    const [url, init] = deps.fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://us.i.posthog.com/i/v1/logs?token=phc_test");
    const body = JSON.parse((init as { body: string }).body);
    // No capture-shaped keys: the analytics stream must not receive this at all.
    expect("event" in body).toBe(false);
    expect("api_key" in body).toBe(false);

    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(body.resourceLogs[0].resource.attributes)
      .toContainEqual({ key: "service.name", value: { stringValue: "vendo-sdk" } });
    // Greppable from either direction: the facet column and the body.
    expect(record.eventName).toBe("doctor_run");
    expect(record.body.stringValue).toBe("doctor_run");

    const attributes = sentAttributes(deps);
    expect(attributes.event).toBe("doctor_run");
    expect(attributes.distinct_id).toBe("id-1");
    expect(attributes.failures).toBe("2");
    expect(attributes.wired).toBe("true");
    expect(attributes.vendoVersion).toBe("9.9.9");
  });

  it.each([["doctor_run"], ["command_run"], ["agent_run"]])(
    "routes %s to logs while analytics events stay on capture",
    async (event) => {
      const logged = makeDeps();
      await createTelemetry(logged).track(event as "doctor_run", {});
      expect(String(logged.fetchImpl.mock.calls[0]![0])).toContain("/i/v1/logs");

      const captured = makeDeps();
      await createTelemetry(captured).track("init_started", { framework: "next" });
      expect(String(captured.fetchImpl.mock.calls[0]![0])).toContain("/capture/");
    },
  );

  it("applies the allowlist, the lane markers and consent exactly as capture does", async () => {
    const deps = makeDeps({ env: { VENDO_API_KEY: CLOUD_KEY, VENDO_INTERNAL: "1" } });
    await createTelemetry(deps).track("command_run", {
      command: "sync",
      ok: true,
      sourceCode: "secret",
    } as never);
    const attributes = sentAttributes(deps);
    expect(attributes.command).toBe("sync");
    expect("sourceCode" in attributes).toBe(false);
    expect(attributes.cloud).toBe("true");
    expect(attributes.internal).toBe("true");

    const optedOut = makeDeps({ env: { DO_NOT_TRACK: "1" } });
    await createTelemetry(optedOut).track("command_run", { command: "sync" });
    expect(optedOut.fetchImpl).not.toHaveBeenCalled();
  });

  it("follows VENDO_POSTHOG_HOST to a self-hosted instance", async () => {
    const deps = makeDeps({ env: { VENDO_POSTHOG_HOST: "https://posthog.internal:8000" } });
    await createTelemetry(deps).track("agent_run", {});
    expect(String(deps.fetchImpl.mock.calls[0]![0]))
      .toBe("https://posthog.internal:8000/i/v1/logs?token=phc_test");
  });
});
