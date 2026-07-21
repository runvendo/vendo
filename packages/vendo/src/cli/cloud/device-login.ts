import { execFile } from "node:child_process";
import { join } from "node:path";
import { option, positionals } from "./args.js";
import { isVendoKey, resolveCloudBaseUrl } from "./client.js";
import { errorMessage, printJson } from "./output.js";
import { deletePendingClaim, readPendingClaim, writePendingClaim } from "./pending-claim.js";
import { upsertEnvLocal } from "../cloud-init.js";
import { browserOpenCommand } from "../playground.js";
import { CLI_VERSION, consoleOutput, withCommandRun, type Output, type TelemetryOptions } from "../shared.js";

/**
 * `vendo login` (alias: `vendo cloud device-login`) — the auth.md
 * user-claimed flow end to end (https://vendo.run/auth.md): open a claim on
 * the console, show the human the pairing code + approval URL (a TTY gets
 * the browser opened too), poll the RFC 8628 token endpoint, and land the
 * minted VENDO_API_KEY in .env.local — exactly where init's --cloud-key flag
 * and the interactive ceremony put it, so a re-run of `vendo init` picks it
 * up with no key ever pasted or printed.
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
  /** TTY seam — a watching human gets the browser opened for them; a non-TTY
      (agent) caller keeps the URL + code contract untouched. */
  isTty?: boolean;
  openBrowser?: (url: string) => void;
  /** init runs the ceremony inline and picks the key up in the same run —
      it suppresses the standalone "re-run `vendo init`" tail. */
  rerunHint?: boolean;
  /** Where ~/.vendo lives (default: the home directory) — the pending-claim
      file that lets a fresh run resume a still-open ceremony (#479). */
  home?: string;
}

function defaultOpenBrowser(url: string): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  execFile(command, args, () => undefined); // best-effort: the printed URL is the fallback
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

/**
 * `vendo login` — the top-level command surface: the identical ceremony
 * wrapped in one `command_run` row (command "login", TELEMETRY.md). The
 * ceremony's other two callers stay untracked here: `vendo cloud
 * device-login` (the alias) calls runDeviceLogin directly, and init's
 * embedded step already tracks itself as "cloud-init".
 */
export async function runLoginCommand(
  args: string[],
  options: DeviceLoginOptions & { telemetry?: TelemetryOptions } = {},
): Promise<number> {
  return withCommandRun(
    {
      command: "login",
      // Where the key lands is the project the ceremony is for.
      root: options.root ?? process.cwd(),
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    },
    () => runDeviceLogin(args, options),
  );
}

