import {
  VendoError,
  type AppDocument,
  type AppId,
  type ComponentCatalog,
  type Guard,
  type IsoDateTime,
  type Json,
  type RunContext,
  type SecretsProvider,
  type StoreAdapter,
  type ToolOutcome,
  type ToolRegistry,
  type UIPayload,
  type VendoTheme,
  type VendoRecord,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { createAgentTools } from "./agent-tools.js";
import { createAppData } from "./app-data.js";
import { createAppCaller } from "./call.js";
import {
  publish,
  share,
  type PublishRecord,
  type ShareSnapshot,
} from "./cloud.js";
import {
  instructionRequiresServer,
  modelEngine,
  type CodeFileEdit,
  type GenerationDependencies,
  type GenerationEngine,
} from "./engine.js";
import { createAppHistory } from "./history.js";
import { createAppInterchange } from "./interchange.js";
import { createMachineSessions } from "./machine.js";
import { createAppOpener } from "./open.js";
import { appRecordInput, documentFromRecord } from "./persistence.js";
import type { PinBaseline } from "./pins.js";
import { createAppsProxy } from "./proxy.js";
import type { SandboxAdapter } from "./sandbox.js";
import type { SandboxMachine } from "./sandbox.js";

/** 06-apps §1 plus block-plan decisions 3–4. */
export interface AppsConfig {
  store: StoreAdapter;
  guard: Guard;
  tools: ToolRegistry;
  sandbox?: SandboxAdapter;
  model?: LanguageModel;
  catalog: ComponentCatalog;
  theme?: VendoTheme;
  secrets?: SecretsProvider;
  designRules?: string;
  proxyUrl?: string;
  pinBaselines?: PinBaseline[];
}

/** 06-apps §1 */
export interface EditResult {
  app: AppDocument;
  version: VersionEntry;
  issues?: string[];
}

/** 06-apps §1 */
export interface VersionEntry {
  at: IsoDateTime;
  intent: string;
  rung: 1 | 2 | 3 | 4;
}

/** 06-apps §1 */
export type OpenSurface =
  | { kind: "tree"; payload: UIPayload; components?: Record<string, string> }
  | { kind: "http"; url: string }
  | { kind: "resuming"; cover?: string };

/** Plan decision 3 — handler mounted by the umbrella at the configured proxy URL. */
export interface AppsProxy {
  handler(request: Request): Promise<Response>;
}

/** 06-apps §1 */
export interface AppsRuntime {
  create(input: { prompt: string }, ctx: RunContext): Promise<AppDocument>;
  get(appId: AppId, ctx: RunContext): Promise<AppDocument | null>;
  list(ctx: RunContext): Promise<AppDocument[]>;
  delete(appId: AppId, ctx: RunContext): Promise<void>;
  fork(appId: AppId, ctx: RunContext): Promise<AppDocument>;
  edit(appId: AppId, instruction: string, ctx: RunContext): Promise<EditResult>;
  history(appId: AppId): { list(): Promise<VersionEntry[]>; undo(): Promise<AppDocument> };
  open(appId: AppId, ctx: RunContext): Promise<OpenSurface>;
  call(appId: AppId, ref: string, args: Json, ctx: RunContext): Promise<ToolOutcome>;
  exportApp(appId: AppId, ctx: RunContext): Promise<Uint8Array>;
  importApp(source: Uint8Array | AppDocument, ctx: RunContext): Promise<AppDocument>;
  share(appId: AppId, ctx: RunContext): Promise<ShareSnapshot>;
  publish(appId: AppId, ctx: RunContext): Promise<PublishRecord>;
  agentTools(): ToolRegistry;
  proxy: AppsProxy;
}

const allRecords = async (
  store: StoreAdapter,
  refs: Record<string, string>,
): Promise<VendoRecord[]> => {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.records("vendo_apps").list(
      cursor === undefined ? { refs } : { refs, cursor },
    );
    records.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
};

const rungFor = (app: AppDocument): VersionEntry["rung"] => {
  if (app.ui === "http") return 4;
  if (app.server !== undefined) return 2;
  return 1;
};

const generationDependencies = (
  config: AppsConfig,
  model: LanguageModel,
): GenerationDependencies => ({
  model,
  catalog: config.catalog,
  theme: config.theme,
  designRules: config.designRules,
});

/** 06-apps §1 — construct the app lifecycle, generation, execution, and interchange surface. */
export const createApps = (config: AppsConfig): AppsRuntime => {
  const engine: GenerationEngine = modelEngine;
  const apps = config.store.records("vendo_apps");
  const data = createAppData(config.store);
  const history = createAppHistory(config.store);
  const tokenSecret = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const machines = createMachineSessions({
    sandbox: config.sandbox,
    proxyUrl: config.proxyUrl,
    store: config.store,
    tokenSecret,
  });

  const owned = async (appId: AppId, subject: string): Promise<AppDocument | null> => {
    const record = await apps.get(appId);
    if (record === null || record.refs?.subject !== subject) return null;
    return documentFromRecord(record);
  };

  const requireOwned = async (appId: AppId, subject: string): Promise<AppDocument> => {
    const app = await owned(appId, subject);
    if (app === null) throw new VendoError("not-found", `app not found: ${appId}`);
    return app;
  };

  const interchange = createAppInterchange({
    store: config.store,
    guard: config.guard,
    sandbox: config.sandbox,
    pinBaselines: config.pinBaselines,
    requireOwned,
  });

  const caller = createAppCaller(machines, config.tools);
  const opener = createAppOpener(machines, caller, config.store);
  const proxy = createAppsProxy({
    tokenSecret,
    tools: config.tools,
    data,
    owns: async (appId, subject) => await owned(appId, subject) !== null,
  });

  const failedEdit = (
    app: AppDocument,
    instruction: string,
    issues: string[],
  ): EditResult => ({
    app: structuredClone(app),
    version: {
      at: new Date().toISOString(),
      intent: instruction,
      rung: rungFor(app),
    },
    issues: [...issues],
  });

  const syntaxCheck = async (
    machine: SandboxMachine,
    file: CodeFileEdit,
  ): Promise<string | undefined> => {
    if (!/\.[cm]?[jt]s$/i.test(file.path)) return undefined;
    const result = await machine.exec(`node --check '${file.path}'`, { cwd: "/app", timeoutMs: 10_000 });
    if (result.code === 0) return undefined;
    const detail = result.stderr.trim() || result.stdout.trim() || `node --check exited ${result.code}`;
    return `${file.path}: ${detail}`;
  };

  const applyCodeFiles = async (
    app: AppDocument,
    files: CodeFileEdit[],
    ctx: RunContext,
  ): Promise<{ machine?: SandboxMachine; server?: string; issues: string[] }> => {
    try {
      return await machines.withFork(
        app,
        ctx,
        async ({ machine }) => {
          try {
            for (const file of files) await machine.files.write(file.path, file.content);
            const issues: string[] = [];
            for (const file of files) {
              const issue = await syntaxCheck(machine, file);
              if (issue !== undefined) issues.push(issue);
            }
            if (issues.length > 0) {
              await machine.stop().catch(() => undefined);
              return { issues };
            }
            return { machine, server: await machine.snapshot(), issues: [] };
          } catch (error) {
            await machine.stop().catch(() => undefined);
            return { issues: [error instanceof Error ? error.message : "machine edit failed"] };
          }
        },
      );
    } catch (error) {
      return {
        issues: [error instanceof Error ? error.message : "sandbox machine unavailable"],
      };
    }
  };

  const persistEdit = async (
    previous: AppDocument,
    app: AppDocument,
    version: VersionEntry,
    subject: string,
  ): Promise<AppDocument> => {
    const appRow = appRecordInput(app, subject);
    await history.append(app.id, previous, version);
    await apps.put(appRow);
    return structuredClone(appRow.data);
  };

  const reportLifecycle = async (
    operation: "create" | "delete" | "fork",
    appId: AppId,
    ctx: RunContext,
    extra: Record<string, Json> = {},
  ): Promise<void> => {
    await config.guard.report({
      id: `aud_${globalThis.crypto.randomUUID()}`,
      at: new Date().toISOString(),
      kind: "app-lifecycle",
      principal: { ...ctx.principal },
      venue: ctx.venue,
      presence: ctx.presence,
      appId,
      trigger: ctx.trigger === undefined ? undefined : { ...ctx.trigger },
      outcome: "ok",
      detail: { operation, ...extra },
    });
  };

  const runtime: AppsRuntime = {
    async create(input, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
      }
      const generated = await engine.create(input, generationDependencies(config, config.model));
      const app: AppDocument = {
        ...generated,
        id: `app_${globalThis.crypto.randomUUID()}`,
      };
      await apps.put(appRecordInput(app, ctx.principal.subject));
      await reportLifecycle("create", app.id, ctx);
      return structuredClone(app);
    },

    async get(appId, ctx) {
      return owned(appId, ctx.principal.subject);
    },

    async list(ctx) {
      const records = await allRecords(config.store, { subject: ctx.principal.subject });
      return records
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .map(documentFromRecord);
    },

    async delete(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      await machines.stop(appId);
      await data.clear(app, ctx.principal.subject);
      await history.clear(appId);
      await apps.delete(appId);
      await reportLifecycle("delete", appId, ctx);
    },

    async fork(appId, ctx) {
      const source = await requireOwned(appId, ctx.principal.subject);
      const fork: AppDocument = {
        ...structuredClone(source),
        id: `app_${globalThis.crypto.randomUUID()}`,
        forkedFrom: source.id,
      };
      await apps.put(appRecordInput(fork, ctx.principal.subject));
      await reportLifecycle("fork", fork.id, ctx, { sourceAppId: source.id });
      return structuredClone(fork);
    },

    async edit(appId, instruction, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
      }
      const previous = await requireOwned(appId, ctx.principal.subject);
      if (instructionRequiresServer(previous, instruction) && !machines.available()) {
        return failedEdit(previous, instruction, [
          "sandbox-unavailable: this edit requires server execution",
        ]);
      }

      let repairIssues: string[] | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const generated = await engine.edit(
          {
            app: structuredClone(previous),
            instruction,
            ...(repairIssues === undefined ? {} : { repairIssues }),
          },
          generationDependencies(config, config.model),
        );
        if (generated.kind === "failure") return failedEdit(previous, instruction, generated.issues);

        if (generated.kind === "document") {
          const app: AppDocument = { ...generated.document, id: appId };
          const version: VersionEntry = {
            at: new Date().toISOString(),
            intent: instruction,
            rung: 1,
          };
          return {
            app: await persistEdit(previous, app, version, ctx.principal.subject),
            version: { ...version },
          };
        }

        const applied = await applyCodeFiles(previous, generated.files, ctx);
        if (applied.machine === undefined || applied.server === undefined) {
          repairIssues = applied.issues;
          continue;
        }
        const app: AppDocument = { ...structuredClone(previous), server: applied.server };
        const version: VersionEntry = {
          at: new Date().toISOString(),
          intent: instruction,
          rung: generated.rung,
        };
        try {
          const persisted = await persistEdit(previous, app, version, ctx.principal.subject);
          await machines.replace(appId, applied.machine);
          return { app: persisted, version: { ...version } };
        } catch (error) {
          await applied.machine.stop().catch(() => undefined);
          throw error;
        }
      }
      return failedEdit(previous, instruction, repairIssues ?? ["code edit failed validation"]);
    },

    history(appId) {
      return history.surface(appId);
    },

    async open(appId, ctx) {
      return opener(await requireOwned(appId, ctx.principal.subject), ctx);
    },

    async call(appId, ref, args, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      return caller.call(app, ref, args, ctx, await machines.mintRun(app, ctx));
    },

    async exportApp(appId, ctx) {
      return interchange.exportApp(appId, ctx);
    },

    async importApp(source, ctx) {
      return interchange.importApp(source, ctx);
    },

    async share(appId, ctx) {
      return share(appId, ctx);
    },

    async publish(appId, ctx) {
      return publish(appId, ctx);
    },

    agentTools() {
      return createAgentTools(runtime);
    },

    proxy,
  };

  return runtime;
};
