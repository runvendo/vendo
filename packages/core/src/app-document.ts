import { z } from "zod";
import { VENDO_APP_FORMAT } from "./formats.js";
import { appIdSchema, isoDateTimeSchema, type AppId, type IsoDateTime } from "./ids.js";
import { sha256Hex } from "./sha256.js";
import { DEFAULT_TRIGGER_ID, triggerSchema, type Trigger } from "./triggers.js";
import { uiPayloadSchema, type UIPayload } from "./genui/tree-node.js";

/**
 * The seat's contents — what one entry of {@link AppDocument.components} holds.
 *
 * A bundle has exactly two origins and both live INSIDE the document, so
 * nothing is attached at open time by hash-matching a baseline the fork may
 * have drifted from.
 *
 * It is declared HERE, beside the field it types, for the same reason
 * `appDocumentSchema` is: core's own store conformance kit parses a stored app
 * row with that schema, and core may not reach up into `@vendoai/apps`. The
 * format door (`@vendoai/apps/contract`) re-exports these names rather than
 * re-declaring them, so consumers still read one place.
 */
export interface ComponentBundle {
  source: string;
  /** Sub-modules the entry imports, keyed by the specifier that names them. */
  modules?: Record<string, string>;
  styles?: string;
  /** The rehearsal seed a preview renders with, spread onto the props. */
  sampleProps?: Record<string, unknown>;
  /** `"authored"` — a generated island. `"seeded"` — captured from a host
   *  component the person forked. */
  origin: "authored" | "seeded";
}

/** 01-core §9 */
export const componentBundleSchema = z.object({
  source: z.string(),
  modules: z.record(z.string()).optional(),
  styles: z.string().optional(),
  sampleProps: z.record(z.unknown()).optional(),
  origin: z.enum(["authored", "seeded"]),
}).passthrough() satisfies z.ZodType<ComponentBundle>;

/**
 * Backward compatible by construction: a stored `components` value is either
 * the legacy bare source string every app written before bundles carries, or a
 * bundle. Nothing migrates — every reader goes through {@link bundleOf}.
 */
export type ComponentEntry = string | ComponentBundle;

/** 01-core §9 */
export const componentEntrySchema: z.ZodType<ComponentEntry> = z.union([z.string(), componentBundleSchema]);

/** The one reader. A bare source string reads as an authored bundle. */
export const bundleOf = (entry: ComponentEntry): ComponentBundle =>
  typeof entry === "string" ? { source: entry, origin: "authored" } : entry;

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

/**
 * The app's own memory — what it was asked for, and what was decided.
 *
 * A screen or build run is STATELESS; the artifact is what carries the context
 * forward. Without this, every editor after the first reads a document with no
 * idea why it looks the way it does, and quietly undoes a deliberate choice
 * ("filtered to 2 accounts — the ask was trip-only") because nothing recorded
 * that it was one.
 *
 * SERVER-WRITTEN, like {@link AppBuildFailure}: `asks` is recorded by the front
 * door and `decisions` by the agent's own save hand, both through the runtime's
 * one memory door. A model-authored `memory` on a generated document is stripped
 * before persist, exactly as a forged `egressApproved` is.
 *
 * Deliberately NOT a log. Reasoning traces, transcripts and tool outputs are not
 * here and must not be added: this is the smallest thing the next editor needs,
 * and an append-only history of everything is how dead context gets read as
 * current fact.
 */
export interface AppMemory {
  /**
   * Every `vendo_make` request that touched this app, VERBATIM and in order,
   * the create ask first. Never a paraphrase — a paraphrase drifts the intent
   * it was written to preserve. Capped at the write site (oldest dropped).
   */
  asks: string[];
  /**
   * A few lines the agent chose to record: choices made, constraints found,
   * things ruled out. REPLACED on every run that writes one, never appended —
   * a stale decision presented as current is worse than no memory at all.
   * Byte-capped at the write site.
   */
  decisions?: string;
}

