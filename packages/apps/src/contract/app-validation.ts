/**
 * `validateAppDocument` — the app-document VALIDATOR (01-core §9).
 *
 * Split from the document's shapes, which stay in `@vendoai/core`: core's own
 * store conformance kit parses a stored app row with `appDocumentSchema`
 * (`core/src/conformance/memory-store.ts`), so the shape has to be readable
 * from below. The validator does not — it reaches `validateTree`, the component
 * map and the fn-reference grammar, which are all app-generation format, and
 * they live here. One definition either way; the door re-exports both halves.
 */
import {
  safeErrorMessage,
  TOOL_NAME_PATTERN,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  appDocumentSchema,
  type AppDocument,
  type TreeNode,
} from "@vendoai/core";
import { componentMapError } from "./component-map.js";
import { FN_REFERENCE_PATTERN, collectActionReferences } from "./fn-references.js";
import { validateTree } from "./genui/tree.js";

export type AppDocumentValidation =
  | { ok: true; app: AppDocument }
  | { ok: false; error: { code: string; message: string } };

const SERVER_REFERENCE_PATTERN = /^[a-z0-9][a-z0-9+.-]*:.+$/;
const HOST_REFERENCE_PATTERN = /^host\.[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const fail = (code: string, message: string): AppDocumentValidation => ({
  ok: false,
  error: { code, message },
});

/** Shared by the tree validation branches: collect every fn: reference a
 *  validated tree names (query tools + prop actions) for the machine-presence
 *  rule. Grammar and server checks happen at the call sites' shared tail. */
const collectTreeFnReferences = (
  tree: { nodes: TreeNode[]; queries?: Array<{ tool: string }> },
  fnReferences: string[],
): void => {
  for (const query of tree.queries ?? []) {
    if (query.tool.startsWith("fn:")) fnReferences.push(query.tool);
  }
  for (const node of tree.nodes) {
    if (node.props !== undefined) collectActionReferences(node.props, fnReferences);
  }
};

/** The tree/components pair, and the fn: references the tree names. Null when
 *  the pair checks out. */
const treeAndComponentsError = (app: AppDocument, fnReferences: string[]): AppDocumentValidation | null => {
  if (app.tree?.formatVersion === VENDO_TREE_FORMAT) {
    // No grafting: trees never carry components (validateTree rejects a
    // tree-level `components` member itself), so the tree validates AS-IS and
    // the document-level map is validated beside it.
    const treeResult = validateTree(app.tree);
    if (!treeResult.ok) {
      return fail("validation", treeResult.error.message);
    }
    const components = app.components ?? {};
    const componentError = componentMapError(components);
    if (componentError !== null) {
      return fail("validation", componentError);
    }
    // Generated-presence — the check validateTree deliberately defers to the
    // document, which is where the components map lives (mirrors v1's rule).
    for (const node of treeResult.tree.nodes) {
      if (node.source === "generated" && !Object.prototype.hasOwnProperty.call(components, node.component)) {
        return fail(
          "validation",
          `node "${node.id}" references generated component "${node.component}" with no definition in components`,
        );
      }
    }
    collectTreeFnReferences(treeResult.tree, fnReferences);
  } else if (app.components !== undefined) {
    // No v1 tree to graft onto — the pinned component limits (01-core §8) still
    // bound what the jail will compile.
    const componentError = componentMapError(app.components);
    if (componentError !== null) {
      return fail("validation", componentError);
    }
  }
  return null;
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

/** A trigger id is what everything per-trigger is keyed by (grants, sponsorship,
 *  schedule cursors, runs), so two triggers sharing one would silently share all
 *  of it. The grammar is the schema's; uniqueness is cross-field and lives here.
 *  Also collects the fn: references the triggers' steps name. */
const triggersError = (app: AppDocument, fnReferences: string[]): AppDocumentValidation | null => {
  const triggerIds = new Set<string>();
  for (const trigger of app.triggers ?? []) {
    if (triggerIds.has(trigger.id)) {
      return fail("validation", `duplicate trigger id "${trigger.id}"`);
    }
    triggerIds.add(trigger.id);
    if (trigger.run.kind !== "steps") continue;
    for (const step of trigger.run.steps) {
      if (step.tool.startsWith("fn:")) {
        fnReferences.push(step.tool);
      } else if (!TOOL_NAME_PATTERN.test(step.tool)) {
        // 01-core §4/§11: a step tool is a provider-safe tool name or an fn: ref.
        return fail("validation", `step "${step.id}" tool "${step.tool}" is not a valid tool name or fn: reference`);
      }
    }
  }
  return null;
};

const fnReferencesError = (app: AppDocument, fnReferences: readonly string[]): AppDocumentValidation | null => {
  for (const reference of fnReferences) {
    if (!FN_REFERENCE_PATTERN.test(reference)) {
      return fail("validation", `invalid fn: reference "${reference}"`);
    }
  }
  // execution-v2 machine-presence rule: an fn: ref is only meaningful when the
  // document carries a box to answer it — the v2 `machine` (Lane B).
  if (fnReferences.length > 0 && app.machine === undefined) {
    return fail("validation", "fn: references require a machine");
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

/** The reference-shaped fields: the box the app runs on and its fork
 *  provenance. */
const referenceFieldsError = (app: AppDocument): AppDocumentValidation | null => {
  if (app.machine !== undefined && !SERVER_REFERENCE_PATTERN.test(app.machine.snapshotRef)) {
    return fail("validation", `invalid machine snapshot reference "${app.machine.snapshotRef}"`);
  }
  for (const pin of app.pins ?? []) {
    if (pin.slot.length === 0) {
      return fail("validation", "pin slot must be non-empty");
    }
    if (!pin.base.startsWith("sha256:")) {
      return fail("validation", `pin base "${pin.base}" must start with "sha256:"`);
    }
  }
  return null;
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

  // The cross-field rules, in the order their messages are pinned to: each
  // returns the failure it found, or null. `fnReferences` accumulates across
  // the tree and trigger rules and is checked once both have filled it.
  const fnReferences: string[] = [];
  const violation = treeAndComponentsError(app, fnReferences)
    ?? componentToolsError(app)
    ?? triggersError(app, fnReferences)
    ?? fnReferencesError(app, fnReferences)
    ?? sourceError(app)
    ?? storageError(app)
    ?? referenceFieldsError(app);
  if (violation !== null) return violation;

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
