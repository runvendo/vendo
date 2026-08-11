import { listAccounts } from "@/server/accounts"
import { ok } from "@/server/http"

export async function GET() { return ok(listAccounts()) }
