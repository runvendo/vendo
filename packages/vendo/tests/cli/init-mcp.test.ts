import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doorWellKnownPaths } from "../../src/door-paths.js";
import { compositionSpecifier, routeSource } from "../../src/cli/init-scaffolds.js";
import { generateServiceKey, planMcp, wellKnownRouteSource, type McpPlan, type McpPlanInput } from "../../src/cli/init-mcp.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const clerk = { preset: "clerk", dependency: "@clerk/nextjs" } as const;

/** How the discovery route reaches the composition module. Assembled rather
    than written literally: an escaping relative specifier spelled inline reads
    to the dependency guard as a real import. */
const COMPOSITION_SPECIFIER = ["..", "..", "..", "lib", "vendo"].join("/");

function plan(overrides: Partial<McpPlanInput> = {}): McpPlan {
  return planMcp({
    root: "/host",
    appDir: "/host/app",
    composition: "/host/lib/vendo.ts",
    compositionSpecifier: COMPOSITION_SPECIFIER,
    framework: "next",
    authWired: clerk,
    serverActions: true,
    posture: "local",
    serviceKey: false,
    ...overrides,
  });
}

describe("planMcp — the files", () => {
  it("adds only the origin-root discovery route: the composition it opens is the one the wire route already imports", () => {
    const { changes, compositionSource } = plan();
    expect(changes.map((change) => change.path)).toEqual(["app/.well-known/[...vendo]/route.ts"]);
    expect(compositionSource).toContain("export const vendo = createVendo({");
  });

  it("opens the door in that composition, with the preset that carries the oauth seam", () => {
    const composition = plan().compositionSource!;
    expect(composition).toContain(`import { clerk } from "@vendoai/vendo/auth/clerk";`);
    expect(composition).toContain("auth: clerk(),");
    expect(composition).toContain("mcp: true,");
  });

  it("points the discovery route at the SAME instance the wire serves", () => {
    const wellKnown = plan().changes[0]!;
    // Instance identity is how wellKnownVendoHandler resolves its path set
    // (server.ts:447-452) — a second createVendo() here 404s every path.
    expect(wellKnown.after).toContain(`import { vendo } from ${JSON.stringify(COMPOSITION_SPECIFIER)};`);
    expect(wellKnown.after).not.toMatch(/import\s*\{[^}]*\bcreateVendo\b/);
    expect(wellKnown.after).toContain("export const { GET, POST } = wellKnownVendoHandler(vendo);");
  });

  it("imports the generated action map only when the host has server actions", () => {
    expect(plan().compositionSource).toContain(`import { serverActions } from "./vendo-actions";`);
    expect(plan({ serverActions: false }).compositionSource).not.toContain("./vendo-actions");
  });
});

describe("planMcp — what it refuses to write", () => {
  it("writes nothing without an oauth seam: mcp: true would throw at composition", () => {
    const blocked = plan({ authWired: null });
    expect(blocked.blocked).toMatch(/cannot open without one/);
    expect(blocked.changes).toEqual([]);
    expect(blocked.compositionSource).toBeNull();
  });

  it("writes nothing off the Next.js app router — the discovery paths are origin-root", () => {
    for (const framework of ["express", "custom"] as const) {
      const blocked = plan({ framework });
      expect(blocked.blocked).toMatch(/Next\.js-only/);
      expect(blocked.changes).toEqual([]);
    }
  });
});

describe("planMcp — the service key", () => {
  it("generates and wires one under local posture", () => {
    const local = plan({ serviceKey: true });
    expect(local.serviceKeyValue).toMatch(/^[0-9a-f]{64}$/);
    expect(local.compositionSource).toContain("const serviceKey = process.env.VENDO_SERVICE_KEY");
    expect(local.compositionSource).toContain(`mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },`);
  });

  // serviceAuth is local-door mechanics: the RFC 8693 exchange lives at the
  // door's own /token, which a broker-fronted door does not serve — and an
  // explicit local serviceAuth beats the env default, so generating one here
  // would quietly hold the door LOCAL against the posture just chosen. Cloud
  // provisions the broker's own key with the tenant, so there is no step here
  // either: nothing for the operator to create, copy or paste.
  it("generates nothing and says nothing under broker posture — Cloud provisions the key", () => {
    const broker = plan({ serviceKey: true, posture: "broker" });
    expect(broker.serviceKeyValue).toBeUndefined();
    expect(broker.compositionSource).toContain("mcp: true,");
    expect(broker.compositionSource).not.toContain("serviceAuth");
  });

  it("mints nothing when the answer was no", () => {
    expect(plan().serviceKeyValue).toBeUndefined();
  });

  it("mints 32 hex bytes", () => {
    expect(generateServiceKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateServiceKey()).not.toBe(generateServiceKey());
  });
});

describe("wellKnownRouteSource", () => {
  it("is a two-line body over the specifier it is handed", () => {
    const source = wellKnownRouteSource("../../api/vendo/[...vendo]/vendo");
    expect(source).toContain(`import { wellKnownVendoHandler } from "@vendoai/vendo/server";`);
    expect(source).toContain(`import { vendo } from "../../api/vendo/[...vendo]/vendo";`);
  });
});

