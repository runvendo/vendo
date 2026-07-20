import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRouteScanState, inferRouteInput, type RouteContext } from "./route-schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-route-schema-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

/** Contract test for the collector seam (Task 1 of the route-scan inference
 * plan): with no collectors implemented yet, `inferRouteInput` returns `null`
 * for every route+method — route-scan's zero-behavior-change fallback. */
describe("inferRouteInput (empty seam)", () => {
  it("returns null for a handler with no recognizable input", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: "export async function POST() { return new Response(); }\n",
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    expect(await inferRouteInput(route, "POST", state)).toBeNull();
    expect(await inferRouteInput(route, "GET", state)).toBeNull();
  });

  it("returns null regardless of route kind or method", async () => {
    const route: RouteContext = {
      file: "/repo/pages/api/thing.ts",
      source: "export default function handler() {}\n",
      urlPath: "/api/thing",
      kind: "pages",
    };
    const state = createRouteScanState("/repo");

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(await inferRouteInput(route, method, state)).toBeNull();
    }
  });
});

/** Task 2: the zod-in-handler collector. Fixture cases from the plan (04 §1,
 * PR-2's Task 2 step 1) — real schema (same-file and cross-file), safeParse,
 * inline construction, an uninterpretable expression, no zod at all, and the
 * path-param-collision carry-over from review. */
describe("inferRouteInput (zod-in-handler collector)", () => {
  it("(a) recognizes schema.parse(await req.json()) with a same-file z.object schema", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string(), age: z.number().optional() });
export async function POST(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "POST", state);
    expect(result).not.toBeNull();
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(result?.note).toBeUndefined();
  });

  it("(b) resolves a validator imported from another file", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/schema.ts", `
import { z } from "zod";
export const schema = z.object({ id: z.string() });
`);
    const route: RouteContext = {
      file: path.join(root, "app/api/widgets/route.ts"),
      source: `
import { schema } from "./schema";
export async function POST(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState(root);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("(c) recognizes the safeParse variant", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const result = schema.safeParse(await req.json());
  return Response.json(result);
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("(d) recognizes an inline z.object(...).parse(await req.json())", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
export async function POST(req: Request) {
  const body = z.object({ title: z.string() }).parse(await req.json());
  return Response.json(body);
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
  });

  it("(e) falls back to a permissive schema with a note for an uninterpretable zod expression", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
const schema = makeValidator();
export async function POST(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({ type: "object", additionalProperties: true });
    expect(result?.note).toBe(
      "input schema not statically interpreted (schema call has no zod-shaped callee); permissive schema emitted",
    );
  });

  it("(f) returns null for a handler with no zod at all", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET() {
  return Response.json({ ok: true });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    expect(await inferRouteInput(route, "GET", state)).toBeNull();
  });

  it("(g) excludes a body property that collides with a path param, so it never clobbers the param's schema", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ id: z.string(), name: z.string() });
export async function PUT(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`,
      urlPath: "/api/widgets/{id}",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "PUT", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });
});
