import type { UIMessage } from "ai";
import type { UINode } from "./ui";

export const SCHEMA_VERSION = 1 as const;

/** Message metadata. Run identity (set by the engine's `start` chunk) rides on
 *  assistant messages; user messages may carry only `anchors`, so the identity
 *  fields are optional at the type level. */
export interface FlowletMetadata {
  runId?: string;
  threadId?: string;
  schemaVersion?: number;
  /** Anchor context riding a send from a FlowletRemix-scoped surface (2026-07-04 spec). */
  anchors?: AnchorContextBlock;
}

/**
 * Host-page context attached to a chat send. `scoped` is the anchor whose
 * affordance opened the surface (DOM snapshot included, captured only at
 * open). `ambient` is the page's other visible anchors — never snapshots,
 * never source.
 */
export interface AnchorContextBlock {
  scoped?: AnchorRef & {
    snapshot?: string;
    /** Captured component source (remix-fidelity epic, 2026-07-04). SERVER-
     *  populated only: the chat handler strips any client-supplied value
     *  before enriching from the captured map. Scoped block only, by design —
     *  ambient anchors can never carry source. */
    source?: string;
  };
  ambient?: AnchorRef[];
}

export interface AnchorRef {
  anchorId: string;
  label?: string;
  context?: unknown;
}

/**
 * One captured component source (`.flowlet/remix-sources.json`, written by
 * `flowlet sync`). `sourceHash`/`capturedAt` make staleness detectable; dev
 * mode re-reads `file` from disk instead of trusting `source`.
 */
export interface RemixSourceRecord {
  /** App-root-relative path of the captured file. */
  file: string;
  /** The export the wrapper's child resolved to; absent when the capture fell
   *  back to the enclosing file. The stage loader consumes `mod.default`, so
   *  prompts must instruct conversion when this names a non-default export. */
  exportName?: string;
  /** Verbatim file content (48 KB cap, truncated with a visible marker). */
  source: string;
  sourceHash: string;
  capturedAt: string;
}

/** Host-supplied source lookup; `undefined` falls through to the file map. */
export type RemixSourceResolver = (anchorId: string) => string | undefined;

/**
 * The sandbox environment manifest (`.flowlet/env/manifest.json`): per-anchor,
 * per-import classification that drives BOTH the model's environment
 * instructions and the dev-facing fidelity report.
 */
export interface EnvManifest {
  /** anchorId → import specifier → how it resolves in the sandbox. */
  anchors: Record<string, Record<string, EnvImportStatus>>;
  /** Vendored bundle sizes in bytes, keyed by import-map specifier. */
  vendorSizes?: Record<string, number>;
}

export type EnvImportStatus =
  | { kind: "real" }
  | { kind: "shimmed"; note: string }
  | { kind: "absent"; alternative: string };

/**
 * Sandbox action — the semantic chokepoint shape only. How actions actually travel
 * (the transport, e.g. a client part) is owned by F3, not defined here.
 */
export interface ActionRequest {
  requestId: string;
  originNodeId: string;
  action: string;
  payload?: unknown;
  /** Opaque capability token authorizing this action; set by the sandbox when the
   *  origin node was granted one. Absent for unprivileged actions. */
  capability?: unknown;
}

export type ActionResult =
  | { result: unknown }
  | { error: { code: string; message: string } };

/** Semantic shape of the sandbox action chokepoint. Transport is owned by F3. */
export type DispatchAction = (req: ActionRequest) => Promise<ActionResult>;

/**
 * Flowlet's typed data-* parts layered on the ai SDK UIMessage. Approvals are NOT
 * here: human-in-the-loop tool approval is handled by the ai SDK natively
 * (`needsApproval` tools + `addToolApprovalResponse`), not a custom data part.
 */
export type FlowletDataParts = {
  ui: UINode;
};

/** The public message type: an ai SDK UIMessage with Flowlet metadata + data parts. */
export type FlowletUIMessage = UIMessage<FlowletMetadata, FlowletDataParts>;
