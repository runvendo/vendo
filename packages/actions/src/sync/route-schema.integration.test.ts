import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vendoSync } from "./index.js";
import { scanRoutes } from "./route-scan.js";

/**
 * Task 5 of the route-scan inference plan: fail-closed invariants over the
 * WHOLE extractor (route-schema.ts's collectors + route-scan.ts's
 * `mergeRouteInput`), plus proof that a newly-inferred schema shows up as
 * visible drift through `vendoSync`'s existing breaking-change diff rather
 * than silently rewriting an installed host's tools.json. Each `describe`
 * below corresponds to one PART A bullet in the plan (04 §1 Task 5).
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-route-schema-integration-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

function withoutInputSchema(tool: Record<string, unknown>): Record<string, unknown> {
  const { inputSchema: _inputSchema, ...rest } = tool;
  return rest;
}

describe("Task 5 PART A(a): inference never changes name/binding/risk/disabled", () => {
  it("a recognized zod body schema changes only inputSchema — everything else about the tool is untouched", async () => {
    const bareRoot = await temporaryRoot();
    await write(bareRoot, "app/api/widgets/route.ts", `
export async function POST(req: Request) {
  return Response.json({ ok: true });
}
`);
    const inferredRoot = await temporaryRoot();
    await write(inferredRoot, "app/api/widgets/route.ts", `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`);

    const bare = (await scanRoutes(bareRoot)).tools
      .find((tool) => tool.binding.kind === "route" && tool.binding.method === "POST");
    const inferred = (await scanRoutes(inferredRoot)).tools
      .find((tool) => tool.binding.kind === "route" && tool.binding.method === "POST");
    expect(bare).toBeDefined();
    expect(inferred).toBeDefined();

    // The whole point of this fixture pair: the collector DID find something
    // (inputSchema differs)...
    expect(inferred?.inputSchema).not.toEqual(bare?.inputSchema);
    // ...yet every other field on the tool — description, risk, binding, and
    // disabled (absent on both, i.e. still "not disabled") — is identical.
    expect(withoutInputSchema(inferred as unknown as Record<string, unknown>))
      .toEqual(withoutInputSchema(bare as unknown as Record<string, unknown>));
    expect(inferred?.name).toBe(bare?.name);
    expect(inferred?.binding).toEqual(bare?.binding);
    expect(inferred?.risk).toBe(bare?.risk);
    expect(inferred?.disabled).toBe(bare?.disabled);
  });
});

describe("Task 5 PART A(b): a property becomes required ONLY via evidence (checker collector)", () => {
  it("an optional TS property (`?`) stays out of required; a non-optional one joins it", async () => {
    const root = await temporaryRoot();
    await write(root, "tsconfig.json", JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
    }));
    await write(root, "app/api/widgets/route.ts", `
type TransferBody = { amount: number; memo?: string };
export async function POST(req: Request) {
  const body = (await req.json()) as TransferBody;
  return Response.json(body);
}
`);

    const { tools } = await scanRoutes(root);
    const tool = tools.find((candidate) => candidate.binding.kind === "route" && candidate.binding.method === "POST");
    const schema = tool?.inputSchema as { properties: Record<string, unknown>; required?: string[] };

    expect(schema.required).toContain("amount");
    expect(schema.required).not.toContain("memo");
    expect(schema.properties.memo).toEqual({ type: "string" });
    expect(schema.properties.amount).toEqual({ type: "number" });
  });
});

describe("Task 5 PART A(c): inferring a schema where none existed is visible drift (vendoSync)", () => {
  it("a handler that gains a zod validator between two syncs reports input-narrowed for that tool", async () => {
    const root = await temporaryRoot();
    const out = path.join(root, ".test-vendo");

    await write(root, "app/api/widgets/route.ts", `
export async function POST(req: Request) {
  const body = await req.json();
  return Response.json(body);
}
`);
    const first = await vendoSync({ root, out });
    // Sanity check on the "before" state: no evidence yet, so no narrowing to
    // report on the first sync itself.
    expect(first.breaking).not.toContainEqual(
      expect.objectContaining({ tool: "host_widgets_create", change: "input-narrowed" }),
    );

    await write(root, "app/api/widgets/route.ts", `
import { z } from "zod";
const schema = z.object({ name: z.string() });
export async function POST(req: Request) {
  const body = schema.parse(await req.json());
  return Response.json(body);
}
`);
    const second = await vendoSync({ root, out });

    // This is `inputNarrowed` (sync/index.ts) doing exactly its job: a tool
    // that used to accept anything (`additionalProperties: true`, no
    // `required`) now requires `name` and rejects unknown properties — a
    // real behavior change for any caller relying on the old (blank) shape,
    // even though nothing about the HANDLER'S real contract changed; only
    // what route-scan could SEE did. Any host upgrading straight onto this
    // PR will see every route-bound tool whose body/query shape newly became
    // statically knowable reported this way on its first post-upgrade
    // sync — expected and correct, not a bug to chase.
    expect(second.breaking).toContainEqual({ tool: "host_widgets_create", change: "input-narrowed" });
  });
});
