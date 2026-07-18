import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import {
  isSessionExpired,
  readCloudSession,
  writeCloudSession,
  type CloudSession,
} from "./session.js";
import { CLI_VERSION } from "../shared.js";

const DEFAULT_CLOUD_URL = "https://console.vendo.run";

export function isVendoKey(key: string): boolean {
  return /^vnd_[0-9a-f]{40}$/.test(key);
}

export class CloudError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.status = status;
  }
}

export interface CloudUrlOptions {
  apiUrl?: string;
  env?: Record<string, string | undefined>;
}

export function resolveCloudBaseUrl(options: CloudUrlOptions = {}): string {
  const value = options.apiUrl ?? (options.env ?? process.env).VENDO_CLOUD_URL ?? DEFAULT_CLOUD_URL;
  return value.replace(/\/+$/, "");
}

export interface SessionStore {
  read(): Promise<CloudSession | null>;
  write(session: CloudSession): Promise<void>;
}

export interface CloudFetchOptions extends CloudUrlOptions {
  method?: string;
  body?: unknown;
  auth?: "user" | "key";
  apiKey?: string;
  accessToken?: string;
  fetchImpl?: typeof fetch;
  home?: string;
  sessionStore?: SessionStore;
  signal?: AbortSignal;
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown };
}

function requestUrl(path: string, options: CloudUrlOptions): string {
  const base = resolveCloudBaseUrl(options);
  const suffix = base.endsWith("/api/v1") && path.startsWith("/api/v1/")
    ? path.slice("/api/v1".length)
    : path;
  return `${base}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFrom(response: Response, body: unknown): CloudError {
  const envelope = body as ErrorEnvelope | null;
  const code = typeof envelope?.error?.code === "string" ? envelope.error.code : `http-${response.status}`;
  const message = typeof envelope?.error?.message === "string"
    ? envelope.error.message
    : `Vendo Cloud request failed (${response.status})`;
  return new CloudError(code, message, response.status);
}

function defaultSessionStore(home: string | undefined): SessionStore {
  return {
    read: () => readCloudSession({ home }),
    write: (session) => writeCloudSession(session, { home }),
  };
}

/** Non-Latin-1 or CR/LF header values make fetch throw "Cannot convert
 *  argument to a ByteString"; identity headers must never take a command
 *  down, so strip to printable ASCII and never send an empty value. */
function headerSafe(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]+/g, "").trim();
  return printable.length > 0 ? printable : "unknown";
}

/** The console's shared auth middleware upserts deployment inventory and
 *  meters usage from these headers on real service calls — there is no
 *  heartbeat. Name is the nearest project identity: the cwd package name,
 *  cached per directory (a process can chdir between calls). */
const deploymentNames = new Map<string, Promise<string>>();

function resolveDeploymentName(cwd: string): Promise<string> {
  let name = deploymentNames.get(cwd);
  if (name === undefined) {
    name = (async () => {
      try {
        const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { name?: unknown };
        if (typeof manifest.name === "string" && manifest.name.length > 0) return manifest.name;
      } catch {
        // no manifest — fall through to the directory name
      }
      return basename(cwd);
    })();
    deploymentNames.set(cwd, name);
  }
  return name;
}

function sessionFrom(value: unknown): CloudSession {
  if (typeof value !== "object" || value === null || typeof (value as Partial<CloudSession>).access_token !== "string") {
    throw new CloudError("invalid-session", "Vendo Cloud returned an invalid session", 500);
  }
  return value as CloudSession;
}

async function refreshUserSession(
  session: CloudSession,
  options: CloudFetchOptions,
  store: SessionStore,
): Promise<CloudSession> {
  if (!session.refresh_token) {
    throw new CloudError("session-expired", "Vendo Cloud session expired; run `vendo cloud login` again", 401);
  }
  const response = await (options.fetchImpl ?? fetch)(requestUrl("/api/v1/auth/refresh", options), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": `vendo-cli/${CLI_VERSION}`,
    },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  const body = await responseBody(response);
  if (!response.ok) throw errorFrom(response, body);
  const refreshed = sessionFrom(body);
  await store.write(refreshed);
  return refreshed;
}

async function send(
  path: string,
  options: CloudFetchOptions,
  token: string | undefined,
): Promise<{ response: Response; body: unknown }> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": `vendo-cli/${CLI_VERSION}`,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (options.auth === "key") {
    headers["x-vendo-deployment-host"] = headerSafe(hostname());
    headers["x-vendo-deployment-name"] = headerSafe(await resolveDeploymentName(process.cwd()));
  }
  const response = await (options.fetchImpl ?? fetch)(requestUrl(path, options), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  return { response, body: await responseBody(response) };
}

export async function cloudFetch<T = unknown>(path: string, options: CloudFetchOptions = {}): Promise<T> {
  let token: string | undefined;
  let session: CloudSession | null = null;
  const store = options.sessionStore ?? defaultSessionStore(options.home);

  if (options.auth === "key") {
    token = options.apiKey ?? (options.env ?? process.env).VENDO_API_KEY;
    if (!token) throw new CloudError("missing-api-key", "Pass --key or set VENDO_API_KEY", 0);
  } else if (options.auth === "user") {
    if (options.accessToken) {
      token = options.accessToken;
    } else {
      session = await store.read();
      if (!session) throw new CloudError("not-logged-in", "Run `vendo cloud login` first", 401);
      if (isSessionExpired(session)) session = await refreshUserSession(session, options, store);
      token = session.access_token;
    }
  }

  let result = await send(path, options, token);
  if (options.auth === "user" && !options.accessToken && result.response.status === 401 && session) {
    session = await refreshUserSession(session, options, store);
    result = await send(path, options, session.access_token);
  }
  if (!result.response.ok) throw errorFrom(result.response, result.body);
  return result.body as T;
}
