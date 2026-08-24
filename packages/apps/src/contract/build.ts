/**
 * The build seam — `screen.ts`'s other half.
 *
 * The screen agent answers `escalate` when an ask is bigger than a screen; this
 * is the engine that ask goes to once, and only once, the person has said yes.
 * It runs a coding agent inside a disposable box — npm from the registry, tests
 * against reality, output frozen as content-addressed blobs — none of which
 * `@vendoai/apps` holds, so the two sides meet on this interface and
 * composition (`packages/vendo`) is the only place that fills the slot. The
 * shipped adapter rule, exactly as `ScreenAssembler` states it.
 *
 * A box is minutes and money. Nothing here is reached until
 * `AppsRuntime.build.propose` has raised the standing approval card and the
 * person has answered it.
 */
import {
  type AppId,
  type AppSourceFile,
  type RunContext,
} from "@vendoai/core";

/** One consented build, as the resume hook hands it over. */
export interface BuildRequest {
  appId: AppId;
  /** The person's ask, verbatim — replayed from the proposal, which may be
   *  older than the turn that asked. */
  prompt: string;
  /** The screen agent's own line for why a screen was not enough. */
  why: string;
  /** The stored source a RESEAL starts from. Absent, the box starts empty. */
  source?: Record<string, AppSourceFile>;
  /** Chat status lines, and nothing else: no streaming and no serving from the
   *  box (FINAL SPEC v1). */
  onStatus?: (label: string) => void;
}

/** One file the box produced, by the path the entry imports it under. Bytes,
 *  not text: a bundle carries fonts and images no string round-trip survives. */
export interface BuiltFile {
  path: string;
  bytes: Uint8Array;
}

export type BuildOutcome =
  | { kind: "built"; files: readonly BuiltFile[]; entry: string; say?: string }
  | { kind: "failed"; why: string; retryable?: boolean };

export interface AppBuilder {
  /** Can this deployment run a build at all — i.e. is a sandbox adapter
   *  composed? The ONE gate, and deliberately not a capability boolean. */
  available(): boolean;
  build(request: BuildRequest, ctx: RunContext): Promise<BuildOutcome>;
}
