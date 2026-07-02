import { listDeadlineEntries } from "@/server/clients"
import { ok } from "@/server/http"

export async function GET() {
  return ok(listDeadlineEntries())
}
