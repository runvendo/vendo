export function unauthenticatedResponse(): Response {
  return Response.json(
    { error: { code: "unauthenticated", message: "sign in first" } },
    { status: 401 },
  );
}

export function notFoundResponse(resource: string): Response {
  return Response.json(
    { error: { code: "not-found", message: `${resource} not found` } },
    { status: 404 },
  );
}

export function badRequestResponse(message: string): Response {
  return Response.json(
    { error: { code: "bad-request", message } },
    { status: 400 },
  );
}
