// --- vendo: touch 2 of 4 — the stock Vendo wire route (exactly what
// `vendo init` scaffolds). It serves apps, approvals, and theming to the
// embeds in the chat page; the Mastra loop never proxies any of it.
import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/lib/vendo";

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
