import { assertNoSymlinks, demoPaths } from "./demo-folder.js";
import { createScrubber, defaultExec, delay, firstLine, type ExecFn, type ExecResult } from "./exec.js";

/**
 * Stage 6 — ship: the demo folder becomes a commit on vendo-demos main, and the
 * ONE shared host service redeploys with it.
 *
 * There is no per-demo service and no router: every demo is a directory the
 * host discovers at build time, so shipping is `git push` + one `railway up`
 * against the `host` service. That also means this stage is the only thing
 * standing between a generated folder and every OTHER live demo — hence the two
 * rules it enforces: it stages ONLY `demos/<slug>` (never `-A`), and it never
 * touches Railway service variables.
 */

export const railwayProject = "vendo-demos";
export const railwayService = "host";
const defaultPublicBaseUrl = "https://demos.vendo.run";

/** `railway up` retries. Live runs on a bad network night measured ~80%
 * failure per attempt from one transient TLS flake, and the deploy is
 * idempotent, so the fix is attempts rather than a failed run. */
export const railwayAttempts = 6;

/** Substrings of the transient `railway up` failures (BadRecordMac and
 * friends) — network and TLS, never the build. A real build error must fail on
 * the FIRST attempt: retrying a broken Dockerfile burns minutes to reach the
 * same answer. */
const transientRailwayFailures = [
  "badrecordmac",
  "error sending request",
  "connection reset",
  "econnreset",
  "connection closed",
  "socket hang up",
  "broken pipe",
  "unexpected eof",
  "tls handshake",
  "received fatal alert",
  "temporary failure in name resolution",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
];

/** The transient `railway up` TLS flake (BadRecordMac and friends). */
export function isTransientRailwayFailure(text: string): boolean {
  const haystack = text.toLowerCase();
  return transientRailwayFailures.some((needle) => haystack.includes(needle));
}

export interface ShipArgs {
  slug: string;
  prospect: string;
  /** default https://demos.vendo.run */
  publicBaseUrl?: string;
}

export interface ShipIo {
  demosRepo: string;
  exec?: ExecFn;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Pause between `railway up` attempts. */
  retryWaitMs?: number;
  /** Budget for each live-URL poll (public URL, then the railway domain). */
  pollTimeoutMs?: number;
  /** How long the submitted deployment may take to reach SUCCESS. Covers a cold
   * Docker build of the shared host, so it is generous. */
  deploymentTimeoutMs?: number;
  /** Pause between deployment-status reads. */
  deploymentPollMs?: number;
  runStage?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Writes the run's timing evidence for the last time. Called immediately
   * before `git add`, because that evidence lives INSIDE the folder being
   * committed: written afterwards it both under-reports the committed run and
   * leaves demos/<slug> dirty for the next slug's run to inherit. */
  finalizeTimings?: () => Promise<void>;
}

export interface ShipResult {
  commit: string;
  liveUrl: string;
  /** Set only when the public base URL never answered and the service's own
   * Railway domain did (the pre-cutover path). */
  railwayDomain?: string;
  attempts: number;
  /** The deployment THIS run submitted, proven SUCCESS before the URL was ever
   * polled — so `liveUrl` cannot be the previous build. */
  deploymentId: string;
}

/** Commit identity: git's own env names, so an operator who already exports
 * them gets their own authorship, and the mini (which has no global identity)
 * gets a documented default rather than a "please tell me who you are" abort. */
const defaultCommitName = "Vendo demo pipeline";
const defaultCommitEmail = "demos@vendo.run";

const pollIntervalMs = 10_000;

/**
 * Extract the service's public domain from `railway domain --service X --json`
 * output. The exact JSON shape is not documented, so parse liberally: any JSON
 * line with a string `domain` field, else the first *.up.railway.app match.
 */
