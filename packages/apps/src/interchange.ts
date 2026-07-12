import {
  VendoError,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type Guard,
  type Json,
  type RunContext,
  type StoreAdapter,
} from "@vendoai/core";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { appRecordInput } from "./persistence.js";
import { assertPinsExportable, type PinBaseline } from "./pins.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const APP_ROOT = "/app";
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "cache",
  "coverage",
  "data",
  "node_modules",
  "tmp",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validationError = (message: string, detail?: Json): VendoError =>
  new VendoError("validation", message, detail);

const validateImportedDocument = (input: unknown): AppDocument => {
  const result = validateAppDocument(input);
  if (!result.ok) {
    throw validationError(`invalid imported app document: ${result.error.message}`, {
      reason: result.error.message,
      validationCode: result.error.code,
    });
  }
  return structuredClone(result.app);
};

const withoutExportIdentity = (app: AppDocument): Omit<AppDocument, "id"> => {
  const exported = structuredClone(app) as AppDocument;
  const record = exported as unknown as Record<string, unknown>;
  delete record.id;
  delete record.server;
  // Export lineage describes the author's copy, not the recipient's new copy.
  delete record.forkedFrom;
  return record as unknown as Omit<AppDocument, "id">;
};

const withFreshIdentity = (input: unknown, id: AppId): Record<string, unknown> => {
  const copy: Record<string, unknown> = isRecord(input)
    ? structuredClone(input)
    : { artifact: structuredClone(input) };
  copy.id = id;
  // Snapshot references and exporter lineage never cross the interchange boundary.
  delete copy.server;
  delete copy.forkedFrom;
  return copy;
};

const normalizedMachinePath = (dir: string, entry: string): string => {
  if (entry.startsWith("/")) return entry.replace(/\/+$/, "");
  if (entry.startsWith("app/")) return `/${entry.replace(/\/+$/, "")}`;
  return `${dir.replace(/\/+$/, "")}/${entry.replace(/^\/+|\/+$/g, "")}`;
};

const excludedMachinePath = (path: string): boolean => {
  const relative = path.slice(`${APP_ROOT}/`.length);
  const segments = relative.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true;
  const name = segments.at(-1) ?? "";
  return name === ".DS_Store"
    || name === ".env"
    || name.startsWith(".env.")
    || name.endsWith(".log");
};

const collectMachineFiles = async (
  machine: SandboxMachine,
): Promise<Record<string, Uint8Array>> => {
  const files: Record<string, Uint8Array> = {};
  const visitedDirectories = new Set<string>();

  const walk = async (dir: string): Promise<void> => {
    if (visitedDirectories.has(dir)) return;
    visitedDirectories.add(dir);
    const entries = await machine.files.list(dir);
    for (const entry of entries) {
      const path = normalizedMachinePath(dir, entry);
      if (path !== APP_ROOT && !path.startsWith(`${APP_ROOT}/`)) continue;
      if (path === APP_ROOT || excludedMachinePath(path)) continue;
      try {
        const bytes = await machine.files.read(path);
        files[`app/${path.slice(`${APP_ROOT}/`.length)}`] = bytes;
      } catch {
        await walk(path);
      }
    }
  };

  await walk(APP_ROOT);
  return files;
};

interface ParsedArchive {
  document: unknown;
  files: Record<string, Uint8Array>;
  hasAppDirectory: boolean;
}

const archiveMachinePath = (entry: string): string => {
  const relative = entry.slice("app/".length);
  if (relative === "" || relative.includes("\\")) {
    throw validationError(`invalid app archive path: ${entry}`);
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw validationError(`invalid app archive path: ${entry}`);
  }
  return `${APP_ROOT}/${segments.join("/")}`;
};

