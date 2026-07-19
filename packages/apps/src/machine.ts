import { VendoError, type AppDocument, type RunContext, type SecretsProvider } from "@vendoai/core";
import { mintRunToken, type RunTokenSecret } from "./run-token.js";
import type { RunTokenGate } from "./run-token-gate.js";
import type { SandboxAdapter } from "./sandbox.js";
import {
  toV1SandboxAdapter,
  type V1SandboxAdapter,
  type V1SandboxMachine,
} from "./sandbox-v1-compat.js";
import { FETCH_SHIM_PATH, FETCH_SHIM_SOURCE } from "./scaffold/fetch-shim.js";

const RUN_TTL_MS = 15 * 60 * 1_000;
const PORT = "8080";

const randomHex = (byteLength: number): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** 06-apps §4.2 — fresh authorization claims for one open() or call(). */
export interface MachineAuthorization {
  runToken: string;
  runId: string;
  /** ENG-251 — the run token's anti-replay nonce, tracked so the run's jti can
      be burned when its machine is torn down. */
  jti: string;
}

/** 06-apps §4.2 — live machine plus fresh authorization claims for one operation. */
export interface MachineRun extends MachineAuthorization {
  machine: V1SandboxMachine;
}

/** 06-apps §4.2 — dependencies for an isolated createApps() machine cache. */
export interface MachineSessionsConfig {
  sandbox?: SandboxAdapter | V1SandboxAdapter;
  proxyUrl?: string;
  tokenSecret: RunTokenSecret;
  /** ENG-251 — the shared anti-replay gate the proxy also consults. When a live
      machine is torn down its env token's jti is burned here, revoking the token
      before its TTL elapses. */
  consumedRunTokens?: RunTokenGate;
  /**
   * ENG-345 — resolves real secret values, the SAME seam the egress proxy uses.
   * Consulted ONLY for a secret with an active in-sandbox exposure grant; a
   * secret with no grant stays a handle (Option B default, §4.3).
   */
  secrets?: SecretsProvider;
  /**
   * ENG-345 — the set of declared secret names currently exposed in-sandbox for
   * this app (its active exposure grants). Absent → nothing is exposed, so every
   * secret is a handle. Injected by the runtime from the exposure store so this
   * cache reads the current grant state at every boot.
   */
  resolveExposedSecrets?: (app: AppDocument) => Promise<Set<string>>;
  /**
   * ENG-345 — emit one audit event for a run whose machine this runtime boots
   * with a secret ACTUALLY exposed in-sandbox (via the guard's existing report
   * seam). Constraint 4. Fired at the injection point (adapter.create), so it
   * can never report an exposed run for a handle-only machine — including the
   * resume path, which cannot inject env and therefore never triggers it.
   */
  reportExposedRun?: (app: AppDocument, ctx: RunContext, secrets: string[]) => Promise<void>;
}

/** 06-apps §4.2 — cache, boot, and resume live machines by app id. */
export interface MachineSessions {
  available(): boolean;
  peek(appId: string): V1SandboxMachine | undefined;
  isWaking(appId: string): boolean;
  mintRun(app: AppDocument, ctx: RunContext): Promise<MachineAuthorization>;
  wake(app: AppDocument, ctx: RunContext, authorization: MachineAuthorization): void;
  stop(appId: string): Promise<void>;
  /** 06-apps §2 — remove a cached machine, including one whose resume is still pending. */
  evict(appId: string): Promise<void>;
  withAuthorization<T>(
    app: AppDocument,
    ctx: RunContext,
    authorization: MachineAuthorization,
    fn: (run: MachineRun) => Promise<T>,
  ): Promise<T>;
  withMachine<T>(app: AppDocument, ctx: RunContext, fn: (run: MachineRun) => Promise<T>): Promise<T>;
  /** 06-apps §2 — isolated edit/graduation machine; never enters the live cache before validation. */
  withFork<T>(app: AppDocument, ctx: RunContext, fn: (run: MachineRun) => Promise<T>): Promise<T>;
  /**
   * 06-apps §7 — provision a fresh machine for an imported app directory and
   * snapshot it. Seeds the archive's files and injects the SAME §4.2 run
   * environment the create/edit path builds (PORT + proxy URL + a freshly
   * minted run token + declared secret handles), so an imported rung-2/3 app
   * reaches host tools and the egress endpoint without a subsequent re-edit
   * (ENG-347). The runtime-owned fetch shim is always written last so the copy
   * boots with the current shim, never one an archive smuggled in.
   */
  provisionImport(
    app: AppDocument,
    ctx: RunContext,
    files: Record<string, Uint8Array>,
  ): Promise<string>;
}