export function parseRailwayDomain(output: string): string | undefined {
  const normalize = (value: string): string => value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  for (const candidate of [output, ...output.split("\n")]) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (typeof parsed === "object" && parsed !== null) {
        const domain = (parsed as { domain?: unknown }).domain;
        if (typeof domain === "string" && domain.length > 0) return normalize(domain);
      }
    } catch {
      // not JSON — fall through to the regex
    }
  }
  const match = /(?:https?:\/\/)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.up\.railway\.app)/i.exec(output);
  return match?.[1];
}

/** A push git refused because main moved under us. `git pull --rebase` is the
 * whole fix — this commit adds ONE new demo folder, so it cannot conflict with
 * whatever else landed. */
const rejectedPush = /rejected|non-fast-forward|fetch first|failed to push/i;

/** One row of `railway deployment list --json`. */
export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt?: string;
}

/** Terminal statuses. Anything else ("QUEUED", "BUILDING", "DEPLOYING",
 * "INITIALIZING", "WAITING") means keep waiting. */
const deploymentSucceeded = "SUCCESS";
const deploymentFailed = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED", "CANCELLED"]);

/**
 * Rows out of `railway deployment list --service <s> --json`, parsed liberally
 * (the shape is undocumented and version-dependent, so this tolerates a bare
 * array, an object wrapping one, or a JSON-per-line stream) — but NEVER silently:
 * `undefined` means "could not read", which the caller turns into a refusal
 * rather than a pass.
 */
export function parseRailwayDeployments(output: string): RailwayDeployment[] | undefined {
  const rows = (value: unknown): RailwayDeployment[] | undefined => {
    const list = Array.isArray(value)
      ? value
      : typeof value === "object" && value !== null && Array.isArray((value as { deployments?: unknown }).deployments)
        ? (value as { deployments: unknown[] }).deployments
        : undefined;
    if (list === undefined) return undefined;
    const parsed = list.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const { id, status, createdAt } = entry as { id?: unknown; status?: unknown; createdAt?: unknown };
      if (typeof id !== "string" || typeof status !== "string") return [];
      return [{ id, status, ...(typeof createdAt === "string" ? { createdAt } : {}) }];
    });
    // A list that parsed but yielded no usable row is not a readable answer.
    return parsed.length === list.length ? parsed : undefined;
  };
  for (const candidate of [output, ...output.split("\n")]) {
    const text = candidate.trim();
    if (text === "") continue;
    try {
      const found = rows(JSON.parse(text));
      if (found !== undefined) return found;
    } catch {
      // not JSON — try the next candidate
    }
  }
  return undefined;
}

