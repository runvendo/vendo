import {
  VendoError,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type ComponentCatalog,
  type Guard,
  type IsoDateTime,
  type Json,
  type RunContext,
  type RiskLabel,
  type SecretsProvider,
  type StoreAdapter,
  type ToolCall,
  type ToolOutcome,
  type ToolRegistry,
  type Tree,
  type UIPayload,
  type VendoViewPart,
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
import { createAppOpener, createProgressiveQueryResolver } from "./open.js";
import { appRecordInput, documentFromRecord, enabledAfterDocumentEdit, rowFromRecord } from "./persistence.js";
import { pinComponentName, type PinBaseline } from "./pins.js";
import { createAppsProxy } from "./proxy.js";
import { createRunTokenGate } from "./run-token-gate.js";
import type { SandboxAdapter } from "./sandbox.js";
import type { SandboxMachine } from "./sandbox.js";
import { servedAppScaffold } from "./scaffold/index.js";
import type { IpResolver } from "./ssrf.js";

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
  /**
   * ENG-259 — advanced egress seam for the allowlisted secret-egress proxy (§4.3).
   * Defaults are zero-config on Node: global fetch + node:dns. A non-Node host (edge)
   * or a test injects its own transport/resolver here.
   */
  egressTransport?: { fetch?: typeof globalThis.fetch; resolveIp?: IpResolver };
}

/** 06-apps §1 */
export interface EditResult {
  app: AppDocument;
  version: VersionEntry;
  issues?: string[];
  /** Additive failure detail: when present, no edit was persisted. */
  failure?: EditFailure;
}

