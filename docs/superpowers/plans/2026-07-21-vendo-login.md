# `vendo login` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the auth.md claim ceremony to a top-level `vendo login` command (browser auto-open on TTY), keep `vendo cloud device-login` as an alias, demote email-OTP `vendo cloud login`, and switch `vendo init`'s interactive Cloud offer to the same ceremony.

**Architecture:** The ceremony already lives in `packages/vendo/src/cli/cloud/device-login.ts` (`runDeviceLogin`) with injectable fetch/sleep/output seams. We add TTY-gated browser auto-open inside `runDeviceLogin` (so both `vendo login` and the `vendo cloud device-login` alias get it), route a new top-level `login` command to it, and replace `runCloudStep`'s email-OTP + starter-mint path with a `deviceLogin` seam that defaults to `runDeviceLogin`. The now-dead `mintStarterAllowance` path is removed.

**Tech Stack:** TypeScript ESM, vitest, existing seam-injection test patterns (`device-login.test.ts`, `cloud-init.test.ts`, `cli.test.ts`).

**Coordination (from the vendo-web install.md track):** Do NOT touch `docs-site/agents/index.mdx` or `docs-site/install.mdx` (owned by that track). DO update `docs-site/reference/cli.mdx`, `docs-site/connect/dev-mode.mdx`, `docs-site/deploy/vendo-cloud.mdx`. Login-hint flag name is `--email` (positional EMAIL also accepted). Their docs PR lands after ours; report our PR number.

**Out of scope:** share/publish/pin-ship removal; playbook/agents.md wording; publishing/releasing (ask Yousef).

---

### Task 1: Browser auto-open + message updates in `runDeviceLogin`

**Files:**
- Modify: `packages/vendo/src/cli/cloud/device-login.ts`
- Test: `packages/vendo/src/cli/cloud/device-login.test.ts`

- [x] **Step 1: Write failing tests** — TTY opens browser at `verification_uri_complete` (URL + code still printed), non-TTY never opens, `rerunHint: false` suppresses the "Re-run `vendo init`" tail. Also pin existing tests to `isTty: false` so no environment ever launches a real browser from the suite.

```ts
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
      sleep: async () => {},
      env: {},
      isTty: false,
      rerunHint: false,
    });
    expect(exit).toBe(0);
    expect(messages.logs.join("\n")).not.toContain("Re-run `vendo init`");
  });
```

- [x] **Step 2: Run** `pnpm --filter @vendoai/vendo exec vitest run src/cli/cloud/device-login.test.ts` — expect the 3 new tests FAIL (unknown options are accepted silently today, so failures are assertion-level).

- [x] **Step 3: Implement.** In `device-login.ts`: import `execFile` from `node:child_process` and `browserOpenCommand` from `../playground.js`. Extend options:

```ts
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
}

function defaultOpenBrowser(url: string): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  execFile(command, args, () => undefined); // best-effort: the printed URL is the fallback
}
```

After the existing "1. Open … 2. Confirm the code …" block:

```ts
    const approvalUrl = ceremony.verification_uri_complete ?? ceremony.verification_uri;
    // (use approvalUrl in the existing "1. Open" line)
    const tty = options.isTty ?? (process.stdout.isTTY === true);
    if (tty) {
      output.log("Opening your browser… (approve there, then come back here)");
      (options.openBrowser ?? defaultOpenBrowser)(approvalUrl);
    }
```

Gate the tail: `if (options.rerunHint !== false) output.log("Re-run \`vendo init\` to finish wiring (it picks the key up from .env.local).");`
Rename the command in both expiry error strings: ``run `vendo login` again``.

- [x] **Step 4: Run the file's tests** — all PASS. Also run `src/cli/playground.test.ts` (unchanged import surface).

- [x] **Step 5: Commit** `feat(cli): device-login opens the browser for TTY humans`

### Task 2: Top-level `vendo login` command