/** 06-apps §4.2 and block-plan decision 5. */
export const createMachineSessions = (config: MachineSessionsConfig): MachineSessions => {
  const live = new Map<string, V1SandboxMachine>();
  const waking = new Map<string, Promise<V1SandboxMachine>>();
  // ENG-251 — the jti carried in each live machine's env token, so eviction can
  // revoke exactly that token. Set only when THIS sessions cache boots a fresh
  // machine (adapter.create); a snapshot resume keeps its snapshot-time token,
  // whose jti we never saw, so there is nothing here to burn for it.
  const envJti = new Map<string, string>();

  const requireAdapter = (): V1SandboxAdapter => {
    if (config.sandbox === undefined) {
      throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    }
    // execution-v2 transition: the dying v1 paths below drive any adapter —
    // v2-native or v1-native — through the archived v1 seam (see sandbox-v1-compat.ts).
    return toV1SandboxAdapter(config.sandbox);
  };

  const newRun = async (app: AppDocument, ctx: RunContext): Promise<MachineAuthorization> => {
    const runId = `run_${globalThis.crypto.randomUUID()}`;
    const jti = `jti_${randomHex(16)}`; // 128-bit anti-replay nonce (ENG-251)
    return {
      runId,
      jti,
      runToken: await mintRunToken(config.tokenSecret, {
        appId: app.id,
        subject: ctx.principal.subject,
        runId,
        presence: ctx.presence,
        expiresAt: Date.now() + RUN_TTL_MS,
        jti,
      }),
    };
  };

  const environment = async (
    app: AppDocument,
    runToken: string,
  ): Promise<{ env: Record<string, string>; injected: string[] }> => {
    // ENG-345 — the ONE place a secret's real value can replace its handle in the
    // sandbox env, and ONLY for a secret with an active exposure grant (the
    // exception to §4.3). Every other secret stays an opaque handle (Option B).
    const exposed = config.resolveExposedSecrets === undefined
      ? new Set<string>()
      : await config.resolveExposedSecrets(app);
    const nonce = randomHex(4);
    const secretEnv: Record<string, string> = {};
    const injected: string[] = [];
    for (const name of app.secrets ?? []) {
      if (exposed.has(name) && config.secrets !== undefined) {
        const value = await config.secrets.get(name);
        if (typeof value === "string" && value.length > 0) {
          secretEnv[name] = value; // exposed: REAL value in-sandbox
          injected.push(name);
          continue;
        }
      }
      secretEnv[name] = `vendo-secret:${name}:${nonce}`; // default: opaque handle
    }
    return {
      env: {
        ...secretEnv,
        PORT,
        ...(config.proxyUrl === undefined ? {} : { VENDO_PROXY_URL: config.proxyUrl }),
        VENDO_RUN_TOKEN: runToken,
      },
      injected,
    };
  };

  // ENG-345 — one audit event per run whose machine this runtime boots with a
  // secret ACTUALLY exposed in-sandbox (constraint 4). Emitted at the injection
  // point (adapter.create), so it is impossible to report an exposed run for a
  // machine that carries only handles — including the resume path, which cannot
  // inject env (adapter.resume takes no env) and therefore never audits here.
  const auditInjection = async (
    app: AppDocument,
    ctx: RunContext,
    injected: string[],
  ): Promise<void> => {
    if (injected.length > 0) await config.reportExposedRun?.(app, ctx, injected);
  };

  const start = async (
    app: AppDocument,
    ctx: RunContext,
    auth: { runToken: string; jti: string },
  ): Promise<V1SandboxMachine> => {
    const adapter = requireAdapter();
    const existing = live.get(app.id);
    if (existing !== undefined) return existing;
    const pending = waking.get(app.id);
    if (pending !== undefined) return pending;

    const fresh = app.server === undefined;
    const built = fresh ? await environment(app, auth.runToken) : undefined;
    const promise = built !== undefined
      ? adapter.create({
        env: built.env,
        // ENG-290 M4 — every fresh machine carries the egress fetch shim; the
        // boot convention (runtime.ts) requires it into the app's node processes.
        files: { [FETCH_SHIM_PATH]: FETCH_SHIM_SOURCE },
        egress: app.egress,
      })
      : adapter.resume(app.server as string);
    waking.set(app.id, promise);
    try {
      const machine = await promise;
      live.set(app.id, machine);
      // Only a freshly created machine carries THIS run's env token; a resume
      // keeps its snapshot-time token, whose jti is not ours to burn.
      if (fresh) envJti.set(app.id, auth.jti);
      // ENG-345 — audit the exposed run at the moment real values enter the
      // sandbox (fresh boot only). A resume injects nothing, so it never fires.
      if (built !== undefined) await auditInjection(app, ctx, built.injected);
      return machine;
    } finally {
      if (waking.get(app.id) === promise) waking.delete(app.id);
    }
  };

  const withMachine = async <T>(
    app: AppDocument,
    ctx: RunContext,
    fn: (run: MachineRun) => Promise<T>,
  ): Promise<T> => {
    requireAdapter();
    const run = await newRun(app, ctx);
    const machine = await start(app, ctx, run);
    return fn({ machine, ...run });
  };

  const withAuthorization = async <T>(
    app: AppDocument,
    ctx: RunContext,
    authorization: MachineAuthorization,
    fn: (run: MachineRun) => Promise<T>,
  ): Promise<T> => {
    requireAdapter();
    const machine = await start(app, ctx, authorization);
    return fn({ machine, ...authorization });
  };

  const withFork = async <T>(
    app: AppDocument,
    ctx: RunContext,
    fn: (run: MachineRun) => Promise<T>,
  ): Promise<T> => {
    const adapter = requireAdapter();
    const run = await newRun(app, ctx);
    if (app.server !== undefined) {
      const machine = await adapter.resume(app.server);
      return fn({ machine, ...run });
    }
    // A fresh edit/graduation fork bakes the current exposure state into its
    // snapshot: this is the materialization path for a served app (its next
    // snapshot carries the real value the owner approved). Audit that boot too.
    const built = await environment(app, run.runToken);
    const machine = await adapter.create({
      env: built.env,
      files: { [FETCH_SHIM_PATH]: FETCH_SHIM_SOURCE },
      egress: app.egress,
    });
    await auditInjection(app, ctx, built.injected);
    return fn({ machine, ...run });
  };

  const provisionImport = async (
    app: AppDocument,
    ctx: RunContext,
    files: Record<string, Uint8Array>,
  ): Promise<string> => {
    const adapter = requireAdapter();
    const run = await newRun(app, ctx);
    // An imported app has a fresh AppId with no grants, so environment() injects
    // no real values here — a copy always boots handle-only (constraint 5).
    const built = await environment(app, run.runToken);
    const machine = await adapter.create({
      env: built.env,
      files: { ...files, [FETCH_SHIM_PATH]: FETCH_SHIM_SOURCE },
      egress: app.egress,
    });
    try {
      await auditInjection(app, ctx, built.injected);
      return await machine.snapshot();
    } finally {
      await machine.stop().catch(() => undefined);
    }
  };

  const evict = async (appId: string): Promise<void> => {
    const pending = waking.get(appId);
    if (pending !== undefined) await pending.catch(() => undefined);
    const machine = live.get(appId);
    live.delete(appId);
    // ENG-251 — revoke the run token this machine was booted with: any later
    // presentation of it at the proxy (a replay) is now rejected within its TTL.
    const jti = envJti.get(appId);
    if (jti !== undefined) {
      config.consumedRunTokens?.consume(jti);
      envJti.delete(appId);
    }
    if (machine !== undefined) await machine.stop().catch(() => undefined);
  };

  return {
    available: () => config.sandbox !== undefined,
    peek: (appId) => live.get(appId),
    isWaking: (appId) => waking.has(appId),
    mintRun: newRun,
    wake(app, ctx, authorization) {
      if (live.has(app.id) || waking.has(app.id)) return;
      requireAdapter();
      void start(app, ctx, authorization).catch(() => undefined);
    },
    async stop(appId) {
      await evict(appId);
    },
    evict,
    withAuthorization,
    withMachine,
    withFork,
    provisionImport,
  };
};
