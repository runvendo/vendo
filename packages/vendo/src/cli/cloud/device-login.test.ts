import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeviceLogin, runLoginCommand } from "./device-login.js";
import { telemetryCapture } from "../telemetry.test-util.js";

// `vendo cloud device-login` — the auth.md user-claimed ceremony against a
// scripted console. The whole RFC 8628 dance runs through the injectable
// fetch + sleep seams, so these tests cover the exact wire shapes the
// console's token endpoint speaks (top-level OAuth error strings).

const KEY = `vnd_${"a".repeat(40)}`;
const CEREMONY = {
  registration: "service_auth",
  claim_token: `vct_${"b".repeat(64)}`,
  device_code: `vct_${"b".repeat(64)}`,
  user_code: "BCDF-GHJK",
  verification_uri: "https://console.test/claim",
  verification_uri_complete: "https://console.test/claim?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-device-login-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) } };
}

/** A scripted console: first call answers the claim, later calls pop token
    responses in order (the last response repeats). */
function scriptedFetch(tokenResponses: Array<{ status: number; body: unknown }>) {
  const requests: Array<{ url: string; contentType: string | null; body: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.text();
    requests.push({ url: request.url, contentType: request.headers.get("content-type"), body });
    if (request.url.endsWith("/api/v1/agent/claim")) {
      return Response.json(CEREMONY);
    }
    const next = tokenResponses.length > 1 ? tokenResponses.shift()! : tokenResponses[0]!;
    return Response.json(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("runDeviceLogin", () => {
  it("runs the full ceremony: claim → code shown → RFC 8628 poll → key into .env.local", async () => {
    const root = await tempRoot();
    const sleeps: number[] = [];
    const { fetchImpl, requests } = scriptedFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: KEY, token_type: "Bearer", scope: "dev-mode" } },
    ]);
    const messages = output();

    const exit = await runDeviceLogin(["dev@example.com", "--api-url", "https://console.test"], {
      output: messages.sink,
      fetchImpl,
      root,
      home: await tempRoot(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      env: {},
      isTty: false,
    });

    expect(exit).toBe(0);
    // Claim request carried the login hint, JSON-encoded.
    expect(requests[0].url).toBe("https://console.test/api/v1/agent/claim");
    expect(JSON.parse(requests[0].body)).toEqual({ login_hint: "dev@example.com" });
    // Polls are form-encoded with the auth.md grant type + claim token.
    expect(requests[1].contentType).toContain("application/x-www-form-urlencoded");
    const poll = new URLSearchParams(requests[1].body);
    expect(poll.get("grant_type")).toBe("urn:workos:agent-auth:grant-type:claim");
    expect(poll.get("claim_token")).toBe(CEREMONY.claim_token);
    // slow_down added 5s to the 5s interval (RFC 8628 §3.5).
    expect(sleeps.slice(0, 4)).toEqual([5000, 5000, 10000, 10000]);

    // The human-facing block names the code and approval URL.
    const joined = messages.logs.join("\n");
    expect(joined).toContain("BCDF-GHJK");
    expect(joined).toContain("https://console.test/claim?code=BCDF-GHJK");

    // The key lands in .env.local and is NEVER printed (last4 only).
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain(`VENDO_API_KEY=${KEY}`);
    expect(joined).not.toContain(KEY);
    expect(joined).toContain(`…${KEY.slice(-4)}`);
  });

  it("upserts .env.local without clobbering other lines", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env.local"), "FOO=bar\nVENDO_API_KEY=old\n");
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl,
      root,
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: false,
    });
    expect(exit).toBe(0);
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain("FOO=bar");
    expect(envLocal).toContain(`VENDO_API_KEY=${KEY}`);
    expect(envLocal).not.toContain("VENDO_API_KEY=old");
  });

  it("stops loudly on access_denied and expired_token", async () => {
    for (const [error, fragment] of [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
    ] as const) {
      const { fetchImpl } = scriptedFetch([{ status: 400, body: { error } }]);
      const messages = output();
      const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
        output: messages.sink,
        fetchImpl,
        root: await tempRoot(),
        home: await tempRoot(),
        sleep: async () => {},
        env: {},
        isTty: false,
      });
      expect(exit).toBe(1);
      expect(messages.errors.join("\n")).toContain(fragment);
    }
  });

  it("gives up when the ceremony deadline passes with the human never approving", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 400, body: { error: "authorization_pending" } },
    ]);
    let clock = 0;
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: messages.sink,
      fetchImpl,
      root: await tempRoot(),
      home: await tempRoot(),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      env: {},
      isTty: false,
    });
    expect(exit).toBe(1);
    expect(messages.errors.join("\n")).toContain("expired");
  });

  it("refuses a malformed credential instead of writing junk to .env.local", async () => {
    const root = await tempRoot();
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { access_token: "not-a-vendo-key" } },
    ]);
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl,
      root,
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: false,
    });
    expect(exit).toBe(1);
    await expect(readFile(join(root, ".env.local"), "utf8")).rejects.toThrow();
  });

  it("surfaces the console envelope message when the claim cannot be opened", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { error: { code: "rate-limited", message: "Too many open claims for this email." } },
        { status: 429 },
      )) as unknown as typeof fetch;
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: messages.sink,
      fetchImpl,
      root: await tempRoot(),
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: false,
    });
    expect(exit).toBe(1);
    expect(messages.errors.join("\n")).toContain("Too many open claims");
  });

  it("opens the browser at verification_uri_complete when a TTY human is watching", async () => {
    const opened: string[] = [];
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: messages.sink,
      fetchImpl,
      root: await tempRoot(),
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: true,
      openBrowser: (url) => opened.push(url),
    });
    expect(exit).toBe(0);
    expect(opened).toEqual(["https://console.test/claim?code=BCDF-GHJK"]);
    // The printed URL + code stay — the browser open is best-effort, text is the fallback.
    const joined = messages.logs.join("\n");
    expect(joined).toContain("BCDF-GHJK");
    expect(joined).toContain("https://console.test/claim?code=BCDF-GHJK");
  });

  it("never launches a browser for a non-TTY (agent) caller", async () => {
    const opened: string[] = [];
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl,
      root: await tempRoot(),
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: false,
      openBrowser: (url) => opened.push(url),
    });
    expect(exit).toBe(0);
    expect(opened).toEqual([]);
  });

  it("suppresses the standalone re-run hint when init drives the ceremony", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: messages.sink,
      fetchImpl,
      root: await tempRoot(),
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: false,
      rerunHint: false,
    });
    expect(exit).toBe(0);
    expect(messages.logs.join("\n")).not.toContain("Re-run `vendo init`");
  });
});

