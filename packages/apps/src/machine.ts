import { VendoError, type AppDocument, type RunContext } from "@vendoai/core";
import { mintRunToken, type RunTokenSecret } from "./run-token.js";
import type { RunTokenGate } from "./run-token-gate.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
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
  machine: SandboxMachine;
}

/** 06-apps §4.2 — dependencies for an isolated createApps() machine cache. */
export interface MachineSessionsConfig {
  sandbox?: SandboxAdapter;
  proxyUrl?: string;
  tokenSecret: RunTokenSecret;
  /** ENG-251 — the shared anti-replay gate the proxy also consults. When a live
      machine is torn down its env token's jti is burned here, revoking the token
      before its TTL elapses. */
  consumedRunTokens?: RunTokenGate;
}

/** 06-apps §4.2 — cache, boot, and resume live machines by app id. */
export interface MachineSessions {
  available(): boolean;
  peek(appId: string): SandboxMachine | undefined;
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
  const live = new Map<string, SandboxMachine>();
  const waking = new Map<string, Promise<SandboxMachine>>();
  // ENG-251 — the jti carried in each live machine's env token, so eviction can
  // revoke exactly that token. Set only when THIS sessions cache boots a fresh
  // machine (adapter.create); a snapshot resume keeps its snapshot-time token,
  // whose jti we never saw, so there is nothing here to burn for it.
  const envJti = new Map<string, string>();

  const requireAdapter = (): SandboxAdapter => {
    if (config.sandbox === undefined) {
      throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    }
    return config.sandbox;
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

  const environment = (app: AppDocument, runToken: string): Record<string, string> => {
    const nonce = randomHex(4);
    const secretEnv = Object.fromEntries((app.secrets ?? []).map((name) => [
      name,
      `vendo-secret:${name}:${nonce}`,
    ]));
    return {
      ...secretEnv,
      PORT,
      ...(config.proxyUrl === undefined ? {} : { VENDO_PROXY_URL: config.proxyUrl }),
      VENDO_RUN_TOKEN: runToken,
    };
  };

  const start = async (
    app: AppDocument,
    ctx: RunContext,
    auth: { runToken: string; jti: string },
  ): Promise<SandboxMachine> => {
    const adapter = requireAdapter();
    const existing = live.get(app.id);
    if (existing !== undefined) return existing;
    const pending = waking.get(app.id);
    if (pending !== undefined) return pending;

    const fresh = app.server === undefined;
    const promise = app.server === undefined
      ? adapter.create({
        env: environment(app, auth.runToken),
        // ENG-290 M4 — every fresh machine carries the egress fetch shim; the
        // boot convention (runtime.ts) requires it into the app's node processes.
        files: { [FETCH_SHIM_PATH]: FETCH_SHIM_SOURCE },
        egress: app.egress,
      })
      : adapter.resume(app.server);
    waking.set(app.id, promise);
    try {
      const machine = await promise;
      live.set(app.id, machine);
      // Only a freshly created machine carries THIS run's env token; a resume
      // keeps its snapshot-time token, whose jti is not ours to burn.
      if (fresh) envJti.set(app.id, auth.jti);
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
    const machine = app.server === undefined
      ? await adapter.create({
        env: environment(app, run.runToken),
        files: { [FETCH_SHIM_PATH]: FETCH_SHIM_SOURCE },
        egress: app.egress,
      })
      : await adapter.resume(app.server);
    return fn({ machine, ...run });
  };

  const provisionImport = async (
    app: AppDocument,
    ctx: RunContext,
    files: Record<string, Uint8Array>,
  ): Promise<string> => {
    const adapter = requireAdapter();
    const run = await newRun(app, ctx);
    const machine = await adapter.create({
      env: environment(app, run.runToken),
      files: { ...files, [FETCH_SHIM_PATH]: FETCH_SHIM_SOURCE },
      egress: app.egress,
    });
    try {
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