export async function runShip(args: ShipArgs, io: ShipIo): Promise<ShipResult> {
  const exec = io.exec ?? defaultExec;
  const fetchImpl = io.fetchImpl ?? fetch;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = io.env ?? process.env;
  const runStage = io.runStage ?? (async <T>(_name: string, fn: () => Promise<T>): Promise<T> => await fn());
  const retryWaitMs = io.retryWaitMs ?? 30_000;
  const pollTimeoutMs = io.pollTimeoutMs ?? 5 * 60_000;
  const deploymentTimeoutMs = io.deploymentTimeoutMs ?? 15 * 60_000;
  const deploymentPollMs = io.deploymentPollMs ?? 10_000;
  const publicBaseUrl = (args.publicBaseUrl ?? defaultPublicBaseUrl).replace(/\/+$/, "");

  const scrub = createScrubber(env);
  const step = async (command: string[], options: { display?: string; tolerate?: RegExp } = {}): Promise<ExecResult> => {
    const display = scrub(options.display ?? command.join(" "));
    write(`$ ${display}`);
    const result = await exec(command, { cwd: io.demosRepo, ...(io.signal === undefined ? {} : { signal: io.signal }) });
    const output = result.stderr || result.stdout;
    if (result.code !== 0 && !(options.tolerate?.test(output) ?? false)) {
      throw new Error(`"${display}" failed (exit ${result.code}):\n${scrub(output)}`);
    }
    return result;
  };

  const demoPath = `demos/${args.slug}`;
  // Last gate before the demo becomes a commit on main: a symlink inside the
  // folder is invisible to a path fence and git would commit it as mode 120000.
  await assertNoSymlinks(demoPaths(io.demosRepo, args.slug).root, args.slug);
  const commit = await runStage("ship:commit", async () => {
    // Last write to RESEARCH/timings.json, before it is staged rather than after.
    await io.finalizeTimings?.();
    // ONLY this demo's path: the checkout also holds the host, and a `git add
    // -A` here would push whatever else an operator or another lane left in the
    // working tree onto main.
    await step(["git", "add", "--", demoPath]);
    const commitResult = await step([
      "git",
      "-c", `user.name=${env.GIT_AUTHOR_NAME ?? defaultCommitName}`,
      "-c", `user.email=${env.GIT_AUTHOR_EMAIL ?? defaultCommitEmail}`,
      "commit", "-m", `demo(${args.slug}): ${args.prospect}`, "--", demoPath,
    ], { tolerate: /nothing to commit|nothing added to commit|no changes added/i });
    // A `demo:fix` that changed no files still has to reach Railway (the host
    // may have moved under it), so an empty commit is a no-op, not a failure.
    if (commitResult.code !== 0) write(`  (nothing to commit for ${demoPath} — redeploying the current HEAD)`);
    // ensureDemosRepo fast-forwarded at the START of the run; by now another
    // pipeline (or a host change) can have landed on main. The build already
    // passed and the demo is good, so a rejected push gets ONE recovery round
    // instead of throwing the whole run away.
    const push = ["git", "push", "origin", "HEAD:main"];
    if ((await step(push, { tolerate: rejectedPush })).code !== 0) {
      write("  push rejected — main moved; rebasing onto it and pushing once more");
      await step(["git", "pull", "--rebase", "origin", "main"]);
      const retry = await step(push, { tolerate: rejectedPush });
      if (retry.code !== 0) {
        throw new Error(
          `"git push origin HEAD:main" was still rejected after rebasing onto origin/main (exit ${retry.code}):\n`
          + `${scrub(retry.stderr || retry.stdout)}\n`
          + `The demo is committed locally and is not lost — push it by hand (git -C "${io.demosRepo}" pull --rebase origin main && git -C "${io.demosRepo}" push origin HEAD:main), then re-run demo:fix for ${args.slug} to deploy it.`,
        );
      }
    }
    return (await step(["git", "rev-parse", "HEAD"])).stdout.trim();
  });

  /**
   * The deployments Railway currently knows about for this service.
   *
   * A failure here is NOT tolerated: the whole point is that "we could not verify
   * the deployment" must never read as "the deployment is live". Falling back to
   * trusting a 200 is exactly the bug — the previous build answers 200 for a slug
   * that is already live, so `demo:fix` reported success against the OLD build.
   */
  const listDeployments = async (): Promise<RailwayDeployment[]> => {
    const command = ["railway", "deployment", "list", "--service", railwayService, "--json"];
    const result = await exec(command, { cwd: io.demosRepo, ...(io.signal === undefined ? {} : { signal: io.signal }) });
    const parsed = result.code === 0 ? parseRailwayDeployments(`${result.stdout}\n${result.stderr}`) : undefined;
    if (parsed === undefined) {
      throw new Error(
        `cannot read this service's deployments ("${command.join(" ")}" exit ${result.code}), so the deploy cannot be verified — `
        + `refusing to report a demo LIVE against a build that may still be the previous one. `
        + `Check the railway CLI is current (\`railway deployment list --service ${railwayService} --json\`) and re-run.\n`
        + scrub(firstLine(result.stderr) ?? firstLine(result.stdout) ?? "no output"),
      );
    }
    return parsed;
  };

  // Snapshotted BEFORE `railway up`, so the deployment we are about to submit is
  // identifiable as the one that is not in here.
  const deploymentsBeforeUp = new Set((await listDeployments()).map((row) => row.id));

  const attempts = await runStage("ship:railway", async () => {
    await step(["railway", "link", "--project", railwayProject]);
    // No `railway variables`: the host's env (VENDO_API_KEY, KILLED_SLUGS,
    // DEMO_PING_WEBHOOK) belongs to the operator, and one shared service means
    // a pipeline that rewrites it reconfigures every live demo at once.
    const up = ["railway", "up", "--service", railwayService, "--detach"];
    for (let attempt = 1; ; attempt += 1) {
      if (io.signal?.aborted) throw io.signal.reason instanceof Error ? io.signal.reason : new Error("ship aborted");
      write(`$ ${up.join(" ")}`);
      const result = await exec(up, { cwd: io.demosRepo, ...(io.signal === undefined ? {} : { signal: io.signal }) });
      if (result.code === 0) return attempt;
      const output = scrub(result.stderr || result.stdout);
      if (!isTransientRailwayFailure(output)) {
        throw new Error(`"railway up --service ${railwayService}" failed (exit ${result.code}):\n${output}`);
      }
      write(`  attempt ${attempt}/${railwayAttempts} hit a transient failure (${firstLine(output) ?? "no output"})`);
      if (attempt >= railwayAttempts) {
        throw new Error(`"railway up --service ${railwayService}" failed after ${railwayAttempts} attempts: ${firstLine(output) ?? "no output"}`);
      }
      await delay(retryWaitMs);
    }
  });

  /**
   * Blocks until the deployment THIS run submitted is genuinely live.
   *
   * `railway up --detach` returns once the upload is queued — 6.06s on a real run
   * whose build then took minutes — and during those minutes the PREVIOUS
   * deployment keeps serving. So the URL poll below is not evidence on its own: for
   * a slug that is already live (every `demo:fix`, and any re-run) the old build
   * answers 200 with the slug marker and the pipeline would print LIVE for a build
   * that was still queued, or that had since failed.
   *
   * Identified as "the deployment that was not there before `up`". Under a
   * concurrent deploy of this shared service by someone else that could name
   * theirs, which the URL+marker check downstream still has to catch — a shared
   * service has no way to make this airtight from the client side.
   */
  const deploymentId = await runStage("ship:deployment", async () => {
    const deadline = Date.now() + deploymentTimeoutMs;
    let named: string | undefined;
    for (;;) {
      if (io.signal?.aborted) throw io.signal.reason instanceof Error ? io.signal.reason : new Error("ship aborted");
      const submitted = (await listDeployments()).filter((row) => !deploymentsBeforeUp.has(row.id));
      // Newest first is Railway's order; the newest unseen one is ours.
      const mine = submitted[0];
      if (mine !== undefined) {
        if (mine.id !== named) {
          write(`[ship] deployment ${mine.id} submitted — waiting for it to go live`);
          named = mine.id;
        }
        if (mine.status === deploymentSucceeded) {
          write(`[ship] deployment ${mine.id} is ${mine.status}`);
          return mine.id;
        }
        if (deploymentFailed.has(mine.status)) {
          throw new Error(
            `the deployment this run submitted (${mine.id}) ended ${mine.status} — the demo is committed and pushed, but the host is still serving the PREVIOUS build. `
            + `Read the build log (railway logs --service ${railwayService} --deployment ${mine.id}) and re-run demo:fix for ${args.slug} once it is fixed.`,
          );
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `the deployment this run submitted ${mine === undefined ? "never appeared" : `was still ${mine.status}`} after ${Math.round(deploymentTimeoutMs / 60_000)} min. `
          + `The demo is committed and pushed and is not lost; the host may still be serving the previous build. Check \`railway deployment list --service ${railwayService}\`.`,
        );
      }
      write(`[ship] deployment ${mine === undefined ? "not registered yet" : `${mine.id} is ${mine.status}`} — waiting`);
      await delay(deploymentPollMs);
    }
  });

  return await runStage("ship:live", async () => {
    const publicUrl = `${publicBaseUrl}/${args.slug}`;
    // The host's own Railway domain is discovered up front and polled in the
    // SAME deadline as the public URL. Pre-cutover, demos.vendo.run still
    // points at the old router and never answers, so polling it to exhaustion
    // first would spend the whole live budget before even trying the URL that
    // works — with a 20-minute end-to-end target, that is the difference
    // between shipping and timing out. Post-cutover the public URL wins the
    // race on the first round and the extra candidate costs one CLI call.
    const domainOutput = await step(["railway", "domain", "--service", railwayService, "--json"]);
    const railwayDomain = parseRailwayDomain(`${domainOutput.stdout}\n${domainOutput.stderr}`);
    const railwayUrl = railwayDomain === undefined ? undefined : `https://${railwayDomain}/${args.slug}`;
    const candidates = [publicUrl, ...(railwayUrl === undefined ? [] : [railwayUrl])];

    const live = await waitForAny200(candidates, {
      fetchImpl,
      timeoutMs: pollTimeoutMs,
      write,
      slug: args.slug,
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    if (live.url !== undefined) {
      return {
        commit,
        liveUrl: live.url,
        attempts,
        deploymentId,
        ...(railwayDomain === undefined ? {} : { railwayDomain }),
      };
    }
    throw new Error(
      `Deployed demo never answered 200 within ${Math.round(pollTimeoutMs / 60_000)} min — ${candidates.map((url) => `${url} (${live.failures[url] ?? "not tried"})`).join(", ")}`,
    );
  });
}

/**
 * Polls every candidate URL each round and returns the FIRST that serves THIS
 * DEMO with a clean 200 (candidate order is preference order).
 *
 * Three things a 200 alone does not prove, all of them observed shapes:
 *  - `redirect: "follow"` followed the auth wall's 307 to `/login`, which
 *    answers a clean 200 — a deployment with DEMO_AUTOLOGIN or VENDO_BASE_URL
 *    misconfigured reported LIVE while every prospect saw a login form. So
 *    redirects are MANUAL and a 3xx is "not ready", named with its location.
 *  - the pre-cutover demos.vendo.run router and Railway's own placeholder both
 *    answer 200 for URLs they know nothing about.
 *  - a rewritten card (the kill switch) answers 200 at the demo's own path.
 * Hence the marker: the product page carries its own slug (the per-slug wire and
 * chrome are built from it), and neither a login form nor a placeholder does.
 *
 * Anything but 200 means not ready: Railway answers 404 "Application not found"
 * for a whole build, and a `< 500` check once let a gate run against a
 * still-building service.
 */
async function waitForAny200(urls: string[], options: {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  write: (line: string) => void;
  slug: string;
  signal?: AbortSignal;
}): Promise<{ url?: string; failures: Record<string, string> }> {
  const deadline = Date.now() + options.timeoutMs;
  const failures: Record<string, string> = {};
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("ship aborted");
    for (const url of urls) {
      try {
        const response = await options.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
        if (response.status !== 200) {
          const location = response.headers.get("location");
          failures[url] = `HTTP ${response.status}${location === null ? "" : ` -> ${location}`}`;
          continue;
        }
        const body = await response.text();
        if (!body.includes(options.slug)) {
          failures[url] = `HTTP 200 but the page carries no "${options.slug}" marker — an auth wall, a placeholder or another service answered`;
          continue;
        }
        return { url, failures };
      } catch (error) {
        failures[url] = error instanceof Error ? error.message : String(error);
      }
    }
    if (Date.now() >= deadline) return { failures };
    options.write(`[ship] waiting for ${urls.map((url) => `${url} (${failures[url] ?? "?"})`).join(", ")}`);
    await delay(pollIntervalMs);
  }
}