**Files:**
- Modify: `packages/vendo/src/cli.ts`
- Test: `packages/vendo/src/cli.test.ts`

- [x] **Step 1: Write failing tests** in `cli.test.ts`:

```ts
  it("wires top-level login: help leads with it, ENG-335 guards apply", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await main(["--help"])).toBe(0);
    const help = log.mock.calls.flat().join("\n");
    expect(help).toContain("login [email]");
    expect(help).toContain("--email <address>");

    expect(await main(["login", "--emial", "x@y.z"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("unknown option: --emial");

    expect(await main(["login", "--email"])).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("--email requires a value");

    log.mockRestore();
    error.mockRestore();
  });
```

- [x] **Step 2: Run** `vitest run src/cli.test.ts` — new test FAILS ("Unknown command: login").

- [x] **Step 3: Implement** in `cli.ts`:
  - Import `runDeviceLogin` from `./cli/cloud/device-login.js`.
  - HELP `Commands:` block gains, right after `doctor`:
    `  login [email]   Claim a Vendo Cloud key: approve in the browser; the key lands in .env.local`
  - HELP `Options:` gains: `  --email <address>          Login only: pre-fill the approval page (login hint)` and the `--api-url` line becomes `Sync/cloud/login: override VENDO_CLOUD_URL`.
  - Guards + routing before the `cloud` branch:

```ts
const LOGIN_VALUE_OPTIONS = ["--email", "--api-url"];
```
```ts
  if (command === "login") {
    const problems = optionErrors(args, new Set(), LOGIN_VALUE_OPTIONS);
    if (problems.length > 0) {
      console.error(`vendo login: ${problems.join("; ")}\n\n${HELP}`);
      return 1;
    }
    return runDeviceLogin(args);
  }
```
  - Update init's `--cloud-key` problem string: `` "--cloud-key must be a Vendo Cloud key (vnd_ + 40 hex; `vendo login` issues one)" ``.

- [x] **Step 4: Run** `vitest run src/cli.test.ts` — PASS.
- [x] **Step 5: Commit** `feat(cli): top-level vendo login runs the claim ceremony`

### Task 3: Demote email-OTP in `vendo cloud` help

**Files:**
- Modify: `packages/vendo/src/cli/cloud/index.ts`
- Test: `packages/vendo/src/cli/cloud/index.test.ts`

- [x] **Step 1: Check `index.test.ts` for CLOUD_HELP assertions; add/adjust a test** asserting device-login is described as the alias of `vendo login` and OTP login reads as fallback:

```ts
  it("help leads with the ceremony and demotes email OTP to a fallback", async () => {
    const logs: string[] = [];
    const exit = await runCloud(["--help"], { output: { log: (m) => logs.push(m), error: () => {} } });
    expect(exit).toBe(0);
    const help = logs.join("\n");
    expect(help.indexOf("device-login")).toBeLessThan(help.indexOf("login EMAIL"));
    expect(help).toContain("alias of `vendo login`");
    expect(help).toContain("fallback");
  });
```

- [x] **Step 2: Run** — FAILS. **Step 3:** Reorder/reword the `User commands:` block in CLOUD_HELP:

```
User commands:
  device-login [EMAIL]                  Alias of `vendo login` — the auth.md user-claimed
                                        flow: your human approves a code in the browser;
                                        the minted VENDO_API_KEY is written to .env.local
                                        (never printed)
  login EMAIL                           Fallback: send an email OTP (6-10 digits) and prompt for it
  login --token <jwt>                   Fallback: store an access token directly
```

- [x] **Step 4: Run cloud tests** `vitest run src/cli/cloud` — PASS. **Step 5: Commit** `docs(cli): cloud help leads with the ceremony, OTP demoted`

### Task 4: `vendo init`'s Cloud offer runs the ceremony

