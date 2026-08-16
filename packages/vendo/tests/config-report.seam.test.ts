/**
 * The config REPORT, read where the console reads it: off the PUT this
 * deployment's own uploader sends.
 *
 * SEAM: real `.vendo` files on disk and a real code-set knob → the real
 * resolution seam → the real reporter → the real batched uploader → the
 * captured HTTP request. Nothing between resolution and the wire is stubbed,
 * and the assertion is the frozen fixture the console repo builds against —
 * so producer and consumer cannot agree on bytes neither of them ships.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";
import type { CreateVendoConfig } from "../src/types.js";

const REPORT_URL = "https://console.report-test/api/v1/config/report";

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./fixtures/config-wire/${name}`, import.meta.url), "utf8"));

/** The one slot a composition cannot default; never resolved in this suite. */
const identity: Pick<CreateVendoConfig, "principal"> = {
  principal: async () => ({ kind: "user", subject: "user_report_test" }),
};

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const cleanups: Array<() => Promise<void>> = [];
let sent: Sent[] = [];

/** The `.vendo` files the fixture's `source: "file"` surfaces stand for. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-config-report-"));
  await mkdir(join(root, ".vendo"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, ".vendo", name), body);
  }
  const originalCwd = process.cwd();
  process.chdir(root);
  cleanups.push(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

beforeEach(() => {
  sent = [];
  vi.stubEnv("VENDO_API_KEY", "vnd_report_test");
  vi.stubEnv("VENDO_CLOUD_URL", "https://console.report-test");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === REPORT_URL) {
      sent.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      // The frozen response: 204 No Content, empty body.
      return new Response(null, { status: 204 });
    }
    return Response.json({});
  }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The uploader batches on a 250ms timer. The budget is far under this
 *  package's 30s test timeout, so the timeout stays the only hang-detector. */
const waitForReport = async (count = 1): Promise<void> => {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(count), { timeout: 5_000, interval: 25 });
};

describe("the config report's wire bytes", () => {
  it("PUTs exactly the frozen request fixture for a real file+code resolution", async () => {
    await project({
      "design-rules.md": "# Design rules\n\nUse the host's own components.\n",
      "theme.json": "{\n  \"radius\": \"8px\"\n}\n",
    });
    createVendo({ ...identity, instructions: "Maple is a consumer bank.", connectors: [] });
    await waitForReport();
    expect(sent[0]?.body).toEqual(await fixture("config-report.request.json"));
  });

  it("is key-authed, PUT, and carries the deployment identity every keyed call carries", async () => {
    await project({ "design-rules.md": "# rules\n" });
    createVendo({ ...identity, connectors: [] });
    await waitForReport();
    expect(sent[0]?.method).toBe("PUT");
    expect(sent[0]?.url).toBe(REPORT_URL);
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer vnd_report_test");
    expect(sent[0]?.headers.get("x-vendo-deployment-host")).not.toBeNull();
  });

  it("takes 204 No Content as delivered — one request, never a retry", async () => {
    await project({ "design-rules.md": "# rules\n" });
    createVendo({ ...identity, connectors: [] });
    await waitForReport();
    // The uploader's two retry delays are 250ms and 1s; a rejected delivery
    // would show up as a second and third PUT inside this window.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(sent).toHaveLength(1);
  });
});

describe("when the report is pushed", () => {
  it("says nothing at all without a key", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    await project({ "design-rules.md": "# rules\n" });
    createVendo({ ...identity, connectors: [] });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(sent).toHaveLength(0);
  });

  it("reports every surface as unset when nothing is set in code or on disk", async () => {
    await project({});
    createVendo({ ...identity, connectors: [] });
    await waitForReport();
    expect(sent[0]?.body).toEqual({
      surfaces: {
        "design-rules.md": { source: "unset", content: null },
        "brief.md": { source: "unset", content: null },
        "theme.json": { source: "unset", content: null },
        "policy.json": { source: "unset", content: null },
        "overrides.json": { source: "unset", content: null },
      },
    });
  });

  it("reports once at boot and never again on its own — no heartbeat, no timer", async () => {
    await project({ "design-rules.md": "# rules\n" });
    createVendo({ ...identity, connectors: [] });
    await waitForReport();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(sent).toHaveLength(1);
  });
});
