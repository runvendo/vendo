import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { isPlainObject as isRecord } from "@vendoai/core";
import serverSchema from "./server.schema.json" with { type: "json" };

export const SERVER_SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validatePinnedSchema = ajv.compile(serverSchema);

function schemaError(error: ErrorObject): string {
  const path = error.instancePath.length > 0 ? error.instancePath : "/";
  return `${path} ${error.message ?? "is invalid"}`;
}

export function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, "");
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (domain.length > 253 || !new RegExp(`^(?:${label}\\.)+${label}$`).test(domain)) {
    throw new Error(`Invalid registry domain: ${input}`);
  }
  return domain;
}

export function registryNamespace(domain: string): string {
  return normalizeDomain(domain).split(".").reverse().join(".");
}

export function registryDomain(name: string): string | null {
  const parts = name.split("/");
  if (parts.length !== 2 || parts[0] === undefined || parts[0].length === 0) return null;
  const domain = parts[0].split(".").reverse().join(".").toLowerCase();
  try {
    return normalizeDomain(domain);
  } catch {
    return null;
  }
}

export function packageSlug(name: string): string {
  const unscoped = name.split("/").at(-1) ?? name;
  const slug = unscoped.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return slug.length > 0 ? slug : "vendo";
}

function urlHost(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

export function hostMatchesDomain(host: string, domain: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  const normalizedDomain = normalizeDomain(domain);
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

export function remoteUrls(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.remotes)) return [];
  return value.remotes.flatMap((remote) => {
    if (!isRecord(remote) || remote.type !== "streamable-http" || typeof remote.url !== "string") return [];
    return [remote.url];
  });
}

/** 10-mcp §5 — validate with the vendored registry schema, then enforce the
 * registry's domain-namespace rule that JSON Schema cannot express. */
export function validateRegistryServer(value: unknown): string[] {
  const errors: string[] = [];
  if (!validatePinnedSchema(value)) errors.push(...(validatePinnedSchema.errors ?? []).map(schemaError));
  if (!isRecord(value)) return errors;

  if (value.$schema !== undefined && value.$schema !== SERVER_SCHEMA_URL) {
    errors.push(`/$schema must be ${SERVER_SCHEMA_URL}`);
  }
  const packages = Array.isArray(value.packages) ? value.packages : [];
  const remotes = Array.isArray(value.remotes) ? value.remotes : [];
  if (packages.length === 0 && remotes.length === 0) {
    errors.push("/ must include at least one package or remote");
  }

  if (typeof value.name !== "string") return errors;
  const domain = registryDomain(value.name);
  if (domain === null) {
    errors.push("/name must use a reversible domain namespace");
    return errors;
  }
  for (const remote of remotes) {
    if (!isRecord(remote) || typeof remote.url !== "string") continue;
    const host = urlHost(remote.url);
    if (host === null) continue;
    if (!hostMatchesDomain(host, domain)) {
      errors.push(`/remotes remote URL must use ${domain} or one of its subdomains`);
    }
  }
  return errors;
}

export function sameUrl(left: string, right: string): boolean {
  try {
    const normalize = (value: string): string => {
      const url = new URL(value);
      url.hash = "";
      if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
      return url.href;
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}
