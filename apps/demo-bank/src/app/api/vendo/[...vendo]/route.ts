import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";
import { publicVendoRequest } from "@/vendo/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = nextVendoHandler(vendo);

export const GET = (request: Request) => handler.GET(publicVendoRequest(request));
export const POST = (request: Request) => handler.POST(publicVendoRequest(request));
export const DELETE = (request: Request) => handler.DELETE(publicVendoRequest(request));
