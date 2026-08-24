/**
 * The shell on the ONE registry — guarded, audited and projected exactly like a
 * host tool, with no privileged side door. The descriptor IS the guard story:
 * `guard.bind` keys off `risk`.
 */
import { InMemoryFs } from "just-bash";
import { VENDO_BASH_TOOL, type Principal, type RunContext, type WorkspaceFs } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createShellTools } from "../../src/vendo/shell/tool.js";

const principal: Principal = { kind: "user", subject: "user_shell" };

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "s_shell",
  ...overrides,
});

/** A workspace double that is a REAL just-bash filesystem plus the one method
    the façade adds — so nothing about the bash half is faked. */
const workspaceDouble = (): WorkspaceFs & { commits: number } => {
  const fs = new InMemoryFs() as unknown as WorkspaceFs & { commits: number };
  fs.commits = 0;
  fs.commit = async () => {
    fs.commits += 1;
    return { status: "ok", changed: [] };
  };
  return fs;
};

describe("the shell tool's descriptor", () => {
  it("is one tool called bash, graded write", async () => {
    const registry = createShellTools(async () => workspaceDouble());

    const [descriptor, ...rest] = await registry.descriptors();

    expect(rest).toEqual([]);
    expect(descriptor?.name).toBe(VENDO_BASH_TOOL);
    expect(descriptor?.title).toBe("Work on your files");
    expect(descriptor?.risk).toBe("write");
    expect(descriptor?.inputSchema).toMatchObject({
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    });
  });

  it("refuses a call that is not this tool, and a call with no command", async () => {
    const registry = createShellTools(async () => workspaceDouble());

    expect(await registry.execute({ id: "c0", tool: "nope", args: {} }, ctx()))
      .toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(await registry.execute({ id: "c1", tool: VENDO_BASH_TOOL, args: {} }, ctx()))
      .toMatchObject({ status: "error", error: { code: "validation" } });
  });
});