**Files:**
- Modify: `packages/vendo/src/cli/cloud-init.ts` (drop `mintStarterAllowance`, OTP path, `promptEmail`/`login`/`mint`/`home` seams; add `deviceLogin`/`sleep` seams)
- Test: `packages/vendo/src/cli/cloud-init.test.ts`

- [x] **Step 1: Rewrite the affected tests** (TDD — new behavior first):
  - Delete the `mintStarterAllowance` describe block.
  - Replace the three OTP-flow tests ("logs in, mints…", "mints through the REAL default…", "degrades gracefully…", "surfaces a mint failure…") with:

```ts
  it("runs the claim ceremony on accept and reports the landed key", async () => {
    const root = await tempRoot();
    const messages = output();
    const deviceLogin = vi.fn(async () => {
      await writeFile(join(root, ".env.local"), `VENDO_API_KEY=${goodKey}\n`);
      return 0;
    });
    const result = await runCloudStep({
      root,
      output: messages.sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      deviceLogin,
    });
    expect(deviceLogin).toHaveBeenCalledOnce();
    expect(result).toEqual({ keyPresent: true, keyValid: true, wroteEnvLocal: true });
    expect((await readFile(join(root, ".env.local"), "utf8"))).toContain(`VENDO_API_KEY=${goodKey}`);
  });

  it("runs the REAL default ceremony against a scripted console and lands the key", async () => {
    const root = await tempRoot();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === "https://cloud.test/api/v1/agent/claim") {
        return Response.json({
          claim_token: `vct_${"b".repeat(64)}`,
          user_code: "BCDF-GHJK",
          verification_uri: "https://cloud.test/claim",
          verification_uri_complete: "https://cloud.test/claim?code=BCDF-GHJK",
          expires_in: 600,
          interval: 5,
        });
      }
      expect(request.url).toBe("https://cloud.test/api/v1/oauth/token");
      return Response.json({ access_token: goodKey, token_type: "Bearer", scope: "dev-mode" });
    }) as unknown as typeof fetch;
    const messages = output();
    const result = await runCloudStep({
      root,
      output: messages.sink,
      yes: false,
      isTty: false,
      credential: noKey,
      apiUrl: "https://cloud.test",
      fetchImpl,
      sleep: async () => {},
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
    });
    expect(result).toEqual({ keyPresent: true, keyValid: true, wroteEnvLocal: true });
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain(`VENDO_API_KEY=${goodKey}`);
    // init drives the ceremony inline — no standalone re-run hint.
    expect(messages.logs.join("\n")).not.toContain("Re-run `vendo init`");
  });

  it("reports a ceremony that did not complete without changing init's exit code", async () => {
    const messages = output();
    const result = await runCloudStep({
      root: await tempRoot(),
      output: messages.sink,
      yes: false,
      credential: noKey,
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
      confirm: async () => true,
      deviceLogin: async () => 1,
    });
    expect(result).toEqual({ keyPresent: false, keyValid: false, wroteEnvLocal: false });
    expect(messages.errors.join("\n")).toContain("run `vendo login`");
  });
```

  - Update string assertions: `"vendo cloud login"` → `"vendo login"` (byo test line ~146, TTY-decline test line ~172 becomes ``"Skipped — run `vendo login`"``), pointer test line ~127 `"vendo cloud device-login"` → ``"`vendo login`"``.
  - Keep: present-key, malformed-key, pointer, byo, decline, "does not offer when ladder has a key", upsert test (drive it through the `deviceLogin` seam writing over an existing `.env.local` via `upsertEnvLocal` import or keep it as a device-login concern — simplest: change its `mint`/`login`/`promptEmail` seams to a `deviceLogin` seam calling `upsertEnvLocal(root, "VENDO_API_KEY", goodKey)` then `return 0`).

- [x] **Step 2: Run** `vitest run src/cli/cloud-init.test.ts` — new tests FAIL.

