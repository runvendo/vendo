import { unauthenticatedResponse } from "../../../../lib/api-response";
import { requireSession } from "../../../../lib/session";

export function GET(req: Request): Response {
  return requireSession(req)
    ? Response.json({ vendo: true })
    : unauthenticatedResponse();
}

export function POST(req: Request): Response {
  return requireSession(req)
    ? Response.json({ vendo: true })
    : unauthenticatedResponse();
}
