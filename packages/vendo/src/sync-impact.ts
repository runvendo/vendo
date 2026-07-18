import { VENDO_TREE_FORMAT_V2, type AppDocument, type PermissionGrant, type VendoRecord } from "@vendoai/core";
import type { VendoStore } from "@vendoai/store";

export interface ToolImpact {
  tool: string;
  apps: { id: string; title: string }[];
  automations: { id: string; title: string }[];
  grants: number;
}

interface StoredApp {
  enabled: boolean;
  doc: AppDocument;
}

async function allRecords(store: VendoStore, collection: string): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.records(collection).list({ limit: 1_000, cursor });
    records.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
}

function collectActions(value: unknown, tools: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectActions(item, tools);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of ["action", "$action"] as const) {
    const reference = record[key];
    if (typeof reference === "string" && !reference.startsWith("fn:")) tools.add(reference);
  }
  for (const nested of Object.values(record)) collectActions(nested, tools);
}

function referencedTools(doc: AppDocument): Set<string> {
  const tools = new Set<string>();
  if (doc.tree?.formatVersion === VENDO_TREE_FORMAT_V2) {
    const tree = doc.tree as {
      queries?: Array<{ tool?: unknown }>;
      nodes?: Array<{ props?: unknown }>;
    };
    for (const query of tree.queries ?? []) {
      if (typeof query.tool === "string" && !query.tool.startsWith("fn:")) tools.add(query.tool);
    }
    for (const node of tree.nodes ?? []) collectActions(node.props, tools);
  }
  if (doc.trigger?.run.kind === "steps") {
    for (const step of doc.trigger.run.steps) {
      if (!step.tool.startsWith("fn:")) tools.add(step.tool);
    }
  }
  return tools;
}

function activeGrant(grant: PermissionGrant, now: string): boolean {
  return grant.revokedAt === undefined && (grant.expiresAt === undefined || grant.expiresAt > now);
}

export async function computeImpact(store: VendoStore, tools: string[]): Promise<ToolImpact[]> {
  const [appRecords, grantRecords] = await Promise.all([
    allRecords(store, "vendo_apps"),
    allRecords(store, "vendo_grants"),
  ]);
  const apps = appRecords.map((record) => record.data as unknown as StoredApp).filter((app) => app.enabled);
  const now = new Date().toISOString();
  const grants = grantRecords
    .map((record) => record.data as unknown as PermissionGrant)
    .filter((grant) => activeGrant(grant, now));

  return tools.map((tool) => {
    const impact: ToolImpact = { tool, apps: [], automations: [], grants: 0 };
    for (const app of apps) {
      if (!referencedTools(app.doc).has(tool)) continue;
      const reference = { id: app.doc.id, title: app.doc.name };
      if (app.doc.trigger === undefined) impact.apps.push(reference);
      else impact.automations.push(reference);
    }
    impact.grants = grants.filter((grant) => grant.tool === tool).length;
    return impact;
  });
}
