import {
  isVendoError,
  VendoError,
  WORKSPACE_INLINE_MAX_BYTES,
  type AppId,
  type Guard,
  type Json,
  type RunContext,
} from "@vendoai/core";
import {
  refuseBundleArtifact,
  validateAppDocument,
  type AppDocument,
} from "../../contract/index.js";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { appLifecycleEvent } from "./audit.js";
import type { EngineOps } from "./engine.js";
import { APPS_COLLECTION, appRecordInput } from "./persistence.js";
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import { type SeedBaseline } from "../../contract/index.js";

/**
 * 06-apps §7–§8 — an artifact export needs explicit host permission for the
 * component the app was seeded from. Missing or drifted baselines fail closed,
 * because an export must never quietly strip the seeded component out.
 */
const assertSeedExportable = (
  app: AppDocument,
  baselines: readonly SeedBaseline[],
): void => {
  const seed = app.seed;
  if (seed === undefined) return;
  const baseline = baselines.find((candidate) => candidate.slot === seed.component);
  if (baseline?.hash === seed.baseline && baseline.exportable === true) return;
  const reason = baseline === undefined
    ? "missing-baseline"
    : baseline.hash !== seed.baseline ? "baseline-hash-mismatch" : "baseline-forbids-export";
  throw new VendoError("blocked", `seed ${seed.component} is not exportable`, {
    component: seed.component,
    baseline: seed.baseline,
    reason,
  });
};

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
  "components",
  "storage",
  // A component screen IS its `app.tsx` (open.ts reads `source[SCREEN_FILE]`),
  // so an archive without `source` carries the document's metadata and nothing
  // that can ever open. Inline only — see {@link assertPortableSource}.
  "source",
  "machine",
  "egress",
  "secrets",
  "seed",
  "forkedFrom",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validationError = (message: string, detail?: Json): VendoError =>
  new VendoError("validation", message, detail);

/**
 * A .vendoapp carries source INLINE or not at all — refused on BOTH sides.
 *
 * `text` and `blobRef` are exclusive (contract §3.2), and a `blobRef` is a key in
 * the exporting deployment's own blob namespace (`apps/<appId>/<hash>`, see
 * app-source.ts), which the archive has no way to carry: on another deployment
 * that key resolves to nothing, and on the same one it still points at the ORIGIN
 * app's bytes. So it fails closed, for {@link assertSeedExportable}'s reason — an
 * export must never quietly hand over an app with a source file missing, and for
 * a component screen that file is the whole app — and on import because a copy
 * must never mint a row aliasing bytes it did not write.
 */
const assertPortableSource = (document: unknown): void => {
  const source = isRecord(document) ? document["source"] : undefined;
  if (!isRecord(source)) return;
  for (const [path, file] of Object.entries(source)) {
    // A blob reference and nothing else: an entry carrying neither is the
    // document validator's to refuse, in its own words.
    if (isRecord(file) && file["blobRef"] !== undefined) {
      throw validationError(
        `source file "${path}" is spilled to a blob, and a .vendoapp carries only inline source:`
        + " one deployment's blob namespace is not portable — keep the file under the"
        + ` ${WORKSPACE_INLINE_MAX_BYTES}-byte inline cap to make this app copyable`,
        { path },
      );
    }
  }
};

/**
 * A `tree` with no screen beside it is an app exported before an app was its
 * own `app.tsx` — the layout WAS the artifact. Nothing here can turn one back
 * into a screen, and the field list below drops it, so importing quietly would
 * mint a row that can never open. Refused instead, in those words.
 *
 * It measures the SAME thing `open` measures — inline `app.tsx` text that is not
 * blank (`open.ts`) — because anything weaker admits a document that opens
 * nowhere: a bare `source: {}` beside a tree cleared the old check.
 */
const assertOpenableSource = (document: unknown): void => {
  if (!isRecord(document) || document["tree"] === undefined) return;
  const source = document["source"];
  const screen = isRecord(source) ? source[SCREEN_FILE] : undefined;
  if (isRecord(screen) && typeof screen["text"] === "string" && screen["text"].trim() !== "") return;
  throw validationError(
    "this .vendoapp holds a stored layout and no source: it was exported before an app was its own"
    + " app.tsx, so there is nothing in it that can open — re-export it from a deployment that still"
    + " has the app's source",
  );
};

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

// execution-v2 — interchange is document-only, a copy boundary: a machine ref
// never crosses it. Export never writes one, import strips one a document tries
// to smuggle in, and the box's disk is scratch by the data rule — an imported
// app re-graduates on its own. `automations` is absent from the field list above
// for the same reason and a stronger one: an automation is a PRINCIPAL's own
// record, so a copy that carried the ids would point at somebody else's.
const withoutExportIdentity = (app: AppDocument): Omit<AppDocument, "id"> =>
  allowedDocumentFields(app, new Set(["id", "machine", "forkedFrom"])) as Omit<AppDocument, "id">;

const withFreshIdentity = (input: unknown, id: AppId): Record<string, unknown> => {
  const copy = allowedDocumentFields(input, new Set(["id", "machine", "forkedFrom"]));
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
    if (isVendoError(error)) throw error;
    throw validationError("invalid .vendoapp archive", {
      reason: error instanceof Error ? error.message : "archive parse failed",
    });
  }
};

/** Dependencies for the 06-apps §7 interchange boundary. */
export interface AppInterchangeDependencies {
  engine: EngineOps;
  guard: Guard;
  seedBaselines?: readonly SeedBaseline[];
  requireOwned(appId: AppId, ctx: RunContext): Promise<AppDocument>;
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
    await dependencies.guard.report(
      appLifecycleEvent(ctx.principal, ctx, appId, { operation, ...extra }),
    );
  };

  return {
    async exportApp(appId, ctx) {
      const app = await dependencies.requireOwned(appId, ctx);
      refuseBundleArtifact(app, "exported");
      assertSeedExportable(app, dependencies.seedBaselines ?? []);
      assertPortableSource(app);
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
      assertPortableSource(parsed.document);
      assertOpenableSource(parsed.document);
      const imported = validateImportedDocument(withFreshIdentity(parsed.document, appId));
      await dependencies.engine.put(
        APPS_COLLECTION,
        appRecordInput(imported, ctx.principal.subject, false, "import"),
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