export interface EditFailure {
  code: "edit-rejected";
  retryable: boolean;
  message: string;
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
  create(input: {
    prompt: string;
    /** Additive per-call stream hook used by the agent bridge. */
    onView?: (part: VendoViewPart) => void;
  }, ctx: RunContext): Promise<AppDocument>;
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
  /** Contextual policy projection for Vendo-owned agent tools. Undefined means
   * the static descriptor remains authoritative. */
  agentToolRisk(call: ToolCall, ctx: RunContext): Promise<RiskLabel | undefined>;
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

const rungFor = (
  app: AppDocument,
  declared?: VersionEntry["rung"],
): VersionEntry["rung"] => {
  if (app.ui === "http") return 4;
  if (app.server !== undefined) return declared === 3 ? 3 : 2;
  return 1;
};

const generationDependencies = (
  config: AppsConfig,
  model: LanguageModel,
  onPartial?: GenerationDependencies["onPartial"],
): GenerationDependencies => ({
  model,
  catalog: config.catalog,
  theme: config.theme,
  designRules: config.designRules,
  pinBaselines: config.pinBaselines,
  ...(onPartial === undefined ? {} : { onPartial }),
});

const pinnedSubtree = (app: AppDocument, componentName: string): unknown[] => {
  if (app.tree?.formatVersion !== "vendo-genui/v1") return [];
  const tree = app.tree as unknown as Tree;
  const included = new Set(tree.nodes.filter((node) => node.component === componentName).map((node) => node.id));
  const pending = [...included];
  while (pending.length > 0) {
    const node = tree.nodes.find(({ id }) => id === pending.pop());
    for (const child of node?.children ?? []) {
      if (included.has(child)) continue;
      included.add(child);
      pending.push(child);
    }
  }
  return tree.nodes.filter(({ id }) => included.has(id));
};

const touchedPinSlots = (previous: AppDocument, next: AppDocument): string[] => {
  const previousPins = new Map((previous.pins ?? []).map((pin) => [pin.slot, pin]));
  return (next.pins ?? []).flatMap((pin) => {
    const prior = previousPins.get(pin.slot);
    if (prior?.base !== pin.base) return [pin.slot];
    const componentName = pinComponentName(pin.slot);
    if (previous.components?.[componentName] !== next.components?.[componentName]) return [pin.slot];
    // Subtree serialization intentionally over-reports reordered nodes as touched.
    return JSON.stringify(pinnedSubtree(previous, componentName)) === JSON.stringify(pinnedSubtree(next, componentName))
      ? []
      : [pin.slot];
  });
};

/** 06-apps §1 — construct the app lifecycle, generation, execution, and interchange surface. */
export const createApps = (config: AppsConfig): AppsRuntime => {
  const engine: GenerationEngine = modelEngine;
  const apps = config.store.records("vendo_apps");
  const data = createAppData(config.store);
  const history = createAppHistory(config.store);
  const tokenSecret = globalThis.crypto.getRandomValues(new Uint8Array(32));
  // ENG-251 — one anti-replay gate shared by the machine cache (which burns a
  // run's jti on teardown) and the proxy (which rejects a burned jti).
  const consumedRunTokens = createRunTokenGate();
  const machines = createMachineSessions({
    sandbox: config.sandbox,
    proxyUrl: config.proxyUrl,
    tokenSecret,
    consumedRunTokens,
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
    loadApp: owned,
    ...(config.secrets === undefined ? {} : { secrets: config.secrets }),
    ...(config.egressTransport?.fetch === undefined ? {} : { fetch: config.egressTransport.fetch }),
    ...(config.egressTransport?.resolveIp === undefined ? {} : { resolveIp: config.egressTransport.resolveIp }),
    consumedRunTokens,
  });

  const failedEdit = (
    app: AppDocument,
    instruction: string,
    issues: string[],
    retryable = true,
  ): EditResult => ({
    app: structuredClone(app),
    version: {
      at: new Date().toISOString(),
      intent: instruction,
      rung: rungFor(app),
    },
    issues: [...issues],
    failure: {
      code: "edit-rejected",
      retryable,
      message: retryable
        ? "Edit was not applied. Retry vendo_apps_edit on the same app with a narrower instruction; do not rebuild the app."
        : "Edit was not applied and cannot be retried until the reported blocker is resolved.",
    },
  });

  const appendIssues = (current: string[], next: string[]): string[] => [
    ...new Set([...current, ...next]),
  ];

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
    rung: VersionEntry["rung"],
    ctx: RunContext,
  ): Promise<{ server?: string; cover?: Uint8Array; issues: string[] }> => {
    const graduatesToHttp = rung === 4 && app.ui !== "http";
    try {
      return await machines.withFork(
        app,
        ctx,
        async ({ machine }) => {
          try {
            if (rung === 4 && machine.url === undefined) {
              return { issues: ["sandbox-unavailable: adapter cannot serve http apps"] };
            }
            if (graduatesToHttp) {
              const scaffold = servedAppScaffold(app);
              const scaffoldPaths = new Set(scaffold.map((file) => file.path));
              const collision = files.find((file) => scaffoldPaths.has(file.path));
              if (collision !== undefined) {
                return {
                  issues: [`initial rung-4 graduation cannot replace scaffold file "${collision.path}"; edit it after graduation`],
                };
              }
              for (const file of scaffold) {
                await machine.files.write(file.path, file.content);
              }
            }
            for (const file of files) await machine.files.write(file.path, file.content);
            const issues: string[] = [];
            for (const file of files) {
              const issue = await syntaxCheck(machine, file);
              if (issue !== undefined) issues.push(issue);
            }
            if (issues.length > 0) {
              return { issues };
            }
            if (graduatesToHttp) {
              const started = await machine.exec(
                "nohup sh /app/start.sh >/tmp/vendo-app.log 2>&1 &",
                { cwd: "/app", timeoutMs: 10_000 },
              );
              if (started.code !== 0) {
                const detail = started.stderr.trim() || started.stdout.trim() || `start command exited ${started.code}`;
                return { issues: [`served-app scaffold failed to start: ${detail}`] };
              }
            }
            const cover = rung === 4 && machine.screenshot !== undefined
              ? await machine.screenshot()
              : undefined;
            const server = await machine.snapshot();
            return cover === undefined ? { server, issues: [] } : { server, cover, issues: [] };
          } catch (error) {
            return { issues: [error instanceof Error ? error.message : "machine edit failed"] };
          } finally {
            await machine.stop().catch(() => undefined);
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
    // Best-effort optimistic concurrency. The core StoreAdapter seam (01-core §12) has
    // no compare-and-swap or transactions, so a narrow TOCTOU window between the final
    // check and the put remains — closing it fully needs a store-level revision column
    // (a store-block follow-up). This catches the common edit-vs-undo / double-edit races.
    const assertCurrent = async (): Promise<boolean> => {
      const current = await apps.get(previous.id);
      const row = current === null ? null : rowFromRecord(current);
      if (row === null
        || row.subject !== subject
        || JSON.stringify(row.doc) !== JSON.stringify(previous)) {
        throw new VendoError("conflict", `app changed during edit: ${previous.id}`);
      }
      return row.enabled;
    };
    await assertCurrent();
    await history.append(app.id, previous, version, touchedPinSlots(previous, app));
    const wasEnabled = await assertCurrent();
    // A changed trigger must be re-armed — enable() re-captures and re-mints trigger state.
    const enabled = enabledAfterDocumentEdit(previous, app, wasEnabled);
    const appRow = appRecordInput(app, subject, enabled);
    await apps.put(appRow);
    return structuredClone(appRow.data.doc);
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
      // Mint before generation so every partial already carries its permanent id.
      const appId = `app_${globalThis.crypto.randomUUID()}`;
      const emit = (payload: Tree): void => input.onView?.({
        type: "data-vendo-view",
        appId,
        payload: payload as unknown as UIPayload,
      });
      let latestTree: Tree | undefined;
      const queryApp: AppDocument = {
        format: "vendo/app@1",
        id: appId,
        name: "Generating app",
        ui: "tree",
      };
      const queryResolver = input.onView === undefined
        ? undefined
        : createProgressiveQueryResolver(machines, caller, queryApp, ctx, (data) => {
          if (latestTree === undefined) return;
          emit({ ...structuredClone(latestTree), data, streaming: true } as Tree);
        });
      const generated = await engine.create(
        { prompt: input.prompt },
        generationDependencies(config, config.model, input.onView === undefined ? undefined : (partial) => {
          latestTree = structuredClone(partial.tree);
          emit(latestTree);
          queryResolver?.update(latestTree);
        }),
      );
      const app: AppDocument = {
        ...generated,
        id: appId,
      };
      let finalTree: Tree | undefined;
      if (input.onView !== undefined && app.tree?.formatVersion === "vendo-genui/v1") {
        finalTree = {
          ...(structuredClone(app.tree) as unknown as Tree),
          ...(app.components === undefined ? {} : { components: structuredClone(app.components) }),
        };
        latestTree = structuredClone(finalTree);
        queryResolver?.update(finalTree);
        finalTree.data = await queryResolver?.complete() ?? structuredClone(finalTree.data ?? {});
      }
      await apps.put(appRecordInput(app, ctx.principal.subject));
      await reportLifecycle("create", app.id, ctx);
      if (finalTree !== undefined) emit(finalTree);
      return structuredClone(app);
    },

    async get(appId, ctx) {
      return owned(appId, ctx.principal.subject);
    },

    async list(ctx) {
      const records = await allRecords(config.store, { subject: ctx.principal.subject });
      const documents: AppDocument[] = [];
      for (const record of records
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))) {
        try {
          documents.push(documentFromRecord(record));
        } catch {
          // Corrupt rows cannot be surfaced, but must not hide valid owned apps.
        }
      }
      return documents;
    },

    async delete(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      await machines.stop(appId);
      await data.clear(app, ctx.principal.subject, await history.documents(appId));
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
      if (source.server !== undefined && config.sandbox !== undefined) {
        const machine = await config.sandbox.resume(source.server);
        try {
          fork.server = await machine.snapshot();
        } finally {
          await machine.stop().catch(() => undefined);
        }
      } else {
        delete fork.server;
      }
      await apps.put(appRecordInput(fork, ctx.principal.subject));
      await reportLifecycle("fork", fork.id, ctx, { sourceAppId: source.id });
      return structuredClone(fork);
    },

    async agentToolRisk(call, ctx) {
      if (call.tool !== "vendo_apps_edit") return undefined;
      if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)) {
        return "write";
      }
      const args = call.args as Record<string, Json>;
      if (typeof args.appId !== "string" || typeof args.instruction !== "string") {
        return "write";
      }
      const app = await owned(args.appId, ctx.principal.subject);
      if (app === null) return "write";
      return instructionRequiresServer(app, args.instruction) ? "write" : "read";
    },

