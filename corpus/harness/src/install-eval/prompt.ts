import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The agent-install eval runs a real coding agent with ONLY the north-star
 * copy-paste prompt users are told to paste. The docs install page folded
 * into the agents playbook (2026-07-21), so the prompt's fenced home is now
 * the repo README; it is read at runtime so the eval can never drift from
 * what we actually tell users to paste (spec 2026-07-19 §Testing).
 */

export const INSTALL_MDX_RELATIVE_PATH = "README.md";

/** Extract the copy-paste prompt: the first ```text fence in the README.
 * Throws when the fence is missing — a silently-empty prompt would make the
 * whole eval measure nothing. */
export function extractNorthStarPrompt(installMdxSource: string): string {
  const match = installMdxSource.match(/```text\r?\n([\s\S]*?)```/);
  const prompt = match?.[1]?.trim();
  if (!prompt) {
    throw new Error(
      "README.md no longer contains a ```text prompt fence; "
        + "the install eval reads the north-star prompt from there and cannot run without it.",
    );
  }
  return prompt;
}

export async function readNorthStarPrompt(workspaceRoot: string): Promise<string> {
  const file = path.join(workspaceRoot, INSTALL_MDX_RELATIVE_PATH);
  return extractNorthStarPrompt(await readFile(file, "utf8"));
}
