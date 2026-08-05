/**
 * ENG-260 away drill: an automation fires with NO live user session and its
 * action executes as the granting user against Maple's own (now Auth.js
 * protected) API.
 *
 * The test boots the REAL Maple app, then composes real store + guard +
 * actions + automations the way the umbrella does — with `actAs` set to the
 * shipped Auth.js preset over the same AUTH_SECRET the app booted with. The
 * grant is captured "while present" (enable + approve); the emit carries no
 * request headers, so the ONLY way the call can reach the 401-walled API is
 * the actAs-minted real session token.
 *
 * The drill's executing step is `host_getProfile` — an auth-walled call an
 * automation may legally run unattended — because THE LAW (design §12) means a
 * destructive-or-external tool never enters an unattended run at all:
 * automations "may **not** move money, message humans, or delete — those tools
 * are not projected into an automation run at all". This file drove
 * `host_transferMoney` until 2026-07-31; that expectation predates the law, and
 * moving money is the first thing §12 names. The law's own behaviour on that
 * tool is now its own scenario here, so the authority mechanic and the law are
 * each proven instead of colliding.
 *
 * Why a read and not a write: Maple's ENTIRE mutating surface is off-limits or
 * unreachable. `/api/transfers` and `/api/orders` both move money, `/api/demo/reset`
 * is destructive, `/api/voice` sits on a PUBLIC proxy prefix (src/proxy.ts) so a
 * write there would sail past the auth wall and prove nothing, and `/api/demo/pin`
 * writes the app row in the SERVER's store, which this test's own temp store
 * cannot see. So the drill proves the authority mechanic on the strongest legal
 * call Maple has: `/api/profile` is the one endpoint whose answer is derived from
 * the SESSION rather than the shared demo seed, which is what lets the away run's
 * own recorded answer name the granting user.
 *
 * That answer is captured at the stack's own `fetch` seam. It was read out of the
 * guard's effect ledger until 2026-07-31, which worked only because
 * `host_getProfile` mis-voted `write` and so got receipted; now that the vote
 * reads `verb_noun` correctly the call is a `read`, and §12's "reads are silent,
 * always" means there is no receipt to read. The real HTTP response is the better
 * witness anyway — it is what Maple actually sent, not a record of it — and the
 * empty ledger became an assertion of its own.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_PATH } from "@/lib/base-path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TRIGGER_ID, UNATTENDED_DESTRUCTIVE_REASON } from "@vendoai/core";
import type { AppDocument, Principal, Step, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createActions } from "@vendoai/actions";
import { authJsPreset } from "@vendoai/actions/presets/auth-js";
import { createApps } from "@vendoai/apps";
import { createAutomations, type AutomationsEngine } from "@vendoai/automations";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { createStore, type VendoStore } from "@vendoai/store";
import { mapleDemoUsers } from "@/server/users";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const AUTH_SECRET = "maple-away-drill-secret";
const BOOT_MS = 240_000;

const MAPLE_USERS = mapleDemoUsers();
const SEEDED = new Set(MAPLE_USERS.map((user) => user.subject));
/** The granting user is deliberately NOT Maple's primary seeded identity:
 *  `/api/profile` merges the SESSION's name+email over a shared demo seed that
 *  hardcodes the primary user's (server/accounts.ts `getProfile`). Granting as
 *  the second user is therefore what makes the away run's own answer prove
 *  WHOSE session reached Maple — the seed alone could never produce it. */
const GRANTING_USER = MAPLE_USERS[1]!;
const SEED_IDENTITY_USER = MAPLE_USERS[0]!;

/** The tool the drill executes: Maple's own auth-walled profile read. Legal
 *  unattended AND behind the 401 wall, which is what keeps the actAs-minted
 *  session load-bearing — `/api/voice` and `/api/auth` are public prefixes
 *  (src/proxy.ts), so a call there would prove nothing. */
