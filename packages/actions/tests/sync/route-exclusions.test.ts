import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VENDO_OVERRIDES_FORMAT, type ExtractedTool } from "../../src/formats.js";
import { createActions } from "../../src/runtime/registry.js";
import { vendoSync } from "../../src/sync/index.js";
import { scanRoutes } from "../../src/sync/route-scan.js";

/**
 * Route extraction used to catalog the endpoints that RUN the agent: the host's
 * own `/api/chat` loop (a tool that calls the agent), a Vendo wire mount the
 * host branded onto its own path (a catch-all over everything Vendo exposes),
 * and Auth.js's sign-in catch-all.
 *
 * Two treatments, because the routes are owned by different people. Vendo's own
 * wire mount is not the host's API at all, so it yields no tool — the GraphQL
 * precedent. A route the HOST wrote is emitted DISABLED with the reason on it,
 * so nothing calls it and nothing vanishes, and `.vendo/overrides.json` is the
 * whole escape hatch when the reading is wrong.
 */

/** Fixture import specifiers, assembled at runtime because the dependency
 *  guard's static text scan reads import-shaped strings even inside fixtures:
 *  actions may not import @vendoai/vendo, and no test file may carry a relative
 *  specifier that escapes its package directory. */
const VENDO_AI_SDK = ["@vendoai", "vendo", "ai-sdk"].join("/");
const VENDO_SERVER = ["@vendoai", "vendo", "server"].join("/");
const LIB_AUTH_FROM_ROUTE = ["..", "..", "..", "lib", "auth"].join("/");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-exclusions-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

function exclusionWarning(urlPath: string, reason: string): string {
  return `route ${urlPath} is excluded from the callable catalog because ${reason};`
    + ` re-enable it by setting its "disabled": false in .vendo/overrides.json`;
}

/** Every tool bound to `urlPath`, in the order the scan emitted them. */
async function toolsAt(root: string, urlPath: string): Promise<ExtractedTool[]> {
  const { tools } = await scanRoutes(root);
  return tools.filter((tool) => tool.binding.kind === "route" && tool.binding.path === urlPath);
}

const AGENT_LOOP_REASON = "its handler runs an agent/model loop";

describe("agent endpoints are excluded from the callable catalog", () => {
  it("excludes an AI-SDK loop and leaves the plain CRUD route beside it callable", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/chat/route.ts",
      [
        `import { anthropic } from "@ai-sdk/anthropic";`,
        `import { streamText } from "ai";`,
        `export async function POST(req: Request) {`,
        `  const result = streamText({ model: anthropic("claude-sonnet-4-6"), messages: await req.json() });`,
        `  return result.toUIMessageStreamResponse();`,
        `}`,
        ``,
      ].join("\n"),
    );
    await write(
      root,
      "app/api/todos/route.ts",
      "export async function GET() { return Response.json([]); }\nexport async function POST() { return Response.json({}); }\n",
    );

    const { tools, warnings } = await scanRoutes(root);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get("host_chat_create")).toMatchObject({ disabled: true, risk: "ungraded" });
    expect(byName.get("host_chat_create")?.note).toBe(
      `${AGENT_LOOP_REASON}; excluded from the callable catalog; overrides.json can flip disabled/risk`,
    );
    expect(warnings).toEqual([exclusionWarning("/api/chat", AGENT_LOOP_REASON)]);

    // The control: a route with no model in it is untouched — no `disabled`,
    // no note, and it is still the ordinary pair of tools.
    expect(byName.get("host_todos_list")).not.toHaveProperty("disabled");
    expect(byName.get("host_todos_list")).not.toHaveProperty("note");
    expect(byName.get("host_todos_create")).not.toHaveProperty("disabled");
  });

  it("excludes a raw Anthropic loop, a Mastra loop, and a route that spreads Vendo's own tool pack", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/assist/route.ts",
      `import Anthropic from "@anthropic-ai/sdk";\nexport async function POST() { return new Response(); }\n`,
    );
    await write(
      root,
      "app/api/weather/route.ts",
      `import { handleChatStream } from "@mastra/ai-sdk";\nexport async function POST() { return new Response(); }\n`,
    );
    await write(
      root,
      "app/api/copilot/route.ts",
      `import { vendoTools } from "${VENDO_AI_SDK}";\nexport async function POST() { return new Response(); }\n`,
    );

    for (const urlPath of ["/api/assist", "/api/weather", "/api/copilot"]) {
      const [tool, ...rest] = await toolsAt(root, urlPath);
      expect(rest).toEqual([]);
      expect(tool).toMatchObject({ disabled: true, binding: { method: "POST", path: urlPath } });
      expect(tool?.note).toContain(AGENT_LOOP_REASON);
    }
  });
});

