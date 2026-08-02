// EXAMPLE ROUTE — part of the src/server fake-host-API pattern the creator
// replaces per prospect. Declared in openapi.json so `vendo sync .` exposes
// it to the agent as the host_listItems tool.
import { listItems } from "@/server/items"
import { ok } from "@/server/http"

export const dynamic = "force-dynamic"

export async function GET() { return ok(listItems()) }
