import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRoutes } from "./route-scan.js";
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

async function writeTsconfig(root: string): Promise<void> {
  await write(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
  }));
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

  it("(h) recognizes a trailing .catch(...) chain on the json read (demo-bank's own handler shape)", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const body = schema.parse(await req.json().catch(() => ({})));
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
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("(i) recognizes a parenthesized `as`-cast json read, exactly demo-bank's `(await req.json().catch(...)) as Type` shape", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const body = schema.parse((await req.json().catch(() => ({}))) as Record<string, unknown>);
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
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("(j) resolves the two-statement form: const body = await req.json(); schema.parse(body)", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = schema.parse(body);
  return Response.json(parsed);
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

  it("(j-counter) does not resolve a one-hop identifier initialized from something other than a json read", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const body = getCached();
  const parsed = schema.parse(body);
  return Response.json(parsed);
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    expect(await inferRouteInput(route, "POST", state)).toBeNull();
  });

  it("(k) carries a partial-interpretation note when one z.object property is uninterpretable", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string(), extra: z.string().pipe(other) });
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
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { name: { type: "string" }, extra: {} },
      required: ["name"],
      additionalProperties: false,
    });
    expect(result?.note).toBe(
      "input schema partially interpreted; permissive where unknown (extra: zod modifier .pipe() is not statically interpreted)",
    );
  });

  it("(l) first match wins when a handler validates the body more than once", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schemaA = z.object({ first: z.string() });
const schemaB = z.object({ second: z.string() });
export async function POST(req: Request) {
  const parsedA = schemaA.parse(await req.json());
  const parsedB = schemaB.parse(await req.json());
  return Response.json({ parsedA, parsedB });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { first: { type: "string" } },
      required: ["first"],
      additionalProperties: false,
    });
  });
});

/** Task 3: the TypeScript-checker collector. Runs only when the zod
 * collector returns null (04 §1 Task 3). One `ts.Program` is built lazily,
 * on first need, and cached on the shared scan state — the perf-guard and
 * ordering tests assert this via `state.checkerProgramBuilds` rather than
 * timing. */
