import {
  appDocumentSchema,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type PermissionGrant,
  type VendoRecord,
} from "@vendoai/core";
import type { VendoStore } from "@vendoai/store";
import { z } from "zod";

export interface ToolImpact {
  tool: string;
  apps: { id: string; title: string }[];
  automations: { id: string; title: string }[];
  grants: number;
}

/** The app row as this reader takes it OFF the store.
 *
 *  `doc` goes through `appDocumentSchema`, not a cast, because that schema is
 *  where a pre-list document's single `trigger` becomes the one-item `triggers`
 *  list every reader below expects. Casting the raw row left `doc.triggers`
 *  undefined on every automation armed before the list shipped, so `vendo sync`
 *  told those deployments that changing a tool would affect NO automations —
 *  which reads as "nothing to worry about" and is the one wrong answer that
 *  costs something. Mirrors `appRowSchema` in the automations engine. */
const storedAppSchema = z.object({
  enabled: z.boolean(),
  doc: appDocumentSchema,
});

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
  if (doc.tree?.formatVersion === VENDO_TREE_FORMAT) {
    const tree = doc.tree as {
      queries?: Array<{ tool?: unknown }>;
      nodes?: Array<{ props?: unknown }>;
    };
    for (const query of tree.queries ?? []) {
      if (typeof query.tool === "string" && !query.tool.startsWith("fn:")) tools.add(query.tool);
    }
    for (const node of tree.nodes ?? []) collectActions(node.props, tools);
  }
  // The compiler-stamped manifest of what each island's SOURCE calls through
  // the ambient `tools` API. Those calls are in generated code, so they never
  // appear in tree.queries or node props — without this, an app full of islands
  // reports zero references for every tool it actually runs.
  for (const names of Object.values(doc.componentTools ?? {})) {
    for (const name of names) {
      if (!name.startsWith("fn:")) tools.add(name);
    }
  }
  for (const trigger of doc.triggers ?? []) {
    if (trigger.run.kind !== "steps") continue;
    for (const step of trigger.run.steps) {
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
  // A row that will not parse is skipped rather than thrown on: `sync` is
  // advisory and read-only, and one unreadable row must not take the whole
  // impact report — including every other row's warning — down with it.
  const apps = appRecords.flatMap((record) => {
    const parsed = storedAppSchema.safeParse(record.data);
    return parsed.success ? [parsed.data] : [];
  }).filter((app) => app.enabled);
  const now = new Date().toISOString();
  const grants = grantRecords
    .map((record) => record.data as unknown as PermissionGrant)
    .filter((grant) => activeGrant(grant, now));

  return tools.map((tool) => {
    const impact: ToolImpact = { tool, apps: [], automations: [], grants: 0 };
    for (const app of apps) {
      if (!referencedTools(app.doc).has(tool)) continue;
      const reference = { id: app.doc.id, title: app.doc.name };
      if ((app.doc.triggers ?? []).length === 0) impact.apps.push(reference);
      else impact.automations.push(reference);
    }
    impact.grants = grants.filter((grant) => grant.tool === tool).length;
    return impact;
  });
}
