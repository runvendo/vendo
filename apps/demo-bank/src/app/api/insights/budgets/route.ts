import { budgets } from "@/server/insights"
import { ok } from "@/server/http"

export async function GET() { return ok(budgets()) }