    async edit(appId, instruction, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "generation requires a model");
      }
      const previous = await requireOwned(appId, ctx.principal.subject);
      const requiresServer = instructionRequiresServer(previous, instruction);
      if (requiresServer && !machines.available()) {
        return failedEdit(previous, instruction, [
          "sandbox-unavailable: this edit requires server execution",
        ], false);
      }

      let repairIssues: string[] | undefined;
      let collectedIssues: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const generated = await engine.edit(
          {
            app: structuredClone(previous),
            instruction,
            ...(repairIssues === undefined ? {} : { repairIssues }),
          },
          generationDependencies(config, config.model),
        );
        if (generated.kind === "failure") {
          collectedIssues = appendIssues(collectedIssues, generated.issues);
          repairIssues = collectedIssues;
          continue;
        }

        if (generated.kind === "document") {
          const app: AppDocument = { ...generated.document, id: appId };
          const version: VersionEntry = {
            at: new Date().toISOString(),
            intent: instruction,
            rung: rungFor(app, generated.rung),
          };
          return {
            app: await persistEdit(previous, app, version, ctx.principal.subject),
            version: { ...version },
          };
        }

        // The contextual guard decision ran before generation. If the engine
        // ever violates the tree dialect and emits code for a call classified
        // read-class, stop before touching a machine or persisting anything.
        if (!requiresServer) {
          return failedEdit(previous, instruction, [
            "approval-required: a tree-classified edit unexpectedly produced server code",
          ]);
        }

        const applied = await applyCodeFiles(previous, generated.files, generated.rung, ctx);
        if (applied.server === undefined) {
          collectedIssues = appendIssues(collectedIssues, applied.issues);
          repairIssues = collectedIssues;
          continue;
        }
        const app: AppDocument = {
          ...structuredClone(previous),
          server: applied.server,
          ...(generated.rung === 4 ? { ui: "http" } : {}),
        };
        const validation = validateAppDocument(app);
        if (!validation.ok) {
          return failedEdit(previous, instruction, [validation.error.message]);
        }
        const version: VersionEntry = {
          at: new Date().toISOString(),
          intent: instruction,
          rung: rungFor(app, generated.rung),
        };
        const persisted = await persistEdit(previous, app, version, ctx.principal.subject);
        if (applied.cover !== undefined) {
          await config.store.blobs(`app:${app.id}`).put("cover.png", applied.cover, {
            contentType: "image/png",
          });
        }
        await machines.evict(appId);
        return { app: persisted, version: { ...version } };
      }
      return failedEdit(
        previous,
        instruction,
        collectedIssues.length === 0 ? ["edit failed validation"] : collectedIssues,
      );
    },

    /**
     * ⚠️ OWNERSHIP IS THE CALLER'S RESPONSIBILITY. The frozen 06 §1 signature
     * `history(appId)` takes no RunContext, so — unlike create/get/edit/delete/fork/
     * open/call, which all scope by `ctx.principal.subject` — this handle cannot check
     * ownership itself. The umbrella wire route (`/apps/:id/history`, 09 §3) MUST resolve
     * the principal and confirm ownership before exposing `list`/`undo`; that route is the
     * system's cross-user auth boundary ("the unauthenticated surface is exactly nothing").
     * Flagged by Codex + Greptile review; closing it inside this block needs a contract
     * major to add `ctx` here — see the PR's escalation note.
     */
    history(appId) {
      const surface = history.surface(appId);
      return Object.freeze({
        list: () => surface.list(),
        undo: async () => {
          const restored = await surface.undo();
          await machines.evict(appId);
          return restored;
        },
      });
    },

    async open(appId, ctx) {
      return opener(await requireOwned(appId, ctx.principal.subject), ctx);
    },

    async call(appId, ref, args, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      // Only fn: refs reach the machine and need a run token; a host-tool ref goes
      // straight to the guard-bound registry, so don't pay for HMAC signing there.
      // The fn: path mints its own token via machines.withMachine when none is passed.
      return caller.call(app, ref, args, ctx);
    },

    async exportApp(appId, ctx) {
      return interchange.exportApp(appId, ctx);
    },

    async importApp(source, ctx) {
      return interchange.importApp(source, ctx);
    },

    async share(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      return share(appId, app, ctx);
    },

    async publish(appId, ctx) {
      const app = await requireOwned(appId, ctx.principal.subject);
      return publish(appId, app, ctx);
    },

    agentTools() {
      return createAgentTools(runtime, { data, requireOwned });
    },

    proxy,
  };

  return runtime;
};
