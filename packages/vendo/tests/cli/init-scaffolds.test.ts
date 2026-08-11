import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { compositionModuleSource, customServerSource, expressServerSource, routeSource } from "../../src/cli/init-scaffolds.js";

const run = promisify(execFile);

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Node's own parser is the only honest judge of "is this valid JavaScript" —
    a substring assertion misses the next type annotation that sneaks in. */
async function parses(source: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vendo-scaffold-check-"));
  cleanup.push(root);
  const file = join(root, "server.mjs");
  await writeFile(file, source);
  await run(execPath, ["--check", file]);
}

/**
 * Self-serve audit B2: the JS-emitted scaffolds carried TypeScript syntax —
 * `kind: "user" as const` in the principal line and a `as Headers & {…}` cast
 * around getSetCookie — so every plain-JS host threw `SyntaxError: Unexpected
 * identifier 'as'` on its first `node server.js`.
 */
describe("JS-emitted scaffolds are valid JavaScript", () => {
  it("the Express composition parses as .mjs", async () => {
    await parses(expressServerSource(false));
  });

  it("the runtime-neutral composition parses as .mjs", async () => {
    await parses(customServerSource(false));
  });

  it("neither JS scaffold carries a type annotation", () => {
    for (const source of [expressServerSource(false), customServerSource(false)]) {
      expect(source).not.toContain(" as const");
      expect(source).not.toContain(" as Headers");
    }
  });

  it("the TypeScript scaffolds keep the annotations they need", () => {
    expect(expressServerSource(true)).toContain(`kind: "user" as const`);
    expect(expressServerSource(true)).toContain("as Headers & { getSetCookie?: () => string[] }");
    expect(customServerSource(true)).toContain(`kind: "user" as const`);
  });
});

describe("the scaffolds init writes", () => {
  it("does not import or pass a registry — the host writes its own client file", () => {
    const source = routeSource({ serverActions: false, auth: null });
    expect(source).not.toContain("./registry");
    expect(source).not.toContain("catalog:");
  });

  it("leaves the server compositions registry-free too", () => {
    for (const source of [expressServerSource(true), customServerSource(true)]) {
      expect(source).not.toContain("catalog: registry");
      expect(source).not.toContain(`from "./registry`);
    }
  });
});

/** The MCP path is the ONLY path that splits the composition, and the non-MCP
    route is byte-identical to what it has always been (the auth-preset suites
    pin those bytes). */
describe("the MCP path's split composition", () => {
  const clerk = { preset: "clerk", dependency: "@clerk/nextjs" } as const;

  it("leaves today's inline route untouched when no mcp arm is passed", () => {
    const inline = routeSource({ serverActions: true, auth: clerk });
    expect(inline).toContain("const vendo = createVendo({");
    expect(inline).toContain("export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);");
    expect(inline).not.toContain(`from "./vendo"`);
  });

  it("makes route.ts thin on the MCP path — a route module may export only handlers", () => {
    const thin = routeSource({ serverActions: true, auth: clerk, mcp: { serviceAuth: false } });
    expect(thin).toContain(`import { vendo } from "./vendo";`);
    expect(thin).toContain("export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);");
    expect(thin).not.toMatch(/import\s*\{[^}]*\bcreateVendo\b/);
    // Nothing the route exports may be a non-handler, so the preset and the
    // action map move out with the composition.
    expect(thin).not.toContain("@vendoai/vendo/auth/clerk");
    expect(thin).not.toContain("./vendo-actions");
  });

  it("opens the door in the composition module, and wires serviceAuth off the environment only when asked", () => {
    const plain = compositionModuleSource({ serverActions: true, auth: clerk, serviceAuth: false });
    expect(plain).toContain("export const vendo = createVendo({");
    expect(plain).toContain("auth: clerk(),");
    expect(plain).toContain("serverActions,");
    expect(plain).toContain("mcp: true,");
    expect(plain).not.toContain("VENDO_SERVICE_KEY");

    const service = compositionModuleSource({ serverActions: false, auth: clerk, serviceAuth: true });
    expect(service).toContain(`const serviceKey = process.env.VENDO_SERVICE_KEY ?? "";`);
    expect(service).toContain(`mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },`);
    expect(service).not.toContain("./vendo-actions");
  });
});

