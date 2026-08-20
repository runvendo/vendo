import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { runSyncFlow } from "../../src/cli/sync-flow.js";
import { createVendo } from "../../src/server.js";

/**
 * The seam `vendo sync` crosses to say what a changed tool would break: the
 * CLI's impact probe on one side, the real wire's `POST /sync/impact` on the
 * other, and between them a host mounted under a path prefix. Maple is that
 * host — `basePath: "/maple"`, so Next strips the prefix on the way in and the
 * wire answers at `/maple/api/vendo`.
 *
 * The probe addressed it one prefix short and read its own 404 back as "dev
 * server not reachable", so every mounted host got the same wrong diagnosis.
 * Neither side may be stubbed here: a probe that talks to a fixture of the
 * wire, or a wire asked at an address the probe never builds, agree with each
 * other and stay wrong together.
 */

const MOUNT = "/maple";

/** The prefix has one static home the CLI can read without a server: the spec's
 *  relative server mount, which is how it reaches host tool calls too. */
const SPEC = `${JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Maple", version: "1" },
  servers: [{ url: MOUNT }],
  paths: {},
})}\n`;

/** One changed tool, so the probe has something to ask about. */
const CHANGED = (async () => ({
  tools: { added: [], removed: [], changed: ["host_a"] },
  breaking: [],
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 0, registered: 0 },
  components: { captured: [], drifted: [] },
  toolSchemas: { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } },
  warnings: [],
})) as never;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The host as Next serves it under `basePath`: requests under the prefix reach
 *  the wire with the prefix stripped, everything else never routes at all. */
function mountedHost(handler: (request: Request) => Promise<Response>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname !== MOUNT && !url.pathname.startsWith(`${MOUNT}/`)) {
      return new Response("Not Found", { status: 404 });
    }
    url.pathname = url.pathname.slice(MOUNT.length);
    return handler(new Request(url, init));
  }) as unknown as typeof fetch;
}

describe("[sync impact] the probe reaches a wire mounted under a path prefix", () => {
  it("reads real impact back through the real route", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-sync-impact-mount-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, "openapi.json"), SPEC, "utf8");

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(() => store.close());
    const vendo = createVendo({
      store,
      development: true,
      principal: async () => ({ kind: "user", subject: "dev" }),
    });

    const result = await runSyncFlow({
      root,
      output: { log: () => {}, error: () => {} },
      mode: "incremental",
      interactive: false,
      yes: true,
      ai: false,
      sync: CHANGED,
      fetchImpl: mountedHost((request) => vendo.handler(request)),
    });

    // `null` is the "impact unknown" the unreachable path returns; a row per
    // asked-about tool is the real route's own answer, off the real store.
    expect(result.impact).toEqual([{ tool: "host_a", apps: [], automations: [], grants: 0 }]);
  }, 120_000);
});

describe("[sync impact] a spec the prefix cannot be read from", () => {
  /** Reading the mount is best-effort, and it happens outside the probe's own
   *  error boundary. A spec that will not parse must cost the run its IMPACT
   *  line and nothing else: `vendo sync` exists to write the catalog, and an
   *  unreadable openapi.json is not a reason to abandon that. */
  it("degrades to the root URL instead of aborting the sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-sync-impact-badspec-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, "openapi.json"), "{ not json at all", "utf8");

    const asked: string[] = [];
    const offline = (async (input: string | URL) => {
      asked.push(String(input));
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const result = await runSyncFlow({
      root,
      output: { log: () => {}, error: () => {} },
      mode: "incremental",
      interactive: false,
      yes: true,
      ai: false,
      sync: CHANGED,
      fetchImpl: offline,
    });

    expect(asked).toEqual(["http://localhost:3000/api/vendo/sync/impact"]);
    expect(result.impact).toBeNull();
  }, 120_000);
});
