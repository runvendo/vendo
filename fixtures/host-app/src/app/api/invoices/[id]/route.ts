import {
  badRequestResponse,
  notFoundResponse,
  unauthenticatedResponse,
} from "../../../../lib/api-response";
import {
  deleteInvoice,
  getInvoice,
  updateInvoice,
  type InvoiceStatus,
} from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  const { id } = await context.params;
  const invoice = getInvoice(id);
  return invoice ? Response.json({ invoice }) : notFoundResponse("invoice");
}

export async function PATCH(req: Request, context: RouteContext): Promise<Response> {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse("request body must be valid JSON");
  }

  const patch =
    typeof body === "object" && body !== null
      ? (body as { memo?: unknown; amountCents?: unknown; status?: unknown })
      : {};
  if (patch.memo !== undefined && typeof patch.memo !== "string") {
    return badRequestResponse("memo must be a string");
  }
  if (patch.amountCents !== undefined && typeof patch.amountCents !== "number") {
    return badRequestResponse("amountCents must be a number");
  }
  if (
    patch.status !== undefined &&
    patch.status !== "draft" &&
    patch.status !== "open" &&
    patch.status !== "paid"
  ) {
    return badRequestResponse("status must be draft, open, or paid");
  }

  const { id } = await context.params;
  const invoice = updateInvoice(id, {
    memo: patch.memo as string | undefined,
    amountCents: patch.amountCents as number | undefined,
    status: patch.status as InvoiceStatus | undefined,
  });
  return invoice ? Response.json({ invoice }) : notFoundResponse("invoice");
}

export async function DELETE(req: Request, context: RouteContext): Promise<Response> {
  if (!requireSession(req)) {
    return unauthenticatedResponse();
  }

  const { id } = await context.params;
  return deleteInvoice(id)
    ? Response.json({ ok: true })
    : notFoundResponse("invoice");
}