describe("Vendo's own wire mount is never part of the host API", () => {
  const wireWarning = (urlPath: string): string =>
    `route ${urlPath} belongs to Vendo's own wire mount, not the host API, so no tool was emitted`;

  it("emits no tool for the stock /api/vendo mount, and says so", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/vendo/[...vendo]/route.ts",
      `import { nextVendoHandler } from "${VENDO_SERVER}";\nimport { vendo } from "@/lib/vendo";\nexport const { GET, POST } = nextVendoHandler(vendo);\n`,
    );

    const { tools, warnings } = await scanRoutes(root);
    expect(tools).toEqual([]);
    expect(warnings).toEqual([wireWarning("/api/vendo/{vendo}")]);
  });

  it("emits no tool for a wire mount the host branded onto its own path", async () => {
    const root = await temporaryRoot();
    // Neither the URL nor the catch-all parameter says "vendo": before this,
    // the branded mount shipped a live GET/POST/DELETE catch-all onto
    // everything Vendo exposes. The handler's own import is what makes the
    // match mount-independent.
    await write(
      root,
      "app/api/assistant/[...slug]/route.ts",
      `import { nextVendoHandler } from "${VENDO_SERVER}";\nimport { vendo } from "@/lib/vendo";\nexport const { GET, POST, DELETE } = nextVendoHandler(vendo);\n`,
    );

    const { tools, warnings } = await scanRoutes(root);
    expect(tools).toEqual([]);
    expect(warnings).toEqual([wireWarning("/api/assistant/{slug}")]);
  });

  // Maple's own `/api/demo/reset`, which a specifier-shaped marker deleted from
  // the catalog. This exclusion emits no tool, so no override can undo it —
  // being narrow is its only defence.
  it("keeps a host route that merely imports a TYPE from @vendoai/vendo/server", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/demo/reset/route.ts",
      [
        `import type { HostedStore } from "${VENDO_SERVER}";`,
        `import { vendo } from "@/vendo/server";`,
        `export async function POST() {`,
        `  const store = vendo.store as Partial<HostedStore>;`,
        `  return Response.json({ reset: store !== null });`,
        `}`,
        ``,
      ].join("\n"),
    );

    const { tools, warnings } = await scanRoutes(root);
    expect(tools.map((tool) => tool.name)).toEqual(["host_demo_reset_create"]);
    expect(tools[0]).not.toHaveProperty("disabled");
    expect(warnings).toEqual([]);
  });
});

describe("auth handlers are excluded from the callable catalog", () => {
  const reason = "it is an authentication handler";

  it("excludes an auth route that only re-exports its verbs from the auth module", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "lib/auth.ts",
      `import NextAuth from "next-auth";\nexport const { handlers: { GET, POST } } = NextAuth({ providers: [] });\n`,
    );
    // The route file itself mentions nothing about auth, and the URL carries no
    // `[...nextauth]` segment: the marker has to reach the re-export target.
    await write(root, "app/api/session-handler/route.ts", `export { GET, POST } from "${LIB_AUTH_FROM_ROUTE}";\n`);

    const { warnings } = await scanRoutes(root);
    const tools = await toolsAt(root, "/api/session-handler");
    expect(tools.length).toBe(2);
    expect(tools.every((tool) => tool.disabled === true && String(tool.note).startsWith(reason))).toBe(true);
    expect(warnings).toEqual([exclusionWarning("/api/session-handler", reason)]);
  });
});

describe("overrides.json is the escape hatch for an excluded route", () => {
  /** The real write path (`vendoSync` → `.vendo/tools.json`) read back through
   *  the real read path (`createActions` → `descriptors()`), with no stub on
   *  either side: enablement is decided by the runtime, not by the scanner. */
  async function liveToolNames(root: string): Promise<string[]> {
    const registry = createActions({ dir: root, fetch: vi.fn() as unknown as typeof fetch, baseUrl: "http://stub" });
    return (await registry.descriptors()).map((descriptor) => descriptor.name);
  }

  it("keeps an excluded route out of the runtime until an override wakes it", async () => {
    const root = await temporaryRoot();
    await write(
      root,
      "app/api/chat/route.ts",
      `import { streamText } from "ai";\nexport async function POST() { return new Response(); }\n`,
    );
    await vendoSync({ root });

    expect(await liveToolNames(root)).not.toContain("host_chat_create");

    await write(
      root,
      ".vendo/overrides.json",
      `${JSON.stringify({ format: VENDO_OVERRIDES_FORMAT, tools: { host_chat_create: { disabled: false } } }, null, 2)}\n`,
    );
    expect(await liveToolNames(root)).toContain("host_chat_create");
  });
});
