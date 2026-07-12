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
import { createAppData } from "./app-data.js";
import { stubEngine, type GenerationDependencies, type GenerationEngine } from "./engine.js";
import { createAppHistory } from "./history.js";
import { appRecordInput, documentFromRecord } from "./persistence.js";
import type { PinBaseline } from "./pins.js";
import type { SandboxAdapter } from "./sandbox.js";

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

/** 06-apps §1 */
export interface ShareSnapshot {
  id: string;
  doc: AppDocument;
  createdAt: IsoDateTime;
}

/** 06-apps §1 */
export interface PublishRecord {
  id: string;
  appId: AppId;
  version: string;
  createdAt: IsoDateTime;
}

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
  const engine: GenerationEngine = stubEngine;
  const apps = config.store.records("vendo_apps");
  const data = createAppData(config.store);
  const history = createAppHistory(config.store);

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

  const reportLifecycle = async (
    operation: "create" | "delete" | "fork",
    appId: AppId,
    ctx: RunContext,
    extra: Record<string, Json> = {},
  ): Promise<void> => {
    await config.guard.report({
      id: `aud_${crypto.randomUUID()}`,
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
        id: `app_${crypto.randomUUID()}`,
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
      await data.clear(app, ctx.principal.subject);
      await history.clear(appId);
      await apps.delete(appId);
      await reportLifecycle("delete", appId, ctx);
    },

    async fork(appId, ctx) {
      const source = await requireOwned(appId, ctx.principal.subject);
      const fork: AppDocument = {
        ...structuredClone(source),
        id: `app_${crypto.randomUUID()}`,
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
      const generated = await engine.edit(
        { app: structuredClone(previous), instruction },
        generationDependencies(config, config.model),
      );
      const app: AppDocument = { ...generated, id: appId };
      const version: VersionEntry = {
        at: new Date().toISOString(),
        intent: instruction,
        rung: rungFor(app),
      };
      const appRow = appRecordInput(app, ctx.principal.subject);
      await history.append(appId, previous, version);
      await apps.put(appRow);
      return { app: structuredClone(appRow.data), version: { ...version } };
    },

    history(appId) {
      return history.surface(appId);
    },

    // Lane C
    async open(_appId, _ctx) {
      throw new VendoError("not-implemented", "open is implemented in Lane C");
    },

    // Lane C
    async call(_appId, _ref, _args, _ctx) {
      throw new VendoError("not-implemented", "call is implemented in Lane C");
    },

    // Lane E
    async exportApp(_appId, _ctx) {
      throw new VendoError("not-implemented", "export is implemented in Lane E");
    },

    // Lane E
    async importApp(_source, _ctx) {
      throw new VendoError("not-implemented", "import is implemented in Lane E");
    },

    // Lane E
    async share(_appId, _ctx) {
      throw new VendoError("not-implemented", "share is implemented in Lane E");
    },

    // Lane E
    async publish(_appId, _ctx) {
      throw new VendoError("not-implemented", "publish is implemented in Lane E");
    },

    // Lane D
    agentTools() {
      throw new VendoError("not-implemented", "agent tools are implemented in Lane D");
    },

    proxy: {
      // Lane C
      async handler(_request) {
        throw new VendoError("not-implemented", "tool proxy is implemented in Lane C");
      },
    },
  };

  return runtime;
};
