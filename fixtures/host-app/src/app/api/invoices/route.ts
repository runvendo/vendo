import { badRequestResponse, unauthenticatedResponse } from "../../../lib/api-response";
import { createInvoice, listInvoices } from "../../../lib/db";
import { requireSession } from "../../../lib/session";

export function GET(req: Request): Response {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  const url = new URL(req.url);
  return Response.json({
    invoices: listInvoices({
      status: url.searchParams.get("status") ?? undefined,
      customerId: url.searchParams.get("customerId") ?? undefined,
    }),
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse("customerId and amountCents are required");
  }

  const input =
    typeof body === "object" && body !== null
      ? (body as {
          customerId?: unknown;
          amountCents?: unknown;
          currency?: unknown;
          memo?: unknown;
        })
      : {};

  if (
    typeof input.customerId !== "string" ||
    !input.customerId ||
    typeof input.amountCents !== "number"
  ) {
    return badRequestResponse("customerId and amountCents are required");
  }
  if (input.currency !== undefined && input.currency !== "USD") {
    return badRequestResponse("currency must be USD");
  }
  if (input.memo !== undefined && typeof input.memo !== "string") {
    return badRequestResponse("memo must be a string");
  }

  const invoice = createInvoice({
    customerId: input.customerId,
    amountCents: input.amountCents,
    currency: input.currency as "USD" | undefined,
    memo: input.memo as string | undefined,
  });
  return Response.json({ invoice });
}
