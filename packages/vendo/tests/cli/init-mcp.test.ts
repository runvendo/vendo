import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doorWellKnownPaths } from "../../src/door-paths.js";
import { compositionSpecifier, routeSource } from "../../src/cli/init-scaffolds.js";
import { generateServiceKey, mcpStepLines, planMcp, wellKnownRouteSource, type McpPlan, type McpPlanInput } from "../../src/cli/init-mcp.js";

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
    cloudKey: true,
    posture: "local",
    serviceKey: false,
    baseUrl: "https://app.acme.com",
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
    expect(local.compositionSource).toContain("const serviceKey = process.env.VENDO_SERVICE_KEY");
    expect(local.compositionSource).toContain(`mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },`);
    expect(local.steps.at(-1)).toContain("/api/vendo/mcp/token");
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
    expect(broker.steps.join("\n")).not.toContain("VENDO_SERVICE_KEY");
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
    expect(plan().steps[0]).toContain("`VENDO_BASE_URL`");
    expect(plan({ baseUrl: null }).steps[0]).toContain("Set `VENDO_BASE_URL`");
    expect(plan({ posture: "broker", serviceKey: true }).steps[0]).toContain("`VENDO_BASE_URL`");
  });

  /** The captured origin is the DEV one now (init writes it to .env.local), so
      the step points at deploy time for production instead of claiming the
      answer already covers it. */
  it("names the captured origin as dev-and-done, and the risk when there is none", () => {
    expect(plan().steps[0]).toContain("When you deploy, set `VENDO_BASE_URL` in your platform to the public origin");
    expect(plan().steps[0]).toContain("`https://app.acme.com` is in .env.local");
    expect(plan().steps[0]).not.toContain(".env.example");
    expect(plan({ baseUrl: null }).steps[0]).toContain("points at the wrong origin");
    expect(plan({ baseUrl: null }).steps[0]).toContain(".env.local in dev, your deploy platform in production");
  });

  it("points clients at the same URL in BOTH postures — it derives from the base URL, never the broker", () => {
    const client = "Point any MCP client at `https://app.acme.com/api/vendo/mcp`";
    expect(plan().steps.map((step) => step.split("\n")[0])).toContain(client);
    expect(plan({ posture: "broker" }).steps.map((step) => step.split("\n")[0])).toContain(client);
  });
});

describe("planMcp — the sign-in posture", () => {
  // The broker posture used to close on two placeholder environment values the
  // operator had to go and look up. Cloud reads both itself and provisions the
  // tenant on first use, so a placeholder printed here is a step that no longer
  // exists — and a `<secret>` on screen is what made this path feel like setup.
  it("prints no placeholder environment values under broker posture — Cloud provisions the tenant", () => {
    const broker = plan({ posture: "broker" }).steps.join("\n");
    expect(broker).not.toContain("<secret>");
    expect(broker).not.toMatch(/VENDO_MCP_(BROKER_URL|FEDERATION_SECRET)=/);
    expect(broker).toContain("provisions the tenant on first use");
  });

  // The posture select only appears when a Cloud key is in hand; a keyless run
  // gets local as the default and today's one-line pointer.
  it("adds the keyless pointer only when no Cloud key is in hand", () => {
    expect(plan({ cloudKey: false }).steps.join("\n")).toContain("Sign-in: your app serves its own OAuth");
    expect(plan().steps.join("\n")).not.toContain("Sign-in: your app serves its own OAuth");
  });
});

describe("mcpStepLines — the closing block reads as steps, not a wall", () => {
  it("numbers every headline and indents its detail under it", () => {
    const broker = plan({ posture: "broker", serviceKey: true });
    const lines = mcpStepLines(broker);
    // Every step's headline is numbered in order...
    const numbered = lines.filter((line) => /^\d+\. /.test(line));
    expect(numbered).toHaveLength(broker.steps.length);
    expect(numbered.map((line) => line.split(". ")[0])).toEqual(
      broker.steps.map((_step, index) => String(index + 1)),
    );
    // ...and every detail line is indented under the headline it belongs to,
    // never left at the margin where it would read as another step.
    for (const [index, step] of broker.steps.entries()) {
      const [headline, ...detail] = step.split("\n");
      const at = lines.indexOf(`${index + 1}. ${headline!}`);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(lines.slice(at + 1, at + 1 + detail.length)).toEqual(detail.map((rest) => `   ${rest}`));
    }
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
      cloudKey: true,
      posture: "local",
      serviceKey: true,
      baseUrl: BASE_URL,
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
