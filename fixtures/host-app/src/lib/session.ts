export interface FixtureSession {
  userId: string;
}

export function requireSession(req: Request): FixtureSession | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [name, ...valueParts] = cookie.trim().split("=");
    if (name === "fixture_session") {
      const userId = valueParts.join("=");
      return userId ? { userId } : null;
    }
  }

  return null;
}
