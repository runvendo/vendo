/**
 * The Cadence (demo-accounting) host fixture: catalog + tools loaded from
 * examples/demo-accounting/.vendo/*.json (demo/voice plumbing filtered out, the
 * bench demo-bank-surface pattern), hand-written shape cards mirroring
 * examples/demo-accounting/src/server/types.ts plus its derived summaries
 * (ClientSummary/DeadlineEntry/DashboardMetrics), and deterministic canned-data
 * executors for every cataloged tool. No Math.random, no Date.now().
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { VendoError, vendoThemeSchema, type NormalizedCatalog, type ShapeType } from "@vendoai/core";
import type { HostToolInfo } from "@vendoai/apps";
import type { HostFixture } from "../runner/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const vendoDir = resolve(repoRoot, "examples/demo-accounting/.vendo");

/** Demo choreography + voice plumbing stay out of the generation surface —
 *  the same intent as the maple loader's host_auth/host_demo/host_voice filter. */
const EXCLUDED_TOOLS = new Set([
  "host_createVoiceSession",
  "host_listDemoChips",
  "host_resetDemo",
  "host_simulateClientUpload",
]);

const loadCadenceCatalog = (): NormalizedCatalog => {
  const raw = JSON.parse(readFileSync(resolve(vendoDir, "catalog.json"), "utf8")) as {
    entries: Array<{ name: string; description: string; propsSchema: unknown; examples?: string[] }>;
  };
  return raw.entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    propsJsonSchema: entry.propsSchema as NormalizedCatalog[number]["propsJsonSchema"],
    ...(entry.examples === undefined ? {} : { examples: entry.examples }),
  })) as NormalizedCatalog;
};

const loadCadenceTools = (): HostToolInfo[] => {
  const raw = JSON.parse(readFileSync(resolve(vendoDir, "tools.json"), "utf8")) as {
    tools: Array<{ name: string; description: string; risk: string; inputSchema?: Record<string, unknown> }>;
  };
  return raw.tools
    .filter(({ name }) => !EXCLUDED_TOOLS.has(name))
    .map(({ name, description, risk, inputSchema }) => ({
      name,
      description,
      risk,
      ...(inputSchema === undefined ? {} : { inputSchema }),
    }));
};

// ---------------------------------------------------------------------------
// Shape cards — mirror src/server/types.ts + the derived API summaries.
// ---------------------------------------------------------------------------

const str: ShapeType = { kind: "string" };
const num: ShapeType = { kind: "number" };
const arr = (items: ShapeType): ShapeType => ({ kind: "array", items });
const obj = (fields: Record<string, ShapeType>, optional?: string[]): ShapeType =>
  optional === undefined ? { kind: "object", fields } : { kind: "object", fields, optional };

const staff = obj({ id: str, name: str, role: str, initials: str });
const clientSummary = obj({
  id: str, businessName: str, entityType: str, contactName: str, contactEmail: str,
  assigneeId: str, filingDeadline: str,
  progress: obj({ received: num, total: num }),
  status: str,
  assignee: staff,
});
const deadlineEntry = obj({
  ...( clientSummary as Extract<ShapeType, { kind: "object" }> ).fields,
  missingDocKinds: arr(str),
});
const documentRequest = obj({
  id: str, clientId: str, kind: str, status: str,
  note: str,
  file: obj({ name: str, uploadedAt: str }),
}, ["note", "file"]);
const message = obj({ id: str, clientId: str, direction: str, author: str, body: str, sentAt: str });
const activityEvent = obj({ id: str, type: str, clientId: str, summary: str, at: str }, ["clientId"]);

export const cadenceToolShapes: Record<string, ShapeType> = {
  host_getDashboard: obj({
    clientsMissingDocs: num,
    documentsOutstanding: num,
    documentsReceived: num,
    documentsTotal: num,
    clientsTotal: num,
    nearestDeadline: str,
    nearestDeadlineClient: obj({ id: str, businessName: str, filingDeadline: str }),
  }),
  host_listClients: arr(clientSummary),
  host_getClient: clientSummary,
  host_listDeadlines: arr(deadlineEntry),
  host_listClientDocuments: arr(documentRequest),
  host_listClientMessages: arr(message),
  host_listActivity: arr(activityEvent),
  host_sendClientMessage: message,
  host_setDocumentStatus: documentRequest,
};

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const NOW = "2026-07-20T17:00:00.000Z";

const staffMembers = [
  { id: "st_maya", name: "Maya Alvarez", role: "Senior Accountant", initials: "MA" },
  { id: "st_jordan", name: "Jordan Lee", role: "Tax Preparer", initials: "JL" },
];

