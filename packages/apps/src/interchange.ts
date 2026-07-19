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

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ARCHIVE_MAX_ENTRIES = 4_096;
const ARCHIVE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ARCHIVE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const APP_DOCUMENT_FIELDS = [
  "format",
  "id",
  "name",
  "description",
  "ui",
  "tree",
  "components",
  "storage",
  "server",
  "machine",
  "trigger",
  "egress",
  "secrets",
  "pins",
  "forkedFrom",
] as const;

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

const allowedDocumentFields = (
  input: unknown,
  omitted: ReadonlySet<string>,
): Record<string, unknown> => {
  if (!isRecord(input)) return {};
  const copy: Record<string, unknown> = {};
  for (const field of APP_DOCUMENT_FIELDS) {
    if (!omitted.has(field) && Object.prototype.hasOwnProperty.call(input, field)) {
      copy[field] = structuredClone(input[field]);
    }
  }
  return copy;
};

// execution-v2 — interchange is document-only, a copy boundary: a machine (or
// retired v1 server) ref never crosses it. Export never writes one, import
// strips one a document tries to smuggle in, and the box's disk is scratch by
// the data rule — an imported app re-graduates on its own.
const withoutExportIdentity = (app: AppDocument): Omit<AppDocument, "id"> =>
  allowedDocumentFields(app, new Set(["id", "server", "machine", "forkedFrom"])) as Omit<AppDocument, "id">;

const withFreshIdentity = (input: unknown, id: AppId): Record<string, unknown> => {
  const copy = allowedDocumentFields(input, new Set(["id", "server", "machine", "forkedFrom"]));
  copy.id = id;
  return copy;
};

interface ParsedArchive {
  document: unknown;
  hasAppDirectory: boolean;
}

const parseArchive = (source: Uint8Array): ParsedArchive => {
  try {
    let entryCount = 0;
    let declaredBytes = 0;
    const archive = unzipSync(source, {
      filter(entry) {
        entryCount += 1;
        declaredBytes += entry.originalSize;
        if (entryCount > ARCHIVE_MAX_ENTRIES
          || entry.originalSize > ARCHIVE_MAX_ENTRY_BYTES
          || declaredBytes > ARCHIVE_MAX_TOTAL_BYTES) {
          throw validationError("app archive exceeds size limits");
        }
        return true;
      },
    });
    let inflatedBytes = 0;
    for (const bytes of Object.values(archive)) {
      inflatedBytes += bytes.byteLength;
      if (bytes.byteLength > ARCHIVE_MAX_ENTRY_BYTES || inflatedBytes > ARCHIVE_MAX_TOTAL_BYTES) {
        throw validationError("app archive exceeds size limits");
      }
    }
    const appJson = archive["app.json"];
    if (appJson === undefined) throw validationError("invalid .vendoapp: app.json is missing");
    return {
      document: JSON.parse(decoder.decode(appJson)) as unknown,
      hasAppDirectory: Object.keys(archive).some((entry) => entry.startsWith("app/")),
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
      const bytes = zipSync(archive, { level: 6 });
      await report("export", app.id, ctx);
      return bytes;
    },

    async importApp(source, ctx) {
      // Mint before document validation; an artifact id is never trusted (01-core §10).
      const appId = `app_${globalThis.crypto.randomUUID()}`;
      const parsed = source instanceof Uint8Array
        ? parseArchive(source)
        : { document: source, hasAppDirectory: false };
      const imported = validateImportedDocument(withFreshIdentity(parsed.document, appId));
      await dependencies.store.records("vendo_apps").put(
        appRecordInput(imported, ctx.principal.subject),
      );
      // An app/ directory in the archive is machine scratch from an older
      // export; it is ignored — the imported copy re-graduates on its own.
      await report("import", imported.id, ctx, {
        appDirectory: parsed.hasAppDirectory ? "ignored" : "absent",
      });
      return structuredClone(imported);
    },
  };
};