/** SPEC 4b: env keys are credentials and CONFIG selects the model, so a stray
    ANTHROPIC_API_KEY no longer picks one. The scaffold is the migration path —
    init writes the explicit selection into the composition it authors, ONCE. */
describe("the models line a detected provider key writes", () => {
  const clerk = { preset: "clerk", dependency: "@clerk/nextjs" } as const;
  const anthropicKey = { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" } as const;

  it("writes the import and the config line exactly once into the Next route", () => {
    const route = routeSource({ serverActions: false, auth: null, models: anthropicKey });
    expect(route).toContain(`import { anthropic } from "@ai-sdk/anthropic";\n`);
    expect(route).toContain(`  models: { default: anthropic("claude-sonnet-4-6") }, // ANTHROPIC_API_KEY supplies the key\n`);
    expect(route.match(/@ai-sdk\/anthropic/g)).toHaveLength(1);
    expect(route.match(/models:/g)).toHaveLength(1);
    // The import leads the file — the same order the runtime-neutral scaffold
    // already uses — and the line lands inside the createVendo call.
    expect(route.indexOf("@ai-sdk/anthropic")).toBeLessThan(route.indexOf("@vendoai/vendo/server"));
    expect(route.indexOf("createVendo({")).toBeLessThan(route.indexOf("models:"));
  });

  it("names each provider's own default instance and flagship id", () => {
    expect(routeSource({ serverActions: false, auth: null, models: { provider: "openai", envVar: "OPENAI_API_KEY" } }))
      .toContain(`  models: { default: openai("gpt-5") }, // OPENAI_API_KEY supplies the key\n`);
    expect(routeSource({ serverActions: false, auth: null, models: { provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" } }))
      .toContain(`  models: { default: google("gemini-2.5-flash") }, // GOOGLE_GENERATIVE_AI_API_KEY supplies the key\n`);
  });

  it("writes neither the import nor the line when no provider key resolved", () => {
    for (const route of [
      routeSource({ serverActions: false, auth: null }),
      routeSource({ serverActions: false, auth: null, models: null }),
    ]) {
      expect(route).not.toContain("@ai-sdk/");
      expect(route).not.toContain("models:");
    }
  });

  it("keeps it out of the thin MCP route and in the composition module — one models line per host", () => {
    // The MCP route composes nothing (it imports ./vendo), so a models line
    // there would be a second, dead selection plus a dangling import.
    const thin = routeSource({ serverActions: false, auth: clerk, models: anthropicKey, mcp: { serviceAuth: false } });
    expect(thin).not.toContain("@ai-sdk/anthropic");
    expect(thin).not.toContain("models:");

    const composition = compositionModuleSource({ serverActions: false, auth: clerk, serviceAuth: false, models: anthropicKey });
    expect(composition).toContain(`import { anthropic } from "@ai-sdk/anthropic";\n`);
    expect(composition).toContain(`  models: { default: anthropic("claude-sonnet-4-6") }, // ANTHROPIC_API_KEY supplies the key\n`);
    expect(composition.match(/@ai-sdk\/anthropic/g)).toHaveLength(1);
    expect(composition.match(/models:/g)).toHaveLength(1);
    // The pair init writes on that path carries exactly one of each.
    expect(`${thin}${composition}`.match(/models:/g)).toHaveLength(1);

    const keyless = compositionModuleSource({ serverActions: false, auth: clerk, serviceAuth: false });
    expect(keyless).not.toContain("@ai-sdk/");
    expect(keyless).not.toContain("models:");
  });
});