export async function runDeviceLogin(
  args: string[],
  options: DeviceLoginOptions = {},
): Promise<number> {
  const output = options.output ?? consoleOutput;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const base = resolveCloudBaseUrl({
    apiUrl: option(args, "--api-url"),
    env: options.env ?? process.env,
  });

  // `--wait <seconds>` (#479): the MAX wall-clock THIS invocation polls before
  // giving up resumably — independent of, and capped by, the claim deadline.
  // Absent: unchanged, block until the claim deadline (~10 min). `--wait 0`:
  // one immediate poll, then exit resumably if still pending. An invalid value
  // is ignored here (the `vendo login` entry validates it up front).
  const waitRaw = option(args, "--wait");
  const waitSeconds = waitRaw !== undefined && /^\d+$/.test(waitRaw) ? Number(waitRaw) : undefined;
  const waitMs = waitSeconds === undefined ? undefined : waitSeconds * 1000;

  const pendingHome = options.home === undefined ? {} : { home: options.home };

  try {
    // A still-open claim from a dead process (#479): resume polling it so the
    // human's late approval — against the code they were already shown —
    // still lands the key. An expired or unreadable file is discarded (a
    // fresh ceremony overwrites it below).
    const pending = await readPendingClaim(pendingHome);
    const resume = pending !== null && pending.api_url === base && pending.expires_at > now()
      ? pending
      : null;

    let claimToken: string;
    let deadline: number;
    let intervalMs: number;
    let root: string;
    let userCode: string;
    let verificationUriComplete: string;
    if (resume !== null) {
      output.log(`Resuming pending approval — code ${resume.user_code}, approve at ${resume.verification_uri_complete}`);
      output.log(`Waiting for approval (the code expires in ${Math.max(1, Math.round((resume.expires_at - now()) / 60_000))} minutes)…`);
      claimToken = resume.claim_token;
      deadline = resume.expires_at;
      intervalMs = Math.max(resume.interval, 1) * 1000;
      // The key lands where the ORIGINAL run intended, not where the resume runs.
      root = resume.cwd;
      userCode = resume.user_code;
      verificationUriComplete = resume.verification_uri_complete;
    } else {
      // Optional email hint — shown to the human on the approval page.
      const email = option(args, "--email") ?? positionals(args, ["--api-url", "--email", "--wait"])[0];
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

      const approvalUrl = ceremony.verification_uri_complete ?? ceremony.verification_uri;
      output.log("Vendo Cloud device login — ask your human to approve this request:");
      output.log(`  1. Open ${approvalUrl}`);
      output.log(`  2. Confirm the code: ${ceremony.user_code}`);
      const tty = options.isTty ?? (process.stdout.isTTY === true);
      if (tty) {
        output.log("Opening your browser… (approve there, then come back here)");
        (options.openBrowser ?? defaultOpenBrowser)(approvalUrl);
      }
      output.log(`Waiting for approval (the code expires in ${Math.round(ceremony.expires_in / 60)} minutes)…`);

      claimToken = ceremony.claim_token;
      deadline = now() + ceremony.expires_in * 1000;
      intervalMs = Math.max(ceremony.interval, 1) * 1000;
      root = options.root ?? process.cwd();
      userCode = ceremony.user_code;
      verificationUriComplete = approvalUrl;
      // Persist the ceremony so a fresh run can resume it if this process
      // dies mid-poll. Deleted on redemption/denial/expiry; deliberately left
      // in place on transient errors and interrupts.
      await writePendingClaim({
        claim_token: claimToken,
        user_code: ceremony.user_code,
        verification_uri_complete: approvalUrl,
        expires_at: deadline,
        interval: ceremony.interval,
        api_url: base,
        cwd: root,
      }, pendingHome);
    }

    const pollBody = new URLSearchParams({
      grant_type: CLAIM_GRANT_TYPE,
      claim_token: claimToken,
    }).toString();

    if (waitMs !== undefined) {
      output.log(`This call polls for up to ${waitSeconds}s — re-run \`vendo login\` to continue this same request.`);
    }

    // One RFC 8628 token poll. Returns the loop's next move; terminal outcomes
    // (approved/denied/expired) settle the pending file and return/throw here.
    type PollResult = "approved" | "pending" | "slow_down";
    const pollOnce = async (): Promise<PollResult> => {
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
        await upsertEnvLocal(root, "VENDO_API_KEY", key);
        await deletePendingClaim(pendingHome);
        // Never print the key itself — .env.local is the hand-off, last4 the
        // receipt. A resumed run names the full path: it may differ from cwd.
        output.log(`Approved — wrote VENDO_API_KEY (…${key.slice(-4)}) to ${
          resume !== null ? join(root, ".env.local") : ".env.local"}.`);
        if (options.rerunHint !== false) {
          output.log("Re-run `vendo init` to finish wiring (it picks the key up from .env.local).");
        }
        printJson(output, { deviceLogin: true, wroteEnvLocal: true, keyLast4: key.slice(-4) });
        return "approved";
      }

      const error = (poll.body as { error?: unknown } | null)?.error;
      if (error === "authorization_pending") return "pending";
      if (error === "slow_down") return "slow_down"; // RFC 8628 §3.5
      if (error === "expired_token") {
        await deletePendingClaim(pendingHome);
        throw new Error("The code expired before it was approved; run `vendo login` again.");
      }
      if (error === "access_denied") {
        await deletePendingClaim(pendingHome);
        throw new Error("Your human denied the request — no key was minted.");
      }
      const description = (poll.body as { error_description?: unknown } | null)?.error_description;
      throw new Error(
        typeof description === "string"
          ? description
          : `Vendo Cloud token polling failed (${typeof error === "string" ? error : poll.status})`,
      );
    };

    // Budget still pending: leave the claim file in place and exit 0 — pending
    // is not a failure. A re-run resumes this same claim (#479).
    const pendingExit = (): number => {
      output.log(`Still waiting on approval — code ${userCode}. Re-run \`vendo login\` to resume (it continues this same request).`);
      printJson(output, {
        deviceLogin: true,
        pending: true,
        userCode,
        verificationUriComplete,
      });
      return 0;
    };

    if (waitMs === undefined) {
      // No budget: block to the claim deadline — unchanged TTY behavior.
      while (now() < deadline) {
        await sleep(intervalMs);
        const result = await pollOnce();
        if (result === "approved") return 0;
        if (result === "slow_down") intervalMs += 5000;
      }
      await deletePendingClaim(pendingHome);
      throw new Error("The code expired before it was approved; run `vendo login` again.");
    }

    // Bounded budget: poll immediately, then pace by interval, stopping at
    // min(now+wait, deadline). `--wait 0` polls exactly once.
    const pollDeadline = Math.min(deadline, now() + waitMs);
    while (true) {
      const result = await pollOnce();
      if (result === "approved") return 0;
      if (result === "slow_down") intervalMs += 5000;
      if (now() >= deadline) {
        await deletePendingClaim(pendingHome);
        throw new Error("The code expired before it was approved; run `vendo login` again.");
      }
      if (now() >= pollDeadline) return pendingExit();
      // Cap the wait to the remaining budget so a small `--wait` (e.g. 1s
      // against the default 5s interval) exits within its bound instead of
      // sleeping a whole interval past it.
      await sleep(Math.min(intervalMs, pollDeadline - now()));
    }
  } catch (error) {
    output.error(errorMessage(error));
    return 1;
  }
}
