import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CloudSession {
  access_token: string;
  refresh_token?: string;
  /** Supabase-compatible Unix timestamp in seconds. */
  expires_at?: number;
}

export interface SessionOptions {
  home?: string;
}

function cloudSessionPath(options: SessionOptions = {}): string {
  return join(options.home ?? homedir(), ".vendo", "cloud-session.json");
}

function isCloudSession(value: unknown): value is CloudSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<CloudSession>;
  return typeof session.access_token === "string"
    && (session.refresh_token === undefined || typeof session.refresh_token === "string")
    && (session.expires_at === undefined || typeof session.expires_at === "number");
}

export async function readCloudSession(options: SessionOptions = {}): Promise<CloudSession | null> {
  try {
    const value: unknown = JSON.parse(await readFile(cloudSessionPath(options), "utf8"));
    if (!isCloudSession(value)) throw new Error("Invalid Vendo Cloud session file");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCloudSession(session: CloudSession, options: SessionOptions = {}): Promise<void> {
  const path = cloudSessionPath(options);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deleteCloudSession(options: SessionOptions = {}): Promise<void> {
  await rm(cloudSessionPath(options), { force: true });
}

export function isSessionExpired(session: CloudSession, now = Date.now()): boolean {
  if (session.expires_at === undefined) return false;
  return session.expires_at * 1_000 <= now + 30_000;
}
