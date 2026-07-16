import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = nextVendoHandler(vendo);

export const GET = handler.GET;
export const POST = handler.POST;
export const DELETE = handler.DELETE;
