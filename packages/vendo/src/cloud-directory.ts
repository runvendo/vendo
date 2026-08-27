import {
  consoleSender,
  defaultFetch,
  log,
  raiseCloudError,
  tenantDirectoryPayloadSchema,
  type Membership,
  type Principal,
  type TenantDirectoryPayload,
} from "@vendoai/core";

/** The hosted tenant directory — the implementation the composition seam
 * (createVendo) puts in the `memberships` slot when VENDO_API_KEY fills a slot
 * the host left unset (adapter rule — see selectConnections in
 * compose-selection.ts; the seam itself never reads the environment). Rides the
 * shared console-client plumbing (cloud-console.ts): Bearer auth + deployment
 * identity + a per-request abort timeout. */

export interface CloudDirectoryOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CONSOLE_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request abort budget. Short, because this is on the REQUEST HOT PATH —
   *  every turn awaits it inside context resolution. */
  timeoutMs?: number;
  /** How long one subject's answer is reused. `door.ts`'s KEY_TTL_MS posture. */
  ttlMs?: number;
}

export interface CloudDirectory {
  /** The whole answer for one person; memoised per subject for ttlMs. */
  entry(principal: Principal): Promise<TenantDirectoryPayload>;
  /** The `memberships` seam, ready to hand to compose-config. */
  memberships: (principal: Principal) => Promise<Membership[]>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_MS = 60_000;
const CONSOLE_USERS_PATH = "/api/v1/users";
const NOTHING: TenantDirectoryPayload = { memberships: [], limits: {} };

export function cloudDirectory(options: CloudDirectoryOptions): CloudDirectory {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const send = consoleSender({
    base,
    mountPath: CONSOLE_USERS_PATH,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? defaultFetch,
    raise: (response) => raiseCloudError(response, "tenants", (code, message) => {
      throw Object.assign(new Error(message), { code: code ?? "unavailable" });
    }),
  });
  const cache = new Map<string, { at: number; payload: TenantDirectoryPayload }>();

  const entry = async (principal: Principal): Promise<TenantDirectoryPayload> => {
    const cached = cache.get(principal.subject);
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.payload;
    let payload: TenantDirectoryPayload;
    try {
      const response = await send(`/${encodeURIComponent(principal.subject)}/memberships`);
      payload = tenantDirectoryPayloadSchema.parse(await response.json());
    } catch (error) {
      // THE fail mode, and it is the opposite of the limiter's. This is awaited
      // inside per-request context resolution (wire/context.ts), so a throw
      // here is a 500 for the WHOLE turn: Cloud being down must not take the
      // host's product down. Stated plainly — during an outage a tenant cap is
      // not enforced and tenant-shared apps are briefly invisible.
      log({
        code: "vendo.tenant_directory_unavailable",
        level: "warn",
        message: `[vendo] the tenant directory did not answer for ${principal.subject}; `
          + `${cached === undefined ? "resolving to no memberships" : "serving the last answer"} for this request:`,
        data: { error },
      });
      return cached?.payload ?? NOTHING;
    }
    cache.set(principal.subject, { at: Date.now(), payload });
    return payload;
  };

  return { entry, memberships: async (principal) => (await entry(principal)).memberships };
}