// The pending-claim file (#479): a claim survives the process that opened it,
// so a fresh `vendo login` can resume polling after the original process dies
// and a late human approval still lands the key.
describe("pending claim persistence", () => {
  const pendingPath = (home: string) => join(home, ".vendo", "pending-claim.json");

  async function writePending(home: string, overrides: Record<string, unknown> = {}): Promise<void> {
    await mkdir(join(home, ".vendo"), { recursive: true });
    await writeFile(pendingPath(home), JSON.stringify({
      claim_token: `vct_${"c".repeat(64)}`,
      user_code: "WXYZ-PQRS",
      verification_uri_complete: "https://console.test/claim?code=WXYZ-PQRS",
      expires_at: Date.now() + 600_000,
      interval: 5,
      api_url: "https://console.test",
      cwd: home,
      ...overrides,
    }));
  }

  it("persists the claim (mode 0600) while polling and removes it on success", async () => {
    const root = await tempRoot();
    const home = await tempRoot();
    const seenDuringPoll: unknown[] = [];
    const { fetchImpl } = scriptedFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl,
      root,
      home,
      sleep: async () => {
        const mode = (await stat(pendingPath(home))).mode & 0o777;
        seenDuringPoll.push({ ...JSON.parse(await readFile(pendingPath(home), "utf8")), mode });
      },
      env: {},
      isTty: false,
    });
    expect(exit).toBe(0);
    // The claim was on disk for every poll, owner-only, carrying the resume state.
    expect(seenDuringPoll[0]).toMatchObject({
      claim_token: CEREMONY.claim_token,
      user_code: CEREMONY.user_code,
      verification_uri_complete: CEREMONY.verification_uri_complete,
      interval: CEREMONY.interval,
      api_url: "https://console.test",
      cwd: root,
      mode: 0o600,
    });
    expect(typeof (seenDuringPoll[0] as { expires_at: unknown }).expires_at).toBe("number");
    // Redeemed — nothing left to resume.
    await expect(stat(pendingPath(home))).rejects.toThrow();
  });

  it("resumes a pending claim: polls the same claim_token without re-opening a claim", async () => {
    const home = await tempRoot();
    const originalCwd = await tempRoot();
    const otherCwd = await tempRoot();
    await writePending(home, { cwd: originalCwd });
    const { fetchImpl, requests } = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: messages.sink,
      fetchImpl,
      root: otherCwd,
      home,
      sleep: async () => {},
      env: {},
      isTty: false,
    });
    expect(exit).toBe(0);
    // No new claim was opened — the first request already polls the token endpoint.
    expect(requests.some((request) => request.url.endsWith("/api/v1/agent/claim"))).toBe(false);
    expect(new URLSearchParams(requests[0].body).get("claim_token")).toBe(`vct_${"c".repeat(64)}`);
    // The human is told the old code is still the one to approve.
    expect(messages.logs.join("\n")).toContain(
      "Resuming pending approval — code WXYZ-PQRS, approve at https://console.test/claim?code=WXYZ-PQRS",
    );
    // The key lands where the ORIGINAL run intended, and the output says so.
    const envLocal = await readFile(join(originalCwd, ".env.local"), "utf8");
    expect(envLocal).toContain(`VENDO_API_KEY=${KEY}`);
    await expect(readFile(join(otherCwd, ".env.local"), "utf8")).rejects.toThrow();
    expect(messages.logs.join("\n")).toContain(join(originalCwd, ".env.local"));
    await expect(stat(pendingPath(home))).rejects.toThrow();
  });

  it("discards an expired pending claim and opens a fresh one", async () => {
    const home = await tempRoot();
    await writePending(home, { expires_at: Date.now() - 1_000 });
    const { fetchImpl, requests } = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl,
      root: await tempRoot(),
      home,
      sleep: async () => {},
      env: {},
      isTty: false,
    });
    expect(exit).toBe(0);
    // The stale claim is ignored: a fresh ceremony opens and its token is polled.
    expect(requests[0].url).toBe("https://console.test/api/v1/agent/claim");
    expect(new URLSearchParams(requests[1].body).get("claim_token")).toBe(CEREMONY.claim_token);
  });

  it("removes the pending claim when the human denies the request", async () => {
    const home = await tempRoot();
    const { fetchImpl } = scriptedFetch([{ status: 400, body: { error: "access_denied" } }]);
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl,
      root: await tempRoot(),
      home,
      sleep: async () => {},
      env: {},
      isTty: false,
    });
    expect(exit).toBe(1);
    await expect(stat(pendingPath(home))).rejects.toThrow();
  });
});