/**
 * THE SEAM. The generator and the consumer are the two halves that can
 * disagree, so neither is stubbed: the scaffold is written THROUGH planMcp,
 * the generated composition is BOOTED, and the door is asked for every path in
 * `doorWellKnownPaths` — the one authority the wire and the composition share.
 * A harness that mocked either half could never catch the failure this exists
 * to catch (a second createVendo() in the discovery route, which resolves an
 * empty path set and 404s all of them).
 *
 * The generated files are written verbatim and loaded through a real
 * `node_modules/@vendoai/vendo` link, so `@vendoai/vendo/server` and
 * `@vendoai/vendo/auth/clerk` resolve exactly as they do in a host.
 */
describe("the generated MCP door answers every well-known path (seam)", () => {
  const PACKAGE_ROOT = resolve(new URL("../..", import.meta.url).pathname);
  const BASE_URL = "https://app.acme.com/maple";

  async function bootGeneratedDoor(): Promise<{
    wellKnown: { GET(request: Request): Promise<Response> };
    wire: { GET(request: Request): Promise<Response> };
  }> {
    // The host tree lives under the package (never inside another suite's dist
    // — see the testing section of CLAUDE.md) so the generated modules load
    // through the SAME resolver a Next.js host uses: extensionless relative
    // imports, and `@vendoai/vendo/*` off a real node_modules link.
    const root = await mkdtemp(join(PACKAGE_ROOT, ".mcp-seam-"));
    cleanup.push(root);
    const routePath = join(root, "app", "api", "vendo", "[...vendo]", "route.ts");
    const composition = join(root, "lib", "vendo.ts");
    // The specifiers come from the SAME helper init uses, so a change that
    // makes the route unable to reach the composition fails here.
    const built = planMcp({
      root,
      appDir: join(root, "app"),
      composition,
      compositionSpecifier: await compositionSpecifier(root, join(root, "app", ".well-known", "[...vendo]")),
      framework: "next",
      authWired: clerk,
      serverActions: false,
      posture: "local",
      serviceKey: true,
    });
    const files = [
      { absolute: routePath, after: routeSource(await compositionSpecifier(root, dirname(routePath))) },
      { absolute: composition, after: built.compositionSource! },
      ...built.changes,
    ];
    for (const file of files) {
      await mkdir(dirname(file.absolute), { recursive: true });
      await writeFile(file.absolute, file.after);
    }
    await mkdir(join(root, "node_modules", "@vendoai"), { recursive: true });
    await symlink(PACKAGE_ROOT, join(root, "node_modules", "@vendoai", "vendo"), "dir");

    // The one value the whole door derives from. A path prefix is deliberate:
    // it is what makes the four exact paths six, and the prefixed spellings are
    // the ones a spec client actually asks for (RFC 8414 §3 / RFC 9728 §3.1).
    vi.stubEnv("VENDO_BASE_URL", BASE_URL);
    vi.stubEnv("VENDO_SERVICE_KEY", generateServiceKey());
    return {
      wellKnown: await import(pathToFileURL(join(root, "app", ".well-known", "[...vendo]", "route.ts")).href),
      wire: await import(pathToFileURL(routePath).href),
    };
  }

  it("answers all six, over the same instance the wire route serves", async () => {
    const { wellKnown, wire } = await bootGeneratedDoor();
    const paths = [...doorWellKnownPaths("/maple")];
    expect(paths).toHaveLength(6);

    for (const path of paths) {
      const response = await wellKnown.GET(new Request(`https://app.acme.com${path}`));
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toBeTypeOf("object");
    }

    // The documents are the door's own, not a generic 200: discovery names the
    // configured public origin, prefix included.
    const resource = await wellKnown.GET(new Request(`https://app.acme.com/.well-known/oauth-protected-resource/maple/api/vendo/mcp`));
    expect((await resource.json() as { resource?: string }).resource).toBe(`${BASE_URL}/api/vendo/mcp`);
    const issuer = await wellKnown.GET(new Request(`https://app.acme.com/.well-known/oauth-authorization-server/maple/api/vendo/mcp`));
    const metadata = await issuer.json() as { issuer?: string; grant_types_supported?: string[] };
    expect(metadata.issuer).toBe(`${BASE_URL}/api/vendo/mcp`);
    // The generated serviceAuth wiring is live: the exchange grant is advertised.
    expect(metadata.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:token-exchange");

    // The generated wire route serves the door itself, and challenges with the
    // discovery URL the route above answers — the two halves agree.
    const door = await wire.GET(new Request("https://app.acme.com/api/vendo/mcp"));
    expect(door.status).toBe(401);
    expect(door.headers.get("www-authenticate"))
      .toContain(`${BASE_URL}/.well-known/oauth-protected-resource/api/vendo/mcp`);

    // …and only its own set: the generated route does not shadow a host's other
    // well-known documents.
    const foreign = await wellKnown.GET(new Request("https://app.acme.com/.well-known/openid-configuration"));
    expect(foreign.status).toBe(404);
  });
});
