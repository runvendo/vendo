import { CLI_VERSION } from "./shared.js";

/**
 * Agent-install DX (design 2026-07-19 §CLI-3) — the doctor error-code
 * registry. Every failure mode doctor can report has one stable, grep-able
 * code here: E-<AREA>-<NNN>, where the area groups related checks (WIRE
 * wiring, CFG config files, STORE store persistence, DEP host dependency
 * versions, UI eject drift, MCP door, CLOUD key, TOOLS catalog). Codes are
 * append-only: never renumber or reuse one — the verify page anchors
 * (`fix_ref`) and agents' remediation notes depend on them staying put. A
 * check that goes away leaves its entry behind, marked RETIRED, for the same
 * reason. Doctor reads only what is on disk, so every code that needed a
 * running app to observe (DEV, LIVE, AUTH, TURN, SCHED and the fetched half
 * of MCP) is retired below.
 *
 * This is the ONE module a CI check enumerates to assert every code has a
 * matching verify-page anchor (no registry rot).
 */
export const DOCTOR_ERROR_CODES = {
  "E-WIRE-001": "Express server is not wired with createVendo from @vendoai/vendo/server",
  "E-WIRE-002": "Express client is not wrapped in <VendoProvider>",
  "E-WIRE-003": "the Next.js catch-all handler app/api/vendo/[...vendo]/route.ts is missing",
  "E-WIRE-004": "the Next.js root layout is not wrapped in <VendoProvider>",
  "E-WIRE-005": "the @vendoai/vendo (or vendoai alias) dependency is not declared",
  "E-WIRE-006": "no visible agent surface is mounted (<VendoProvider> alone renders nothing)",
  "E-WIRE-007": "no createVendo server wiring found in an unknown-framework host",
  "E-WIRE-008": "no <VendoProvider> found in an unknown-framework host's source",
  "E-WIRE-009": "detected \"use server\" actions are not registered or not wired into createVendo",
  "E-WIRE-010": "the host still names the removed <VendoRoot> (swap it for <VendoProvider>)",
  "E-WIRE-011": "@vendoai/vendo is not resolvable from the app (a vendoai-alias-only install under pnpm)",
  "E-CFG-001": "a required .vendo/ config file is missing",
  "E-CFG-002": ".vendo/data/.gitignore is missing",
  "E-CFG-003": "the OpenAPI spec's relative server mount and VENDO_BASE_URL's path prefix disagree",
  "E-CFG-004": "the Next host's next.config does not keep @vendoai/apps out of the server bundle (serverExternalPackages)",
  "E-STORE-001": "the store's data directory is on ephemeral disk (it will be wiped on redeploy)",
  "E-DEP-001": "the installed ai package is a major version @vendoai/vendo does not support",
  "E-DEP-002": "RETIRED — doctor no longer reads a running wire's version",
  "E-DEP-003": "the installed zod predates the zod/v3 + zod/v4 subpaths the AI SDK imports (zod < 3.25)",
  "E-UI-001": "an ejected surface predates the installed @vendoai/ui",
  "E-DEV-001": "RETIRED — doctor no longer starts a dev server",
  "E-LIVE-001": "RETIRED — doctor no longer reads /status",
  "E-LIVE-002": "RETIRED — doctor no longer reads /status",
  "E-LIVE-003": "RETIRED — doctor no longer reads /status",
  "E-LIVE-004": "RETIRED — doctor no longer reads the execution venue off /status",
  "E-LIVE-005": "RETIRED — doctor no longer reads the execution venue off /status",
  "E-LIVE-006": "RETIRED — doctor no longer requests the app's root page",
  // RETIRED 2026-08-11 (the selection law): E2B_API_KEY no longer selects a
  // venue, so no host can be handed an e2b venue it did not ask for. An explicit
  // `sandbox: e2bSandbox()` refuses at boot when the SDK does not resolve, which
  // is earlier and louder than a probe. The ENTRY stays — the registry is
  // append-only and the verify page anchors on it.
  "E-LIVE-007": "RETIRED — doctor no longer emits this; E2B_API_KEY does not select an execution venue",
  "E-LIVE-008": "the host still calls store ops the wire has deprecated and will remove",
  "E-AUTH-001": "RETIRED — doctor no longer probes present credentials",
  "E-AUTH-002": "RETIRED — doctor no longer probes present credentials",
  "E-AUTH-003": "RETIRED — doctor no longer probes present credentials",
  "E-AUTH-004": "RETIRED — doctor no longer probes actAs",
  "E-AUTH-005": "RETIRED — doctor no longer probes actAs",
  "E-AUTH-006": "RETIRED — doctor no longer probes actAs",
  "E-AUTH-007": "RETIRED — doctor no longer probes actAs",
  "E-AUTH-008": "RETIRED — doctor no longer probes actAs",
  "E-AUTH-009": "supabase() is wired but neither SUPABASE_JWT_SECRET nor SUPABASE_URL is set",
  "E-MCP-001": "RETIRED — doctor no longer fetches MCP discovery documents",
  "E-MCP-002": "RETIRED — doctor no longer fetches MCP discovery documents",
  "E-MCP-003": "RETIRED — doctor no longer fetches the MCP server card",
  "E-MCP-004": "server.json does not meet MCP registry discovery requirements",
  "E-MCP-005": "RETIRED — doctor no longer compares server.json against a live door",
  "E-MCP-006": "server.json is invalid JSON",
  "E-MCP-007": "the local MCP registry auth challenge is malformed",
  "E-MCP-008": "RETIRED — doctor no longer fetches the live registry auth challenge",
  "E-MCP-009": "the MCP door is wired but VENDO_BASE_URL is not set (discovery advertises the wrong origin)",
  "E-SCHED-001": "RETIRED — doctor no longer reads machines and schedules off a running app",
  "E-TURN-001": "RETIRED — doctor no longer runs a model turn",
  "E-TURN-002": "RETIRED — doctor no longer runs a model turn",
  "E-CLOUD-001": "VENDO_API_KEY is set but not usable",
  "E-TOOLS-001": "every extracted host tool is disabled or excluded (zero live host tools)",
  "E-TOOLS-002": "the extracted tool surface is empty (zero host tools)",
  "E-TOOLS-003": "part of the tool catalog is ungraded (nobody has graded it, so it asks on every call)",
  "E-TOOLS-004": "part of the tool catalog declares no request/response shape (the agent must pass whole outputs through / cannot know the arguments)",
  "E-TOOLS-005": "some extracted host tools are off, so the agent will never offer them (an audience grade or an explicit disable took them)",
} as const;

export type DoctorErrorCode = keyof typeof DOCTOR_ERROR_CODES;

/** Complete list of every code doctor can emit, for CI enumeration. */
export const doctorErrorCodes = Object.keys(DOCTOR_ERROR_CODES) as readonly DoctorErrorCode[];

/** The verify playbook page the fix_ref URLs anchor into. The docs host
    serves it directly — the marketing-site path 302s there, and some agent
    HTTP clients refuse the hop (FINDINGS F7a). */
export const VERIFY_URL = "https://docs.vendo.run/agents/verify";

/** Full fix URL for a code: the installed vendoai version rides as a query
 *  param BEFORE the fragment so the URL stays valid and the verify page can
 *  version-match its guidance. */
export function doctorFixRef(code: DoctorErrorCode, version: string = CLI_VERSION): string {
  return `${VERIFY_URL}?v=${encodeURIComponent(version)}#${code}`;
}
