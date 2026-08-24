/**
 * `validateAppDocument` — the app-document VALIDATOR (01-core §9).
 *
 * Split from the document's shapes, which stay in `@vendoai/core`: core's own
 * store conformance kit parses a stored app row with `appDocumentSchema`
 * (`core/src/conformance/memory-store.ts`), so the shape has to be readable
 * from below. The validator does not — it reaches the component map, which is
 * app-generation format and lives here. One definition either way; the door
 * re-exports both halves.
 */
import {
  safeErrorMessage,
  TOOL_NAME_PATTERN,
  VENDO_APP_FORMAT,
  VendoError,
  appDocumentSchema,
  type AppDocument,
} from "@vendoai/core";
import { componentMapError } from "./component-map.js";

export type AppDocumentValidation =
  | { ok: true; app: AppDocument }
  | { ok: false; error: { code: string; message: string } };

const HOST_REFERENCE_PATTERN = /^host\.[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const fail = (code: string, message: string): AppDocumentValidation => ({
  ok: false,
  error: { code, message },
});

/** The pinned component limits (01-core §8) — what the jail will compile. */
const componentsError = (app: AppDocument): AppDocumentValidation | null => {
  if (app.components === undefined) return null;
  const componentError = componentMapError(app.components);
  return componentError === null ? null : fail("validation", componentError);
};

/** W4b — a stamped island tool manifest must name a real island and real
 *  (grammar-valid) registry tool names; the runtime trusts this map as the
 *  island's entire tool surface. */
const componentToolsError = (app: AppDocument): AppDocumentValidation | null => {
  for (const [componentName, manifest] of Object.entries(app.componentTools ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(app.components ?? {}, componentName)) {
      return fail("validation", `componentTools names "${componentName}" which has no components entry`);
    }
    for (const toolName of manifest) {
      if (!TOOL_NAME_PATTERN.test(toolName)) {
        return fail("validation", `componentTools["${componentName}"] entry "${toolName}" is not a valid tool name`);
      }
    }
  }
  return null;
};

/** Contract §3.2 — a source key is a POSIX-relative path inside the app
 *  directory. Checked HERE because a checkout writes each key to disk: `../` or
 *  a leading slash would put one app's checkout in another app's files, and the
 *  document validator is the gate every stored document passes. */
const sourceError = (app: AppDocument): AppDocumentValidation | null => {
  for (const [path, file] of Object.entries(app.source ?? {})) {
    if (path.length === 0 || path.startsWith("/")) {
      return fail("validation", `source path "${path}" must be relative to the app directory`);
    }
    if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      return fail("validation", `source path "${path}" must not contain empty or dot segments`);
    }
    if ((file.text === undefined) === (file.blobRef === undefined)) {
      return fail("validation", `source file "${path}" must carry exactly one of text or blobRef`);
    }
  }
  return null;
};

const storageError = (app: AppDocument): AppDocumentValidation | null => {
  for (const [name, declaration] of Object.entries(app.storage ?? {})) {
    if (name === "state") {
      return fail("validation", 'storage collection "state" is reserved');
    }
    if (declaration.about.length === 0) {
      return fail("validation", `storage collection "${name}" must have a non-empty about`);
    }
    for (const reference of Object.values(declaration.refs ?? {})) {
      if (!HOST_REFERENCE_PATTERN.test(reference)) {
        return fail("validation", `invalid host reference "${reference}"`);
      }
    }
  }
  return null;
};

/** The reference-shaped fields: the app's fork provenance. */
const referenceFieldsError = (app: AppDocument): AppDocumentValidation | null => {
  if (app.seed !== undefined) {
    if (app.seed.component.length === 0) {
      return fail("validation", "seed component must be non-empty");
    }
    if (!app.seed.baseline.startsWith("sha256:")) {
      return fail("validation", `seed baseline "${app.seed.baseline}" must start with "sha256:"`);
    }
  }
  return null;
};

/** `proposal` is `building`'s half-step BACK — a build that has been offered
 *  and not answered — so a document carrying both claims a box was spent on an
 *  ask nobody has said yes to yet. The shape schema cannot say this (it parses
 *  fields, not their relationship), and the propose path is the first writer
 *  that could produce it. */
const buildStateError = (app: AppDocument): AppDocumentValidation | null =>
  app.proposal !== undefined && app.building !== undefined
    ? fail("validation", "a document cannot carry both proposal and building")
    : null;

const validateAppDocumentUnsafe = (input: unknown): AppDocumentValidation => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("validation", "app document must be a non-null object");
  }
  if ((input as Record<string, unknown>).format !== VENDO_APP_FORMAT) {
    return fail("version", `format must be "${VENDO_APP_FORMAT}"`);
  }

  const parsed = appDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", parsed.error.issues[0]?.message ?? "invalid app document");
  }
  const app = parsed.data;
  if (app.name.length === 0) {
    return fail("validation", "name must be non-empty");
  }

  // The cross-field rules, in the order their messages are pinned to: each
  // returns the failure it found, or null.
  const violation = componentsError(app)
    ?? componentToolsError(app)
    ?? sourceError(app)
    ?? storageError(app)
    ?? referenceFieldsError(app)
    ?? buildStateError(app);
  if (violation !== null) return violation;

  return { ok: true, app };
};

/**
 * FINAL SPEC v1 — a BUILT app never leaves its owner, refused at each of the
 * four doors a copy travels through (share, fork, export, placement).
 *
 * The bundle is arbitrary code whose one door is the guarded tool bridge, so a
 * copy would run its author's code with the recipient's own permissions. That
 * seam ships with its own egress/consent story; screens are untouched.
 *
 * EITHER signal refuses. The two are written by one CAS, but a seal that dies
 * between them — or the `ui: "bundle"` a build sets before its first seal —
 * leaves a row carrying one and not the other, and both of those are still a
 * built app.
 */
export function refuseBundleArtifact(doc: AppDocument, operation: string): void {
  if (doc.ui !== "bundle" && doc.bundle === undefined) return;
  throw new VendoError(
    "blocked",
    `a built app cannot be ${operation}: its bundle would run someone else's code with the recipient's`
    + " own permissions, and that seam ships with its own consent story — only screens travel today",
  );
}

/** 01-core §9 */
export function validateAppDocument(input: unknown): AppDocumentValidation {
  try {
    return validateAppDocumentUnsafe(input);
  } catch (error) {
    return fail("validation", `app document validation failed: ${safeErrorMessage(error)}`);
  }
}
