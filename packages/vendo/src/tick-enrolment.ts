/**
 * The tick secret, and the enrolment that hands it to Vendo Cloud.
 *
 * Cloud's heartbeat is the only thing that wakes a hosted deployment, and it can
 * only knock on a door it knows the URL and the secret of. Nobody configures
 * either: the deployment derives the secret from the VENDO_API_KEY it already has
 * and publishes both at boot, exactly as the text channel registers its inbound
 * door (compose-channels.ts).
 */
import { base64url } from "@vendoai/automations";
import { consoleSender, defaultFetch, log, raiseCloudError } from "@vendoai/core";
import { environment } from "./wire/shared.js";

/** The label the tick secret is derived under. FROZEN: both ends key an HMAC on
 *  this derivation's output, so a change here 401s every enrolled deployment's
 *  next knock until it re-registers. Distinct from the text channel's label
 *  (INBOUND_SECRET_LABEL) so neither secret can ever be the other. */
const TICK_SECRET_LABEL = "vendo:automations:tick:v1";

/** Deterministic by construction — one HMAC of a frozen label under the Cloud
 *  key — because a deployment runs many replicas and every one of them enrols:
 *  two that derived different secrets would take turns breaking the other's
 *  knock. base64url, because Cloud keys its HMAC on this string's DECODED BYTES
 *  and the door's `verifySignature` decodes it the same way on the way back in.
 *  WebCrypto only (no node:crypto), like channelInboundSecret, so the module
 *  keeps bundling for edge/Worker targets. */
export async function deriveTickSecret(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(TICK_SECRET_LABEL));
  return base64url(new Uint8Array(derived));
}

/** THE secret, singular: what the firing door verifies against AND what
 *  enrolment publishes, so Cloud can never be told a secret the door refuses.
 *  `VENDO_TICK_SECRET` is the BYO override and wins outright (hard BYO rule — a
 *  deployment with no Cloud key keeps a working `/tick`); otherwise VENDO_API_KEY
 *  derives it. Undefined for a deployment that has neither, which is what makes
 *  the door refuse every knock. The door reads the key from the environment; the
 *  composition already resolved one (cloudKeyOptions) and passes THAT, so the two
 *  callers cannot end up deriving from different keys. */
export async function tickSecret(
  apiKey: string | undefined = environment("VENDO_API_KEY"),
): Promise<string | undefined> {
  const configured = environment("VENDO_TICK_SECRET");
  if (configured !== undefined) return configured;
  return apiKey === undefined ? undefined : await deriveTickSecret(apiKey);
}

/** Cloud's enrolment door. Idempotent on (project, host), so every boot of every
 *  replica calling it is the intended usage rather than something to guard. */
const REGISTER_PATH = "/api/v1/automations/deployments/register";
const DEFAULT_CONSOLE_URL = "https://console.vendo.run";
/** The other Cloud adapters' per-request budget (cloudTextChannel's). */
const TIMEOUT_MS = 30_000;

/** Loud, and never thrown: a console blip must not take the deployment down with
 *  it, but it must not pass for health either — an unenrolled deployment serves
 *  every request perfectly and never fires a single automation. */
const shout = (why: string): void => log({
  code: "vendo.tick-enrolment-failed",
  level: "error",
  message: `[vendo] this deployment could not enrol with Vendo Cloud, so its scheduled automations will not fire: ${why}`,
});

/**
 * Publish this deployment's firing door and the secret that will sign the knock.
 *
 * Silent in the three cases where there is nothing to publish and nothing wrong:
 * no Cloud key (nobody is going to knock), no automations mounted (a knock would
 * have nothing to fire), and a development process — which fires its own ticks
 * (compose-automations) behind a URL that is in no deployment inventory, so
 * enrolling it would register a wire Cloud cannot reach and then alarm about the
 * silence.
 */
export async function enrolForTicks(options: {
  cloud: { apiKey: string; baseUrl?: string } | undefined;
  automationsMounted: boolean;
  development: boolean;
  publicUrl: URL | undefined;
  /** Injection seam for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}): Promise<void> {
  const { cloud } = options;
  if (cloud === undefined || !options.automationsMounted || options.development) return;
  if (options.publicUrl === undefined) {
    shout("this deployment has no public URL for the heartbeat to knock on — set VENDO_BASE_URL to its "
      + "FULL public URL (path prefix included) and redeploy");
    return;
  }
  const secret = await tickSecret(cloud.apiKey);
  // Unreachable: the Cloud key that got us past the guard above is the
  // derivation's input, so the ladder cannot come back empty here.
  if (secret === undefined) return;
  const send = consoleSender({
    base: (cloud.baseUrl ?? DEFAULT_CONSOLE_URL).replace(/\/$/, ""),
    mountPath: "",
    apiKey: cloud.apiKey,
    timeoutMs: TIMEOUT_MS,
    fetchImpl: options.fetch ?? defaultFetch,
    raise: (response) => raiseCloudError(response, "automations", (code, message) => {
      throw Object.assign(new Error(message), { code: code ?? "unavailable" });
    }),
  });
  try {
    // Cloud appends /api/vendo/tick to what it stores, so the path prefix stays
    // and the trailing slash goes — the knock must never double the separator.
    await send(REGISTER_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: options.publicUrl.href.replace(/\/$/, ""), secret }),
    });
  } catch (error) {
    shout(error instanceof Error ? error.message : String(error));
  }
}