const DRILL_TOOL = "host_getProfile";
/** The tool THE LAW withholds: it moves money. */
const MONEY_TOOL = "host_transferMoney";
/** The exact strings the pre-law drill asserted were PRESENT in Maple's ledger.
 *  They must now be absent: nothing may execute. */
const MONEY_RECIPIENT = "Away Drill";
const MONEY_MEMO = "ENG-260 away drill";

let child: ChildProcessWithoutNullStreams | undefined;
let serverOutput = "";
/** The app's own root — the origin plus the mount point Maple is served under.
 *  What a visitor types, and what every page/API fetch hangs off. */
let baseUrl = "";
/** The bare origin. The WIRE base: `binding.path` in tools.json already carries
 *  the mount point, so joining it onto `baseUrl` would double it. */
let origin = "";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** Next's dev server can reset an in-flight socket while compiling a route. */
async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

async function waitForApp(): Promise<void> {
  const deadline = Date.now() + BOOT_MS;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`Maple exited early (${child.exitCode})\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) return;
    } catch {
      // still compiling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Maple did not become ready\n${serverOutput}`);
}

interface Stack {
  store: VendoStore;
  guard: VendoGuard;
  bound: ToolRegistry;
  automations: AutomationsEngine;
  dataDir: string;
  /** Every body Maple returned to a tool call made THROUGH this stack — see
   *  {@link createStack}. The away run's own evidence channel. */
  hostAnswers: string[];
  close(): Promise<void>;
}

async function mapleTools(): Promise<Parameters<typeof createActions>[0]["tools"]> {
  const parsed = JSON.parse(await readFile(join(appDir, ".vendo", "tools.json"), "utf8")) as {
    tools: unknown[];
  };
  return parsed.tools as Parameters<typeof createActions>[0]["tools"];
}

/**
 * Maple's own `.vendo/overrides.json`, handed to the registry exactly as the
 * real composition hands it.
 *
 * It used to be left out, and while extraction guessed grades from tool names
 * that was invisible — the raw catalog already carried a `risk` for everything.
 * Grades now come from a person, the judge, or a protocol fact (risk-grading
 * redesign D2), so a drill built from the catalog ALONE sees `ungraded` where
 * the running app sees Maple's authored grade. Loading the file is what makes
 * this drill the app again.
 */
async function mapleOverrides(): Promise<Parameters<typeof createActions>[0]["overrides"]> {
  return JSON.parse(await readFile(join(appDir, ".vendo", "overrides.json"), "utf8")) as
    Parameters<typeof createActions>[0]["overrides"];
}

