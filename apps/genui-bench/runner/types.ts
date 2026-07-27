import type { AppDocument, VendoTheme } from "@vendoai/core";
import type { PipelineEvent } from "@vendoai/apps";
import type { RunModel } from "./models";

export type { RunModel };

export type LaneName = "vendo" | "thesys-c1" | "copilotkit" | "tambo";
export type HostName = "maple" | "cadence";

export interface RunRequest {
  prompt: string;
  host: HostName;
  lanes: LaneName[];
  /** Set when the prompt came from a pack (evidence labeling only). */
  packRef?: { pack: string; index: number };
  /**
   * Per-run model + sampling for the Vendo lane (the engine under study).
   * ABSENT = the engine's production default, so an untouched run measures
   * what ships. Competitor lanes keep their own model defaults. RunRecord
   * embeds RunRequest, so history stamps this automatically.
   */
  model?: RunModel;
}

export type LaneResult =
  | { status: "ok"; startedAt: number; durationMs: number; costUsd?: number;
      /** Vendo lane: the document to render live. */
      document?: AppDocument;
      /** Vendo lane: raw wire text as streamed. */
      wire?: string;
      /** Vendo lane: the tapped pipeline events (JSON-safe). */
      events?: PipelineEvent[];
      /** Competitor lanes: their raw response payload, renderable by their SDK. */
      raw?: unknown }
  | { status: "failed"; startedAt: number; durationMs: number; error: string;
      events?: PipelineEvent[]; wire?: string; raw?: unknown }
  | { status: "no-key" };

export interface RunRecord {
  id: string;                      // `${yyyymmdd-hhmmss}-${4 hex}`
  createdAt: string;               // ISO
  gitSha: string;
  gitDirty: string | null;         // sha256 of `git diff` when tree dirty, else null
  request: RunRequest;
  lanes: Partial<Record<LaneName, LaneResult>>;
  pin?: string;                    // label; absence = unpinned
}

/** Per-run knobs the runner hands every lane; lanes ignore what they don't use. */
export interface LaneRunOptions {
  /** The Vendo lane's per-run model choice (see RunRequest.model). */
  model?: RunModel;
}

export interface LaneAdapter {
  name: LaneName;
  /** Resolve to a LaneResult; NEVER throw — catch and return status:"failed". */
  generate(prompt: string, host: HostFixture, options?: LaneRunOptions): Promise<LaneResult>;
}

/** Executable host fixture — catalog/tools/shapes for generation, executors for interaction. */
export interface HostFixture {
  name: HostName;
  catalog: unknown;                // NormalizedCatalog (from @vendoai/core)
  tools: unknown[];                // HostToolInfo[] (from @vendoai/apps)
  shapes: unknown;                 // shape cards, bench demo-bank-surface pattern
  /** The host's real .vendo/theme.json, schema-parsed: the engine stamps it
   *  into generation and /embed/<host> hands it to VendoProvider. */
  theme: VendoTheme;
  /** Canned-data executor: same names as `tools`; throws VendoError for unknown tool. */
  execute(tool: string, input: Record<string, unknown>): Promise<unknown>;
}
