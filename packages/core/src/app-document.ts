import { z } from "zod";
import { componentMapError } from "./component-map.js";
import { safeErrorMessage } from "./errors.js";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT } from "./formats.js";
import { appIdSchema, type AppId } from "./ids.js";
import { TOOL_NAME_PATTERN } from "./tools.js";
import { triggerSchema, type Trigger } from "./triggers.js";
import { uiPayloadSchema, validateTree, type UIPayload } from "./tree.js";

/** 01-core §9 */
export interface StorageDecl {
  about: string;
  kind?: "records" | "files";
  refs?: Record<string, string>;
}

/** 01-core §9 */
export const storageDeclSchema = z.object({
  about: z.string(),
  kind: z.enum(["records", "files"]).optional(),
  refs: z.record(z.string()).optional(),
}).passthrough() satisfies z.ZodType<StorageDecl>;

/** 01-core §9 */
export interface Pin {
  slot: string;
  base: string;
}

/** 01-core §9 */
export const pinSchema = z.object({
  slot: z.string(),
  base: z.string(),
}).passthrough() satisfies z.ZodType<Pin>;

/** 01-core §9 */
export interface AppDocument {
  format: typeof VENDO_APP_FORMAT;
  id: AppId;
  name: string;
  description?: string;
  ui?: "tree" | "http";
  tree?: UIPayload;
  components?: Record<string, string>;
  storage?: Record<string, StorageDecl>;
  server?: string;
  trigger?: Trigger;
  egress?: string[];
  secrets?: string[];
  pins?: Pin[];
  forkedFrom?: AppId;
}

/**
 * 01-core §9 — structural shape only. Like every core schema, this parses the
 * SHAPE (passthrough for forward compatibility); the cross-field business
 * rules (component limits, fn:-requires-server, reserved `state` collection,
 * ref/pin formats, non-empty names) live in {@link validateAppDocument}, which
 * is the normative gate. A `parse()` alone can accept a semantically invalid
 * document.
 */
export const appDocumentSchema = z.object({
  format: z.literal(VENDO_APP_FORMAT),
  id: appIdSchema,
  name: z.string(),
  description: z.string().optional(),
  ui: z.enum(["tree", "http"]).optional(),
  tree: uiPayloadSchema.optional(),
  components: z.record(z.string()).optional(),
  storage: z.record(storageDeclSchema).optional(),
  server: z.string().optional(),
  trigger: triggerSchema.optional(),
  egress: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  pins: z.array(pinSchema).optional(),
  forkedFrom: appIdSchema.optional(),
}).passthrough() satisfies z.ZodType<AppDocument>;

type AppDocumentValidation =
  | { ok: true; app: AppDocument }
  | { ok: false; error: { code: string; message: string } };

const FN_REFERENCE_PATTERN = /^fn:[A-Za-z_][A-Za-z0-9_-]*$/;
const SERVER_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9+.-]*:.+$/;
const HOST_REFERENCE_PATTERN = /^host\.[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const fail = (code: string, message: string): AppDocumentValidation => ({
  ok: false,
  error: { code, message },
});

const collectActionReferences = (value: unknown, references: string[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectActionReferences(item, references);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.action === "string" && record.action.startsWith("fn:")) {
    references.push(record.action);
  }
  for (const nested of Object.values(record)) collectActionReferences(nested, references);
};

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

  const fnReferences: string[] = [];
  if (app.tree?.formatVersion === VENDO_TREE_FORMAT) {
    if (Object.prototype.hasOwnProperty.call(app.tree, "components")) {
      return fail("validation", "v1 tree components must live at the app document level");
    }
    const treeResult = validateTree({ ...app.tree, components: app.components });
    if (!treeResult.ok) {
      return fail("validation", treeResult.error.message);
    }
    for (const query of treeResult.tree.queries ?? []) {
      if (query.tool.startsWith("fn:")) fnReferences.push(query.tool);
    }
    for (const node of treeResult.tree.nodes) {
      if (node.props !== undefined) collectActionReferences(node.props, fnReferences);
    }
  } else if (app.components !== undefined) {
    // No v1 tree to graft onto — the pinned component limits (01-core §8) still
    // bound what the jail will compile.
    const componentError = componentMapError(app.components);
    if (componentError !== null) {
      return fail("validation", componentError);
    }
  }

  if (app.trigger?.run.kind === "steps") {
    for (const step of app.trigger.run.steps) {
      if (step.tool.startsWith("fn:")) {
        fnReferences.push(step.tool);
      } else if (!TOOL_NAME_PATTERN.test(step.tool)) {
        // 01-core §4/§11: a step tool is a provider-safe tool name or an fn: ref.
        return fail("validation", `step "${step.id}" tool "${step.tool}" is not a valid tool name or fn: reference`);
      }
    }
  }
  for (const reference of fnReferences) {
    if (!FN_REFERENCE_PATTERN.test(reference)) {
      return fail("validation", `invalid fn: reference "${reference}"`);
    }
  }
  if (fnReferences.length > 0 && app.server === undefined) {
    return fail("validation", "fn: references require an app server");
  }

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

  if (app.server !== undefined && !SERVER_REFERENCE_PATTERN.test(app.server)) {
    return fail("validation", `invalid server reference "${app.server}"`);
  }
  for (const pin of app.pins ?? []) {
    if (pin.slot.length === 0) {
      return fail("validation", "pin slot must be non-empty");
    }
    if (!pin.base.startsWith("sha256:")) {
      return fail("validation", `pin base "${pin.base}" must start with "sha256:"`);
    }
  }

  return { ok: true, app };
};

/** 01-core §9 */
export function validateAppDocument(input: unknown): AppDocumentValidation {
  try {
    return validateAppDocumentUnsafe(input);
  } catch (error) {
    return fail("validation", `app document validation failed: ${safeErrorMessage(error)}`);
  }
}
