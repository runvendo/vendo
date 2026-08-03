/**
 * The demo-bank (Maple) host surface for live harnesses: catalog + tools from
 * examples/demo-bank/.vendo, plus hand-written shape cards mirroring
 * examples/demo-bank/src/server/types.ts — what runtime shape-sampling would
 * derive from live responses. Shared by the live measurement harnesses
 * (engine.speed.test.ts, engine.pipeline.live.test.ts) so their deps match
 * what a real demo-bank create sees; never part of the test gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NormalizedCatalog, ShapeType } from "@vendoai/core";
import type { HostToolInfo } from "../generation/engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");

export const loadDemoBankCatalog = (): NormalizedCatalog => {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, "examples/demo-bank/.vendo/catalog.json"), "utf8")) as {
    entries: Array<{ name: string; description: string; propsSchema: unknown; examples?: string[] }>;
  };
  return raw.entries.map((e) => ({
    name: e.name,
    description: e.description,
    propsJsonSchema: e.propsSchema as NormalizedCatalog[number]["propsJsonSchema"],
    ...(e.examples === undefined ? {} : { examples: e.examples }),
  })) as NormalizedCatalog;
};

export const loadDemoBankTools = (): HostToolInfo[] => {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, "examples/demo-bank/.vendo/tools.json"), "utf8")) as {
    tools: Array<{ name: string; description: string; risk: string; inputSchema?: Record<string, unknown> }>;
  };
  // tools.json is what `vendo sync` writes; the live registry merges
  // overrides.json on top (disabled, risk, description). Mirror that here or
  // the bench sees tools the deployment disabled and labels it corrected.
  const { tools: overrides = {} } = JSON.parse(
    readFileSync(resolve(repoRoot, "examples/demo-bank/.vendo/overrides.json"), "utf8"),
  ) as { tools?: Record<string, { disabled?: boolean; risk?: string; description?: string }> };
  return raw.tools
    .filter(({ name }) => overrides[name]?.disabled !== true)
    .filter(({ name }) => !name.startsWith("host_auth") && !name.startsWith("host_demo") && !name.startsWith("host_voice"))
    .map(({ name, description, risk, inputSchema }) => ({
      name,
      description: overrides[name]?.description ?? description,
      risk: overrides[name]?.risk ?? risk,
      ...(inputSchema === undefined ? {} : { inputSchema }),
    }));
};

const str: ShapeType = { kind: "string" };
const num: ShapeType = { kind: "number" };
const bool: ShapeType = { kind: "boolean" };
const arr = (items: ShapeType): ShapeType => ({ kind: "array", items });
const obj = (fields: Record<string, ShapeType>): ShapeType => ({ kind: "object", fields });

const account = obj({
  id: str, name: str, kind: str, mask: str, balance: num,
  accountNumber: str, sparkline: arr(num),
});
const transaction = obj({
  id: str, accountId: str, merchant: str, descriptor: str, amount: num,
  timestamp: str, category: str, status: str, method: str,
});
const page = (items: ShapeType): ShapeType => obj({ data: arr(items), total: num });

export const demoBankToolShapes: Record<string, ShapeType> = {
  host_getProfile: obj({ name: str, email: str, netWorth: num, accountCount: num, avatarInitials: str }),
  host_listAccounts: arr(account),
  host_getAccount: account,
  host_listTransactions: page(transaction),
  host_listAccountTransactions: page(transaction),
  host_getTransaction: transaction,
  host_listCards: arr(obj({
    id: str, accountId: str, type: str, network: str, mask: str,
    expMonth: num, expYear: num, frozen: bool, design: str,
  })),
  host_listCardTransactions: page(transaction),
  host_getBudgets: arr(obj({ category: str, limit: num, spent: num })),
  host_listGoals: arr(obj({ id: str, name: str, target: num, saved: num, icon: str })),
  host_listPayees: arr(obj({ id: str, name: str, kind: str })),
  host_listScheduledPayments: arr(obj({
    id: str, payeeId: str, payeeName: str, amount: num, nextDate: str, cadence: str,
  })),
  host_getSpendingInsights: arr(obj({ category: str, amount: num })),
  host_getCashflowInsights: arr(obj({ label: str, in: num, out: num })),
  host_getRecurringInsights: arr(obj({
    id: str, merchant: str, amount: num, cadence: str, category: str, nextDate: str,
  })),
  host_listNotifications: arr(obj({
    id: str, kind: str, title: str, body: str, at: str, read: bool,
  })),
};