// A bounded per-invocation poll budget (#479): `--wait <seconds>` caps how
// long ONE call polls before exiting resumably, so a coding agent can loop
// short re-runs (each resuming the same claim) instead of a 10-min block.
describe("bounded --wait budget (#479)", () => {
  const pendingPath = (home: string) => join(home, ".vendo", "pending-claim.json");
  const tokenPolls = (requests: Array<{ url: string }>) =>
    requests.filter((request) => request.url.endsWith("/api/v1/oauth/token"));

  async function writePending(home: string, overrides: Record<string, unknown> = {}): Promise<void> {
    await mkdir(join(home, ".vendo"), { recursive: true });
    await writeFile(pendingPath(home), JSON.stringify({
      claim_token: `vct_${"c".repeat(64)}`,
      user_code: "WXYZ-PQRS",
      verification_uri_complete: "https://console.test/claim?code=WXYZ-PQRS",
      expires_at: Date.now() + 600_000,
      interval: 5,
      api_url: "https://console.test",
      cwd: home,
      ...overrides,
    }));
  }

  it("(a) exits 0 and leaves the claim resumable when the budget elapses while pending", async () => {
    const root = await tempRoot();
    const home = await tempRoot();
    let clock = 0;
    const { fetchImpl } = scriptedFetch([
      { status: 400, body: { error: "authorization_pending" } },
    ]);
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test", "--wait", "10"], {
      output: messages.sink,
      fetchImpl,
      root,
      home,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      env: {},
      isTty: false,
    });
    // Pending is not a failure — exit 0, no throw.
    expect(exit).toBe(0);
    expect(messages.errors).toEqual([]);
    // The claim file stays on disk for the next re-run to resume.
    await expect(stat(pendingPath(home))).resolves.toBeTruthy();
    // No key was written.
    await expect(readFile(join(root, ".env.local"), "utf8")).rejects.toThrow();
    // The resumable line + budget hint were printed, with the JSON pending shape.
    const joined = messages.logs.join("\n");
    expect(joined).toContain("This call polls for up to 10s");
    expect(joined).toContain(
      "Still waiting on approval — code BCDF-GHJK. Re-run `vendo login` to resume (it continues this same request).",
    );
    expect(messages.logs).toContainEqual(JSON.stringify({
      deviceLogin: true,
      pending: true,
      userCode: "BCDF-GHJK",
      verificationUriComplete: "https://console.test/claim?code=BCDF-GHJK",
    }, null, 2));
  });

  it("(b) a --wait re-run resumes the same claim_token and lands the key when approval arrives", async () => {
    const home = await tempRoot();
    const originalCwd = await tempRoot();
    const otherCwd = await tempRoot();
    await writePending(home, { cwd: originalCwd });
    const { fetchImpl, requests } = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    const exit = await runDeviceLogin(["--api-url", "https://console.test", "--wait", "90"], {
      output: output().sink,
      fetchImpl,
      root: otherCwd,
      home,
      sleep: async () => {},
      env: {},
      isTty: false,
    });
    expect(exit).toBe(0);
    // No new claim opened — it polls the persisted claim_token directly.
    expect(requests.some((request) => request.url.endsWith("/api/v1/agent/claim"))).toBe(false);
    expect(new URLSearchParams(requests[0].body).get("claim_token")).toBe(`vct_${"c".repeat(64)}`);
    // The key lands where the ORIGINAL run intended, and the pending file is gone.
    const envLocal = await readFile(join(originalCwd, ".env.local"), "utf8");
    expect(envLocal).toContain(`VENDO_API_KEY=${KEY}`);
    await expect(stat(pendingPath(home))).rejects.toThrow();
  });

  it("(c) without --wait the call still blocks to the claim deadline (unchanged)", async () => {
    const root = await tempRoot();
    const home = await tempRoot();
    let clock = 0;
    const { fetchImpl } = scriptedFetch([
      { status: 400, body: { error: "authorization_pending" } },
    ]);
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test"], {
      output: messages.sink,
      fetchImpl,
      root,
      home,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      env: {},
      isTty: false,
    });
    // Legacy path: it runs to the deadline and reports expiry (exit 1), never
    // the resumable pending exit, and clears the pending file.
    expect(exit).toBe(1);
    expect(messages.errors.join("\n")).toContain("expired");
    expect(messages.logs.join("\n")).not.toContain("Still waiting on approval");
    await expect(stat(pendingPath(home))).rejects.toThrow();
  });

  it("(d) --wait 0 does exactly one poll then exits resumably if still pending", async () => {
    const root = await tempRoot();
    const home = await tempRoot();
    const sleeps: number[] = [];
    const { fetchImpl, requests } = scriptedFetch([
      { status: 400, body: { error: "authorization_pending" } },
    ]);
    const messages = output();
    const exit = await runDeviceLogin(["--api-url", "https://console.test", "--wait", "0"], {
      output: messages.sink,
      fetchImpl,
      root,
      home,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      env: {},
      isTty: false,
    });
    expect(exit).toBe(0);
    // Exactly one token poll, and no pacing sleep before that single poll.
    expect(tokenPolls(requests)).toHaveLength(1);
    expect(sleeps).toEqual([]);
    // Still resumable: claim on disk, no key, resumable line printed.
    await expect(stat(pendingPath(home))).resolves.toBeTruthy();
    await expect(readFile(join(root, ".env.local"), "utf8")).rejects.toThrow();
    expect(messages.logs.join("\n")).toContain("Still waiting on approval — code BCDF-GHJK");
  });
});

