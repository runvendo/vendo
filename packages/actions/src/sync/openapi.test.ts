import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenApiBinding, RouteBinding } from "../formats.js";
import { runExtractors } from "./extractors.js";
import { openApiMountPath } from "./openapi.js";

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

  /** The one that matters: without the prefix every tool call lands on the
   *  unmounted origin path and 404s while the pages themselves render fine. */
  it("carries the mount point into every binding path", async () => {
    expect(await paths([{ url: "/cadence" }])).toEqual(["/cadence/api/clients/{id}", "/cadence/api/dashboard"]);
  });

  /** dedupKey is method+path: prefix the OpenAPI operation and not the route
   *  handler behind it and the two stop collapsing, shipping two tools per
   *  endpoint with one of them pointing at nothing. */
  it("moves every extractor's paths together, so they still collapse", async () => {
    expect(await paths([{ url: "/cadence" }])).toHaveLength((await paths([{ url: "/" }])).length);
  });
});
