import { listGoals } from "@/server/payments"
import { ok } from "@/server/http"

export async function GET() { return ok(listGoals()) }
