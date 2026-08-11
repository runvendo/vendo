import type { RiskLabel, RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";

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

/** One tool the broker's own search matched, carrying everything the model
 * needs to call it — schema included — so finding a tool costs one round trip
 * and the tool LISTING never changes (connector-discovery design 2026-08-03). */
export interface ServiceToolMatch {
  /** The broker's callable slug, verbatim — what `use_service_tool` takes. */
  slug: string;
  toolkit: string;
  description: string;
  /** JSON Schema for `arguments`. Absent when the broker could not produce one:
   * the model must then ask rather than guess (`find_service_tools` says so). */
  inputSchema?: Record<string, unknown>;
  /** Whether THIS caller has an active connection for the toolkit. */
  connected: boolean;
  /** The broker's own sentence about the connection and what to do next. */
  statusMessage?: string;
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
  /**
   * Optional: the broker's OWN search over its whole catalog, for the caller in
   * `ctx`. This is the capability that makes `find_service_tools` exist — a
   * host cannot index 20,000 third-party tools and neither can we, so a
   * connector that cannot search simply does not get the tool.
   *
   * `ctx` is the CALLER's, handed down from the tool's `execute`: a connection
   * belongs to a person, so `connected` is per-subject and never deployment-wide.
   */
  searchTools?(need: string, ctx: RunContext): Promise<ServiceToolMatch[]>;
  /**
   * Optional: the broker's risk grade for one slug, from ITS OWN per-tool tags —
   * the grading nobody else can do at catalog scale. `undefined` means the slug
   * does not exist here; an ungradable slug that DOES exist resolves `ungraded`,
   * which the guard asks about (risk-grading redesign D1). Never inferred from
   * the name: §12 and #747 deleted the word lists on purpose.
   *
   * Load-bearing for DISPATCH, not just grading: composition treats a
   * non-`undefined` answer as this connector CLAIMING the slug, so one lookup
   * decides both who runs the call and how the guard grades it and the two can
   * never disagree. The consequence is that the three capabilities on this
   * interface are one unit — a connector with {@link searchTools} and
   * {@link executeSlug} but no `toolRisk` can claim nothing, so it is projected
   * no service tools at all rather than a dispatcher that always misses.
   */
  toolRisk?(slug: string): Promise<RiskLabel | undefined>;
  /** Optional: run one of the broker's tools by its own slug, as the caller in
   * `ctx`. The companion of {@link searchTools}: the model reaches the catalog
   * through `use_service_tool` instead of through the tool listing. */
  executeSlug?(slug: string, args: unknown, ctx: RunContext): Promise<ToolOutcome>;
  /** Optional: the toolkit one of this connector's loaded tools belongs to
   * (undefined for names it does not serve). Present only on brokered
   * connectors with PER-USER connections — it feeds the pre-guard connect
   * check (discovery-discipline 2026-07-25), which must never gate a
   * connector whose credentials are not per-user. */
  toolkitOf?(tool: string): string | undefined;
}
