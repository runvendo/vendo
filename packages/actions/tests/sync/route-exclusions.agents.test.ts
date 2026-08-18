import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractedTool } from "../../src/formats.js";
import { runsAgentLoop, scanRoutes } from "../../src/sync/route-scan.js";

/**
 * The exclusion missed VENDO'S OWN backend library.
 *
 * `@vendoai/agents` is how a host writes an agent loop with Vendo, and the two
 * shapes it produces — `agent().run(…)` and a named agent's `.respond(…)` — were
 * both invisible here: the import list named every OTHER framework, and the call
 * marker was anchored on the literal receiver `vendo.`, which nobody writes when
 * their agent is called `support`. So the route hosting the agent became a
 * callable tool and was handed back to the agent running in it.
 */

/** Assembled at runtime: the dependency guard reads import-shaped strings even
 *  inside fixtures, and @vendoai/actions may not import the umbrella or its
 *  siblings. */
const VENDO_AGENTS = ["@vendoai", "agents"].join("/");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-agents-exclusion-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

async function toolsAt(root: string, urlPath: string): Promise<ExtractedTool[]> {
  const { tools } = await scanRoutes(root);
  return tools.filter((tool) => tool.binding.kind === "route" && tool.binding.path === urlPath);
}

const AGENT_LOOP_REASON = "its handler runs an agent/model loop";

describe("a route that runs a @vendoai/agents loop is excluded", () => {
  it("excludes an agent() route, and leaves the plain CRUD route beside it callable", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/assistant/route.ts",
      [
        `import { agent } from "${VENDO_AGENTS}";`,
        `const support = agent({ instructions: "help" });`,
        `export async function POST(request: Request) {`,
        `  return Response.json(await support.respond(await request.json()));`,
        `}`,
        ``,
      ].join("\n"),
    );
    await write(
      root,
      "app/api/todos/route.ts",
      [
        `export async function GET() { return Response.json({ todos: [] }); }`,
        ``,
      ].join("\n"),
    );

    const [assistant] = await toolsAt(root, "/api/assistant");
    expect(assistant?.disabled).toBe(true);
    expect(assistant?.note).toContain(AGENT_LOOP_REASON);

    const [todos] = await toolsAt(root, "/api/todos");
    expect(todos?.disabled).toBeUndefined();
  });

  it("matches .respond( and .run( on ANY receiver, not just the literal `vendo.`", async () => {
    const root = await temporaryRoot();
    // The agent is imported from the host's OWN module, so no @vendoai specifier
    // reaches this file at all — the CALL is the only evidence left.
    await write(root, "lib/support.ts", "export const support = { respond: async () => ({}) };\n");
    await write(
      root,
      "app/api/support/route.ts",
      [
        `import { support } from "${["..", "..", "..", "lib", "support"].join("/")}";`,
        `export async function POST(request: Request) {`,
        `  return Response.json(await support.respond(await request.json()));`,
        `}`,
        ``,
      ].join("\n"),
    );
    await write(
      root,
      "app/api/tasks/route.ts",
      [
        `import { runner } from "${["..", "..", "..", "lib", "support"].join("/")}";`,
        `export async function POST() { return Response.json(await runner.run({})); }`,
        ``,
      ].join("\n"),
    );

    const [support] = await toolsAt(root, "/api/support");
    expect(support?.disabled).toBe(true);
    expect(support?.note).toContain(AGENT_LOOP_REASON);

    const [tasks] = await toolsAt(root, "/api/tasks");
    expect(tasks?.disabled).toBe(true);
    expect(tasks?.note).toContain(AGENT_LOOP_REASON);
  });

  it("exports the same predicate the exclusion matches on, so init cannot drift from it", () => {
    expect(runsAgentLoop(`import { agent } from "${VENDO_AGENTS}";`)).toBe(true);
    expect(runsAgentLoop("await support.respond(body)")).toBe(true);
    expect(runsAgentLoop("await support.run(body)")).toBe(true);
    expect(runsAgentLoop("export async function GET() { return Response.json({}); }")).toBe(false);
  });
});
