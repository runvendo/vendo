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
import type { Integration } from "@flowlet/shell";

/** Advertised tools. `id`s MUST match the BrandIcon ids in @flowlet/shell. */
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

/** The catalog with each tool's live `connected` flag. */
export function listIntegrations(): Integration[] {
  return CATALOG.map((c) => ({ ...c, connected: connected.has(c.id) }));
}

/** Mark a toolkit connected. No-op for unknown ids. */
export function connect(id: string): void {
  if (VALID_IDS.has(id)) connected.add(id);
}

/** Mark a toolkit disconnected. */
export function disconnect(id: string): void {
  connected.delete(id);
}

/** The currently-connected toolkit ids (drives agent ingestion). */
export function connectedToolkits(): string[] {
  return CATALOG.filter((c) => connected.has(c.id)).map((c) => c.id);
}

/** Reset everything to disconnected (used by the demo reset). */
export function resetConnections(): void {
  connected.clear();
}
