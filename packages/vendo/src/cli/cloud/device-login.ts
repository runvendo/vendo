import { option, positionals } from "./args.js";
import { isVendoKey, resolveCloudBaseUrl } from "./client.js";
import { cloudConsoleOutput, errorMessage, printJson } from "./output.js";
import { upsertEnvLocal } from "../cloud-init.js";
import { CLI_VERSION, type Output } from "../shared.js";

/**
 * `vendo cloud device-login` — the auth.md user-claimed flow end to end
 * (https://vendo.run/auth.md): open a claim on the console, show the human
 * the pairing code + approval URL, poll the RFC 8628 token endpoint, and
 * land the minted VENDO_API_KEY in .env.local — exactly where init's
 * --cloud-key flag and the interactive mint put it, so a re-run of
 * `vendo init` picks it up with no key ever pasted or printed.
 *
 * The token endpoint speaks RFC 8628 §3.5 (top-level `error` string), which
 * the console-envelope-shaped cloudFetch would flatten to http-400 — so this
 * command talks to both endpoints with a raw (injectable) fetch instead.
 */

const CLAIM_PATH = "/api/v1/agent/claim";
const TOKEN_PATH = "/api/v1/oauth/token";
const CLAIM_GRANT_TYPE = "urn:workos:agent-auth:grant-type:claim";

export interface DeviceLoginOptions {
  output?: Output;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Where .env.local lives (default: the current working directory). */
  root?: string;
  /** Injectable pacing seam — tests run the ceremony in microseconds. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Ceremony {
  claim_token: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

function ceremonyFrom(value: unknown): Ceremony {
  const body = value as Partial<Ceremony> | null;
  if (
    typeof body?.claim_token !== "string"
    || typeof body.user_code !== "string"
    || typeof body.verification_uri !== "string"
    || typeof body.expires_in !== "number"
    || typeof body.interval !== "number"
  ) {
    throw new Error("Vendo Cloud returned an invalid claim ceremony");
  }
  return body as Ceremony;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  contentType: string,
  body: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": contentType,
      "user-agent": `vendo-cli/${CLI_VERSION}`,
    },
    body,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

export async function runDeviceLogin(
  args: string[],
  options: DeviceLoginOptions = {},
): Promise<number> {
  const output = options.output ?? cloudConsoleOutput;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const base = resolveCloudBaseUrl({
    apiUrl: option(args, "--api-url"),
    env: options.env ?? process.env,
  });

  try {
    // Optional email hint — shown to the human on the approval page.
    const email = option(args, "--email") ?? positionals(args, ["--api-url", "--email"])[0];
    const claim = await postJson(
      fetchImpl,
      `${base}${CLAIM_PATH}`,
      "application/json",
      JSON.stringify(email === undefined ? {} : { login_hint: email }),
    );
    if (claim.status !== 200) {
      const envelope = claim.body as { error?: { message?: unknown } } | null;
      throw new Error(
        typeof envelope?.error?.message === "string"
          ? envelope.error.message
          : `Vendo Cloud could not open a claim (${claim.status})`,
      );
    }
    const ceremony = ceremonyFrom(claim.body);

    output.log("Vendo Cloud device login — ask your human to approve this request:");
    output.log(`  1. Open ${ceremony.verification_uri_complete ?? ceremony.verification_uri}`);
    output.log(`  2. Confirm the code: ${ceremony.user_code}`);
    output.log(`Waiting for approval (the code expires in ${Math.round(ceremony.expires_in / 60)} minutes)…`);

    const deadline = now() + ceremony.expires_in * 1000;
    let intervalMs = Math.max(ceremony.interval, 1) * 1000;
    const pollBody = new URLSearchParams({
      grant_type: CLAIM_GRANT_TYPE,
      claim_token: ceremony.claim_token,
    }).toString();

    while (now() < deadline) {
      await sleep(intervalMs);
      const poll = await postJson(
        fetchImpl,
        `${base}${TOKEN_PATH}`,
        "application/x-www-form-urlencoded",
        pollBody,
      );

      if (poll.status === 200) {
        const key = (poll.body as { access_token?: unknown } | null)?.access_token;
        if (typeof key !== "string" || !isVendoKey(key)) {
          throw new Error("Vendo Cloud returned an invalid credential");
        }
        const root = options.root ?? process.cwd();
        await upsertEnvLocal(root, "VENDO_API_KEY", key);
        // Never print the key itself — .env.local is the hand-off, last4 the receipt.
        output.log(`Approved — wrote VENDO_API_KEY (…${key.slice(-4)}) to .env.local.`);
        output.log("Re-run `vendo init` to finish wiring (it picks the key up from .env.local).");
        printJson(output, { deviceLogin: true, wroteEnvLocal: true, keyLast4: key.slice(-4) });
        return 0;
      }

      const error = (poll.body as { error?: unknown } | null)?.error;
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        intervalMs += 5000; // RFC 8628 §3.5
        continue;
      }
      if (error === "expired_token") {
        throw new Error("The code expired before it was approved; run `vendo cloud device-login` again.");
      }
      if (error === "access_denied") {
        throw new Error("Your human denied the request — no key was minted.");
      }
      const description = (poll.body as { error_description?: unknown } | null)?.error_description;
      throw new Error(
        typeof description === "string"
          ? description
          : `Vendo Cloud token polling failed (${typeof error === "string" ? error : poll.status})`,
      );
    }
    throw new Error("The code expired before it was approved; run `vendo cloud device-login` again.");
  } catch (error) {
    output.error(errorMessage(error));
    return 1;
  }
}
