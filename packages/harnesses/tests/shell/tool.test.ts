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

  it("says the write did NOT land when the workspace answers conflict", async () => {
    const workspace = workspaceDouble();
    workspace.commit = async () => ({ status: "conflict", paths: ["/orgs/acme/files/ledger.csv"] });
    const registry = createShellTools(async () => workspace);

    const outcome = await registry.execute(
      { id: "c9", tool: VENDO_BASH_TOOL, args: { command: "echo 'jan,31000' > /tmp/out.csv" } },
      ctx(),
    );

    expect(outcome).toMatchObject({ status: "error", error: { code: "conflict" } });
    const { message } = (outcome as { error: { message: string } }).error;
    expect(message).toContain("/orgs/acme/files/ledger.csv");
    // A commit batches PER OWNER (store/src/workspace-fs.ts:592-595), so a lost
    // `/orgs` swap does NOT take the same command's `/user` writes down with it.
    // Saying nothing was saved would send the model to re-run a command that
    // already half-landed.
    expect(message).not.toContain("none of this command");
    expect(message).toContain("elsewhere");
  });
});

describe("a very talkative command", () => {
  it("comes back clipped, and says so, instead of tripping the bridge's cap", async () => {
    const workspace = workspaceDouble();
    const registry = createShellTools(async () => workspace);

    // `seq`, not `yes`: just-bash 3.4.2 ships no `yes`. ~48 900 chars — well over
    // the clip, well under the 1 MB default output ceiling.
    const outcome = await registry.execute(
      { id: "c4", tool: VENDO_BASH_TOOL, args: { command: "seq 1 10000" } },
      ctx(),
    );

    const { stdout } = (outcome as { output: { stdout: string } }).output;
    expect(stdout.length).toBeLessThanOrEqual(16_000);
    expect(stdout).toContain("[clipped]");
    expect(JSON.stringify((outcome as { output: unknown }).output).length).toBeLessThan(32_000);
  });

  it("keeps stdout AND stderr together under the bridge's cap, escaping and all", async () => {
    const workspace = workspaceDouble();
    const registry = createShellTools(async () => workspace);

    // Both streams full of the one character JSON doubles. Raw, each is 30 000
    // characters; in the JSON `capOutcome` weighs, each is 60 000, so a
    // raw-character budget hands the bridge far more than it caps at.
    const blanks = `awk 'BEGIN{for(i=0;i<30000;i++)print ""}'`;
    const outcome = await registry.execute(
      { id: "c10", tool: VENDO_BASH_TOOL, args: { command: `${blanks}; ${blanks} >&2` } },
      ctx(),
    );

    const { stdout, stderr } = (outcome as { output: { stdout: string; stderr: string } }).output;
    expect(stdout).toContain("[clipped]");
    expect(stderr).toContain("[clipped]");
    expect(JSON.stringify((outcome as { output: unknown }).output).length).toBeLessThanOrEqual(32_000);
  });
});

describe("the session's lifetime", () => {
  it("keeps /tmp across calls in ONE turn", async () => {
    const workspace = workspaceDouble();
    const registry = createShellTools(async () => workspace);
    const turn = ctx({ turnId: "trn_same" });

    await registry.execute({ id: "c5", tool: VENDO_BASH_TOOL, args: { command: "echo kept > /tmp/note" } }, turn);
    const second = await registry.execute(
      { id: "c6", tool: VENDO_BASH_TOOL, args: { command: "cat /tmp/note" } },
      turn,
    );

    expect((second as { output: { stdout: string } }).output.stdout).toBe("kept\n");
  });

  it("does NOT carry /tmp into another turn", async () => {
    const workspace = workspaceDouble();
    const registry = createShellTools(async () => workspace);

    const wrote = await registry.execute(
      { id: "c7", tool: VENDO_BASH_TOOL, args: { command: "echo leaked > /tmp/note" } },
      ctx({ turnId: "trn_one" }),
    );
    const other = await registry.execute(
      { id: "c8", tool: VENDO_BASH_TOOL, args: { command: "cat /tmp/note" } },
      ctx({ turnId: "trn_two" }),
    );

    // The write has to have LANDED, or the second turn's failure proves nothing
    // but that nobody ever wrote the file.
    expect((wrote as { output: { exitCode: number } }).output.exitCode).toBe(0);
    expect((other as { output: { exitCode: number } }).output.exitCode).not.toBe(0);
  });

  it("opens ONE workspace for a turn whose two calls arrive together", async () => {
    const workspace = workspaceDouble();
    let opened = 0;
    const registry = createShellTools(async () => {
      opened += 1;
      return workspace;
    });
    const turn = ctx({ turnId: "trn_parallel" });

    // What the AI SDK does with two tool calls in one step: both at once.
    const [, second] = await Promise.all([
      registry.execute({ id: "c11", tool: VENDO_BASH_TOOL, args: { command: "echo one > /tmp/shared" } }, turn),
      registry.execute({ id: "c12", tool: VENDO_BASH_TOOL, args: { command: "cat /tmp/shared" } }, turn),
    ]);

    expect(opened).toBe(1);
    expect((second as { output: { stdout: string } }).output.stdout).toBe("one\n");
  });

  it("does not poison the turn when opening the workspace fails once", async () => {
    const workspace = workspaceDouble();
    let attempt = 0;
    const registry = createShellTools(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("store unreachable");
      return workspace;
    });
    const turn = ctx({ turnId: "trn_flaky" });

    await expect(registry.execute(
      { id: "c13", tool: VENDO_BASH_TOOL, args: { command: "echo hi" } },
      turn,
    )).rejects.toThrow("store unreachable");
    // Caching the PROMISE is what fixes the open race; caching a REJECTED one
    // would wedge the rest of the turn on a blip the store already recovered from.
    const second = await registry.execute(
      { id: "c14", tool: VENDO_BASH_TOOL, args: { command: "echo recovered" } },
      turn,
    );

    expect((second as { output: { stdout: string } }).output.stdout).toBe("recovered\n");
  });
});

describe("the JavaScript hand, through the tool", () => {
  it("is on under Node, and the description says so", async () => {
    const workspace = workspaceDouble();
    const registry = createShellTools(async () => workspace);

    const [descriptor] = await registry.descriptors();
    expect(descriptor?.description).toContain("js-exec");

    const outcome = await registry.execute(
      { id: "c9", tool: VENDO_BASH_TOOL, args: { command: `js-exec -c 'console.log(6 * 7)'` } },
      ctx({ turnId: "trn_js" }),
    );
    expect((outcome as { output: { stdout: string } }).output.stdout).toContain("42");
  });
});

describe("the parsers, announced", () => {
  it("names all three in the description, so the model never guesses at a PDF", async () => {
    const [descriptor] = await createShellTools(async () => workspaceDouble()).descriptors();

    expect(descriptor?.description).toContain("pdftotext");
    expect(descriptor?.description).toContain("xlsx2csv");
    expect(descriptor?.description).toContain("docx2txt");
  });
});

describe("what the shell says about apps", () => {
  it("tells the model to copy a file into the app it is building from it", async () => {
    const [descriptor] = await createShellTools(async () => workspaceDouble()).descriptors();

    expect(descriptor?.description).toContain("/user/apps/");
    expect(descriptor?.description).toContain("cp");
  });
});
