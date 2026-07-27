/**
 * Headless bench runner — the agent path (`pnpm --filter genui-bench bench
 * run --host maple --pack smoke --lanes vendo`). Same runner library as the
 * cockpit; prints each RunRecord path, then one compact JSON summary line.
 *
 * GENUI_BENCH_FAKE_LANES=1 swaps every lane for a stub adapter (tests: no
 * model calls, no keys, no fixtures needed).
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { executeRun } from "./runner/run";
import type { HostFixture, HostName, LaneAdapter, LaneName, RunRequest } from "./runner/types";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const HOSTS: HostName[] = ["maple", "cadence"];
const LANES: LaneName[] = ["vendo", "thesys-c1", "copilotkit", "tambo"];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      host: { type: "string" },
      prompt: { type: "string", multiple: true },
      pack: { type: "string" },
      lanes: { type: "string", default: "vendo" },
      "runs-dir": { type: "string" },
    },
  });
  if (positionals.length > 0 && positionals[0] !== "run") {
    usage(`unknown command "${positionals[0]}" — only "run" exists`);
  }

  const host = values.host as HostName | undefined;
  if (!host) usage("--host <maple|cadence> is required");
  if (!HOSTS.includes(host)) usage(`unknown --host "${host}" (maple|cadence)`);

  const lanes = (values.lanes as string).split(",").map((lane) => lane.trim()) as LaneName[];
  for (const lane of lanes) {
    if (!LANES.includes(lane)) usage(`unknown lane "${lane}" (${LANES.join("|")})`);
  }

  const prompts = resolvePrompts(values.prompt, values.pack);
  const runsDir = values["runs-dir"] ?? join(APP_DIR, "runs");

  loadRootEnv();
  const { fixtures, adapters } = await resolveLanes(lanes);

  const summary: Array<Record<string, unknown>> = [];
  for (const [index, prompt] of prompts.entries()) {
    const request: RunRequest = {
      prompt,
      host,
      lanes,
      ...(values.pack ? { packRef: { pack: values.pack, index } } : {}),
    };
    const record = await executeRun(request, fixtures, adapters, runsDir);
    console.log(join(runsDir, record.id, "run.json"));

    const entry: Record<string, unknown> = { prompt };
    for (const lane of lanes) {
      const result = record.lanes[lane];
      if (!result) continue;
      if (result.status === "no-key") {
        entry[lane] = { status: "no-key" };
        continue;
      }
      const repairs = (result.events ?? []).filter(
        (event) => event.stage === "repair" || event.stage === "island-repair",
      ).length;
      entry[lane] = {
        status: result.status,
        durationMs: result.durationMs,
        repairs,
        ...(result.status === "failed" ? { error: result.error } : {}),
      };
    }
    summary.push(entry);
  }
  console.log(JSON.stringify({ runs: summary }));
}

function resolvePrompts(prompts: string[] | undefined, pack: string | undefined): string[] {
  if (pack && prompts?.length) usage("--prompt and --pack are mutually exclusive");
  if (pack) {
    const packPath = join(APP_DIR, "packs", `${pack}.json`);
    if (!existsSync(packPath)) usage(`pack not found: ${packPath}`);
    return (JSON.parse(readFileSync(packPath, "utf8")) as { prompts: string[] }).prompts;
  }
  if (!prompts?.length) usage("give --prompt (repeatable) or --pack <name>");
  return prompts;
}

/** Real lanes/fixtures land in later tasks — resolved lazily by name so the
 *  CLI (and fake mode) works before they exist. */
async function resolveLanes(lanes: LaneName[]): Promise<{
  fixtures: Partial<Record<HostName, HostFixture>>;
  adapters: LaneAdapter[];
}> {
  if (process.env.GENUI_BENCH_FAKE_LANES === "1") {
    const stub = (name: HostName): HostFixture => ({
      name,
      catalog: {},
      tools: [],
      shapes: {},
      theme: {},
      execute: async () => ({}),
    });
    const adapters = lanes.map(
      (name): LaneAdapter => ({
        name,
        async generate() {
          return { status: "ok", startedAt: Date.now(), durationMs: 0, events: [] };
        },
      }),
    );
    return { fixtures: { maple: stub("maple"), cadence: stub("cadence") }, adapters };
  }

  // Variable specifiers keep tsc from resolving modules that later tasks add.
  const fixturesSpecifier = "./fixtures";
  const { fixtures } = (await import(fixturesSpecifier)) as {
    fixtures: Partial<Record<HostName, HostFixture>>;
  };
  const adapters = await Promise.all(
    lanes.map(async (lane) => {
      const mod = await import(`./lanes/${lane}`);
      return (mod.default ?? mod.adapter) as LaneAdapter;
    }),
  );
  return { fixtures, adapters };
}

/** Source-only root .env load: fills unset process.env keys, never prints values. */
function loadRootEnv(): void {
  let root: string;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }
}

function usage(message: string): never {
  console.error(`genui-bench: ${message}`);
  console.error(
    'usage: bench run --host <maple|cadence> (--prompt "..." [--prompt "..."] | --pack <name>) [--lanes vendo,thesys-c1,copilotkit,tambo] [--runs-dir <dir>]',
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(`genui-bench: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
