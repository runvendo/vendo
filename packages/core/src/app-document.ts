import { z } from "zod";
import { componentMapError } from "./component-map.js";
import { safeErrorMessage } from "./errors.js";
import { FN_REFERENCE_PATTERN, collectActionReferences } from "./fn-references.js";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT } from "./formats.js";
import { appIdSchema, isoDateTimeSchema, type AppId, type IsoDateTime } from "./ids.js";
import { TOOL_NAME_PATTERN } from "./tools.js";
import { validateTree } from "./genui/tree.js";
import { triggerSchema, type Trigger } from "./triggers.js";
import { uiPayloadSchema, type TreeNode, type UIPayload } from "./genui/tree-node.js";

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

/**
 * A terminal build failure recorded by the runtime when app generation threw
 * (model error, quota exhaustion, timeout). SERVER-WRITTEN ONLY: the model
 * never authors it — the runtime persists it on the create catch path so
 * open() can surface `{kind:"failed"}` and the embed resolves PROMPTLY with the
 * reason instead of spinning to the client build deadline. `reason` is a short,
 * honest, non-leaky line (never a raw provider stack).
 */
export interface AppBuildFailure {
  reason: string;
  retryable?: boolean;
  at: IsoDateTime;
  /** The create prompt that failed, persisted so a retry affordance can
   *  re-issue the EXACT create (the record's name is a capped collapse of it,
   *  too lossy to replay). Absent on records from before this field. */
  prompt?: string;
}

/**
 * One file of an app's own code, at rest in the document (contract §3.2).
 *
 * Today an app's code lives in three places — island TSX in `components`, the
 * wire surface in workspace file rows, and the whole served app only inside the
 * E2B snapshot behind `machine.snapshotRef`. Lose the snapshot and the customer's
 * app is gone, because the store never had it. This is the one home: the row
 * becomes the truth and a workspace becomes a working copy of it.
 *
 * `hash` is the CAS base a checkout stamps and a commit diffs against, so a
 * commit lands exactly the paths that changed. `text` and `blobRef` are exclusive:
 * inline up to {@link WORKSPACE_INLINE_MAX_BYTES}, and past it the same blob seam
 * the workspace rows already spill to — never a second spill mechanism.
 */
export interface AppSourceFile {
  /** `"sha256:<hex>"` of the bytes. */
  hash: string;
  bytes: number;
  /** Inline iff `bytes <= WORKSPACE_INLINE_MAX_BYTES`. */
  text?: string;
  /** Else: the key in the app's blob namespace. */
  blobRef?: string;
}

/** Contract §3.2 */
export const appSourceFileSchema = z.object({
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  text: z.string().optional(),
  blobRef: z.string().min(1).optional(),
}).passthrough() satisfies z.ZodType<AppSourceFile>;

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

/**
 * execution-v2 — the app's persistent machine. Presence means layer 2+; an app
 * with no machine is a layer-1 tree app. The layer itself is always derived
 * from presence (and, for layer 3, from what the box serves), never stored.
 */
interface AppMachine {
  /** Provider-prefixed snapshot reference (e.g. "e2b:snap_x91"), opaque past the colon. */
  snapshotRef: string;
  provisionedAt: IsoDateTime;
  /**
   * Wave 7 — set when a secret grant changed after the last env injection
   * (secrets are baked into the box at provision and at pre-edit
   * re-injection; a resume restores the snapshot's env on every provider).
   * The next wake rebuilds the boundary env through the box control port and
   * clears this marker.
   */
  envStaleAt?: IsoDateTime;
}

/** execution-v2 */
const appMachineSchema = z.object({
  snapshotRef: z.string(),
  provisionedAt: isoDateTimeSchema,
  envStaleAt: isoDateTimeSchema.optional(),
}).passthrough() satisfies z.ZodType<AppMachine>;

/** 01-core §9 */
const appBuildFailureSchema = z.object({
  reason: z.string(),
  retryable: z.boolean().optional(),
  at: isoDateTimeSchema,
  prompt: z.string().optional(),
}).passthrough() satisfies z.ZodType<AppBuildFailure>;

