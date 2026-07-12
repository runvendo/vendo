import { unauthenticatedResponse } from "./api-response";
import { listInvoices } from "./db";
import { requireSession } from "./session";

export function GET(req: Request): Response {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  return Response.json({ report: { paidCount: listInvoices({ status: "paid" }).length } });
}
