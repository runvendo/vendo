import { execFile } from "node:child_process";
import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { option } from "./args.js";
import { isVendoKey, resolveCloudBaseUrl } from "./client.js";
import { errorMessage, printJson } from "./output.js";
import { deletePendingClaim, readPendingClaim, writePendingClaim, type PendingClaim } from "./pending-claim.js";
import { writeCloudSession, type CloudSession } from "./session.js";
import { ensureEnvLocalIgnored, upsertEnvLocal } from "../cloud-init.js";
import { browserOpenCommand, CLI_VERSION, consoleOutput, withCommandRun, type Output, type TelemetryOptions } from "../shared.js";

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

/** How long the ceremony may run before it explains itself (see noteStall). */
const STALL_MS = 20_000;

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
  /** TTY seam — a watching human gets the browser opened for them. What the
      ceremony PRINTS is `pretty`'s call, not this one: the numbered URL + code
      contract holds on every non-pretty path, TTY or not. */
  isTty?: boolean;
  openBrowser?: (url: string) => void;
  /** init runs the ceremony inline and picks the key up in the same run —
      it suppresses the standalone "re-run `vendo init`" tail. */
  rerunHint?: boolean;
  /**
   * The pretty renderer is driving this ceremony, so a human is reading a rail
   * and the machine-readable receipt below is noise sitting under the three
   * lines of state. Suppressed there — and, `isTty` above, on any terminal a
   * human is watching: nothing parses a TTY, and standalone `vendo login`
   * printed that JSON block at a human who read it as a crash. `--agent`,
   * piped, non-TTY and CI runs keep it byte for byte.
   *
   * Passed explicitly rather than inferred. `usePrettyOutput()` answers "is
   * this terminal colour-capable", which is a different question — standalone
   * `vendo login` in the same terminal has no renderer and must keep its
   * receipt — and inferring it from `rerunHint` would give that flag a second
   * meaning for the next reader to break silently.
   */
  pretty?: boolean;
  /** Where ~/.vendo lives (default: the home directory) — the pending-claim
      file that lets a fresh run resume a still-open ceremony (#479). */
  home?: string;
}

function defaultOpenBrowser(url: string): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  execFile(command, args, () => undefined); // best-effort: the printed URL is the fallback
}

/**
 * Write-preflight (0.4.1 E2E cert M4): prove `.env.local` is writable BEFORE
 * any claim is opened or redeemed. Sandboxed agent runs — headless Claude
 * Code protects env files even under --dangerously-skip-permissions — can
 * deny the write; without this check the ceremony redeems the single-use
 * claim, the key mints server-side, and the write failure loses it. A real
 * append-mode open is the probe (permission checks like `access(W_OK)` don't
 * see sandbox policies, which deny at open time); a probe-created empty file
 * is removed again. Returns the failure detail, or null when writable.
 */
