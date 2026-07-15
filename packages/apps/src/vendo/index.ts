import { VendoError, type VendoErrorCode } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

const DEFAULT_BASE_URL = "https://console.vendo.run";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface VendoSandboxOptions {
  /** Vendo API key. When omitted, VENDO_API_KEY is used. */
  apiKey?: string;
  /** Broker base URL override for tests and self-hosted brokers. */
  baseUrl?: string;
  /** Default control-plane and command timeout, in milliseconds. */
  timeoutMs?: number;
}

interface MachineRecord {
  id: string;
  url: string;
}

interface ErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    meter?: unknown;
  };
}

const textEncoder = new TextEncoder();

const toBytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? textEncoder.encode(value) : value.slice();

const toArrayBuffer = (value: Uint8Array | string): ArrayBuffer =>
  toBytes(value).buffer as ArrayBuffer;

const toBase64 = (value: Uint8Array | string): string =>
  Buffer.from(toBytes(value)).toString("base64");

const fromBase64 = (value: string): Uint8Array =>
  new Uint8Array(Buffer.from(value, "base64"));

const brokerErrorCodes: Readonly<Record<string, VendoErrorCode>> = {
  validation: "validation",
  unauthorized: "cloud-required",
  "cloud-required": "cloud-required",
  "not-found": "not-found",
  conflict: "conflict",
  "sandbox-unavailable": "sandbox-unavailable",
  unavailable: "sandbox-unavailable",
};

const statusErrorCodes: Readonly<Record<number, VendoErrorCode>> = {
  400: "validation",
  401: "cloud-required",
  402: "cloud-required",
  404: "not-found",
  409: "conflict",
  501: "sandbox-unavailable",
  503: "sandbox-unavailable",
};

const errorEnvelope = async (response: Response): Promise<{ code: string; message: string }> => {
  let parsed: ErrorEnvelope | undefined;
  try {
    parsed = JSON.parse(await response.text()) as ErrorEnvelope;
  } catch {
    parsed = undefined;
  }
  return {
    code: typeof parsed?.error?.code === "string" ? parsed.error.code : "unknown",
    message: typeof parsed?.error?.message === "string"
      ? parsed.error.message
      : response.statusText || `HTTP ${response.status}`,
  };
};

const throwBrokerError = async (response: Response): Promise<never> => {
  const error = await errorEnvelope(response);
  if (error.code === "quota-exhausted") {
    throw new VendoError("cloud-required", "quota exhausted: upgrade or wait for period reset");
  }
  const code = brokerErrorCodes[error.code] ?? statusErrorCodes[response.status];
  if (code !== undefined) throw new VendoError(code, error.message);
  throw Object.assign(new Error(error.message), { code: error.code });
};

const snapshotRef = (ref: string): string => {
  if (!ref.startsWith("vendo:") || ref.length === "vendo:".length) {
    throw new VendoError("validation", "Vendo snapshot references must start with vendo:");
  }
  return ref;
};

/** Adapt the hosted Vendo broker to the frozen provider-neutral sandbox seam. */
export const vendoSandbox = (options: VendoSandboxOptions = {}): SandboxAdapter => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiBaseUrl = `${baseUrl}/api/v1`;

  const brokerFetch = async (
    path: string,
    init: Omit<RequestInit, "headers" | "signal"> & { headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const apiKey = options.apiKey ?? globalThis.process?.env?.VENDO_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new VendoError("cloud-required", "Vendo Cloud requires VENDO_API_KEY");
    }
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) await throwBrokerError(response);
    return response;
  };

  const brokerJson = async <T>(
    path: string,
    init: Omit<RequestInit, "headers" | "signal"> & { headers?: Record<string, string> } = {},
  ): Promise<T> => {
    const response = await brokerFetch(path, init);
    return response.json() as Promise<T>;
  };

  const wrap = ({ id, url }: MachineRecord): SandboxMachine => {
    const machinePath = `/sandboxes/${encodeURIComponent(id)}`;
    const jsonPost = <T>(path: string, body?: unknown): Promise<T> => brokerJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return {
      id,
      async exec(cmd, execOptions) {
        return jsonPost(`${machinePath}/exec`, {
          cmd,
          ...(execOptions?.cwd === undefined ? {} : { cwd: execOptions.cwd }),
          timeout_ms: execOptions?.timeoutMs ?? timeoutMs,
        });
      },
      files: {
        async read(path) {
          const params = new URLSearchParams({ path });
          const response = await brokerFetch(`${machinePath}/files?${params}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        async write(path, bytes) {
          const params = new URLSearchParams({ path });
          await brokerFetch(`${machinePath}/files?${params}`, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: toArrayBuffer(bytes),
          });
        },
        async list(dir) {
          const params = new URLSearchParams({ dir });
          const result = await brokerJson<{ entries: string[] }>(`${machinePath}/files/list?${params}`);
          return result.entries;
        },
      },
      async request(request) {
        const result = await jsonPost<{
          status: number;
          headers: Record<string, string>;
          body_b64: string;
        }>(`${machinePath}/request`, {
          method: request.method,
          path: request.path,
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          ...(request.body === undefined ? {} : { body_b64: toBase64(request.body) }),
        });
        return {
          status: result.status,
          headers: result.headers,
          body: fromBase64(result.body_b64),
        };
      },
      async snapshot() {
        return (await jsonPost<{ ref: string }>(`${machinePath}/snapshot`)).ref;
      },
      async screenshot() {
        const response = await brokerFetch(`${machinePath}/screenshot`);
        return new Uint8Array(await response.arrayBuffer());
      },
      async url(_port) {
        return url;
      },
      async stop() {
        await brokerFetch(machinePath, { method: "DELETE" });
      },
    };
  };

  return {
    async create(spec) {
      const files = spec.files === undefined
        ? undefined
        : Object.fromEntries(Object.entries(spec.files).map(([path, value]) => [path, toBase64(value)]));
      return wrap(await brokerJson<MachineRecord>("/sandboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          env: spec.env,
          ...(files === undefined ? {} : { files }),
          ...(spec.egress === undefined ? {} : { egress: spec.egress }),
        }),
      }));
    },
    async resume(ref) {
      return wrap(await brokerJson<MachineRecord>("/sandboxes/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: snapshotRef(ref) }),
      }));
    },
  };
};
