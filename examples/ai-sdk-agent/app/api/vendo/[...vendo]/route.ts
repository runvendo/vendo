// --- vendo: the stock wire route. It serves apps, approvals, and connected
// accounts to the embeds — Vendo minus the conversation.
import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/lib/vendo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
// --- /vendo
