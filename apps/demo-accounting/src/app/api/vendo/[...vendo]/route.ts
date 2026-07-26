import { nextVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";
import { chipThreadsResponse } from "@/vendo/chips-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = nextVendoHandler(vendo);

export const { GET, PUT, PATCH, DELETE } = handler;
export const POST = async (request: Request) => {
  // "Try this" chips (demo-hygiene): a chip prompt with a pre-generated app
  // attaches it instantly; a cache miss falls through to live generation.
  const chip = await chipThreadsResponse(request);
  if (chip !== null) return chip;
  return handler.POST(request);
};
