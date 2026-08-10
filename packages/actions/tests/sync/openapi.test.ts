import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunContext } from "@vendoai/core";
import type { OpenApiBinding, RouteBinding } from "../../src/formats.js";
import { createActions } from "../../src/runtime/registry.js";
import { runExtractors } from "../../src/sync/extractors.js";
import { openApiMountPath } from "../../src/sync/openapi.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function writeFile(root: string, relative: string, source: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

const spec = (servers: unknown) => ({
  openapi: "3.1.0",
  info: { title: "Host", version: "1.0.0" },
  ...(servers === undefined ? {} : { servers }),
  paths: {
    "/api/dashboard": { get: { operationId: "getDashboard", responses: {} } },
    "/api/clients/{id}": { get: { operationId: "getClient", responses: {} } },
  },
});

/** A host whose OpenAPI spec and Next route handlers describe the SAME two
 *  endpoints — the shape both extractors see, and the one that has to keep
 *  collapsing to one tool per endpoint. */
async function host(servers: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-openapi-"));
  temporaryDirectories.push(root);
  await writeFile(root, "package.json", JSON.stringify({ name: "mounted-host", dependencies: { next: "16.0.0" } }));
  await writeFile(root, "openapi.json", JSON.stringify(spec(servers)));
  await writeFile(root, "app/api/dashboard/route.ts", "export async function GET() { return Response.json({}) }\n");
  await writeFile(root, "app/api/clients/[id]/route.ts", "export async function GET() { return Response.json({}) }\n");
  return root;
}

/** Every distinct binding path the extractors produce. Both the OpenAPI
 *  operation and the route handler behind it appear here — `unionExtracted`
 *  collapses them downstream, and it collapses them BY PATH, which is why the
 *  set below has to come out the same size prefixed or not. */
async function paths(servers: unknown): Promise<string[]> {
  const { tools } = await runExtractors(await host(servers));
  const bound = tools.map((tool) => (tool.binding as OpenApiBinding | RouteBinding).path);
  return [...new Set(bound)].sort();
}

async function mountOf(servers: unknown): Promise<string> {
  const root = await host(servers);
  return openApiMountPath(path.join(root, "openapi.json"));
}

describe("openApiMountPath", () => {
  it.each([
    ["a root server", [{ url: "/" }], ""],
    ["no servers at all", undefined, ""],
    ["an absolute server url", [{ url: "https://host.example/cadence" }], ""],
    ["a relative server url", [{ url: "/cadence" }], "/cadence"],
    ["a trailing slash on the mount point", [{ url: "/cadence/" }], "/cadence"],
  ])("reads %s as %j", async (_label, servers, expected) => {
    expect(await mountOf(servers)).toBe(expected);
  });
});

describe("a host mounted under a subpath", () => {
  it("leaves an origin-root host's paths alone", async () => {
    expect(await paths([{ url: "/" }])).toEqual(["/api/clients/{id}", "/api/dashboard"]);
  });

  /** Spec 2026-08-06 §B1 inverts the old law: stored paths are PREFIX-FREE.
   *  The deployment's prefix lives in VENDO_BASE_URL and core's joinUrl
   *  attaches it exactly once at call time. Baking it in here is what made
   *  every host tool 404 on /maple/maple/… (#914). */
  it("keeps stored paths prefix-free whatever the spec's relative server declares", async () => {
    expect(await paths([{ url: "/cadence" }])).toEqual(["/api/clients/{id}", "/api/dashboard"]);
  });

  it("collapses the OpenAPI operation and the route handler behind it, as before", async () => {
    expect(await paths([{ url: "/cadence" }])).toHaveLength((await paths([{ url: "/" }])).length);
  });
});

/** THE SEAM, both halves real: a spec with a relative server url is extracted by
 *  the real extractors, and the URL the runtime actually calls is read off the
 *  registry's own outbound fetch. Neither side asserts anything about the other,
 *  so they cannot agree on a prefix-free path and still 404 together — the
 *  failure mode the prefix-free law is accused of. */
describe("the mount the runtime actually calls", () => {
  const ctx: RunContext = {
    principal: { kind: "user", subject: "user_1" },
    venue: "chat",
    presence: "present",
    sessionId: "session_1",
  };

  async function calledUrl(servers: unknown, baseUrl: string): Promise<string> {
    const { tools } = await runExtractors(await host(servers));
    const seen: string[] = [];
    const actions = createActions({
      tools,
      baseUrl,
      fetch: (async (input: URL | RequestInfo) => {
        seen.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await actions.execute({ id: "1", tool: "host_getDashboard", args: {} }, ctx);
    return seen[0]!;
  }

  it("reaches the mounted endpoint, prefixed exactly once, via VENDO_BASE_URL", async () => {
    expect(await calledUrl([{ url: "/cadence" }], "https://host.example/cadence"))
      .toBe("https://host.example/cadence/api/dashboard");
  });

  /** The mount hazard, reproduced: nothing in extraction can save a base URL
   *  that drops the prefix — the call lands one prefix short and 404s while
   *  every page renders. Doctor's E-CFG-003 is the check that catches it. */
  it("lands one prefix short when the base URL drops the mount", async () => {
    expect(await calledUrl([{ url: "/cadence" }], "https://host.example"))
      .toBe("https://host.example/api/dashboard");
  });
});
