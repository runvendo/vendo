import { CLI_VERSION } from "./shared.js";

/**
 * Agent-install DX (design 2026-07-19 §CLI-3) — the doctor error-code
 * registry. Every failure mode doctor can report (static and live) has one
 * stable, grep-able code here: E-<AREA>-<NNN>, where the area groups related
 * checks (WIRE wiring, CFG config files, UI eject drift, DEV probe server,
 * LIVE composition/status, AUTH credentials, MCP door, TURN model turn,
 * CLOUD key). Codes are append-only: never renumber or reuse one — the
 * verify page anchors (`fix_ref`) and agents' remediation notes depend on
 * them staying put.
 *
 * This is the ONE module a CI check enumerates to assert every code has a
 * matching verify-page anchor (no registry rot).
 */
export const DOCTOR_ERROR_CODES = {
  "E-WIRE-001": "Express server is not wired with createVendo from @vendoai/vendo/server",
  "E-WIRE-002": "Express client is not wrapped in <VendoRoot>",
  "E-WIRE-003": "the Next.js catch-all handler app/api/vendo/[...vendo]/route.ts is missing",
  "E-WIRE-004": "the Next.js root layout is not wrapped in <VendoRoot>",
  "E-WIRE-005": "the @vendoai/vendo (or vendoai alias) dependency is not declared",
  "E-CFG-001": "a required .vendo/ config file is missing",
  "E-CFG-002": ".vendo/data/.gitignore is missing",
  "E-UI-001": "an ejected surface predates the installed @vendoai/ui",
  "E-DEV-001": "the dev server could not be started for the probe",
  "E-LIVE-001": "/status returned an invalid composition response",
  "E-LIVE-002": "/status is unreachable",
  "E-LIVE-003": "/status returned an invalid execution venue",
  "E-LIVE-004": "no execution venue is configured",
  "E-LIVE-005": "the host /status does not report an execution venue (version skew)",
  "E-AUTH-001": "present credentials did not reach the host API",
  "E-AUTH-002": "the present credential probe is unreachable",
  "E-AUTH-003": "the present credential probe cannot run while the dev server is down",
  "E-AUTH-004": "actAs mint + host verification failed",
  "E-AUTH-005": "the actAs probe is unreachable",
  "E-AUTH-006": "the actAs probe cannot run while the dev server is down",
  "E-AUTH-007": "actAs is not configured",
  "E-MCP-001": "MCP protected-resource metadata did not resolve",
  "E-MCP-002": "MCP authorization-server metadata did not resolve",
  "E-MCP-003": "the MCP server card did not parse",
  "E-MCP-004": "server.json does not meet MCP registry discovery requirements",
  "E-MCP-005": "the server.json remote does not match the live MCP door",
  "E-MCP-006": "server.json is invalid JSON",
  "E-MCP-007": "the local MCP registry auth challenge is malformed",
  "E-MCP-008": "the live MCP registry auth challenge is malformed",
  "E-TURN-001": "the live model turn did not answer",
  "E-TURN-002": "the live model turn cannot run while the dev server is down",
  "E-CLOUD-001": "VENDO_API_KEY is set but not usable",
} as const;

export type DoctorErrorCode = keyof typeof DOCTOR_ERROR_CODES;

/** Complete list of every code doctor can emit, for CI enumeration. */
export const doctorErrorCodes = Object.keys(DOCTOR_ERROR_CODES) as readonly DoctorErrorCode[];

/** The verify playbook page the fix_ref URLs anchor into. */
export const VERIFY_URL = "https://vendo.run/agents/verify";

/** Full fix URL for a code: the installed vendoai version rides as a query
 *  param BEFORE the fragment so the URL stays valid and the verify page can
 *  version-match its guidance. */
export function doctorFixRef(code: DoctorErrorCode, version: string = CLI_VERSION): string {
  return `${VERIFY_URL}?v=${encodeURIComponent(version)}#${code}`;
}