async function createStack(): Promise<Stack> {
  const dataDir = await mkdtemp(join(tmpdir(), "maple-away-drill-"));
  const hostAnswers: string[] = [];
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({ store });
  const actions = createActions({
    tools: await mapleTools(),
    overrides: await mapleOverrides(),
    baseUrl: origin,
    // The drill's point: away identity is a REAL Auth.js session minted with
    // the host's own secret. Unknown subjects are declined via claims → null.
    actAs: authJsPreset({
      secret: AUTH_SECRET,
      claims: (principal) => (SEEDED.has(principal.subject) ? {} : null),
    }),
    // The away call's OWN answer, captured at the real HTTP boundary. §12 says
    // "reads are silent, always", so the drill's read leaves no effect receipt
    // to read back, and a run record carries step outcomes only — this seam is
    // the one place Maple's response to an away call survives. It is also the
    // most direct evidence there is: the actual bytes Maple sent the away run,
    // not a guard-written record of them.
    fetch: async (input, init) => {
      const response = await appFetch(String(input), init);
      hostAnswers.push(await response.clone().text());
      return response;
    },
  });
  const bound = guard.bind(actions);
  const apps = createApps({ store, guard, tools: bound, catalog: [] });
  const automations = createAutomations({ apps, tools: bound, guard, store });
  return {
    store,
    guard,
    bound,
    automations,
    dataDir,
    hostAnswers,
    async close() {
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** One-step automation on the shared `maple.payday` host event. */
function oneStepAutomation(id: string, name: string, step: Step): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name,
    triggers: [{
      id: DEFAULT_TRIGGER_ID,
      on: { kind: "host-event", event: "maple.payday" },
      run: { kind: "steps", steps: [step] },
    }],
  };
}

/** The drill's executing step: ask Maple who the away session belongs to. */
function whoamiAutomation(id: string): AppDocument {
  return oneStepAutomation(id, "Payday summary", { id: "whoami", tool: DRILL_TOOL, args: {} });
}

/** The step THE LAW must refuse: an automation moving money. Steps args are
 *  JSONata expressions — strings need quoting. */
function paydayAutomation(id: string): AppDocument {
  return oneStepAutomation(id, "Payday sweep", {
    id: "transfer",
    tool: MONEY_TOOL,
    args: { amount: "25", recipient_name: `'${MONEY_RECIPIENT}'`, memo: `'${MONEY_MEMO}'` },
  });
}

function ownerCtx(principal: Principal, appId: string) {
  return {
    principal,
    venue: "chat" as const,
    presence: "present" as const,
    sessionId: `sess_${principal.subject}`,
    appId,
  };
}

async function enableAndApprove(stack: Stack, subject: string, doc: AppDocument): Promise<void> {
  const appId = doc.id;
  const principal: Principal = { kind: "user", subject };
  await stack.store.records("vendo_apps").put({
    id: appId,
    data: { subject, enabled: false, doc },
    refs: { subject },
  });
  const enabled = await stack.automations.enable(appId, DEFAULT_TRIGGER_ID, ownerCtx(principal, appId));
  expect(enabled.enabled).toBe(true);
  if (enabled.missing.length > 0) {
    await stack.guard.approvals.decide(
      enabled.missing.map((request) => request.id),
      { approve: true },
      principal,
    );
  }
}

/** Read Maple's own API as `subject`, with a session minted the same way the
 *  away run's actAs mints one. This is the evidence channel, not the subject. */
async function readAs(subject: string, tool: string, path: string): Promise<Response> {
  const material = await authJsPreset({ secret: AUTH_SECRET })(
    { kind: "user", subject },
    {
      id: "grt_evidence",
      subject,
      tool,
      descriptorHash: "sha256:evidence",
      scope: { kind: "tool" },
      duration: "session",
      source: "chat",
      grantedAt: new Date().toISOString(),
    },
  );
  return appFetch(`${baseUrl}${path}`, { headers: material!.headers });
}

async function descriptorFor(stack: Stack, name: string): Promise<ToolDescriptor> {
  const found = (await stack.bound.descriptors({ venue: "chat", presence: "present" })).find(
    (descriptor) => descriptor.name === name,
  );
  expect(found, `${name} is not in Maple's extracted toolset`).toBeDefined();
  return found!;
}

/** Rows in the guard's effect ledger (build contract §7), which receipts every
 *  MUTATING call and NOTHING else. The drill's step is a read, so §12's "reads
 *  are silent, always" says this stays empty — asserted rather than assumed,
 *  because an effect row on a read is exactly the bug that made
 *  `host_getProfile` vote `write`. */
async function effectRows(stack: Stack, subject: string): Promise<unknown[]> {
  const page = await stack.store.records("vendo_effects").list({ refs: { subject } });
  return page.records.map((record) => record.data);
}

/** Maple's checking balance, as the granting user. `transferMoney` debits this
 *  (server/transfers.ts), so it is the money-moved witness. */
async function checkingBalance(subject: string): Promise<number> {
  const response = await readAs(subject, "host_listAccounts", "/api/accounts");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<{ kind: string; balance: number }> };
  const checking = body.data.find((account) => account.kind === "checking");
  expect(checking, "Maple seeds a checking account").toBeDefined();
  return checking!.balance;
}

