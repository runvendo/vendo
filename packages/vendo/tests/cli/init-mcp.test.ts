import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doorWellKnownPaths } from "../../src/door-paths.js";
import { generateServiceKey, planMcp, wellKnownRouteSource, type McpPlan, type McpPlanInput } from "../../src/cli/init-mcp.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const clerk = { preset: "clerk", dependency: "@clerk/nextjs" } as const;

function plan(overrides: Partial<McpPlanInput> = {}): McpPlan {
  return planMcp({
    root: "/host",
    appDir: "/host/app",
    framework: "next",
    authWired: clerk,
    serverActions: true,
    cloudKey: true,
    posture: "local",
    serviceKey: false,
    baseUrl: "https://app.acme.com",
    ...overrides,
  });
}

describe("planMcp — the files", () => {
  it("writes the composition and the origin-root discovery route alongside a thin route", () => {
    const { changes, routeSource } = plan();
    expect(changes.map((change) => change.path)).toEqual([
      "app/api/vendo/[...vendo]/vendo.ts",
      "app/.well-known/[...vendo]/route.ts",
    ]);
    // A Next.js route module may export only route handlers, so the route is
    // thin and the composition lives next door.
    expect(routeSource).toContain(`import { vendo } from "./vendo";`);
    expect(routeSource).not.toMatch(/import\s*\{[^}]*\bcreateVendo\b/);
  });

  it("opens the door in the composition it authors, with the preset that carries the oauth seam", () => {
    const [composition] = plan().changes;
    expect(composition!.after).toContain(`import { clerk } from "@vendoai/vendo/auth/clerk";`);
    expect(composition!.after).toContain("auth: clerk(),");
    expect(composition!.after).toContain("mcp: true,");
    expect(composition!.after).toContain("export const vendo = createVendo({");
  });

  it("points the discovery route at the SAME instance the wire serves", () => {
    const wellKnown = plan().changes[1]!;
    // Instance identity is how wellKnownVendoHandler resolves its path set
    // (server.ts:447-452) — a second createVendo() here 404s every path.
    expect(wellKnown.after).toContain(`import { vendo } from "../../api/vendo/[...vendo]/vendo";`);
    expect(wellKnown.after).not.toMatch(/import\s*\{[^}]*\bcreateVendo\b/);
    expect(wellKnown.after).toContain("export const { GET, POST } = wellKnownVendoHandler(vendo);");
  });

  it("imports the generated action map only when the host has server actions", () => {
    expect(plan().changes[0]!.after).toContain(`import { serverActions } from "./vendo-actions";`);
    expect(plan({ serverActions: false }).changes[0]!.after).not.toContain("./vendo-actions");
  });
});

describe("planMcp — what it refuses to write", () => {
  it("writes nothing without an oauth seam: mcp: true would throw at composition", () => {
    const blocked = plan({ authWired: null });
    expect(blocked.blocked).toMatch(/cannot open without one/);
    expect(blocked.changes).toEqual([]);
    expect(blocked.routeSource).toBeNull();
    expect(blocked.steps).toEqual([]);
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
    expect(local.changes[0]!.after).toContain("const serviceKey = process.env.VENDO_SERVICE_KEY");
    expect(local.changes[0]!.after).toContain(`mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },`);
    expect(local.steps.at(-1)).toContain("/api/vendo/mcp/token");
  });

  // serviceAuth is local-door mechanics: the RFC 8693 exchange lives at the
  // door's own /token, which a broker-fronted door does not serve — and an
  // explicit local serviceAuth beats the env default, so generating one here
  // would quietly hold the door LOCAL against the posture just chosen.
  it("generates nothing under broker posture and points at the console instead", () => {
    const broker = plan({ serviceKey: true, posture: "broker" });
    expect(broker.serviceKeyValue).toBeUndefined();
    expect(broker.changes[0]!.after).toContain("mcp: true,");
    expect(broker.changes[0]!.after).not.toContain("serviceAuth");
    expect(broker.steps.at(-1)).toContain("console's keys page");
  });

  it("says nothing about service keys when the answer was no", () => {
    const none = plan();
    expect(none.serviceKeyValue).toBeUndefined();
    expect(none.steps.join("\n")).not.toContain("VENDO_SERVICE_KEY");
  });

  it("mints 32 hex bytes", () => {
    expect(generateServiceKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateServiceKey()).not.toBe(generateServiceKey());
  });
});

describe("planMcp — the two steps that stay the user's", () => {
  it("puts the base URL FIRST, always", () => {
    expect(plan().steps[0]).toContain("Set VENDO_BASE_URL");
    expect(plan({ baseUrl: null }).steps[0]).toContain("Set VENDO_BASE_URL");
    expect(plan({ posture: "broker", serviceKey: true }).steps[0]).toContain("Set VENDO_BASE_URL");
  });

  it("names the captured origin when there is one, and the risk when there is not", () => {
    expect(plan().steps[0]).toContain("https://app.acme.com, captured earlier, is in .env.example");
    expect(plan({ baseUrl: null }).steps[0]).toContain("points at the wrong origin");
  });

  it("points clients at the same URL in BOTH postures — it derives from the base URL, never the broker", () => {
    const client = "Point any MCP client at https://app.acme.com/api/vendo/mcp";
    expect(plan().steps).toContain(client);
    expect(plan({ posture: "broker" }).steps).toContain(client);
  });
});

describe("planMcp — the sign-in posture", () => {
  it("prints the operator's two broker lines under broker posture, and nothing under local", () => {
    expect(plan({ posture: "broker" }).envLines).toEqual([
      "VENDO_MCP_BROKER_URL=<your tenant MCP endpoint, from the console MCP page>",
      "VENDO_MCP_FEDERATION_SECRET=<from the console MCP page>",
    ]);
    expect(plan().envLines).toEqual([]);
  });

  // The posture select only appears when a Cloud key is in hand; a keyless run
  // gets local as the default and today's one-line pointer.
  it("adds the keyless pointer only when no Cloud key is in hand", () => {
    expect(plan({ cloudKey: false }).steps.join("\n")).toContain("Sign-in: your app serves its own OAuth");
    expect(plan().steps.join("\n")).not.toContain("Sign-in: your app serves its own OAuth");
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
    const built = planMcp({
      root,
      appDir: join(root, "app"),
      framework: "next",
      authWired: clerk,
      serverActions: false,
      cloudKey: true,
      posture: "local",
      serviceKey: true,
      baseUrl: BASE_URL,
    });
    const routePath = join(root, "app", "api", "vendo", "[...vendo]", "route.ts");
    const files = [
      { absolute: routePath, after: built.routeSource! },
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
