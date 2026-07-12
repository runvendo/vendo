import { listCustomers } from "@fixture/lib/db";
import { unauthenticatedResponse } from "../../../lib/api-response";
import { requireSession } from "../../../lib/session";

export function GET(req: Request): Response {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  return Response.json({ customers: listCustomers() });
}