interface SeedClient {
  id: string; businessName: string; entityType: string; contactName: string;
  contactEmail: string; assigneeId: string; filingDeadline: string;
}

const clients: SeedClient[] = [
  { id: "cl_rivera", businessName: "Rivera Design Co", entityType: "s_corp", contactName: "Sofia Rivera", contactEmail: "sofia@riveradesign.co", assigneeId: "st_maya", filingDeadline: "2026-09-15T07:00:00.000Z" },
  { id: "cl_baystate", businessName: "Baystate Catering", entityType: "sole_prop", contactName: "Marcus Cole", contactEmail: "marcus@baystatecatering.com", assigneeId: "st_jordan", filingDeadline: "2026-10-15T07:00:00.000Z" },
  { id: "cl_northwind", businessName: "Northwind Labs", entityType: "c_corp", contactName: "Priya Nair", contactEmail: "priya@northwindlabs.io", assigneeId: "st_maya", filingDeadline: "2026-10-15T07:00:00.000Z" },
];

interface SeedDocument {
  id: string; clientId: string; kind: string; status: string; note?: string;
  file?: { name: string; uploadedAt: string };
}

const documents: SeedDocument[] = [
  { id: "doc_rivera_w2", clientId: "cl_rivera", kind: "W-2", status: "missing" },
  { id: "doc_rivera_1099", clientId: "cl_rivera", kind: "1099-NEC", status: "received", file: { name: "1099-nec-2025.pdf", uploadedAt: "2026-07-14T18:22:00.000Z" } },
  { id: "doc_rivera_bank", clientId: "cl_rivera", kind: "Bank statements (2025)", status: "verified", file: { name: "statements-2025.pdf", uploadedAt: "2026-07-08T20:04:00.000Z" } },
  { id: "doc_baystate_prior", clientId: "cl_baystate", kind: "Prior-year return", status: "verified", file: { name: "return-2024.pdf", uploadedAt: "2026-06-30T15:11:00.000Z" } },
  { id: "doc_baystate_bank", clientId: "cl_baystate", kind: "Bank statements (2025)", status: "needs_review", note: "Statement range looks incomplete", file: { name: "bank-jan-jun.pdf", uploadedAt: "2026-07-12T17:45:00.000Z" } },
  { id: "doc_northwind_w2", clientId: "cl_northwind", kind: "W-2 (all employees)", status: "verified", file: { name: "w2-batch.zip", uploadedAt: "2026-07-01T16:00:00.000Z" } },
  { id: "doc_northwind_dep", clientId: "cl_northwind", kind: "Depreciation schedule", status: "verified", file: { name: "depreciation-2025.xlsx", uploadedAt: "2026-07-02T19:30:00.000Z" } },
];

const messages = [
  { id: "msg_001", clientId: "cl_rivera", direction: "firm", author: "Maya Alvarez", body: "Hi Sofia — we still need your W-2 to start the return.", sentAt: "2026-07-10T16:00:00.000Z" },
  { id: "msg_002", clientId: "cl_rivera", direction: "client", author: "Sofia Rivera", body: "On it, I'll upload this week.", sentAt: "2026-07-10T18:24:00.000Z" },
  { id: "msg_003", clientId: "cl_baystate", direction: "firm", author: "Jordan Lee", body: "Your bank statements look incomplete — can you send Jul–Dec?", sentAt: "2026-07-13T15:30:00.000Z" },
];

const activity = [
  { id: "act_001", type: "upload_received", clientId: "cl_baystate", summary: "Baystate Catering uploaded Bank statements (2025)", at: "2026-07-12T17:45:00.000Z" },
  { id: "act_002", type: "document_verified", clientId: "cl_northwind", summary: "Depreciation schedule verified for Northwind Labs", at: "2026-07-12T09:10:00.000Z" },
  { id: "act_003", type: "message_sent", clientId: "cl_rivera", summary: "Maya Alvarez messaged Rivera Design Co about a missing W-2", at: "2026-07-10T16:00:00.000Z" },
  { id: "act_004", type: "deadline_approaching", summary: "Rivera Design Co files in under 60 days", at: "2026-07-09T12:00:00.000Z" },
];

// ---------------------------------------------------------------------------
// Derivations mirroring src/server/clients.ts / documents.ts
// ---------------------------------------------------------------------------

const outstanding = (status: string): boolean => status === "missing" || status === "rejected";

const clientDocs = (clientId: string): SeedDocument[] =>
  documents.filter((doc) => doc.clientId === clientId);

const clientStatus = (clientId: string): string => {
  const docs = clientDocs(clientId);
  if (docs.some((doc) => outstanding(doc.status))) return "missing_docs";
  if (docs.some((doc) => doc.status === "received" || doc.status === "needs_review")) return "in_review";
  return "complete";
};

