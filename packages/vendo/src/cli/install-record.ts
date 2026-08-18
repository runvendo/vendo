import { join } from "node:path";
import { readOptional, writeText } from "./shared.js";

/** How the host's people will reach the agent — `vendo init`'s FIRST question.
    It decides what gets scaffolded and how the run ends; the wired route is the
    same in all three, so picking wrong costs nothing. */
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

export async function writeUseCase(root: string, useCase: InitUseCase): Promise<void> {
  await writeText(
    join(root, ".vendo", INSTALL_FILE),
    `${JSON.stringify({ format: "vendo/install@1", useCase }, null, 2)}\n`,
  );
}
