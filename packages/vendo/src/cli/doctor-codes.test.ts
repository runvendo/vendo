import { describe, expect, it } from "vitest";
import { DOCTOR_ERROR_CODES, VERIFY_URL, doctorErrorCodes, doctorFixRef } from "./doctor-codes.js";
import { CLI_VERSION } from "./shared.js";

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
    expect(DOCTOR_ERROR_CODES).toMatchInlineSnapshot(`
      {
        "E-AUTH-001": "present credentials did not reach the host API",
        "E-AUTH-002": "the present credential probe is unreachable",
        "E-AUTH-003": "the present credential probe cannot run while the dev server is down",
        "E-AUTH-004": "actAs mint + host verification failed",
        "E-AUTH-005": "the actAs probe is unreachable",
        "E-AUTH-006": "the actAs probe cannot run while the dev server is down",
        "E-AUTH-007": "actAs is not configured",
        "E-CFG-001": "a required .vendo/ config file is missing",
        "E-CFG-002": ".vendo/data/.gitignore is missing",
        "E-CLOUD-001": "VENDO_API_KEY is set but not usable",
        "E-DEP-001": "the installed ai package is a major version @vendoai/vendo does not support",
        "E-DEP-002": "the running wire serves a different @vendoai/vendo version than this CLI (split-brain install)",
        "E-DEV-001": "the dev server could not be started for the probe",
        "E-LIVE-001": "/status returned an invalid composition response",
        "E-LIVE-002": "/status is unreachable",
        "E-LIVE-003": "/status returned an invalid execution venue",
        "E-LIVE-004": "no execution venue is configured",
        "E-LIVE-005": "the host /status does not report an execution venue (version skew)",
        "E-LIVE-006": "the app's root page returns a server error while the wire answers",
        "E-MCP-001": "MCP protected-resource metadata did not resolve",
        "E-MCP-002": "MCP authorization-server metadata did not resolve",
        "E-MCP-003": "the MCP server card did not parse",
        "E-MCP-004": "server.json does not meet MCP registry discovery requirements",
        "E-MCP-005": "the server.json remote does not match the live MCP door",
        "E-MCP-006": "server.json is invalid JSON",
        "E-MCP-007": "the local MCP registry auth challenge is malformed",
        "E-MCP-008": "the live MCP registry auth challenge is malformed",
        "E-SCHED-001": "apps declare vendo.json schedules but no schedule caller is configured",
        "E-TOOLS-001": "every extracted host tool is disabled or excluded (zero live host tools)",
        "E-TOOLS-002": "the extracted tool surface is empty (zero host tools)",
        "E-TURN-001": "the live model turn did not answer",
        "E-TURN-002": "the live model turn cannot run while the dev server is down",
        "E-UI-001": "an ejected surface predates the installed @vendoai/ui",
        "E-WIRE-001": "Express server is not wired with createVendo from @vendoai/vendo/server",
        "E-WIRE-002": "Express client is not wrapped in <VendoRoot>",
        "E-WIRE-003": "the Next.js catch-all handler app/api/vendo/[...vendo]/route.ts is missing",
        "E-WIRE-004": "the Next.js root layout is not wrapped in <VendoRoot>",
        "E-WIRE-005": "the @vendoai/vendo (or vendoai alias) dependency is not declared",
        "E-WIRE-006": "no visible agent surface is mounted (<VendoRoot> alone renders nothing)",
        "E-WIRE-007": "no createVendo server wiring found in an unknown-framework host",
        "E-WIRE-008": "no <VendoRoot> found in an unknown-framework host's source",
      }
    `);
  });

  it("builds a URL-valid fix_ref with the version param before the fragment", () => {
    const ref = doctorFixRef("E-AUTH-001", "1.2.3");
    expect(ref).toBe("https://vendo.run/agents/verify?v=1.2.3#E-AUTH-001");
    const url = new URL(ref);
    expect(url.searchParams.get("v")).toBe("1.2.3");
    expect(url.hash).toBe("#E-AUTH-001");
    expect(`${url.origin}${url.pathname}`).toBe(VERIFY_URL);
  });

  it("defaults the version param to the installed CLI version", () => {
    expect(new URL(doctorFixRef("E-WIRE-001")).searchParams.get("v")).toBe(CLI_VERSION);
  });
});