export async function preflightEnvLocalWrite(root: string): Promise<string | null> {
  const path = join(root, ".env.local");
  const existedBefore = await stat(path).then(() => true, () => false);
  try {
    const handle = await open(path, "a");
    await handle.close();
    if (!existedBefore) await unlink(path).catch(() => undefined);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * A dead claim was still on disk when a fresh ceremony opened, so whoever the
 * last code was relayed to may still be holding it. Say the old code is gone
 * before the new one prints: the published flow has the agent hand its code to
 * a human through a chat relay, and a silently replaced code reaches that human
 * as a bare "no open request matches that code" on the approval page.
 */
function noteStaleCode(pending: PendingClaim | null, now: number, output: Output): void {
  if (pending === null || pending.expires_at > now) return;
  output.log(`The earlier code ${pending.user_code} has expired and no longer works. Here is a new one.`);
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

/**
 * Unified auth: the device-claim (`oauth/token`) response may carry the
 * account-level Supabase session ALONGSIDE the minted project key. The key is
 * the top-level `access_token` (a `vnd_` string), so the session — whose own
 * `access_token` is a Supabase JWT — arrives nested under `session` to avoid
 * the name collision. Returns it only when well-formed (a string
 * `access_token`); anything else (older console, absent, malformed) → null, so
 * the caller stays key-only with no session file and no crash.
 */
function accountSessionFrom(body: unknown): CloudSession | null {
  const session = (body as { session?: unknown } | null)?.session;
  if (typeof session !== "object" || session === null) return null;
  const candidate = session as Partial<CloudSession>;
  if (typeof candidate.access_token !== "string") return null;
  if (candidate.refresh_token !== undefined && typeof candidate.refresh_token !== "string") return null;
  if (candidate.expires_at !== undefined && typeof candidate.expires_at !== "number") return null;
  return candidate as CloudSession;
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
  const tty = options.isTty ?? (process.stdout.isTTY === true);
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
  const claimCwd = options.root ?? process.cwd();

  // Prove the key's landing file is writable BEFORE the ceremony touches the
  // network: a claim is single-use, so a post-approval write failure loses
  // the minted key (M4). This is a WRITE failure, distinct from a timeout —
  // the error says so instead of the generic polling copy.
  const writeProblem = await preflightEnvLocalWrite(claimCwd);
  if (writeProblem !== null) {
    output.error(
      `Cannot write ${join(claimCwd, ".env.local")} (${writeProblem}). ` +
      "`vendo login` lands the minted key there, so the ceremony was NOT started and no key was minted. " +
      "This is a file-write problem, not a timeout: fix write access (sandboxed agent runs often deny env-file " +
      "writes — re-run outside the sandbox or have your human run `vendo login`), then re-run.",
    );
    return 1;
  }

  try {
    // A still-open claim from a dead process (#479): resume polling it so the
    // human's late approval — against the code they were already shown —
    // still lands the key. Claims are scoped per project directory (0.4.2):
    // only THIS cwd's ceremony is ever resumed, so concurrent logins in other
    // repos neither clobber this one nor get resumed by it. An expired or
    // unreadable file is discarded (a fresh ceremony overwrites it below).
    const pending = await readPendingClaim(claimCwd, pendingHome);
    const resume = pending !== null && pending.api_url === base && pending.cwd === claimCwd && pending.expires_at > now()
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
      if (options.pretty !== true) {
        output.log(`Waiting for approval (the code expires in ${Math.max(1, Math.round((resume.expires_at - now()) / 60_000))} minutes)…`);
      }
      claimToken = resume.claim_token;
      deadline = resume.expires_at;
      intervalMs = Math.max(resume.interval, 1) * 1000;
      // The key lands where the ORIGINAL run intended, not where the resume runs.
      root = resume.cwd;
      userCode = resume.user_code;
      verificationUriComplete = resume.verification_uri_complete;
    } else {
      // No identity hint by design: the human signs in as whoever they choose
      // on the approval page. A guessed login_hint (git email, positional arg)
      // is an assumption that mis-attributes the claim, so the ceremony never
      // sends one.
      const claim = await postJson(
        fetchImpl,
        `${base}${CLAIM_PATH}`,
        "application/json",
        "{}",
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
      noteStaleCode(pending, now(), output);
      if (options.pretty === true) {
        if (tty) {
          // One line, no numbered list — but it NAMES the URL: opening the
          // browser is best-effort, and on a headless or remote box nothing
          // comes up, leaving a code with nowhere to type it.
          output.log(`Opening your browser — approve the code ${ceremony.user_code} at ${approvalUrl}`);
          (options.openBrowser ?? defaultOpenBrowser)(approvalUrl);
        } else {
          output.log(`Vendo Cloud device login — approve the code ${ceremony.user_code} at ${approvalUrl}`);
        }
      } else {
        // Everything else — piped, --agent, CI, standalone `vendo login` —
        // keeps the numbered ceremony byte for byte. Something parses each of
        // those, so the collapse above is the rail's alone.
        output.log("Vendo Cloud device login — ask your human to approve this request:");
        output.log(`  1. Open ${approvalUrl}`);
        output.log(`  2. Confirm the code: ${ceremony.user_code}`);
        if (tty) {
          output.log("Opening your browser… (approve there, then come back here)");
          (options.openBrowser ?? defaultOpenBrowser)(approvalUrl);
        }
        output.log(`Waiting for approval (the code expires in ${Math.round(ceremony.expires_in / 60)} minutes)…`);
      }

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

    // Pretty only, and the other half of the collapse above: the rail states
    // the expiry when it becomes relevant — once, after the ceremony has
    // visibly stalled — instead of leading with it, carrying the URL as the
    // recovery path the collapsed line no longer prints up top. Every other
    // path already printed the expiry up front, exactly as it always did.
    const ceremonyStarted = now();
    let stallNoted = false;
    const noteStall = (): void => {
      if (options.pretty !== true || stallNoted || now() - ceremonyStarted < STALL_MS) return;
      stallNoted = true;
      output.log(
        `Still waiting — the code expires in ${Math.max(1, Math.round((deadline - now()) / 60_000))} minutes. `
        + `Approve at ${verificationUriComplete}`,
      );
    };

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
        try {
          await upsertEnvLocal(root, "VENDO_API_KEY", key);
        } catch (writeError) {
          // The claim is consumed and the key minted — a resume can never
          // succeed, so the pending file goes; and this must read as a WRITE
          // failure, never the timeout/polling copy (M4). The key is never
          // printed, so the minted key is unrecoverable here: name the
          // console cleanup explicitly.
          await deletePendingClaim(claimCwd, pendingHome);
          throw new Error(
            `Approved and the key was minted, but writing it to ${join(root, ".env.local")} failed ` +
            `(${writeError instanceof Error ? writeError.message : String(writeError)}). ` +
            "The key was NOT saved and is not shown anywhere: revoke it in the console (Keys page), " +
            "fix write access to .env.local, and run `vendo login` again.",
          );
        }
        await deletePendingClaim(claimCwd, pendingHome);
        // Unified auth: one login establishes the account-level session too.
        // When the claim response carries a Supabase session alongside the key,
        // persist it so account-level `cloud` subcommands work immediately with
        // no second ceremony (older consoles omit it — key-only). Best-effort:
        // the key is the primary credential and is already saved, so a
        // session-write failure must never turn a successful login into a fault.
        const session = accountSessionFrom(poll.body);
        if (session !== null) {
          try {
            await writeCloudSession(session, pendingHome);
          } catch {
            // A session-write failure must not strand a successful key login.
          }
        }
        // Never print the key itself — .env.local is the hand-off, last4 the
        // receipt. A resumed run names the full path: it may differ from cwd.
        // Same split as the ceremony above: the rail's phrasing is the rail's,
        // and every non-pretty path keeps the pinned piped wording byte for byte.
        const envLocalPath = resume !== null ? join(root, ".env.local") : ".env.local";
        output.log(options.pretty === true
          ? `Approved — VENDO_API_KEY saved to ${envLocalPath} (…${key.slice(-4)})`
          : `Approved — wrote VENDO_API_KEY (…${key.slice(-4)}) to ${envLocalPath}.`);
        await ensureEnvLocalIgnored(root, output);
        if (options.rerunHint !== false) {
          output.log("Re-run `vendo init` to finish wiring (it picks the key up from .env.local).");
        }
        if (options.pretty !== true && !tty) {
          printJson(output, { deviceLogin: true, wroteEnvLocal: true, keyLast4: key.slice(-4) });
        }
        return "approved";
      }

      const error = (poll.body as { error?: unknown } | null)?.error;
      if (error === "authorization_pending") return "pending";
      if (error === "slow_down") return "slow_down"; // RFC 8628 §3.5
      if (error === "expired_token") {
        await deletePendingClaim(claimCwd, pendingHome);
        throw new Error("The code expired before it was approved; run `vendo login` again.");
      }
      if (error === "access_denied") {
        await deletePendingClaim(claimCwd, pendingHome);
        throw new Error("Your human denied the request — no key was minted.");
      }
      // Any other token error is terminal for THIS claim (invalid_grant =
      // consumed/denied server-side; single-use means it can never succeed
      // again). Delete the pending file so the next `vendo login` opens a
      // fresh claim instead of resuming into the same error forever — the
      // exact trap a live install hit.
      await deletePendingClaim(claimCwd, pendingHome);
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
      if (options.pretty !== true && !tty) {
        printJson(output, {
          deviceLogin: true,
          pending: true,
          userCode,
          verificationUriComplete,
        });
      }
      return 0;
    };

    if (waitMs === undefined) {
      // No budget: block to the claim deadline — unchanged TTY behavior.
      while (now() < deadline) {
        await sleep(intervalMs);
        const result = await pollOnce();
        if (result === "approved") return 0;
        if (result === "slow_down") intervalMs += 5000;
        noteStall();
      }
      await deletePendingClaim(claimCwd, pendingHome);
      throw new Error("The code expired before it was approved; run `vendo login` again.");
    }

    // Bounded budget: poll immediately, then pace by interval, stopping at
    // min(now+wait, deadline). `--wait 0` polls exactly once.
    const pollDeadline = Math.min(deadline, now() + waitMs);
    while (true) {
      const result = await pollOnce();
      if (result === "approved") return 0;
      if (result === "slow_down") intervalMs += 5000;
      noteStall();
      if (now() >= deadline) {
        await deletePendingClaim(claimCwd, pendingHome);
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
    // A transient failure (network, DNS, a killed fetch) deliberately leaves
    // the claim file in place, so say so — otherwise the reader assumes the
    // ceremony is lost and starts over, abandoning an approval that would
    // still land. Terminal outcomes above already deleted the claim, so this
    // line only appears when a resume can actually succeed.
    const survived = await readPendingClaim(claimCwd, pendingHome);
    if (survived !== null && survived.expires_at > now()) {
      output.error(
        `Your pending approval survives — code ${survived.user_code}. ` +
        "Re-run `vendo login` to resume this same request.",
      );
    }
    return 1;
  }
}
