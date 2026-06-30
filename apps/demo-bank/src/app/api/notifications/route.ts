import { listNotifications } from "@/server/notifications"
import { ok } from "@/server/http"

export async function GET() { return ok(listNotifications()) }