/** 01-core §9 */
export const appMemorySchema = z.object({
  asks: z.array(z.string()),
  decisions: z.string().optional(),
}).passthrough() satisfies z.ZodType<AppMemory>;

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
 * The stable generated-component name a fork of one captured host slot ships
 * under — a pure function of {@link Pin}'s slot, so it belongs beside the pin.
 *
 * It lives in core because BOTH sides of the fork seam need the same answer and
 * `ui → apps` is not an edge layering allows (dependency-guard): the runtime
 * writes the node under this name, and the client's in-place mount finds it by
 * this name. It was hand-copied three times before this (apps' pins.ts, ui's
 * remixable wrapper, ui's wire fixture).
 */
export const pinComponentName = (slot: string): string => {
  const stem = (slot.match(/[A-Za-z0-9]+/g) ?? [])
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("") || "Slot";
  // The hash suffix prevents punctuation-only normalization collisions while
  // keeping the name a valid generated-component PascalCase identifier.
  return `Pinned${stem}${sha256Hex(slot).slice(0, 8)}`;
};

/**
 * execution-v2 — the app's persistent machine. Presence means layer 2+; an app
 * with no machine is a layer-1 tree app. The layer itself is always derived
 * from presence (and, for layer 3, from what the box serves), never stored.
 */
interface AppMachine {
  /** Provider-prefixed snapshot reference (e.g. "e2b:snap_x91"), opaque past the colon. */
  snapshotRef: string;
  provisionedAt: IsoDateTime;
}

/** execution-v2 */
const appMachineSchema = z.object({
  snapshotRef: z.string(),
  provisionedAt: isoDateTimeSchema,
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
  components?: Record<string, ComponentEntry>;
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
  machine?: AppMachine;
  /** An automation is an app with a LIST of triggers, each keyed by its own
   *  `id`. Documents stored before the list existed carry a single `trigger`
   *  object; {@link appDocumentSchema} normalizes those on READ into a
   *  one-element list under {@link DEFAULT_TRIGGER_ID}, so an old row loads and
   *  fires unchanged. Writes always write `triggers`. */
  triggers?: Trigger[];
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
  /** Fork provenance ONLY (drift, ship-diff, rebase). "Show this app in that
   *  slot" is a placement ROW, never a document field — see
   *  `@vendoai/apps` `placements.ts`. */
  pins?: Pin[];
  forkedFrom?: AppId;
  /**
   * A terminal build failure. Present only on a record the runtime persisted
   * when generation threw; open() reads it to answer `{kind:"failed"}`.
   * Server-written — stripped from a successful create/edit like the other
   * server-authoritative fields.
   */
  buildFailed?: AppBuildFailure;
  /**
   * What this app remembers about itself. Server-written — stripped from a
   * generated document before persist and pinned from the stored row on every
   * edit, so only the memory door ever changes it.
   */
  memory?: AppMemory;
}

/**
 * 01-core §9 — structural shape only. Like every core schema, this parses the
 * SHAPE (passthrough for forward compatibility); the cross-field business
 * rules (component limits, fn:-requires-machine, reserved `state` collection,
 * ref/pin formats, non-empty names) live in {@link validateAppDocument}, which
 * is the normative gate. A `parse()` alone can accept a semantically invalid
 * document.
 */
const appDocumentShapeSchema = z.object({
  format: z.literal(VENDO_APP_FORMAT),
  id: appIdSchema,
  name: z.string(),
  description: z.string().optional(),
  ui: z.enum(["tree", "http"]).optional(),
  tree: uiPayloadSchema.optional(),
  components: z.record(componentEntrySchema).optional(),
  componentTools: z.record(z.array(z.string())).optional(),
  storage: z.record(storageDeclSchema).optional(),
  source: z.record(appSourceFileSchema).optional(),
  machine: appMachineSchema.optional(),
  triggers: z.array(triggerSchema).optional(),
  egress: z.array(z.string()).optional(),
  egressApproved: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  pins: z.array(pinSchema).optional(),
  forkedFrom: appIdSchema.optional(),
  buildFailed: appBuildFailureSchema.optional(),
  memory: appMemorySchema.optional(),
}).passthrough() satisfies z.ZodType<AppDocument>;

/**
 * READ-TIME normalization of the pre-list document shape: a stored `trigger`
 * object becomes the one-element `triggers` list it always meant, under
 * {@link DEFAULT_TRIGGER_ID}.
 *
 * It runs before validation rather than after, so the legacy object is checked
 * by the SAME `triggerSchema` the new shape is — including the required `id`,
 * which no stored document has. The legacy key is dropped so a normalized
 * document never carries both, and a document that already has `triggers` is
 * left alone: writes always write the list, so re-reading one is the common case
 * and must not pay for the old one.
 */
const normalizeTriggers = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const doc = input as Record<string, unknown>;
  const legacy = doc["trigger"];
  if (doc["triggers"] !== undefined || typeof legacy !== "object" || legacy === null || Array.isArray(legacy)) {
    return input;
  }
  const { trigger: _dropped, ...rest } = doc;
  return { ...rest, triggers: [{ id: DEFAULT_TRIGGER_ID, ...legacy as Record<string, unknown> }] };
};

/** 01-core §9 — see {@link appDocumentShapeSchema} for the shape and
 *  {@link normalizeTriggers} for the one thing this door does beyond parsing. */
export const appDocumentSchema = z.preprocess(normalizeTriggers, appDocumentShapeSchema);
