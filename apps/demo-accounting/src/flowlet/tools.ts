/**
 * The Cadence agent's in-process tools: read-only views over the firm's store,
 * shaped for generated UI. These exist alongside the camelCase host-API tools
 * for one reason — they run SERVER-SIDE in the same Next process, so the
 * sandbox action route (a generated component's flowlet.dispatch) and the
 * saved-view refresh seam (runQuery on reopen) can execute them without a
 * browser session. Writes have no in-process form: they go through the
 * client-executed host tools and their approval cards.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getStore } from "@/server/store";
import { listClientSummaries, listDeadlineEntries } from "@/server/clients";
import { dashboardMetrics } from "@/server/documents";

const getDashboard = tool({
  description:
    "Read the firm-wide dashboard metrics: clients missing documents, documents " +
    "outstanding vs received, and the nearest filing deadline with its client.",
  inputSchema: z.object({}),
  execute: async () => dashboardMetrics(),
});

const getClients = tool({
  description:
    "List the firm's clients with document progress ('3 of 6 received'), derived " +
    "status (missing_docs | in_review | complete), entity type, contact, assignee " +
    "and filing deadline. Filter to clients still missing documents or search by name.",
  inputSchema: z.object({
    missingDocs: z.boolean().optional().describe("Only clients still missing documents."),
    search: z.string().optional().describe("Case-insensitive business-name search."),
  }),
  execute: async ({ missingDocs, search }) =>
    listClientSummaries({ filter: missingDocs ? "missing_docs" : null, q: search ?? null }),
});

const getClientDocuments = tool({
  description:
    "List one client's requested tax documents (their checklist) with per-document " +
    "status (missing | received | needs_review | verified | rejected), uploaded file " +
    "and any rejection note.",
  inputSchema: z.object({
    clientId: z.string().describe("The client id, e.g. from get_clients."),
  }),
  execute: async ({ clientId }) => {
    const store = getStore();
    if (!store.clients.some((c) => c.id === clientId)) {
      return { error: `Unknown client: ${clientId}` };
    }
    return store.documents.filter((d) => d.clientId === clientId);
  },
});

const getDeadlines = tool({
  description:
    "All clients ordered by filing deadline (soonest first), each with document " +
    "progress and the kinds of documents still missing. Use this to see who is at " +
    "risk of missing their deadline.",
  inputSchema: z.object({}),
  execute: async () => listDeadlineEntries(),
});

const getActivity = tool({
  description:
    "Firm-wide activity feed, newest first: uploads received, documents verified or " +
    "rejected, messages sent, deadlines approaching.",
  inputSchema: z.object({
    limit: z.number().optional().describe("Max events to return (default all)."),
  }),
  execute: async ({ limit }) => {
    const events = getStore().activity;
    return limit !== undefined && Number.isFinite(limit) && limit > 0
      ? events.slice(0, limit)
      : events;
  },
});

export function demoTools(): ToolSet {
  return {
    get_dashboard: getDashboard,
    get_clients: getClients,
    get_client_documents: getClientDocuments,
    get_deadlines: getDeadlines,
    get_activity: getActivity,
  };
}

export { READ_ONLY_TOOLS } from "./read-only-tools";