/** 01-core §9 */
export interface AppDocument {
  format: typeof VENDO_APP_FORMAT;
  id: AppId;
  name: string;
  description?: string;
  ui?: "tree" | "http";
  tree?: UIPayload;
  components?: Record<string, string>;
  /**
   * W4b — the compiler-stamped per-island tool manifest: for each generated
   * component, the registry tool names its source reaches through the ambient
   * `tools` API (literal member access, scanned at compile). The runtime
   * exposes ONLY these tools to that island's jail; derived data, so it
   * travels with `components` on copy.
   */
  componentTools?: Record<string, string[]>;
  storage?: Record<string, StorageDecl>;
  /**
   * Contract §3.2 — the app's own code, at rest. Keys are POSIX-relative paths
   * inside the app directory ("src/App.tsx", "vendo.json"). The wire surface
   * (`app.vendo`) is NOT here: it stays {@link AppDocument.tree}, which is what
   * the render seam paints from.
   *
   * With this present, `machine.snapshotRef` is a CACHE: an app can always be
   * rebuilt from here onto a fresh box, and nothing may read a snapshot to
   * recover source.
   */
  source?: Record<string, AppSourceFile>;
  server?: string;
  machine?: AppMachine;
  trigger?: Trigger;
  egress?: string[];
  /**
   * execution-v2 Lane E — the outbound domains the OWNER has approved for this
   * app's machine (grant state, written only by the egress approval flow).
   * `egress` is the app's declaration (mirrors `vendo.json`); this field is
   * the one-time user/host approval over it. A declared domain missing from
   * here blocks provision/wake loudly. Grant hygiene: the field never travels
   * with a copy — fork/share/publish/export all strip it, so a copied app
   * re-approves its egress.
   */
  egressApproved?: string[];
  secrets?: string[];
  pins?: Pin[];
  /**
   * Remix final shape (2026-08-02) — "show this app in that slot". A placement
   * is a host-authored slot name (a `VendoSlot` id) and feeds slot discovery
   * ONLY; `pins` records fork provenance ONLY (drift, ship-diff, rebase). The
   * pre-split rows that fabricated `Pin.base` hashes to land an app in a slot
   * are classified into this field on read and normalized on the next write.
   */
  placements?: string[];
  forkedFrom?: AppId;
  /**
   * A terminal build failure. Present only on a record the runtime persisted
   * when generation threw; open() reads it to answer `{kind:"failed"}`.
   * Server-written — stripped from a successful create/edit like the other
   * server-authoritative fields.
   */
  buildFailed?: AppBuildFailure;
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
  componentTools: z.record(z.array(z.string())).optional(),
  storage: z.record(storageDeclSchema).optional(),
  source: z.record(appSourceFileSchema).optional(),
  server: z.string().optional(),
  machine: appMachineSchema.optional(),
  trigger: triggerSchema.optional(),
  egress: z.array(z.string()).optional(),
  egressApproved: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  pins: z.array(pinSchema).optional(),
  placements: z.array(z.string()).optional(),
  forkedFrom: appIdSchema.optional(),
  buildFailed: appBuildFailureSchema.optional(),
}).passthrough() satisfies z.ZodType<AppDocument>;

type AppDocumentValidation =
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

  // W4b — a stamped island tool manifest must name a real island and real
  // (grammar-valid) registry tool names; the runtime trusts this map as the
  // island's entire tool surface.
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
  // execution-v2 machine-presence rule: an fn: ref is only meaningful when the
  // document carries a box to answer it — the v2 `machine` (Lane B), or the
  // dying v1 `server` snapshot until its execution path is fully removed.
  if (fnReferences.length > 0 && app.server === undefined && app.machine === undefined) {
    return fail("validation", "fn: references require a machine (or legacy app server)");
  }

  // Contract §3.2 — a source key is a POSIX-relative path inside the app
  // directory. Checked HERE because a checkout writes each key to disk: `../` or
  // a leading slash would put one app's checkout in another app's files, and the
  // document validator is the gate every stored document passes.
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
  for (const placement of app.placements ?? []) {
    if (placement.length === 0) {
      return fail("validation", "placement slot must be non-empty");
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
