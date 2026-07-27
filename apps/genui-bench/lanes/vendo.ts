/**
 * The Vendo lane: modelEngine.create driven directly against the HostFixture
 * surface — the exact composition the live pipeline harness
 * (packages/apps/src/engine.pipeline.live.test.ts) uses: catalog + tools +
 * shape cards + theme as GenerationDependencies, the production wire dialect
 * and PipelineConfig defaults (no knobs overridden), and an onPipeline tap
 * accumulating every stage event. NEVER throws: an engine crash resolves to
 * status:"failed" carrying the partial events captured up to the throw.
 *
 * The model key comes from the repo-root .env (source-only: values are read
 * into process.env and never printed). The Anthropic provider resolves through
 * @vendoai/apps's own module space — genui-bench declares no model SDK.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  modelEngine,
  type GenerationDependencies,
  type GenerationEngine,
  type HostToolInfo,
  type PipelineEvent,
} from "@vendoai/apps";
import {
  printWire,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type NormalizedCatalog,
  type ShapeType,
  type Tree,
  type VendoTheme,
} from "@vendoai/core";
import type { HostFixture, LaneAdapter, LaneResult } from "../runner/types";

export interface VendoAdapterOverrides {
  /** Test seam: a GenerationEngine-shaped fake (default: the real modelEngine). */
  engine?: Pick<GenerationEngine, "create">;
  /** Test seam: an injected model instance (default: Anthropic from root .env). */
  model?: GenerationDependencies["model"];
}

const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

/** Source-only root .env load (cli.ts pattern, duplicated because cli.ts runs
 *  its main on import): fills unset process.env keys, never prints values. */
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
    if (process.env[key as string] !== undefined) continue;
    process.env[key as string] = (raw as string).replace(/^(["'])(.*)\1$/, "$2");
  }
}

/** The real model: @ai-sdk/anthropic resolved through @vendoai/apps's module
 *  space (the engine's own provider dep) so this app adds no model SDK. */
function resolveAnthropicModel(): GenerationDependencies["model"] {
  loadRootEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY missing — set it in the repo-root .env");
  }
  // import.meta.resolve is absent when tsx runs this file as CJS (the CLI
  // path) — createRequire(import.meta.url).resolve is the everywhere-safe way
  // to locate @vendoai/apps's entry and require from its module space.
  const appsEntry = createRequire(import.meta.url).resolve("@vendoai/apps");
  const requireFromApps = createRequire(appsEntry);
  const { createAnthropic } = requireFromApps("@ai-sdk/anthropic") as {
    createAnthropic: (options: { apiKey: string }) => (id: string) => GenerationDependencies["model"];
  };
  return createAnthropic({ apiKey })(process.env.GENUI_BENCH_MODEL ?? DEFAULT_MODEL_ID);
}

/** The canonical printed wire of the final document (the engine exposes no
 *  raw-stream tap; this is the same print the repair/verify stages read). */
function renderWire(document: AppDocument): string | undefined {
  if (document.tree?.formatVersion !== VENDO_TREE_FORMAT) return undefined;
  try {
    return printWire(
      { tree: document.tree as unknown as Tree, components: document.components ?? {}, name: document.name },
      { includeIds: true },
    );
  } catch {
    return undefined;
  }
}

export function createVendoAdapter(overrides: VendoAdapterOverrides = {}): LaneAdapter {
  return {
    name: "vendo",
    async generate(prompt: string, host: HostFixture): Promise<LaneResult> {
      const startedAt = Date.now();
      const events: PipelineEvent[] = [];
      try {
        const engine = overrides.engine ?? modelEngine;
        const model = overrides.model ?? resolveAnthropicModel();
        const deps: GenerationDependencies = {
          model,
          catalog: host.catalog as NormalizedCatalog,
          tools: host.tools as HostToolInfo[],
          toolShapes: host.shapes as Readonly<Record<string, ShapeType>>,
          theme: host.theme as VendoTheme,
          // production PipelineConfig defaults — deliberately no `pipeline` key
          onPipeline: (event) => events.push(event),
        };
        const generated = await engine.create({ prompt }, deps);
        const document: AppDocument = { ...generated, id: `app_bench_${startedAt.toString(36)}` };
        const wire = renderWire(document);
        return {
          status: "ok",
          startedAt,
          durationMs: Date.now() - startedAt,
          document,
          ...(wire === undefined ? {} : { wire }),
          events,
        };
      } catch (error) {
        return {
          status: "failed",
          startedAt,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          events,
        };
      }
    },
  };
}

export const adapter: LaneAdapter = createVendoAdapter();
export default adapter;
