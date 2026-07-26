import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";
import { publicVendoRequest } from "@/vendo/request";
import { scriptedThreadsResponse } from "@/demo-script/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = nextVendoHandler(vendo);

export const GET = (request: Request) => handler.GET(publicVendoRequest(request));
export const POST = async (request: Request) => {
  // Scripted sales demo: a chat turn whose user text exactly matches one of
  // the scenario cards streams a canned (but real-plumbing) turn instead of
  // invoking the model; everything else passes through untouched.
  const scripted = await scriptedThreadsResponse(request);
  if (scripted !== null) return scripted;
  return handler.POST(publicVendoRequest(request));
};
export const PUT = (request: Request) => handler.PUT(publicVendoRequest(request));
export const PATCH = (request: Request) => handler.PATCH(publicVendoRequest(request));
export const DELETE = (request: Request) => handler.DELETE(publicVendoRequest(request));
