import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExec, normalizeRouterUrl, type ExecFn } from "./deploy.js";

/**
 * `demo:reap` — expiry teardown for deployed demos. Reads the registry via
 * the router's admin API, selects rows that are past `expiresAt` or killed,
 * and (with `--execute`; dry-run is the default) removes each demo's latest
 * Railway deployment plus its registry row.
 *
 * Railway CLI 4.36.1 has NO service-delete command (verified via `--help`
 * probes: `railway delete` deletes whole PROJECTS, `railway down` removes the
 * most recent deployment). So the reaper runs `railway down --service
 * demo-<id> --yes` — which stops the demo from serving (and billing) — and
 * reports that deleting the empty service shell is a manual dashboard step.
 */

export interface DemoReapArgs {
  routerUrl: string;
  project: string;
  /** Actually tear down; without it the reap is a dry run that only prints the plan. */
  execute: boolean;
}

/** A row as served by tools/demo-router's admin API. */
export interface RegistryRow {
  id: string;
  url: string;
  prospect: string;
  expiresAt: string;
  killed: boolean;
  createdAt: string;
  hits: number;
}

export type ReapReason = "expired" | "killed" | "invalid-expiry";

export interface ReapCandidate {
  row: RegistryRow;
  reason: ReapReason;
}

export interface DemoReapResult {
  candidates: ReapCandidate[];
  executed: boolean;
  /** Ids whose Railway teardown failed — their registry rows were KEPT so a future reap still sees them. */
  failed: string[];
}

const defaultRouterUrl = "https://demos.vendo.run";
const defaultProject = "vendo-demos";

const valueOptions = new Set(["--router-url", "--project"]);
const flagOptions = new Set(["--execute"]);

export function parseDemoReapArgs(argv: string[]): DemoReapArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const option = normalizedArgv[index];
    if (!option?.startsWith("--")) throw new Error(`Unexpected argument: ${option ?? ""}`);
    if (flagOptions.has(option)) {
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = normalizedArgv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    options.set(option, value);
    index += 1;
  }
  return {
    routerUrl: normalizeRouterUrl("--router-url", options.get("--router-url") ?? defaultRouterUrl),
    project: options.get("--project") ?? defaultProject,
    execute: flags.has("--execute"),
  };
}

/**
 * Which rows come down: killed always; past-or-at `expiresAt` (>= to match
 * the router's boundary); an unparseable `expiresAt` is reapable too — the
 * router already stopped routing it (fail closed), so tearing it down is
 * consistent, and the distinct reason keeps the report honest.
 */
export function selectReapable(rows: RegistryRow[], now: Date): ReapCandidate[] {
  const candidates: ReapCandidate[] = [];
  for (const row of rows) {
    if (row.killed) {
      candidates.push({ row, reason: "killed" });
      continue;
    }
    const expiresAtMs = Date.parse(row.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      candidates.push({ row, reason: "invalid-expiry" });
    } else if (now.getTime() >= expiresAtMs) {
      candidates.push({ row, reason: "expired" });
    }
  }
  return candidates;
}

export interface ReapPlan {
  railwayDown: string[];
  registryDelete: string;
}

export function buildReapPlan(row: Pick<RegistryRow, "id">, routerUrl: string): ReapPlan {
  return {
    railwayDown: ["railway", "down", "--service", `demo-${row.id}`, "--yes"],
    registryDelete: `${routerUrl.replace(/\/+$/, "")}/admin/demos/${row.id}`,
  };
}

export interface ReapIo {
  exec?: ExecFn;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
  now?: () => Date;
}

export async function runDemoReap(args: DemoReapArgs, io: ReapIo): Promise<DemoReapResult> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const env = io.env ?? process.env;
  const write = io.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = io.now ?? (() => new Date());

  const token = env.ROUTER_ADMIN_TOKEN;
  if (token === undefined || token === "") {
    throw new Error("ROUTER_ADMIN_TOKEN must be set to read the demo registry");
  }

  const listUrl = `${args.routerUrl.replace(/\/+$/, "")}/admin/demos`;
  const response = await fetchImpl(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Registry read failed: ${response.status} ${await response.text()}`);
  }
  const { demos } = (await response.json()) as { demos: RegistryRow[] };
  const candidates = selectReapable(demos, now());

  if (candidates.length === 0) {
    write(`Nothing to reap — ${demos.length} registered demo(s), none expired or killed.`);
    return { candidates, executed: args.execute, failed: [] };
  }

  write(`${candidates.length} demo(s) to reap (of ${demos.length} registered):`);
  for (const candidate of candidates) {
    const plan = buildReapPlan(candidate.row, args.routerUrl);
    write(`  ${candidate.row.id} (${candidate.reason}, expires ${candidate.row.expiresAt}, ${candidate.row.hits} hits)`);
    write(`    ${plan.railwayDown.join(" ")}`);
    write(`    DELETE ${plan.registryDelete}`);
  }

  if (!args.execute) {
    write("Dry run (the default) — re-run with --execute to tear these down.");
    return { candidates, executed: false, failed: [] };
  }

  const exec = io.exec ?? defaultExec;
  // The railway CLI acts on the directory-linked project; link once up front.
  const repoRoot = repoRootFromHere();
  const link = await exec(["railway", "link", "--project", args.project], { cwd: repoRoot });
  if (link.code !== 0) {
    throw new Error(`"railway link --project ${args.project}" failed (exit ${link.code}):\n${link.stderr || link.stdout}`);
  }

  const failed: string[] = [];
  for (const candidate of candidates) {
    const plan = buildReapPlan(candidate.row, args.routerUrl);
    // `railway down` removes the latest deployment — the service stops
    // serving/billing. The ONLY tolerated failure is "nothing to remove"
    // (already torn down); any other failure keeps the registry row, so the
    // still-live service stays visible to the next reap instead of becoming
    // an orphan running on our key.
    const down = await exec(plan.railwayDown, { cwd: repoRoot });
    const alreadyGone = /no\s+(recent\s+|active\s+)?deployments?/i.test(`${down.stderr}\n${down.stdout}`);
    if (down.code !== 0 && !alreadyGone) {
      const detail = (down.stderr || down.stdout).trim().split("\n")[0] ?? `exit ${down.code}`;
      write(`  ${candidate.row.id}: railway down failed (${detail}) — keeping its registry row so the next reap retries`);
      failed.push(candidate.row.id);
      continue;
    }
    const deleted = await fetchImpl(plan.registryDelete, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`Failed to delete registry row for "${candidate.row.id}": ${deleted.status} ${await deleted.text()}`);
    }
    write(`  ${candidate.row.id}: deployment removed + registry row deleted`);
  }
  write("NOTE: railway CLI 4.36.1 cannot delete a service — the empty service shells remain; delete them in the Railway dashboard (project settings) when convenient.");
  if (failed.length > 0) {
    write(`FAILED to tear down: ${failed.join(", ")} — registry rows kept; investigate and re-run.`);
  }
  return { candidates, executed: true, failed };
}

function repoRootFromHere(): string {
  // bench/dist/demo-creator/reap.js -> repo root (same shape as cli.ts's repoRoot).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}
