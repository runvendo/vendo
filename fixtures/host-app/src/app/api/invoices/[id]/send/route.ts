import { notFoundResponse, unauthenticatedResponse } from "../../../../../lib/api-response";
import { sendInvoice } from "../../../../../lib/db";
import { requireSession } from "../../../../../lib/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  const { id } = await context.params;
  const invoice = sendInvoice(id);
  return invoice ? Response.json({ invoice }) : notFoundResponse("invoice");
}
