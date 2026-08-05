// GET /api/demo/seed-status — durable status of the latest scripted-automation
// seed. The reset response answers within a bounded budget, so a contended
// seed can still be landing after reset already returned; the demo panel and
// the global reset shortcut poll THIS positive signal instead of trusting a
// timer to mean "the automations are back".
import { NextResponse } from "next/server"
import { demoSeedStatus } from "@/demo-script/seed"

export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json({ seedStatus: demoSeedStatus() })
}