describe("inferRouteInput (checker collector)", () => {
  it("(a) recognizes an as-cast to a local type alias, with an optional property from `?`", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
type TransferBody = { amount: number; recipient: string; memo?: string };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { amount: { type: "number" }, recipient: { type: "string" }, memo: { type: "string" } },
      required: ["amount", "recipient"],
      additionalProperties: false,
    });
    expect(result?.note).toBeUndefined();
  });

  it("(b) recognizes an annotated variable declaration", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
type TransferBody = { amount: number; recipient: string };
export async function POST(req: Request) {
  const body: TransferBody = await req.json();
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { amount: { type: "number" }, recipient: { type: "string" } },
      required: ["amount", "recipient"],
      additionalProperties: false,
    });
  });

  it("(c) resolves a type imported from another file", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    await write(root, "app/api/widgets/schema.ts", `export type TransferBody = { id: string };\n`);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
import type { TransferBody } from "./schema";
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("(d) converts a literal-union property to an enum-shaped schema", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
type TransferBody = { status: "draft" | "sent" };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { status: { type: "string", enum: ["draft", "sent"] } },
      required: ["status"],
      additionalProperties: false,
    });
  });

  it("(e) converts nested object and array-of-object properties", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
type Item = { id: string; qty: number };
type TransferBody = { items: Item[]; nested: { a: string } };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, qty: { type: "number" } },
            required: ["id", "qty"],
            additionalProperties: false,
          },
        },
        nested: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
      },
      required: ["items", "nested"],
      additionalProperties: false,
    });
  });

  it("(f) falls back to a permissive schema with a note for a mapped/generic type outside the supported subset", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
type Mapped<T> = { [K in keyof T]: T[K] };
type TransferBody = Mapped<{ x: number }>;
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({ type: "object", additionalProperties: true });
    expect(result?.note).toMatch(
      /^input schema not statically interpreted \(mapped type is not statically interpreted/,
    );
  });

  it("(i) fails closed per-property for a lib-declared type (Date) and a class-instance type, while siblings survive", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
class Account { id = "x"; }
type TransferBody = { amount: number; dueDate: Date; owner: Account };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    // A schema requiring `dueDate`/`owner` shaped like `Date`'s ~48 own
    // methods (or a class's private internals) is one no real JSON body can
    // ever satisfy — both properties fail closed to `{}` instead, and
    // `amount` (an ordinary property) is untouched.
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { amount: { type: "number" }, dueDate: {}, owner: {} },
      required: ["amount"],
      additionalProperties: false,
    });
    expect(result?.note).toMatch(/dueDate: .*not statically interpreted/);
    expect(result?.note).toMatch(/owner: .*not statically interpreted/);
  });

  it("(j) falls back to a permissive schema with a note for an index-signature type", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
type TransferBody = { [key: string]: string };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    // Zero named properties with `additionalProperties: false` rejects
    // every real body — the checker collector must not claim this shape.
    expect(result?.bodySchema).toEqual({ type: "object", additionalProperties: true });
    expect(result?.note).toMatch(/^input schema not statically interpreted \(index signature/);
  });

  it("(g) fails closed with exactly one scan-level warning when no tsconfig exists (JS-only repo), even with two candidate-bearing routes", async () => {
    const root = await temporaryRoot();
    // The pre-check that gates the program build (`checkerCollector`'s
    // syntactic candidate search) runs over the SAME parse the zod collector
    // already cached via `parseModule` (static-ts.ts:~112), which assigns
    // every non-.tsx/.jsx file — `.js` included — `ts.ScriptKind.TS`. That
    // TS-flavored parse is what lets an `as`-cast read as real evidence here,
    // not some general cast-tolerance of the TS parser in JS-scriptkind
    // files. Two routes each carry that evidence, both reach
    // `checkerProgramFor`, and the build is attempted (and fails, since this
    // repo has no tsconfig.json at all) exactly once — the second call hits
    // the cached `null` instead of re-attempting, so only one warning comes
    // out the other end.
    await write(root, "app/api/widgets/route.js", `
export async function POST(req) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    await write(root, "app/api/other/route.js", `
export async function GET(req) {
  const body = (await req.json()) as OtherBody;
  return Response.json(body);
}
`);

    const result = await scanRoutes(root);
    const postTool = result.tools.find((tool) => tool.binding.kind === "route" && tool.binding.method === "POST");
    expect(postTool?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    const checkerWarnings = result.warnings.filter((warning) => warning.includes("checker collector"));
    expect(checkerWarnings).toEqual([`route-scan checker collector skipped: no tsconfig.json found under ${root}`]);
  });

  it("(g2) returns null with one scan-level warning for a typed .ts handler in a repo with no tsconfig (the realistic no-tsconfig case)", async () => {
    const root = await temporaryRoot();
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
type TransferBody = { amount: number };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    expect(await inferRouteInput(route, "POST", state)).toBeNull();
    expect(state.warnings).toEqual([`route-scan checker collector skipped: no tsconfig.json found under ${root}`]);
  });

  it("(h) returns null for an unannotated, uncast json read with no other reads (voice-proxy case)", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
export async function POST(req: Request) {
  const body = await req.json();
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    expect(await inferRouteInput(route, "POST", state)).toBeNull();
  });

  it("builds the checker program at most once per scan, across three different route files", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const routes: RouteContext[] = [];
    for (const name of ["a", "b", "c"]) {
      const file = path.join(root, `app/api/${name}/route.ts`);
      await write(root, `app/api/${name}/route.ts`, `
type TransferBody = { value: string };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);
      routes.push({ file, source: await fs.readFile(file, "utf8"), urlPath: `/api/${name}`, kind: "app" });
    }
    const state = createRouteScanState(root, routes.map((route) => route.file));

    for (const route of routes) {
      const result = await inferRouteInput(route, "POST", state);
      expect(result?.bodySchema).toEqual({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      });
    }
    expect(state.checkerProgramBuilds).toBe(1);
  });

  it("prefers the zod collector's schema over a cast on the same expression; the checker is never consulted", async () => {
    const root = await temporaryRoot();
    await writeTsconfig(root);
    const file = path.join(root, "app/api/widgets/route.ts");
    await write(root, "app/api/widgets/route.ts", `
import { z } from "zod";
type TransferBody = { amount: number };
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const body = schema.parse((await req.json()) as TransferBody);
  return Response.json(body);
}
`);
    const route: RouteContext = { file, source: await fs.readFile(file, "utf8"), urlPath: "/api/widgets", kind: "app" };
    const state = createRouteScanState(root, [file]);

    const result = await inferRouteInput(route, "POST", state);
    expect(result?.bodySchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(state.checkerProgramBuilds).toBe(0);
  });
});