const parseArchive = (source: Uint8Array): ParsedArchive => {
  try {
    const archive = unzipSync(source);
    const appJson = archive["app.json"];
    if (appJson === undefined) throw validationError("invalid .vendoapp: app.json is missing");
    const files: Record<string, Uint8Array> = {};
    let hasAppDirectory = false;
    for (const [entry, bytes] of Object.entries(archive)) {
      if (!entry.startsWith("app/")) continue;
      hasAppDirectory = true;
      if (entry.endsWith("/")) continue;
      files[archiveMachinePath(entry)] = bytes.slice();
    }
    return {
      document: JSON.parse(decoder.decode(appJson)) as unknown,
      files,
      hasAppDirectory,
    };
  } catch (error) {
    if (error instanceof VendoError) throw error;
    throw validationError("invalid .vendoapp archive", {
      reason: error instanceof Error ? error.message : "archive parse failed",
    });
  }
};

/** Dependencies for the 06-apps §7 interchange boundary. */
export interface AppInterchangeDependencies {
  store: StoreAdapter;
  guard: Guard;
  sandbox?: SandboxAdapter;
  pinBaselines?: readonly PinBaseline[];
  requireOwned(appId: AppId, subject: string): Promise<AppDocument>;
}

/** Public interchange methods wired into AppsRuntime. */
export interface AppInterchange {
  exportApp(appId: AppId, ctx: RunContext): Promise<Uint8Array>;
  importApp(source: Uint8Array | AppDocument, ctx: RunContext): Promise<AppDocument>;
}

/** 06-apps §7 — build the copy-only .vendoapp import/export boundary. */
export const createAppInterchange = (
  dependencies: AppInterchangeDependencies,
): AppInterchange => {
  const report = async (
    operation: "export" | "import",
    appId: AppId,
    ctx: RunContext,
    extra: Record<string, Json> = {},
  ): Promise<void> => {
    await dependencies.guard.report({
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

  return {
    async exportApp(appId, ctx) {
      const app = await dependencies.requireOwned(appId, ctx.principal.subject);
      assertPinsExportable(app.pins ?? [], dependencies.pinBaselines ?? []);
      const archive: Zippable = {
        "app.json": encoder.encode(JSON.stringify(withoutExportIdentity(app))),
      };

      if (app.server !== undefined) {
        if (dependencies.sandbox === undefined) {
          throw new VendoError("sandbox-unavailable", "app snapshot cannot be exported without a sandbox adapter");
        }
        const machine = await dependencies.sandbox.resume(app.server);
        try {
          const files = await collectMachineFiles(machine);
          Object.assign(archive, Object.keys(files).length === 0
            ? { "app/": new Uint8Array() }
            : files);
        } finally {
          await machine.stop().catch(() => undefined);
        }
      }

      const bytes = zipSync(archive, { level: 6 });
      await report("export", app.id, ctx, { includedAppDirectory: app.server !== undefined });
      return bytes;
    },

    async importApp(source, ctx) {
      // Mint before document validation; an artifact id is never trusted (01-core §10).
      const appId = `app_${globalThis.crypto.randomUUID()}`;
      const parsed = source instanceof Uint8Array
        ? parseArchive(source)
        : { document: source, files: {}, hasAppDirectory: false };
      const candidate = withFreshIdentity(parsed.document, appId);
      let imported: AppDocument;
      let appDirectory: Json = "absent";

      if (parsed.hasAppDirectory && dependencies.sandbox !== undefined) {
        // A temporary non-authoritative ref lets core validate fn: surfaces before provisioning.
        validateImportedDocument({ ...candidate, server: "import:pending" });
        const machine = await dependencies.sandbox.create({ env: {}, files: parsed.files });
        try {
          imported = validateImportedDocument({ ...candidate, server: await machine.snapshot() });
          appDirectory = "rebuilt";
        } finally {
          await machine.stop().catch(() => undefined);
        }
      } else {
        imported = validateImportedDocument(candidate);
        if (parsed.hasAppDirectory) appDirectory = "contained-without-sandbox";
      }

      await dependencies.store.records("vendo_apps").put(
        appRecordInput(imported, ctx.principal.subject),
      );
      await report("import", imported.id, ctx, { appDirectory });
      return structuredClone(imported);
    },
  };
};
