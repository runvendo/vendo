import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);
