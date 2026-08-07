// Test-only header mirror. Lives under /fixture (not /api) so the route scanner
// never emits it as a tool — it exists purely so e2e can assert which headers
// actually arrived on the outbound request (present forwarding vs away actAs).

function reflect(req: Request): Response {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const url = new URL(req.url);
  return Response.json({
    method: req.method,
    headers,
    query: Object.fromEntries(url.searchParams.entries()),
  });
}

export function GET(req: Request): Response {
  return reflect(req);
}

export function POST(req: Request): Response {
  return reflect(req);
}
