import { describe, expect, it } from "vitest";
import { DOCTOR_ERROR_CODES, TROUBLESHOOTING_URL, doctorErrorCodes, doctorFixRef } from "../../src/cli/doctor-codes.js";
import { CLI_VERSION } from "../../src/cli/shared.js";

describe("doctor error-code registry", () => {
  it("exports a complete, well-formed list a CI check can enumerate", () => {
    expect(doctorErrorCodes.length).toBeGreaterThan(0);
    expect(doctorErrorCodes).toEqual(Object.keys(DOCTOR_ERROR_CODES));
    for (const code of doctorErrorCodes) {
      // Short, grep-able, stable: E-<AREA>-<NNN>.
      expect(code).toMatch(/^E-[A-Z]+-\d{3}$/);
      expect(DOCTOR_ERROR_CODES[code].length).toBeGreaterThan(0);
    }
  });

  it("locks the registry append-only: renumbering, removing, or reusing a code fails here", () => {
    // A NEW code extends this snapshot; touching an existing entry rewrites
    // published fix_ref anchors and agents' remediation notes — never do it.
    // A check that goes away leaves its KEY behind, marked RETIRED (E-LIVE-007,
    // 2026-08-11): the verify page anchors on it, so deleting the entry breaks a
    // published URL for the sake of tidiness.
    expect(DOCTOR_ERROR_CODES).toMatchInlineSnapshot(`
      {
        "E-AUTH-001": "RETIRED — doctor no longer probes present credentials",
        "E-AUTH-002": "RETIRED — doctor no longer probes present credentials",
        "E-AUTH-003": "RETIRED — doctor no longer probes present credentials",
        "E-AUTH-004": "RETIRED — doctor no longer probes actAs",
        "E-AUTH-005": "RETIRED — doctor no longer probes actAs",
        "E-AUTH-006": "RETIRED — doctor no longer probes actAs",
        "E-AUTH-007": "RETIRED — doctor no longer probes actAs",
        "E-AUTH-008": "RETIRED — doctor no longer probes actAs",
        "E-AUTH-009": "supabase() is wired but neither SUPABASE_JWT_SECRET nor SUPABASE_URL is set",
        "E-AUTH-010": "clerk() is wired but neither CLERK_SECRET_KEY nor CLERK_JWT_KEY is set",
        "E-CFG-001": "a required .vendo/ config file is missing",
        "E-CFG-002": ".vendo/data/.gitignore is missing",
        "E-CFG-003": "the OpenAPI spec's relative server mount and VENDO_BASE_URL's path prefix disagree",
        "E-CFG-004": "the Next host's next.config does not keep @vendoai/apps out of the server bundle (serverExternalPackages)",
        "E-CLOUD-001": "VENDO_API_KEY is set but not usable",
        "E-DEP-001": "the installed ai package is a major version @vendoai/vendo does not support",
        "E-DEP-002": "RETIRED — doctor no longer reads a running wire's version",
        "E-DEP-003": "the installed zod predates the zod/v3 + zod/v4 subpaths the AI SDK imports (zod < 3.25)",
        "E-DEV-001": "RETIRED — doctor no longer starts a dev server",
        "E-LIVE-001": "RETIRED — doctor no longer reads /status",
        "E-LIVE-002": "RETIRED — doctor no longer reads /status",
        "E-LIVE-003": "RETIRED — doctor no longer reads /status",
        "E-LIVE-004": "RETIRED — doctor no longer reads the execution venue off /status",
        "E-LIVE-005": "RETIRED — doctor no longer reads the execution venue off /status",
        "E-LIVE-006": "RETIRED — doctor no longer requests the app's root page",
        "E-LIVE-007": "RETIRED — doctor no longer emits this; E2B_API_KEY does not select an execution venue",
        "E-LIVE-008": "the host still calls store ops the wire has deprecated and will remove",
        "E-MCP-001": "RETIRED — doctor no longer fetches MCP discovery documents",
        "E-MCP-002": "RETIRED — doctor no longer fetches MCP discovery documents",
        "E-MCP-003": "RETIRED — doctor no longer fetches the MCP server card",
        "E-MCP-004": "server.json does not meet MCP registry discovery requirements",
        "E-MCP-005": "RETIRED — doctor no longer compares server.json against a live door",
        "E-MCP-006": "server.json is invalid JSON",
        "E-MCP-007": "the local MCP registry auth challenge is malformed",
        "E-MCP-008": "RETIRED — doctor no longer fetches the live registry auth challenge",
        "E-MCP-009": "the MCP door is wired but VENDO_BASE_URL is not set (discovery advertises the wrong origin)",
        "E-MODEL-001": "the key this install's \`models\` wiring reads is not set (the wire is wired, but the agent cannot answer a single turn)",
        "E-SCHED-001": "RETIRED — doctor no longer reads machines and schedules off a running app",
        "E-STORE-001": "the store's data directory is on ephemeral disk (it will be wiped on redeploy)",
        "E-TENANT-001": "tenant connectors are wired but the store has no encryption key, so a tenant's pasted token has nowhere safe to live",
        "E-TOOLS-001": "every extracted host tool is disabled or excluded (zero live host tools)",
        "E-TOOLS-002": "the extracted tool surface is empty (zero host tools)",
        "E-TOOLS-003": "part of the tool catalog is ungraded (nobody has graded it, so it asks on every call)",
        "E-TOOLS-004": "part of the tool catalog declares no request/response shape (the agent must pass whole outputs through / cannot know the arguments)",
        "E-TOOLS-005": "some extracted host tools are off, so the agent will never offer them (an audience grade or an explicit disable took them)",
        "E-TURN-001": "RETIRED — doctor no longer runs a model turn",
        "E-TURN-002": "RETIRED — doctor no longer runs a model turn",
        "E-UI-001": "an ejected surface predates the installed @vendoai/ui",
        "E-WIRE-001": "Express server is not wired with createVendo from @vendoai/vendo/server",
        "E-WIRE-002": "Express client is not wrapped in <VendoProvider>",
        "E-WIRE-003": "the Next.js catch-all handler app/api/vendo/[...vendo]/route.ts is missing",
        "E-WIRE-004": "the Next.js root layout is not wrapped in <VendoProvider>",
        "E-WIRE-005": "the @vendoai/vendo (or vendoai alias) dependency is not declared",
        "E-WIRE-006": "no visible agent surface is mounted (<VendoProvider> alone renders nothing)",
        "E-WIRE-007": "no createVendo server wiring found in an unknown-framework host",
        "E-WIRE-008": "no <VendoProvider> found in an unknown-framework host's source",
        "E-WIRE-009": "detected "use server" actions are not registered or not wired into createVendo",
        "E-WIRE-010": "the host still names the removed <VendoRoot> (swap it for <VendoProvider>)",
        "E-WIRE-011": "@vendoai/vendo is not resolvable from the app (a vendoai-alias-only install under pnpm)",
      }
    `);
  });

  it("builds a URL-valid fix_ref that lands on the code's own page", () => {
    const ref = doctorFixRef("E-AUTH-001", "1.2.3");
    // docs.vendo.run serves the troubleshooting pages directly; the
    // marketing-site path 302s (FINDINGS F7a) and some agents refuse the hop.
    // The code is in the PATH, not a fragment — a fragment never reaches the
    // server, so it could not select a page.
    expect(ref).toBe("https://docs.vendo.run/production/troubleshooting/e-auth-001?v=1.2.3");
    const url = new URL(ref);
    expect(url.searchParams.get("v")).toBe("1.2.3");
    expect(url.hash).toBe("");
    expect(`${url.origin}${url.pathname}`).toBe(`${TROUBLESHOOTING_URL}/e-auth-001`);
  });

  it("defaults the version param to the installed CLI version", () => {
    expect(new URL(doctorFixRef("E-WIRE-001")).searchParams.get("v")).toBe(CLI_VERSION);
  });
});
