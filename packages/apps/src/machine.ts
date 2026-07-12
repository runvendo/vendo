import { VendoError, type AppDocument, type RunContext, type StoreAdapter } from "@vendoai/core";
import { appRecordInput } from "./persistence.js";
import { mintRunToken, type RunTokenSecret } from "./run-token.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

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
}

/** 06-apps §4.2 — live machine plus fresh authorization claims for one operation. */
export interface MachineRun extends MachineAuthorization {
  machine: SandboxMachine;
}

/** 06-apps §4.2 — dependencies for an isolated createApps() machine cache. */
export interface MachineSessionsConfig {
  sandbox?: SandboxAdapter;
  proxyUrl?: string;
  store: StoreAdapter;
  tokenSecret: RunTokenSecret;
}

/** 06-apps §4.2 — cache, boot, and resume live machines by app id. */
export interface MachineSessions {
  available(): boolean;
  peek(appId: string): SandboxMachine | undefined;
  isWaking(appId: string): boolean;
  mintRun(app: AppDocument, ctx: RunContext): Promise<MachineAuthorization>;
  wake(app: AppDocument, ctx: RunContext, authorization: MachineAuthorization): void;
  stop(appId: string): Promise<void>;
  withAuthorization<T>(
    app: AppDocument,
    ctx: RunContext,
    authorization: MachineAuthorization,
    fn: (run: MachineRun) => Promise<T>,
  ): Promise<T>;
  withMachine<T>(app: AppDocument, ctx: RunContext, fn: (run: MachineRun) => Promise<T>): Promise<T>;
  snapshot(app: AppDocument, ctx: RunContext, machine: SandboxMachine): Promise<AppDocument>;
}

/** 06-apps §4.2 and block-plan decision 5. */
export const createMachineSessions = (config: MachineSessionsConfig): MachineSessions => {
  const live = new Map<string, SandboxMachine>();
  const waking = new Map<string, Promise<SandboxMachine>>();

  const requireAdapter = (): SandboxAdapter => {
    if (config.sandbox === undefined) {
      throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    }
    return config.sandbox;
  };

  const newRun = async (app: AppDocument, ctx: RunContext): Promise<MachineAuthorization> => {
    const runId = `run_${globalThis.crypto.randomUUID()}`;
    return {
      runId,
      runToken: await mintRunToken(config.tokenSecret, {
        appId: app.id,
        subject: ctx.principal.subject,
        runId,
        presence: ctx.presence,
        expiresAt: Date.now() + RUN_TTL_MS,
      }),
    };
  };

  const start = async (app: AppDocument, ctx: RunContext, runToken: string): Promise<SandboxMachine> => {
    const adapter = requireAdapter();
    const existing = live.get(app.id);
    if (existing !== undefined) return existing;
    const pending = waking.get(app.id);
    if (pending !== undefined) return pending;

    const nonce = randomHex(4);
    const secretEnv = Object.fromEntries((app.secrets ?? []).map((name) => [
      name,
      `vendo-secret:${name}:${nonce}`,
    ]));
    const promise = app.server === undefined
      ? adapter.create({
        env: {
          ...secretEnv,
          PORT,
          ...(config.proxyUrl === undefined ? {} : { VENDO_PROXY_URL: config.proxyUrl }),
          VENDO_RUN_TOKEN: runToken,
        },
        files: {},
      })
      : adapter.resume(app.server);
    waking.set(app.id, promise);
    try {
      const machine = await promise;
      live.set(app.id, machine);
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
    const machine = await start(app, ctx, run.runToken);
    return fn({ machine, ...run });
  };

  const withAuthorization = async <T>(
    app: AppDocument,
    ctx: RunContext,
    authorization: MachineAuthorization,
    fn: (run: MachineRun) => Promise<T>,
  ): Promise<T> => {
    requireAdapter();
    const machine = await start(app, ctx, authorization.runToken);
    return fn({ machine, ...authorization });
  };

  return {
    available: () => config.sandbox !== undefined,
    peek: (appId) => live.get(appId),
    isWaking: (appId) => waking.has(appId),
    mintRun: newRun,
    wake(app, ctx, authorization) {
      if (live.has(app.id) || waking.has(app.id)) return;
      requireAdapter();
      void Promise.resolve()
        .then(() => start(app, ctx, authorization.runToken))
        .catch(() => undefined);
    },
    async stop(appId) {
      const pending = waking.get(appId);
      if (pending !== undefined) await pending.catch(() => undefined);
      const machine = live.get(appId);
      live.delete(appId);
      if (machine !== undefined) await machine.stop();
    },
    withAuthorization,
    withMachine,
    async snapshot(app, ctx, machine) {
      if (machine.screenshot !== undefined) {
        const cover = await machine.screenshot();
        await config.store.blobs(`app:${app.id}`).put("cover.png", cover, { contentType: "image/png" });
      }
      const updated = { ...structuredClone(app), server: await machine.snapshot() };
      await config.store.records("vendo_apps").put(appRecordInput(updated, ctx.principal.subject));
      live.set(app.id, machine);
      return updated;
    },
  };
};