/** Task 4: the query collector. Additive — asked for every (route, method)
 * regardless of whether a body collector already answered (04 §1 Task 4).
 * These fixtures exercise `inferRouteInput` directly, so `queryProperties`
 * is asserted unconditionally here: whether those findings actually reach
 * the emitted tool schema is `route-scan.ts`'s `mergeRouteInput` decision
 * (argsIn-gated — see the "argsIn honesty" describe block below, which goes
 * through `scanRoutes`). */
describe("inferRouteInput (query collector)", () => {
  it("(a) recognizes searchParams.get and .getAll literal reads as optional properties", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");
  const tags = searchParams.getAll("tag");
  return Response.json({ status, tags });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "GET", state);
    expect(result?.queryProperties).toEqual({
      status: { type: "string" },
      tag: { type: "array", items: { type: "string" } },
    });
    expect(result?.note).toBeUndefined();
  });

  it("(a2) recognizes the direct req.nextUrl.searchParams.get(...) chain with no intermediate variable", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const status = req.nextUrl.searchParams.get("status");
  return Response.json({ status });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "GET", state);
    expect(result?.queryProperties).toEqual({ status: { type: "string" } });
  });

  it("(a3) recognizes new URL(req.url).searchParams via a local const", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const status = searchParams.get("status");
  return Response.json({ status });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "GET", state);
    expect(result?.queryProperties).toEqual({ status: { type: "string" } });
  });

  it("(b) still runs and reports query findings on a handler that also has a recognized zod body schema", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const status = req.nextUrl.searchParams.get("status");
  const body = schema.parse(await req.json());
  return Response.json({ body, status });
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
    expect(result?.queryProperties).toEqual({ status: { type: "string" } });
  });

  it("(c) ignores a computed searchParams.get(key) — no property, no note", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const key = pickKey();
  const value = req.nextUrl.searchParams.get(key);
  return Response.json({ value });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    expect(await inferRouteInput(route, "GET", state)).toBeNull();
  });

  it("excludes a query property that collides with a path param", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const id = req.nextUrl.searchParams.get("id");
  const status = req.nextUrl.searchParams.get("status");
  return Response.json({ id, status });
}
`,
      urlPath: "/api/widgets/{id}",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "GET", state);
    expect(result?.queryProperties).toEqual({ status: { type: "string" } });
  });

  it("does not resolve a two-hop local (the URL object stored locally, searchParams accessed off it) — documented fail-closed", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  return Response.json({ status });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    expect(await inferRouteInput(route, "GET", state)).toBeNull();
  });
});

/** The review carry-over (04 §1 Task 4, and Task 1's `mergeRouteInput` doc
 * comment): the runtime (`runtime/registry.ts`'s route execution) sends every
 * non-path argument as `searchParams` for a query-bound tool but as a single
 * JSON body for a body-bound tool — never split. So a query-derived property
 * is only honest to advertise on a query-bound tool (GET/DELETE); for a
 * body-bound tool (POST/PUT/PATCH) the collector's findings are dropped by
 * `mergeRouteInput`, even though `inferRouteInput` itself always reports
 * them (asserted above). These fixtures go through the full `scanRoutes` ->
 * `mergeRouteInput` path to prove the drop actually happens at emission. */
describe("query collector — argsIn honesty (route-scan merge)", () => {
  it("merges query properties into a GET tool's schema alongside its path params", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/[id]/route.ts", `
