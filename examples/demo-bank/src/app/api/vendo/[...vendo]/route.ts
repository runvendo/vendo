import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";
import { publicVendoRequest } from "@/vendo/request";
import { chipThreadsResponse } from "@/vendo/chips-response";
import { scriptedThreadsResponse } from "@/demo-script/engine";
import { harnessThreadsResponse } from "@/vendo/harness-proof";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = nextVendoHandler(vendo);

export const GET = (request: Request) => handler.GET(publicVendoRequest(request));
export const POST = async (request: Request) => {
  // Wave-1 live proof (MAPLE_HARNESS=1): the chat turn is served by the composed
  // harness runtime. FIRST, deliberately — the two canned seams below would fake
  // the very turn the proof exists to observe.
  const harnessTurn = await harnessThreadsResponse(request);
  if (harnessTurn !== null) return harnessTurn;
  // Scripted sales demo: a chat turn whose user text exactly matches one of
  // the scenario cards streams a canned (but real-plumbing) turn instead of
  // invoking the model; everything else passes through untouched.
  const scripted = await scriptedThreadsResponse(request);
  if (scripted !== null) return scripted;
  // "Try this" chips: a chip prompt with a pre-generated app attaches it
  // instantly; a cache miss falls through to normal live generation.
  const chip = await chipThreadsResponse(request);
  if (chip !== null) return chip;
  return handler.POST(publicVendoRequest(request));
};
export const PUT = (request: Request) => handler.PUT(publicVendoRequest(request));
export const PATCH = (request: Request) => handler.PATCH(publicVendoRequest(request));
export const DELETE = (request: Request) => handler.DELETE(publicVendoRequest(request));
