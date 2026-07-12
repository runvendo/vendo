import { unauthenticatedResponse } from "../../../../lib/api-response";
import { listInvoices } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";

export function GET(req: Request): Response {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  return Response.json({ archive: listInvoices({ status: "paid" }) });
}
