import { listCards } from "@/server/cards"
import { ok } from "@/server/http"

export async function GET() { return ok(listCards()) }
