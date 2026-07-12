export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: { code: "bad-request", message: "user is required" } },
      { status: 400 },
    );
  }

  const user =
    typeof body === "object" && body !== null && "user" in body
      ? (body as { user?: unknown }).user
      : undefined;
  if (typeof user !== "string" || !user) {
    return Response.json(
      { error: { code: "bad-request", message: "user is required" } },
      { status: 400 },
    );
  }

  return Response.json(
    { ok: true, user },
    { headers: { "Set-Cookie": `fixture_session=${user}; Path=/; HttpOnly` } },
  );
}
