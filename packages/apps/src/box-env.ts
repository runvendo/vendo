import { VendoError, type AppDocument, type SecretsProvider } from "@vendoai/core";

/** execution-v2 skin contract, env half — the ONE seam that assembles what
 * Vendo puts into the box at provision/wake. Lane B's lifecycle calls this
 * when it creates a machine; nothing else composes box env vars. Inside the
 * box is free country — these vars are the whole "in" side of the contract:
 *   - PORT: where the app must listen;
 *   - each GRANTED declared secret, by its own name, real value (the v2 box
 *     does its own allowlisted egress — no handles, no egress proxy);
 *   - VENDO_STORE_URL + VENDO_APP_TOKEN: durable rows over plain HTTP;
 *   - VENDO_HOST_URL + the same token: host tool calls through the guard;
 *   - VENDO_INFERENCE_URL/KEY: the in-box agent's model door (resolver seam;
 *     Cloud-gateway vs BYO value wiring rides model provisioning, Wave 3+). */

const DEFAULT_PORT = 8080;

/** The boundary vars the contract owns; a secret must never shadow one. */
const RESERVED_ENV = new Set([
  "PORT",
  "VENDO_STORE_URL",
  "VENDO_APP_TOKEN",
  "VENDO_HOST_URL",
  "VENDO_INFERENCE_URL",
  "VENDO_INFERENCE_KEY",
]);

/** Resolves the box inference endpoint; undefined = no inference in this box. */
export type InferenceResolver = () => Promise<{ url: string; key: string } | undefined>;

export interface BuildEnvContext {
  /** Secret names the owner granted to THIS app; only declared ∩ granted inject. */
  granted: ReadonlySet<string>;
  secrets?: SecretsProvider;
  /** Base URL for the durable-rows callback surface (the wire's /box mount). */
  storeUrl: string;
  /** Base URL for the host-tools callback surface (same mount in OSS). */
  hostUrl: string;
  /** The per-app bearer minted at provision (createAppTokens). */
  appToken: string;
  inference?: InferenceResolver;
  port?: number;
}

export interface BuiltBoxEnv {
  env: Record<string, string>;
  /** Names whose REAL values entered the box — the provisioner audits these. */
  injectedSecrets: string[];
}

export async function buildEnv(app: AppDocument, ctx: BuildEnvContext): Promise<BuiltBoxEnv> {
  if (ctx.port !== undefined && (!Number.isInteger(ctx.port) || ctx.port < 1 || ctx.port > 65_535)) {
    throw new VendoError("validation", "port must be an integer between 1 and 65535");
  }
  const env: Record<string, string> = {};
  const injectedSecrets: string[] = [];
  for (const name of new Set(app.secrets ?? [])) {
    if (RESERVED_ENV.has(name)) {
      throw new VendoError("validation", `secret name ${name} collides with a reserved box env var`);
    }
    if (!ctx.granted.has(name) || ctx.secrets === undefined) continue;
    const value = await ctx.secrets.get(name);
    if (value === undefined || value.length === 0) continue;
    env[name] = value;
    injectedSecrets.push(name);
  }
  env["PORT"] = String(ctx.port ?? DEFAULT_PORT);
  env["VENDO_STORE_URL"] = ctx.storeUrl;
  env["VENDO_APP_TOKEN"] = ctx.appToken;
  env["VENDO_HOST_URL"] = ctx.hostUrl;
  const inference = await ctx.inference?.();
  if (inference !== undefined) {
    env["VENDO_INFERENCE_URL"] = inference.url;
    env["VENDO_INFERENCE_KEY"] = inference.key;
  }
  return { env, injectedSecrets };
}