- [x] **Step 3: Implement** in `cloud-init.ts`:
  - Drop imports: `createInterface`, `runLogin`, `CloudError`, `cloudFetch`, `CloudFetchOptions` (keep `isVendoKey` only if still used — it isn't; drop). Add `import { runDeviceLogin } from "./cloud/device-login.js";` (safe cycle: `device-login.ts` imports the hoisted `upsertEnvLocal` function declaration from here).
  - Delete `askText` and `mintStarterAllowance` (+ its contract comment; the ceremony is now the one mint path).
  - `CloudStepOptions`: remove `promptEmail`, `login`, `mint`, `home`; add:

```ts
  /** Ceremony seams (tests script the console / the whole ceremony). */
  deviceLogin?: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
```

  - Replace everything after the confirm-decline block with:

```ts
  const deviceLogin = options.deviceLogin ?? (() => runDeviceLogin(
    options.apiUrl === undefined ? [] : ["--api-url", options.apiUrl],
    {
      output,
      env,
      root,
      isTty: tty,
      rerunHint: false,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    },
  ));
  if ((await deviceLogin()) !== 0) {
    output.error("Vendo Cloud login did not complete; run `vendo login` and re-run `vendo init`.");
    return { keyPresent: false, keyValid: false, wroteEnvLocal: false };
  }
  output.log("Production always needs a real server-side key.");
  return { keyPresent: true, keyValid: true, wroteEnvLocal: true };
```

    (Hoist `const tty = options.isTty ?? (stdin.isTTY === true && stdout.isTTY === true);` above the confirm so both the decline branch and the ceremony share it.)
  - Message updates: invalid-key line → `` `vendo login` can issue a fresh one ``; byo/no-ladder line → ``"Run `vendo login` to claim a free dev-mode key; it lands in .env.local."``; TTY decline → ``"Skipped — run `vendo login` any time; the key lands in .env.local."``; `agentKeyPointerLines` step 1 → `` "  1. run `vendo login` — it prints a code your human approves in the browser" ``.
  - Update the module docstring (ENG-339 comment) to describe the ceremony offer instead of OTP + starter mint.

- [x] **Step 4: Run** `vitest run src/cli/cloud-init.test.ts` — PASS.
- [x] **Step 5: Commit** `feat(init): interactive Cloud offer runs the vendo login ceremony`

### Task 5: init pointer text + init tests

**Files:**
- Modify: `packages/vendo/src/cli/init.ts` (lines ~501, ~1050)
- Test: `packages/vendo/src/cli/init.test.ts` (seam users ~660-683, ~820-843; string assertions)

- [x] **Step 1: Update tests first:**
  - "--byo declines…" test: replace the `mint` seam with `deviceLogin: async () => { minted += 1; return 0; }` and assert `sink.logs` contains ``"vendo login"``.
  - "a starter key minted mid-run…" test: replace `promptEmail`/`login`/`mint` seams with a `deviceLogin` seam that writes `.env.local` (`await writeFile(join(root, ".env.local"), \`VENDO_API_KEY=${key}\n\`)` — the fixture has no prior .env.local) and returns 0; assert `.env.local` contains the key and `"No model key yet"` is absent (drop the `"Wrote VENDO_API_KEY to .env.local"` assertion — that line moved into device-login's own receipt, which the seam bypasses).
  - Grep `init.test.ts` for `cloud login` / `device-login` and update expectations to `vendo login`.
- [x] **Step 2: Run** `vitest run src/cli/init.test.ts` — fails on old source strings.
- [x] **Step 3: Implement** in `init.ts`:
  - Line ~501: ``lines.push(`cloud key: none — for Vendo Cloud, fetch ${AUTH_MD_URL} and run \`vendo login\` (your human approves a code in the browser; the key lands in .env.local), then re-run init or pass --cloud-key <key>; --byo with a provider key also works`);``
  - Line ~1050: `` "No model key yet: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY in .env.local, or run `vendo login` for a free dev key." ``
- [x] **Step 4: Run** `vitest run src/cli/init.test.ts` — PASS.
- [x] **Step 5: Commit** `feat(init): agent tail and reminders name vendo login`

### Task 6: Docs (this repo, minus the two files owned by the install.md track)

**Files:**
- Modify: `docs/quickstart.md`, `docs-site/reference/cli.mdx`, `docs-site/deploy/vendo-cloud.mdx`, `docs-site/connect/dev-mode.mdx`, `docs-site/agents/verify.mdx`, `packages/vendo/skills/vendo-setup/SKILL.md`, `packages/vendo/src/cli/cloud/E2E.md`
- Do NOT touch: `docs-site/install.mdx`, `docs-site/agents/index.mdx`

- [x] **Step 1: Apply edits** (read each file first; keep surrounding style):
  - `docs/quickstart.md` (~42-46): the offer is `vendo login` — "it opens your browser to approve a code (agents get the URL + code printed instead), and the minted key is written to `.env.local` for you. You never paste a key." Line ~59: "offers `vendo login` only when a starter key would help." Email OTP: one clause noting `vendo cloud login <email>` remains as a fallback.
  - `docs-site/reference/cli.mdx`: add a `## \`vendo login\`` section (browser approve on TTY, URL + code when non-TTY, `--email` login hint, key lands in `.env.local`, `vendo cloud device-login` is the alias); reword the `## vendo cloud` intro so OTP login reads as the fallback.
  - `docs-site/deploy/vendo-cloud.mdx` "Sign in from the CLI": lead with `vendo login` (browser approval, key to `.env.local`); keep the OTP + `--token` blocks as the fallback subsection; line ~184 "running `vendo cloud login`" → "running `vendo login`".
  - `docs-site/connect/dev-mode.mdx` ~34: "`npx vendo login` mints a free metered dev key."
  - `docs-site/agents/verify.mdx` ~407 and ~432: "run `vendo login` (your human approves in the browser; non-TTY prints the URL + code) — the minted key lands in `.env.local`; then re-run `vendo init` (ask your human first)."
  - `packages/vendo/skills/vendo-setup/SKILL.md` ~119: `` (`npx vendo login`) ``.
  - `packages/vendo/src/cli/cloud/E2E.md`: under "User authentication", lead with `vendo login` / `vendo cloud device-login` (alias) ceremony; mark OTP entries as fallback.
- [x] **Step 2: Grep for leftovers:** `grep -rn "cloud login\|device-login" docs docs-site packages/vendo --include="*.md*" | grep -v node_modules | grep -v superpowers | grep -v archive | grep -v evidence | grep -v install.mdx | grep -v "agents/index.mdx"` — remaining hits must be intentional (alias/fallback mentions).
- [x] **Step 3: Commit** `docs: vendo login is the key ceremony; email OTP demoted`

### Task 7: Full gates + PR

- [x] **Step 1:** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` from the repo root — all green (fix anything that surfaces, e.g. docs tests pinned to old strings).
- [x] **Step 2:** Push branch `yousefh409/vendo-login`, open PR to `main` titled `cli: top-level vendo login (auth.md claim ceremony), OTP demoted`. Body: scope, the coordination note (install.md track lands docs after; `--email` is the hint flag), non-TTY contract unchanged. No publishing/releasing.
- [x] **Step 3:** Report PR number back to Yousef / the install.md session.

## Self-Review

- Spec coverage: (1) top-level login + auto-open + `--email` → Tasks 1-2; (2) alias + OTP demotion → Task 3; (3) init offer switch + agent-tail naming → Tasks 4-5; (4) help/docs/tests/TDD/full suite → Tasks 2-7. ✓
- No placeholders; types consistent (`isTty`/`openBrowser`/`rerunHint` defined in Task 1, used in Task 4's default). ✓
- Circular-import check: `cloud-init.ts` ↔ `device-login.ts` is function-declaration-only at eval time — safe. ✓
