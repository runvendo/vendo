import { z } from "zod";
import { VENDO_APP_FORMAT } from "./formats.js";
import type { AutomationId } from "./automation.js";
import { appIdSchema, isoDateTimeSchema, type AppId, type IsoDateTime, type Json } from "./ids.js";
import { sha256Hex } from "./sha256.js";

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
  /**
   * What the JAIL needs to run a seeded entry: the import table the captured
   * source resolves against, and the module bodies it reaches.
   *
   * These travel in the bundle rather than being looked up per open, which is
   * the whole point of the seat holding its own contents. They used to be
   * hash-matched against the live host baseline at open time, so the moment the
   * host component changed the match failed and a seeded app rendered with no
   * imports, no styles and no sub-modules at all — silently.
   */
  sourceImports?: Record<string, string>;
  subSources?: Record<string, { source: string; imports: Record<string, string> }>;
  /** Inert host stylesheet snapshots, in captured order. */
  styleSheets?: Array<{ path: string; css: string }>;
}

const bundleSubSourceSchema = z.object({
  source: z.string(),
  imports: z.record(z.string()),
}).passthrough();

/** 01-core §9 */
export const componentBundleSchema = z.object({
  source: z.string(),
  modules: z.record(z.string()).optional(),
  styles: z.string().optional(),
  sampleProps: z.record(z.unknown()).optional(),
  origin: z.enum(["authored", "seeded"]),
  sourceImports: z.record(z.string()).optional(),
  subSources: z.record(bundleSubSourceSchema).optional(),
  styleSheets: z.array(z.object({ path: z.string(), css: z.string() }).passthrough()).optional(),
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

/**
 * 01-core §9 — remix provenance: "this app was created from host component X at
 * baseline hash H".
 *
 * ONE seed, not a list of pins. A remix is an app created from something that
 * already existed, so the provenance is a property of the app, not a row set:
 * the thing it was seeded from, and the version of that thing it started at.
 * `slot` is the placement the ✦ gesture came from (a convenience for the chrome,
 * never the location of record — that is a placement ROW), and `review` carries
 * the captured baseline's review kind.
 *
 * `wishes` is EVERY change the person has asked of this remix, VERBATIM and in
 * order, the ✦ gesture's own first. There are no bare forks — the gesture
 * collects the first wish before it fires — and a re-seed replays the WHOLE list
 * against the host's new baseline, so a wish missing here is an edit the person
 * silently loses. Unlike {@link AppMemory.asks}, a capped working set, this list
 * is never trimmed: it IS the remix.
 */
export interface AppSeed {
  component: string;
  baseline: string;
  wishes: string[];
  /**
   * The key in {@link AppDocument.components} holding the PORT — the host
   * component re-split against `baseline` for this remix to build its wishes on.
   * Absent until a re-split has run.
   */
  port?: string;
  /** Wishes the last re-seed could not land on the new baseline. Still in
   *  `wishes` — kept and reported, never dropped. */
  unapplied?: string[];
  /**
   * The LIVE props of the host instance this remix stands in for — couriered by
   * the `<Remixable>` wrapper on mount and on every change, and the values a
   * ported screen is painted on.
   *
   * The alternative is the baseline's captured `sampleProps`, which is what the
   * floor falls back to and which is frozen the day `vendo sync` ran: a remix of
   * a balance card painted the sync-time number forever while the host's own
   * component, two inches away, painted today's. A port renders from its props
   * and no prop is in any source it could read, so this is the only route the
   * page's own state has into it.
   *
   * Filtered at the door to the captured baseline's own declared prop names, so
   * a prop the host component never declared is dropped before it is stored.
   * JSON only, by the same law as every value that crosses into the VM.
   */
  props?: Record<string, Json>;
  slot?: string;
  review?: boolean;
}

/** 01-core §9 */
export const appSeedSchema = z.object({
  component: z.string(),
  baseline: z.string(),
  wishes: z.array(z.string()).optional(),
  // Seeds stored before the wish list carry one `instruction` (and the oldest of
  // all carry none), and a required field would make every one of those apps
  // unreadable. Lifted on READ so the list stays required for everything that
  // writes a seed — the parsed shape is still an AppSeed; only the INPUT is
  // looser than one.
  instruction: z.string().optional(),
  port: z.string().optional(),
  unapplied: z.array(z.string()).optional(),
  props: z.record(z.unknown()).optional(),
  slot: z.string().optional(),
  review: z.boolean().optional(),
}).passthrough().transform(({ instruction, wishes, ...seed }) => ({
  ...seed,
  wishes: wishes ?? (instruction === undefined || instruction === "" ? [] : [instruction]),
})) satisfies z.ZodType<AppSeed, z.ZodTypeDef, unknown>;

/**
 * The stable generated-component name a seeded app's copy of the host component
 * ships under — a pure function of {@link AppSeed}'s component, so it belongs
 * beside the seed.
 *
 * It lives in core because BOTH sides of the seam need the same answer and
 * `ui → apps` is not an edge layering allows (dependency-guard): the runtime
 * writes the node under this name, and the client's in-place mount finds it by
 * this name.
 */
export const seedComponentName = (slot: string): string => {
  const stem = (slot.match(/[A-Za-z0-9]+/g) ?? [])
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("") || "Slot";
  // The hash suffix prevents punctuation-only normalization collisions while
  // keeping the name a valid generated-component PascalCase identifier.
  // The `Pinned` stem is a STORED value — it is the key of `components` in every
  // seeded document already on disk — so the surface rename to `seed` leaves it
  // alone rather than invalidating them.
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
   * inside the app directory ("src/App.tsx", "vendo.json"), the app's own
   * screen (`app.tsx`) included.
   *
   * With this present, `machine.snapshotRef` is a CACHE: an app can always be
   * rebuilt from here onto a fresh box, and nothing may read a snapshot to
   * recover source.
   */
  source?: Record<string, AppSourceFile>;
  machine?: AppMachine;
  /**
   * The app's automations, by id — maintained by the APPS layer ONLY
   * (`vendo_make`'s compound flow, the manifest fold-in), and resolved on read
   * so a dead id simply drops out.
   *
   * A pointer, never the automation: an {@link AutomationRecord} carries no app
   * reference at all, so the automations engine never sees this field and an
   * app that is deleted takes nothing down with it.
   */
  automations?: AutomationId[];
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
  /** Remix provenance ONLY (drift, ship-diff, re-seed). "Show this app in that
   *  slot" is a placement ROW, never a document field — see
   *  `@vendoai/apps` `placements.ts`. */
  seed?: AppSeed;
  forkedFrom?: AppId;
  /**
   * A terminal build failure. Present only on a record the runtime persisted
   * when generation threw; open() reads it to answer `{kind:"failed"}`.
   * Server-written — stripped from a successful create/edit like the other
   * server-authoritative fields.
   */
  buildFailed?: AppBuildFailure;
  /**
   * A build still WRITING this app — the time its first painting save landed.
   * `buildFailed`'s live half: a screen saves as it goes, so its row exists
   * tens of seconds before the mandatory reviewer pass and its repair round
   * finish, and mounting on the row alone showed people a draft the build was
   * about to correct. `open()` answers not-found until it clears, which the
   * wire's build window already turns into the `{kind:"pending"}` every embed
   * waits on. Server-written; cleared when the assembler returns.
   */
  building?: IsoDateTime;
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
export const appDocumentSchema = z.object({
  format: z.literal(VENDO_APP_FORMAT),
  id: appIdSchema,
  name: z.string(),
  description: z.string().optional(),
  ui: z.enum(["tree", "http"]).optional(),
  components: z.record(componentEntrySchema).optional(),
  componentTools: z.record(z.array(z.string())).optional(),
  storage: z.record(storageDeclSchema).optional(),
  source: z.record(appSourceFileSchema).optional(),
  machine: appMachineSchema.optional(),
  automations: z.array(z.string()).optional(),
  egress: z.array(z.string()).optional(),
  egressApproved: z.array(z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  seed: appSeedSchema.optional(),
  forkedFrom: appIdSchema.optional(),
  buildFailed: appBuildFailureSchema.optional(),
  building: isoDateTimeSchema.optional(),
  memory: appMemorySchema.optional(),
  // Input widened for the same reason as {@link appSeedSchema}'s: a defaulted
  // field inside `seed` makes this schema's input looser than an AppDocument.
}).passthrough() satisfies z.ZodType<AppDocument, z.ZodTypeDef, unknown>;
