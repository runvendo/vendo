import { consoleSender, defaultFetch, raiseCloudError, type SecretsProvider } from "@vendoai/core";

/** The Cloud secrets provider — the implementation the composition seam
 * (selectSecrets in server.ts) chains BEHIND envSecrets when VENDO_API_KEY
 * fills the unset slot (adapter rule — see selectConnections in server.ts;
 * the provider itself never reads the environment). Rides the shared
 * console-client plumbing (cloud-console.ts): Bearer auth + deployment
 * identity + per-request abort timeout + the honest 401/402 → cloud-required
 * error table.
 *
 * Wire contract (the console endpoint is built in a sibling lane; the
 * fixtures in cloud-secrets.test.ts ARE the contract until it lands):
 *
 *   GET <console>/api/v1/secrets/<encodeURIComponent(name)>
 *     authorization: Bearer <key>   accept: application/json
 *     x-vendo-deployment-* identity headers (deployment-identity.ts)
 *
 *   200 { "value": "<string>" } → resolves the value
 *   404 (any body)              → resolves undefined — a missing secret is
 *                                 the SecretsProvider contract's "unset"
 *                                 (01-core §13), never an error
 *   401/402                     → VendoError("cloud-required") with the
 *                                 server's message (shared console table)
 *   anything else               → wire-legal envelope codes forward as
 *                                 VendoErrors; unknown codes, 5xx, and
 *                                 non-JSON bodies ride a plain Error — the
 *                                 SERVICE misbehaving, never the caller's
 *                                 fault (hosted-store's posture). */

export interface CloudSecretsOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CONSOLE_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request abort budget (default 30s, hosted-store's). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The console mounts the secrets surface here. */
const CONSOLE_SECRETS_PATH = "/api/v1/secrets";

/** Module-private 404 signal: intercepted BEFORE the shared error table so a
 * missing secret resolves undefined instead of raising the console's
 * not-found envelope as a VendoError. */
class SecretMissing extends Error {}

const raiseSecretsError = (response: Response): Promise<never> => {
  if (response.status === 404) throw new SecretMissing();
  return raiseCloudError(response, "secrets", (code, message) => {
    throw Object.assign(new Error(message), { code: code ?? "unavailable" });
  });
};

export function cloudSecrets(options: CloudSecretsOptions): SecretsProvider {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const send = consoleSender({
    base,
    mountPath: CONSOLE_SECRETS_PATH,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? defaultFetch,
    raise: raiseSecretsError,
  });

  return {
    async get(name) {
      let response: Response;
      try {
        response = await send(`/${encodeURIComponent(name)}`);
      } catch (error) {
        if (error instanceof SecretMissing) return undefined;
        throw error;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // hosted-store's malformed-200 posture: a 2xx that isn't JSON means a
        // misdeployed Cloud base — the SERVICE misbehaving, never the caller's
        // fault, so this is a plain Error (not a wire-legal "validation" code).
        throw new Error(
          `Vendo Cloud secrets returned a non-JSON ${response.status} response — check VENDO_CONSOLE_URL`,
        );
      }
      const value = (payload as { value?: unknown } | null)?.value;
      if (typeof value !== "string") {
        // A 2xx without the envelope must fail loudly — resolving undefined
        // here would be indistinguishable from a genuinely unset secret.
        throw new Error("Vendo Cloud secrets returned an invalid response (no string value)");
      }
      return value;
    },
  };
}

/** First-hit-wins provider chaining for the secrets seam (selectSecrets in
 * server.ts): a defined, NON-EMPTY value from an earlier provider wins — so
 * process env stays authoritative over Cloud for any name the operator ships
 * locally (the hard BYO rule) — and a provider failure PROPAGATES rather than
 * being swallowed: redaction already tolerates provider failures at its own
 * layer, and masking a broken Cloud standing here would read as "secret
 * unset" forever. */
export function chainSecrets(...providers: SecretsProvider[]): SecretsProvider {
  return {
    async get(name) {
      for (const provider of providers) {
        const value = await provider.get(name);
        if (value !== undefined && value !== "") return value;
      }
      return undefined;
    },
  };
}
