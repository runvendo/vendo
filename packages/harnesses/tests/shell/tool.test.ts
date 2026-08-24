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

describe("the shell tool's hands", () => {
  it("reads a file the workspace holds and answers with the shell's three outputs", async () => {
    const workspace = workspaceDouble();
    await workspace.mkdir("/user/files", { recursive: true });
    await workspace.writeFile("/user/files/ledger.csv", "month,revenue\njan,31000\n");
    const registry = createShellTools(async () => workspace);

    const outcome = await registry.execute(
      { id: "c2", tool: VENDO_BASH_TOOL, args: { command: "cut -d, -f2 files/ledger.csv | tail -1" } },
      ctx(),
    );

    expect(outcome).toMatchObject({ status: "ok", output: { exitCode: 0, stderr: "" } });
    expect((outcome as { output: { stdout: string } }).output.stdout.trim()).toBe("31000");
  });

  it("commits what the call wrote, so the next turn sees it", async () => {
    const workspace = workspaceDouble();
    await workspace.mkdir("/user/files", { recursive: true });
    const registry = createShellTools(async () => workspace);

    await registry.execute(
      { id: "c3", tool: VENDO_BASH_TOOL, args: { command: "echo 'jan,31000' > files/out.csv" } },
      ctx(),
    );

    expect(await workspace.readFile("/user/files/out.csv")).toBe("jan,31000\n");
    expect(workspace.commits).toBe(1);
  });
});