beforeAll(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  baseUrl = `${origin}${BASE_PATH}`;
  const env = {
    ...process.env,
    AUTH_SECRET,
    VENDO_BASE_URL: origin,
    NEXT_TELEMETRY_DISABLED: "1",
    MAPLE_DIST_DIR: ".next/away-drill",
  };
  delete (env as Record<string, string | undefined>).NODE_ENV; // vitest's "test" would leak into next dev
  const spawned = spawn(join(appDir, "node_modules", ".bin", "next"), ["dev", "-p", String(port)], {
    cwd: appDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = spawned;
  spawned.stdout.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000);
  });
  spawned.stderr.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000);
  });
  await waitForApp();
}, BOOT_MS);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
});

describe("Maple away drill (ENG-260)", () => {
  it("walls the bank API off behind the real login", { timeout: 120_000 }, async () => {
    const anonymous = await appFetch(`${baseUrl}/api/transfers?amount=25&recipient_name=Nope`, {
      method: "POST",
    });
    expect(anonymous.status).toBe(401);

    // The drill's own path, walled the same way — this is what makes the
    // actAs-minted session the only way an away run gets an answer.
    const profile = await appFetch(`${baseUrl}/api/profile`);
    expect(profile.status).toBe(401);

    // `baseUrl` IS the app root (origin + mount point) — a trailing slash on top
    // of it is a different URL, and Next answers it with its own 308 to the
    // canonical path instead of the login bounce this asserts.
    const page = await appFetch(baseUrl, { redirect: "manual" });
    expect([302, 303, 307, 308]).toContain(page.status);
    expect(page.headers.get("location")).toContain("/maple/login");
  });

  it("executes an automation as the granting user with no live session", { timeout: 120_000 }, async () => {
    const stack = await createStack();
    try {
      const subject = GRANTING_USER.subject;
      const appId = "app_away_whoami";

      // The drill's subject is the authority mechanic, so the tool it runs must
      // be one an automation may legally run unattended. Pin the declared label
      // (overrides.json — the dev's label is final; two-vote grading removed),
      // so relabelling or repointing this step fails here loudly instead of
      // silently turning the drill into a law test.
      const profile = await descriptorFor(stack, DRILL_TOOL);
      expect(profile.risk).toBe("read");

      await enableAndApprove(stack, subject, whoamiAutomation(appId));

      // No request, no cookie, no live session anywhere: the host event fires.
      const runIds = await stack.automations.emit(
        "maple.payday",
        { requestedBy: "away-drill" },
        { kind: "user", subject },
      );
      expect(runIds).toHaveLength(1);
      const run = await stack.automations.runs.get(
        runIds[0]!,
        ownerCtx({ kind: "user", subject }, appId),
      );
      expect(run?.status).toBe("ok");
      expect(run?.steps.map(({ id, outcome }) => ({ id, outcome }))).toEqual([
        { id: "whoami", outcome: "ok" },
      ]);

      // The call landed in Maple AS THE GRANTING USER: her own name and email
      // came back. Neither is in the shared demo seed — that seed hardcodes the
      // OTHER user's identity, so its absence here is what rules out "some
      // valid session" and "no session at all".
      expect(stack.hostAnswers).toHaveLength(1);
      const answer = stack.hostAnswers[0]!;
      const identity = (JSON.parse(answer) as { data?: { name?: string; email?: string } }).data ?? {};
      expect(identity.email).toBe(GRANTING_USER.email);
      expect(identity.name).toBe(GRANTING_USER.display);

      // §12, "reads are silent, always": the away run really executed, and it
      // left the effect ledger empty. This is the assertion the drill could not
      // make while `host_getProfile` voted `write` — back then the row below was
      // the drill's evidence channel.
      expect(await effectRows(stack, subject)).toEqual([]);
      // Asserted on the IDENTITY fields, not the whole body: since E8 the same
      // payload also carries the seeded roster (the account switcher offers the
      // other staff member by email), and whose ROSTER came back says nothing
      // about whose SESSION ran the call — whose identity came back does.
      expect(identity.email).not.toBe(SEED_IDENTITY_USER.email);
    } finally {
      await stack.close();
    }
  });

  /** THE LAW (design §12): automations "may **not** move money, message humans,
   *  or delete — those tools are not projected into an automation run at all.
   *  Not with a limit, not with a condition, not with an admin override." The
   *  drill above used to BE this step, and expected it to succeed; that
   *  expectation predates the law. Maple's `host_transferMoney` "IRREVERSIBLY
   *  MOVES MONEY", so the honest pattern is prepare-then-a-person-sends. */
  it("refuses host_transferMoney in an unattended run — never projected, never sent (THE LAW, §12)", { timeout: 120_000 }, async () => {
    const stack = await createStack();
    try {
      const subject = GRANTING_USER.subject;
      const appId = "app_away_payday";
      const pay = await descriptorFor(stack, MONEY_TOOL);
      expect(pay.risk).toBe("destructive");

      // Enable + approve while present: the ceremony sees the tool and mints the
      // strongest authority that exists (app-bound, automation-source). The law
      // must beat it.
      await enableAndApprove(stack, subject, paydayAutomation(appId));
      const balanceBefore = await checkingBalance(subject);

      // 1. Not projected: an unattended run is never even offered the tool.
      const projected = await stack.bound.descriptors({
        venue: "automation",
        presence: "away",
      });
      expect(projected.map(({ name }) => name)).not.toContain(MONEY_TOOL);

      // 2. The run refuses with the law's own reason — the constant both sides
      //    read, so the test and the law cannot drift.
      const runIds = await stack.automations.emit(
        "maple.payday",
        { requestedBy: "away-drill" },
        { kind: "user", subject },
      );
      expect(runIds).toHaveLength(1);
      const run = await stack.automations.runs.get(
        runIds[0]!,
        ownerCtx({ kind: "user", subject }, appId),
      );
      expect(run?.status).toBe("error");
      expect(run?.steps.map(({ id, tool, outcome, detail }) => ({ id, tool, outcome, detail })))
        .toEqual([
          {
            id: "transfer",
            tool: MONEY_TOOL,
            outcome: "blocked",
            detail: UNATTENDED_DESTRUCTIVE_REASON,
          },
        ]);
      expect(run?.error?.message).toBe(UNATTENDED_DESTRUCTIVE_REASON);

      // 3. No money moved: the balance is untouched and Maple's ledger has no
      //    such transfer. These two strings are exactly what the pre-law drill
      //    asserted were PRESENT.
      expect(await checkingBalance(subject)).toBe(balanceBefore);
      const ledger = await readAs(subject, "host_listTransactions", "/api/transactions?limit=50");
      expect(ledger.status).toBe(200);
      const entries = JSON.stringify(await ledger.json());
      expect(entries).not.toContain(MONEY_RECIPIENT);
      expect(entries).not.toContain(MONEY_MEMO);
    } finally {
      await stack.close();
    }
  });

  it("fails closed when the grant's subject is not a Maple user", { timeout: 120_000 }, async () => {
    const stack = await createStack();
    try {
      const subject = "user_ghost";
      const appId = "app_away_ghost";
      await enableAndApprove(stack, subject, whoamiAutomation(appId));
      const runIds = await stack.automations.emit(
        "maple.payday",
        {},
        { kind: "user", subject },
      );
      const run = await stack.automations.runs.get(
        runIds[0]!,
        ownerCtx({ kind: "user", subject }, appId),
      );
      // actAs declines (claims → null) → the step surfaces the seam error and
      // nothing reaches Maple's API.
      expect(run?.status).not.toBe("ok");
    } finally {
      await stack.close();
    }
  });
});
