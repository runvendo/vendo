/**
 * The default connectable-toolkit catalog. Isomorphic on purpose — the server
 * integrations endpoints and the client Connect card both read it, and the
 * client must never pull the Composio server module in transitively.
 * Ids must match the shell's BrandIcon ids.
 */
import type { IntegrationCatalogEntry } from "./options.js";

export const DEFAULT_INTEGRATION_CATALOG: IntegrationCatalogEntry[] = [
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
