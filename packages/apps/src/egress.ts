/** 06-apps §4.3 — request shape inspected by a sandbox egress adapter. */
export interface SandboxEgressRequest {
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** 06-apps §4.3 — opaque handle to secret-value map held outside app code. */
export type SecretHandleMap = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

const entries = (handleMap: SecretHandleMap): Array<[string, string]> =>
  handleMap instanceof Map ? [...handleMap.entries()] : Object.entries(handleMap);

const hostAllowed = (hostname: string, allowlist: readonly string[]): boolean => {
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith("*.")) {
      const suffix = allowed.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed;
  });
};

const substitute = (value: string, replacements: Array<[string, string]>): string => {
  if (replacements.length === 0) return value;
  const values = new Map(replacements);
  const pattern = replacements
    .map(([handle]) => handle)
    .sort((left, right) => right.length - left.length)
    .map((handle) => handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return value.replace(new RegExp(pattern, "g"), (handle) => values.get(handle) ?? handle);
};

/** 06-apps §4.3 — sandbox-side egress substitution after host allowlist matching. */
export const substituteSecretHandles = <T extends SandboxEgressRequest>(
  request: T,
  handleMap: SecretHandleMap,
  allowlist: readonly string[],
): T => {
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return request;
  }
  if (!hostAllowed(hostname, allowlist)) return request;
  const replacements = entries(handleMap);
  return {
    ...request,
    headers: request.headers === undefined
      ? undefined
      : Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, substitute(value, replacements)])),
    body: typeof request.body === "string" ? substitute(request.body, replacements) : request.body,
  };
};
