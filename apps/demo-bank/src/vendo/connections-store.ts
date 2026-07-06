/**
 * In-memory connection store — the single source of truth for which toolkits are
 * "connected" in the demo.
 *
 * In the live demo every toolkit starts DISCONNECTED. The user connects them on
 * screen (no real OAuth popup — the underlying Composio auth already exists;
 * connecting just flips the demo flag and enables ingestion). This store drives
 * BOTH the Integrations rail UI and which toolkits the chat agent ingests, so the
 * agent's real capabilities always track the on-screen connect state.
 */
import type { Principal } from "@vendoai/core";
import type { Integration } from "@vendoai/shell";
import { DEMO_USER_ID } from "./principal";

/** Advertised tools. `id`s MUST match the BrandIcon ids in @vendoai/shell. */
const CATALOG: { id: string; name: string }[] = [
  { id: "gmail", name: "Gmail" },
  { id: "slack", name: "Slack" },
  { id: "notion", name: "Notion" },
  { id: "github", name: "GitHub" },
  { id: "googlecalendar", name: "Google Calendar" },
  { id: "linear", name: "Linear" },
  { id: "googledrive", name: "Google Drive" },
  { id: "discord", name: "Discord" },
  { id: "googlesheets", name: "Google Sheets" },
  { id: "stripe", name: "Stripe" },
  { id: "jira", name: "Jira" },
  { id: "asana", name: "Asana" },
  { id: "hubspot", name: "HubSpot" },
  { id: "airtable", name: "Airtable" },
];

const VALID_IDS = new Set(CATALOG.map((c) => c.id));

/** Connected toolkit ids. Starts EMPTY — everything is disconnected on boot. */
const connected = new Set<string>();

/**
 * Composio connected-account id → owner, satisfying `vendo/server`'s widened
 * `ConnectionsStore` (Task 13). The demo runs with `automations: false`, so
 * webhook routing never actually reads this — it exists to satisfy the
 * handler's connections seam, not because the demo fires Composio triggers.
 */
const byAccount = new Map<string, { toolkit: string; principal: Principal }>();
const DEMO_SCOPE: Principal = { tenantId: "vendo-embedded", subject: DEMO_USER_ID };

/** The catalog with each tool's live `connected` flag. Async — `vendo/server`'s
 *  `ConnectionsStore` contract is fully async (the durable, DB-backed port
 *  necessarily is), so every method here is too even though this in-memory
 *  demo store never actually awaits anything. */
export async function listIntegrations(): Promise<Integration[]> {
  return CATALOG.map((c) => ({ ...c, connected: connected.has(c.id) }));
}

/** Mark a toolkit connected. No-op for unknown ids. */
export async function connect(id: string): Promise<void> {
  if (VALID_IDS.has(id)) connected.add(id);
}

/** Mark a toolkit disconnected. */
export async function disconnect(id: string): Promise<void> {
  connected.delete(id);
}

/** The currently-connected toolkit ids (drives agent ingestion). */
export async function connectedToolkits(): Promise<string[]> {
  return CATALOG.filter((c) => connected.has(c.id)).map((c) => c.id);
}

/** Record the Composio connected-account id once the OAuth flow lands. */
export async function setConnectedAccount(toolkit: string, connectedAccountId: string): Promise<void> {
  if (!VALID_IDS.has(toolkit)) return;
  connected.add(toolkit);
  byAccount.set(connectedAccountId, { toolkit, principal: DEMO_SCOPE });
}

/** Webhook routing: which principal owns this connected account? */
export async function findByConnectedAccount(
  connectedAccountId: string,
): Promise<{ toolkit: string; principal: Principal } | undefined> {
  return byAccount.get(connectedAccountId);
}

/** Reset everything to disconnected (used by the demo reset). */
export function resetConnections(): void {
  connected.clear();
  byAccount.clear();
}
