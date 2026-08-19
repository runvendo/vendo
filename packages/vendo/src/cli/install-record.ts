import { join } from "node:path";
import { readOptional, writeText } from "./shared.js";

/** How the host's people will reach the agent — `vendo init`'s FIRST question.
    It decides what gets scaffolded and where the run says to continue; the
    wired route is the same in all three, so picking wrong costs nothing. */
export type InitUseCase = "embedded" | "agent-loop" | "mcp";

export const INIT_USE_CASES: readonly InitUseCase[] = ["embedded", "agent-loop", "mcp"];

/**
 * The install's own record: the answers `vendo init` resolved, for the commands
 * that run later. `.vendo/` is where a project's Vendo config lives and this is
 * a project fact, but it is not a CONTENT surface (config-surface.ts) and it
 * belongs to no other file's schema — so it gets its own small CLI-owned file
 * rather than a field smuggled into someone else's.
 *
 * Absent on every install that predates it, and `readUseCase` says so with
 * `undefined` rather than a default: a reader that guessed "embedded" would
 * turn an old MCP install's silence into a wrong answer.
 */
const INSTALL_FILE = "install.json";

export async function readUseCase(root: string): Promise<InitUseCase | undefined> {
  const raw = await readOptional(join(root, ".vendo", INSTALL_FILE));
  if (raw === null) return undefined;
  try {
    const value = (JSON.parse(raw) as { useCase?: unknown }).useCase;
    return (INIT_USE_CASES as readonly unknown[]).includes(value) ? value as InitUseCase : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The env var this install's model wiring actually reads: `VENDO_API_KEY` when
 * the models answer was Vendo Cloud (the runtime ladder resolves it and the
 * composition names no provider), else the provider key its `models` line
 * names. Recording the KEY rather than the answer is what lets `vendo doctor`
 * grade the one variable that changes anything — it used to name three provider
 * keys the resolver never reads. Absent when no key resolved at all.
 */
export async function readModelKey(root: string): Promise<string | undefined> {
  const raw = await readOptional(join(root, ".vendo", INSTALL_FILE));
  if (raw === null) return undefined;
  try {
    const value = (JSON.parse(raw) as { modelKey?: unknown }).modelKey;
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeInstallRecord(
  root: string,
  record: { useCase: InitUseCase; modelKey: string | null },
): Promise<void> {
  await writeText(
    join(root, ".vendo", INSTALL_FILE),
    `${JSON.stringify({
      format: "vendo/install@1",
      useCase: record.useCase,
      ...(record.modelKey === null ? {} : { modelKey: record.modelKey }),
    }, null, 2)}\n`,
  );
}
