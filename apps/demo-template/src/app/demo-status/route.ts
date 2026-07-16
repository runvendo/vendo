import { getCapsGuard } from "@/server/caps"

// ============================================================================
// PLUMBING — DO NOT MODIFY PER PROSPECT.
// Read-only caps status for the demo chrome's limit/expired card
// (src/components/demo-chrome.tsx polls GET /demo-status). Never consumes a
// turn. Always 200: body.vendoDemo is null while the demo is live, otherwise
// the same machine-readable `{ limit, message, ctaUrl }` the guarded agent
// route refuses with (429/410).
// Deliberately NOT under /api: `vendo sync` scans /api/* route handlers into
// .vendo/tools.json as agent-callable host tools, and this endpoint is chrome
// plumbing, not a tool.
// ============================================================================

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  const refusal = await getCapsGuard().peekRefusal()
  return Response.json({ vendoDemo: refusal === null ? null : refusal.body.vendoDemo })
}
