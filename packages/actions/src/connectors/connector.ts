import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";

/** 04-actions §3 — one per-user connected account at an external connector,
 * as the umbrella's /connections endpoints and the chrome panel see it. */
export interface ConnectorAccount {
  id: string;
  connector: string;
  toolkit: string;
  status: "initiated" | "active" | "expired" | "failed";
  createdAt?: string;
}

/** One connectable toolkit as the connect dock's catalog advertises it. */
export interface ConnectorCatalogEntry {
  toolkit: string;
  /** Display name; the UI falls back to its humanizer when absent. */
  label?: string;
  /** One-line capability blurb (provider metadata). Load-bearing for the
   * discovery index's recall — "send email" must match gmail. */
  description?: string;
}

/** One toolkit in the discovery index: always searchable, never executable on
 * its own. Implementations enrich `description` from provider metadata with a
 * static fallback, because index recall depends on it. */
export interface ToolkitIndexEntry {
  toolkit: string;
  label?: string;
  description?: string;
}

/** 04-actions §3 — the per-user connected-accounts capability of a connector.
 * Every method is scoped to ONE subject (entityId = principal subject); an
 * implementation must never let one subject read or disconnect another's
 * account — `status` returns null and `disconnect` throws not-found for
 * accounts outside the subject's scope. */
export interface ConnectorConnections {
  list(subject: string): Promise<ConnectorAccount[]>;
  initiate(
    subject: string,
    toolkit: string,
    options?: { callbackUrl?: string },
  ): Promise<{ id: string; redirectUrl: string }>;
  status(subject: string, connectionId: string): Promise<ConnectorAccount | null>;
  disconnect(subject: string, connectionId: string): Promise<void>;
  /** Optional: the toolkits a user can actually finish connecting here — the
   * host's explicit scoping when it has one, else whatever the broker holds
   * credentials for. Host-level, not per-subject: this feeds the wire's
   * catalog endpoint, which the connect dock renders when the host passes no
   * explicit `connectors` list. */
  listConnectable?(): Promise<ConnectorCatalogEntry[]>;
}

/** Cross-cutting audit enrichment (block-actions design §Cross-cutting): the
 * connector account identity a connector attaches to every execution outcome
 * as the passthrough `connectorAccount` field. The guard lifts it into the
 * tool-call audit event's detail and strips it from the outcome it returns. */
export interface ConnectorAccountIdentity {
  connector: string;
  toolkit?: string;
  /** The per-user entity the call executed as (entityId = principal subject). */
  entityId?: string;
  /** The provider-side connected-account id, when the provider reports it. */
  accountId?: string;
  /** Whether the call authenticated with a per-principal credential or a
   * shared connector-wide one (the MCP connector's static-headers default). */
  credential?: "per-principal" | "shared";
}

/** 04-actions §3: external tool sources — lean, we build zero. */
export interface Connector {
  name: string;
  descriptors(): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome>;
  /** Optional: per-user connected accounts (Composio is the sole broker). */
  connections?: ConnectorConnections;
  /** Optional: the lazily-loaded discovery index — one entry per connectable
   * toolkit. Present only on connectors that defer full schema loading
   * (connection-scoped tool loading, spec 2026-07-20). */
  discoveryIndex?(): Promise<ToolkitIndexEntry[]>;
  /** Optional: fetch + include the named toolkits' full descriptors in the
   * next descriptors() read. Returns true when anything NEW was expanded (the
   * registry then invalidates its load memo). Unknown toolkits are ignored. */
  expandToolkits?(toolkits: string[]): Promise<boolean>;
}