describe("login telemetry (runLoginCommand)", () => {
  it("tracks command_run login with ok reflecting the ceremony's exit code", async () => {
    const root = await tempRoot();
    const ok = await telemetryCapture();
    cleanup.push(() => rm(ok.home, { recursive: true, force: true }));
    const approved = scriptedFetch([
      { status: 200, body: { access_token: KEY, token_type: "Bearer" } },
    ]);
    expect(await runLoginCommand(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl: approved.fetchImpl,
      root,
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: false,
      telemetry: ok.telemetry,
    })).toBe(0);
    expect(ok.event("command_run").properties).toMatchObject({ command: "login", ok: true });
    expect(typeof ok.event("command_run").properties.durationMs).toBe("number");

    const denied = await telemetryCapture();
    cleanup.push(() => rm(denied.home, { recursive: true, force: true }));
    const deniedConsole = scriptedFetch([
      { status: 400, body: { error: "access_denied" } },
    ]);
    expect(await runLoginCommand(["--api-url", "https://console.test"], {
      output: output().sink,
      fetchImpl: deniedConsole.fetchImpl,
      root,
      home: await tempRoot(),
      sleep: async () => {},
      env: {},
      isTty: false,
      telemetry: denied.telemetry,
    })).toBe(1);
    expect(denied.event("command_run").properties).toMatchObject({ command: "login", ok: false });
  });
});
