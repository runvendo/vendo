import type { ActAs, Principal } from "@vendoai/vendo";

const SESSION_COOKIE = "maple_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOCAL_SESSION_SECRET = "maple-local-development-session-secret";

export interface MapleDemoUser {
  subject: string;
  display: string;
  email: string;
}

interface SessionPayload {
  subject: string;
  expiresAt: number;
}

function configuredUser(): (MapleDemoUser & { password: string }) | null {
  const production = process.env.NODE_ENV === "production";
  const password = process.env.MAPLE_DEMO_PASSWORD ?? (production ? undefined : "maple-demo");
  if (!password) return null;
  return {
    subject: "vendo-demo",
    display: "Yousef Helal",
    email: (process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com").trim().toLowerCase(),
    password,
  };
}

export function resolveMapleSubject(subject: string): MapleDemoUser | null {
  const user = configuredUser();
  return user && user.subject === subject
    ? { subject: user.subject, display: user.display, email: user.email }
    : null;
}

export function mapleDemoEmail(): string {
  return configuredUser()?.email ?? (process.env.MAPLE_DEMO_EMAIL ?? "yousef@maple.com");
}

function sessionSecret(): string {
  const configured = process.env.MAPLE_SESSION_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("MAPLE_SESSION_SECRET is required in production");
  }
  return LOCAL_SESSION_SECRET;
}

async function sessionKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): ArrayBuffer | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}

async function passwordMatches(actual: string, expected: string): Promise<boolean> {
  const key = await sessionKey();
  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(expected),
  );
  return crypto.subtle.verify("HMAC", key, expectedSignature, new TextEncoder().encode(actual));
}

export async function authenticateMapleUser(
  email: string,
  password: string,
): Promise<MapleDemoUser | null> {
  const user = configuredUser();
  if (!user) return null;
  const emailMatches = email.trim().toLowerCase() === user.email;
  const validPassword = await passwordMatches(password, user.password);
  return emailMatches && validPassword
    ? { subject: user.subject, display: user.display, email: user.email }
    : null;
}

async function issueSession(subject: string, now = Date.now()): Promise<string> {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    subject,
    expiresAt: now + SESSION_SECONDS * 1000,
  } satisfies SessionPayload)));
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(), new TextEncoder().encode(payload));
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifySession(value: string, now = Date.now()): Promise<SessionPayload | null> {
  const [payload, encodedSignature, extra] = value.split(".");
  if (!payload || !encodedSignature || extra !== undefined) return null;
  const signature = decodeBase64Url(encodedSignature);
  const decodedPayload = decodeBase64Url(payload);
  if (!signature || !decodedPayload) return null;
  if (!await crypto.subtle.verify(
    "HMAC",
    await sessionKey(),
    signature,
    new TextEncoder().encode(payload),
  )) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodedPayload)) as Partial<SessionPayload>;
    if (typeof parsed.subject !== "string" || typeof parsed.expiresAt !== "number") return null;
    if (parsed.expiresAt <= now) return null;
    return { subject: parsed.subject, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function publicOrigin(request: Request): URL {
  return new URL(process.env.VENDO_BASE_URL ?? request.url);
}

export function safeReturnTo(request: Request, candidate: string | null | undefined): string {
  if (!candidate) return "/";
  const base = publicOrigin(request);
  try {
    const target = new URL(candidate, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export function maplePublicUrl(request: Request, path: string): URL {
  return new URL(path, publicOrigin(request));
}

export async function createMapleSessionCookie(
  request: Request,
  user: MapleDemoUser,
): Promise<string> {
  const token = await issueSession(user.subject);
  const secure = publicOrigin(request).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

export async function resolveMapleSession(request: Request): Promise<MapleDemoUser | null> {
  const value = cookieValue(request, SESSION_COOKIE);
  if (!value) return null;
  const session = await verifySession(value);
  return session ? resolveMapleSubject(session.subject) : null;
}

export async function resolveMaplePrincipal(request: Request): Promise<Principal | null> {
  const user = await resolveMapleSession(request);
  return user ? { kind: "user", subject: user.subject, display: user.display } : null;
}

/** MCP host calls have no browser cookie. Re-mint the authenticated Maple
 * subject's signed session cookie over the existing ActAs seam. */
export const actAsMapleUser: ActAs = async (principal) => {
  const user = resolveMapleSubject(principal.subject);
  if (!user) return null;
  return { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(await issueSession(user.subject))}` } };
};