const summarize = (client: SeedClient) => {
  const docs = clientDocs(client.id);
  return {
    ...client,
    progress: { received: docs.filter((doc) => !outstanding(doc.status)).length, total: docs.length },
    status: clientStatus(client.id),
    assignee: staffMembers.find((member) => member.id === client.assigneeId) ?? staffMembers[0],
  };
};

const byId = <T extends { id: string }>(items: T[], id: unknown): T =>
  items.find((item) => item.id === id) ?? (items[0] as T);

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

type Executor = (input: Record<string, unknown>) => unknown;

const executors: Record<string, Executor> = {
  host_getDashboard: () => {
    const outstandingCount = documents.filter((doc) => outstanding(doc.status)).length;
    const nearest = [...clients].sort(
      (a, b) => +new Date(a.filingDeadline) - +new Date(b.filingDeadline),
    )[0] as SeedClient;
    return {
      clientsMissingDocs: clients.filter((client) => clientStatus(client.id) === "missing_docs").length,
      documentsOutstanding: outstandingCount,
      documentsReceived: documents.length - outstandingCount,
      documentsTotal: documents.length,
      clientsTotal: clients.length,
      nearestDeadline: nearest.filingDeadline,
      nearestDeadlineClient: { id: nearest.id, businessName: nearest.businessName, filingDeadline: nearest.filingDeadline },
    };
  },
  host_listClients: (input) => {
    const q = typeof input.q === "string" ? input.q.trim().toLowerCase() : "";
    return clients
      .map(summarize)
      .filter((client) => input.filter !== "missing_docs" || client.status === "missing_docs")
      .filter((client) =>
        q === ""
        || client.businessName.toLowerCase().includes(q)
        || client.contactName.toLowerCase().includes(q));
  },
  host_getClient: (input) => summarize(byId(clients, input.id)),
  host_listDeadlines: () =>
    [...clients]
      .sort((a, b) => +new Date(a.filingDeadline) - +new Date(b.filingDeadline))
      .map((client) => ({
        ...summarize(client),
        missingDocKinds: clientDocs(client.id).filter((doc) => outstanding(doc.status)).map((doc) => doc.kind),
      })),
  host_listClientDocuments: (input) => clientDocs(byId(clients, input.id).id),
  host_listClientMessages: (input) => {
    const client = byId(clients, input.id);
    return messages.filter((msg) => msg.clientId === client.id);
  },
  host_listActivity: (input) =>
    typeof input.limit === "number" ? activity.slice(0, Math.max(0, Math.floor(input.limit))) : activity,
  host_sendClientMessage: (input) => {
    const client = byId(clients, input.id);
    const body = (input.body ?? {}) as Record<string, unknown>;
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (text === "") throw new VendoError("validation", "body.body must be a non-empty message");
    return {
      id: `msg_live_${client.id}`,
      clientId: client.id,
      direction: "firm",
      author: typeof body.author === "string" && body.author !== "" ? body.author : "Maya Alvarez",
      body: text,
      sentAt: NOW,
    };
  },
  host_setDocumentStatus: (input) => {
    const client = byId(clients, input.id);
    const doc = byId(clientDocs(client.id), input.docId);
    const body = (input.body ?? {}) as Record<string, unknown>;
    const action = body.action;
    if (action !== "receive" && action !== "verify" && action !== "reject") {
      throw new VendoError("validation", "body.action must be receive | verify | reject");
    }
    if (action === "receive") {
      const fileName = typeof body.fileName === "string" && body.fileName !== "" ? body.fileName : `${doc.id}.pdf`;
      return { id: doc.id, clientId: doc.clientId, kind: doc.kind, status: "received", file: { name: fileName, uploadedAt: NOW } };
    }
    if (action === "verify") {
      return { id: doc.id, clientId: doc.clientId, kind: doc.kind, status: "verified", ...(doc.file === undefined ? {} : { file: doc.file }) };
    }
    const reason = typeof body.reason === "string" && body.reason !== "" ? body.reason : "Wrong document";
    return { id: doc.id, clientId: doc.clientId, kind: doc.kind, status: "missing", note: reason };
  },
};

export const cadenceFixture: HostFixture = {
  name: "cadence",
  catalog: loadCadenceCatalog(),
  tools: loadCadenceTools(),
  shapes: cadenceToolShapes,
  theme: vendoThemeSchema.parse(JSON.parse(readFileSync(resolve(vendoDir, "theme.json"), "utf8"))),
  async execute(tool, input) {
    const executor = executors[tool];
    if (executor === undefined) throw new VendoError("not-found", `cadence fixture has no tool "${tool}"`);
    return executor(input);
  },
};
