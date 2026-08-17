import {
  automationRecordSchema,
  VENDO_TREE_FORMAT,
  VendoError,
  type AppDocument,
  type AutomationRecord,
  type PermissionGrant,
  type StoreOps,
  type VendoRecord,
} from "@vendoai/core";
import { appRowSchema } from "@vendoai/apps/contract";

export interface ToolImpact {
  tool: string;
  apps: { id: string; title: string }[];
  automations: { id: string; title: string }[];
  grants: number;
}

/** The app row as this reader takes it OFF the store. `appRowSchema` is the
 *  contract's one definition of the stored row, and it is parsed rather than
 *  cast: `sync` telling a deployment that changing a tool would affect NOTHING
 *  reads as "nothing to worry about", which is the one wrong answer here that
 *  costs something. This reader needs two of its three fields. */
const storedAppSchema = appRowSchema.pick({ enabled: true, doc: true });

async function allRecords(ops: StoreOps, collection: string): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await ops.engine.list(collection, { limit: 1_000, cursor });
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
  return tools;
}

/** An automation's own tool references. Only a STEPS task names tools ahead of
 *  time — a goal task decides at run time, so it can promise nothing here. */
function automationTools(record: AutomationRecord): Set<string> {
  const tools = new Set<string>();
  if (record.task.kind !== "steps") return tools;
  for (const step of record.task.steps) {
    if (!step.tool.startsWith("fn:")) tools.add(step.tool);
  }
  return tools;
}

/** What a person reads in the report. A record has no name — it has a WHEN,
 *  which is the thing they would recognize it by. */
function automationTitle(when: AutomationRecord["when"]): string {
  if (when.kind === "host-event") return `on ${when.event}`;
  if (when.kind === "external") return `on ${when.connector}`;
  return when.cron ?? when.every ?? when.at ?? "on a schedule";
}

function activeGrant(grant: PermissionGrant, now: string): boolean {
  return grant.revokedAt === undefined && (grant.expiresAt === undefined || grant.expiresAt > now);
}

export async function computeImpact(
  ops: StoreOps | undefined,
  tools: string[],
): Promise<ToolImpact[]> {
  if (ops === undefined) {
    throw new VendoError(
      "not-implemented",
      "The impact report reads Vendo's own app and grant drawers, so it needs the store's "
      + "named-operation surface: a SQL-backed store (`store: postgres(url)`, or the local default) "
      + "or a StoreOps-capable store (the Cloud hosted store). The configured store is neither.",
    );
  }
  const [appRecords, automationRecords, grantRecords] = await Promise.all([
    allRecords(ops, "vendo_apps"),
    allRecords(ops, "vendo_automations"),
    allRecords(ops, "vendo_grants"),
  ]);
  // A row that will not parse is skipped rather than thrown on: `sync` is
  // advisory and read-only, and one unreadable row must not take the whole
  // impact report — including every other row's warning — down with it.
  const apps = appRecords.flatMap((record) => {
    const parsed = storedAppSchema.safeParse(record.data);
    return parsed.success ? [parsed.data] : [];
  }).filter((app) => app.enabled);
  const automations = automationRecords.flatMap((record) => {
    const parsed = automationRecordSchema.safeParse(record.data);
    return parsed.success && parsed.data.armed ? [parsed.data] : [];
  });
  const now = new Date().toISOString();
  const grants = grantRecords
    .map((record) => record.data as unknown as PermissionGrant)
    .filter((grant) => activeGrant(grant, now));

  return tools.map((tool) => {
    const impact: ToolImpact = { tool, apps: [], automations: [], grants: 0 };
    for (const app of apps) {
      if (referencedTools(app.doc).has(tool)) impact.apps.push({ id: app.doc.id, title: app.doc.name });
    }
    for (const automation of automations) {
      if (automationTools(automation).has(tool)) {
        impact.automations.push({ id: automation.id, title: automationTitle(automation.when) });
      }
    }
    impact.grants = grants.filter((grant) => grant.tool === tool).length;
    return impact;
  });
}
