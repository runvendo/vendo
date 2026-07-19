import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentEnv, buildClaudeArgs, runInstallAgent } from "./agent.js";

describe("buildClaudeArgs", () => {
  it("builds a headless stream-json invocation with budget and model", () => {
    const args = buildClaudeArgs({ prompt: "Install Vendo in this repo.", model: "haiku", maxBudgetUsd: 2.5 });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("Install Vendo in this repo.");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("bypassPermissions");
    expect(args).toContain("--no-session-persistence");
    // User-level CLAUDE.md/skills stay out of the measurement.
    const settingSources = args[args.indexOf("--setting-sources") + 1];
    expect(settingSources).toBe("project");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.5");
  });
});

describe("runInstallAgent", () => {
  it("enforces the time budget with a group kill and keeps the transcript pure JSONL", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-agent-"));
    // Fake agent: one JSON line on stdout, noise on stderr, then hang — the
    // wall-clock kill has to end it (and its process group).
    const fakeBin = path.join(dir, "fake-claude.sh");
    await writeFile(fakeBin, "#!/bin/sh\necho '{\"type\":\"assistant\"}'\necho 'stderr noise' 1>&2\nsleep 60\n");
    await chmod(fakeBin, 0o755);
    const transcriptPath = path.join(dir, "logs", "transcript.jsonl");

    const result = await runInstallAgent({
      prompt: "p",
      cwd: dir,
      transcriptPath,
      model: "haiku",
      maxBudgetUsd: 1,
      timeBudgetMs: 750,
      claudeBin: fakeBin,
      env: { PATH: process.env["PATH"] ?? "" },
    });

    expect(result.timedOut).toBe(true);
    const transcript = await readFile(transcriptPath, "utf8");
    expect(transcript).toContain('{"type":"assistant"}');
    expect(transcript).not.toContain("stderr noise");
    expect(await readFile(`${transcriptPath}.stderr.log`, "utf8")).toContain("stderr noise");
  }, 15_000);
});

describe("agentEnv", () => {
  it("drops VENDO_API_KEY so a machine key cannot skip the account ask", () => {
    const env = agentEnv({ PATH: "/bin", VENDO_API_KEY: "sk-vendo-x", ANTHROPIC_API_KEY: "sk-ant-y" });
    expect(env["VENDO_API_KEY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-y");
  });
});