export async function GET(req: Request) {
  const status = req.nextUrl.searchParams.get("status");
  const tags = req.nextUrl.searchParams.getAll("tag");
  return Response.json({ status, tags });
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "GET");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        tag: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: true,
    });
  });

  it("drops query findings from a POST (body-bound) tool's schema even though the collector found them", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/route.ts", `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const status = req.nextUrl.searchParams.get("status");
  const body = schema.parse(await req.json());
  return Response.json({ body, status });
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "POST");
    // The zod-recognized body schema is present; "status" (query-derived) is
    // NOT — POST args are delivered as a JSON body by the runtime, so a
    // "status" property here would never reach searchParams.
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("a GET handler's query findings still merge even when the (unused, argsIn=query) body evidence is ignored", async () => {
    const root = await temporaryRoot();
    // A GET handler that also happens to read/validate a body is unusual, but
    // the zod collector doesn't gate on method — this proves route-scan.ts's
    // existing argsIn gate (body only applies for body-bound methods) still
    // holds unchanged alongside the new query gate.
    await write(root, "app/api/widgets/route.ts", `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function GET(req: Request) {
  const status = req.nextUrl.searchParams.get("status");
  const body = schema.parse(await req.json());
  return Response.json({ body, status });
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "GET");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: { status: { type: "string" } },
      additionalProperties: true,
    });
  });
});

/** Task 5 PART B, review-queued decisions on `mergeRouteInput` (route-scan.ts):
 * body-bound methods drop query-only evidence to a blank schema with no note
 * (decision 1); a note only ever surfaces when it describes evidence that was
 * actually merged onto the tool — never for a query-bound tool's dropped body
 * evidence (decision 2) — except a recognized-but-non-object top-level body
 * schema, which earns its OWN note on a body-bound tool precisely because the
 * evidence was real but unrepresentable (decision 3). All four fixtures below
 * go through `scanRoutes`, exercising `mergeRouteInput` end to end. */
describe("mergeRouteInput — note honesty and the body-bound drop invariant (Task 5 PART B)", () => {
  it("(1) a POST handler reading only searchParams (no body evidence) emits exactly the blank base schema, no note", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/route.ts", `
export async function POST(req: Request) {
  const status = req.nextUrl.searchParams.get("status");
  return Response.json({ status });
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "POST");
    expect(tool?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(tool?.note).toBeUndefined();
  });

  it("(2) a GET handler whose body-validator is uninterpretable emits the blank base schema, no note (the note describes evidence never delivered to a query-bound tool)", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/route.ts", `
export async function GET(req: Request) {
  const schema = makeValidator();
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "GET");
    expect(tool?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(tool?.note).toBeUndefined();
  });

  it("(3a) a POST validating the whole body as z.array(...) emits the blank base schema PLUS a non-object-body note", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/route.ts", `
import { z } from "zod";
const schema = z.array(z.string());
export async function POST(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "POST");
    expect(tool?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(tool?.note).toBe(
      "recognized non-object body schema (array) cannot be represented on a route tool; permissive schema emitted",
    );
  });

  it("(3b) the same whole-body z.array(...) validator on a GET handler emits the blank base schema, no note (query-bound: the body is never merged, so the non-object note never fires either)", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/route.ts", `
import { z } from "zod";
const schema = z.array(z.string());
export async function GET(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "GET");
    expect(tool?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(tool?.note).toBeUndefined();
  });
});

/** Task 5 PART B item 4: coverage minors flagged by review — a renamed
 * destructuring binding, the fully-direct `new URL(req.url).searchParams.get`
 * chain with no intermediate variable at all, and a DELETE (query-bound,
 * like GET) query merge through the full `scanRoutes` path. None of these
 * exercise new collector logic — `resolvesToSearchParams`/`isSearchParamsAccessor`
 * already cover these shapes; these fixtures just prove it. */
describe("query collector — coverage minors (Task 5 PART B item 4)", () => {
  it("resolves a renamed destructuring binding: const { searchParams: sp } = req.nextUrl", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const { searchParams: sp } = req.nextUrl;
  const status = sp.get("status");
  return Response.json({ status });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "GET", state);
    expect(result?.queryProperties).toEqual({ status: { type: "string" } });
  });

  it("resolves the fully-direct new URL(req.url).searchParams.get(...) chain with no intermediate variable", async () => {
    const route: RouteContext = {
      file: "/repo/app/api/widgets/route.ts",
      source: `
export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status");
  return Response.json({ status });
}
`,
      urlPath: "/api/widgets",
      kind: "app",
    };
    const state = createRouteScanState("/repo");

    const result = await inferRouteInput(route, "GET", state);
    expect(result?.queryProperties).toEqual({ status: { type: "string" } });
  });

  it("merges query properties into a DELETE tool's schema alongside its path params (query-bound like GET)", async () => {
    const root = await temporaryRoot();
    await write(root, "app/api/widgets/[id]/route.ts", `
export async function DELETE(req: Request) {
  const reason = req.nextUrl.searchParams.get("reason");
  return Response.json({ reason });
}
`);
    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "DELETE");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string" } },
      required: ["id"],
      additionalProperties: true,
    });
    expect(tool?.note).toBeUndefined();
  });
});
