import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCRIPTED_HUMAN_ANSWER, agentEnv, buildClaudeArgs, runInstallAgent } from "./agent.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

describe("buildClaudeArgs", () => {
  it("builds a headless stream-json invocation with budget, model, and a pinned session id", () => {
    const args = buildClaudeArgs({
      prompt: "Install Vendo in this repo.",
      model: "haiku",
      maxBudgetUsd: 2.5,
      session: { id: SESSION_ID, resume: false },
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("Install Vendo in this repo.");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("bypassPermissions");
    // Sessions persist now — the scripted-human continuation needs --resume.
    expect(args).not.toContain("--no-session-persistence");
    expect(args[args.indexOf("--session-id") + 1]).toBe(SESSION_ID);
    expect(args).not.toContain("--resume");
    // User-level CLAUDE.md/skills stay out of the measurement.
    const settingSources = args[args.indexOf("--setting-sources") + 1];
    expect(settingSources).toBe("project");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.5");
  });

  it("builds the scripted-human continuation as a --resume of the same session", () => {
    const args = buildClaudeArgs({
      prompt: SCRIPTED_HUMAN_ANSWER,
      model: "haiku",
      maxBudgetUsd: 2.1,
      session: { id: SESSION_ID, resume: true },
    });
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe(SCRIPTED_HUMAN_ANSWER);
    expect(args[args.indexOf("--resume") + 1]).toBe(SESSION_ID);
    expect(args).not.toContain("--session-id");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.1");
  });
});

/** Fake claude: logs every invocation's args to args.log, then plays the
 * scripted transcript for its mode (first turn vs --resume continuation). */
async function writeFakeClaude(dir: string, script: { firstResult: string; resumeResult: string }): Promise<string> {
  const fakeBin = path.join(dir, "fake-claude.sh");
  const argsLog = path.join(dir, "args.log");
  await writeFile(fakeBin, [
    "#!/bin/sh",
    `echo "$@" >> ${JSON.stringify(argsLog)}`,
    'case "$*" in',
    "  *--resume*)",
    `    echo '{"type":"system","subtype":"init","session_id":"${SESSION_ID}"}'`,
    `    echo '{"type":"result","subtype":"success","num_turns":5,"total_cost_usd":0.5,"result":${JSON.stringify(script.resumeResult)}}'`,
    "    ;;",
    "  *)",
    `    echo '{"type":"system","subtype":"init","session_id":"${SESSION_ID}"}'`,
    `    echo '{"type":"result","subtype":"success","num_turns":3,"total_cost_usd":0.4,"result":${JSON.stringify(script.firstResult)}}'`,
    "    ;;",
    "esac",
    "",
  ].join("\n"));
  await chmod(fakeBin, 0o755);
  return fakeBin;
}

const KEY_QUESTION_RESULT = "Before I run vendo init, the playbook requires me to ask: Cloud, or bring-your-own for the model key? Let me know which.";
const STAR_ASK_RESULT = "Done — vendo doctor --json is green. Want me to star runvendo/vendo on GitHub to support the project?";

async function readArgsLog(dir: string): Promise<string[]> {
  return (await readFile(path.join(dir, "args.log"), "utf8")).split("\n").filter((line) => line.length > 0);
}

describe("runInstallAgent scripted-human continuation", () => {
  it("answers the mandated key question exactly once via --resume and appends the second turn to the transcript", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-agent-resume-"));
    const fakeBin = await writeFakeClaude(dir, { firstResult: KEY_QUESTION_RESULT, resumeResult: STAR_ASK_RESULT });
    const transcriptPath = path.join(dir, "logs", "transcript.jsonl");

    const result = await runInstallAgent({
      prompt: "Install Vendo in this repo.",
      cwd: dir,
      transcriptPath,
      model: "haiku",
      maxBudgetUsd: 2.5,
      timeBudgetMs: 30_000,
      claudeBin: fakeBin,
      sessionId: SESSION_ID,
      env: { PATH: process.env["PATH"] ?? "" },
    });

    expect(result.scriptedReplies).toBe(1);
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.command).toContain("--resume");

    const invocations = await readArgsLog(dir);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain(`--session-id ${SESSION_ID}`);
    expect(invocations[0]).not.toContain("--no-session-persistence");
    expect(invocations[1]).toContain(`--resume ${SESSION_ID}`);
    expect(invocations[1]).toContain(SCRIPTED_HUMAN_ANSWER);
    // The continuation spends what is LEFT of the money budget (2.5 - 0.4).
    expect(invocations[1]).toContain("--max-budget-usd 2.1");

    // Both invocations land in one transcript: scoring reads across turns.
    const transcript = await readFile(transcriptPath, "utf8");
    expect(transcript).toContain(KEY_QUESTION_RESULT.slice(0, 40));
    expect(transcript).toContain(STAR_ASK_RESULT.slice(0, 40));
    expect(transcript.match(/"subtype":"init"/g)).toHaveLength(2);
  }, 15_000);

  it("caps at ONE scripted reply — a second ask ends the run as today", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-agent-cap-"));
    // The fake agent asks the key question again even after the reply.
    const fakeBin = await writeFakeClaude(dir, { firstResult: KEY_QUESTION_RESULT, resumeResult: KEY_QUESTION_RESULT });

    const result = await runInstallAgent({
      prompt: "p",
      cwd: dir,
      transcriptPath: path.join(dir, "logs", "transcript.jsonl"),
      model: "haiku",
      maxBudgetUsd: 2.5,
      timeBudgetMs: 30_000,
      claudeBin: fakeBin,
      sessionId: SESSION_ID,
      env: { PATH: process.env["PATH"] ?? "" },
    });

    expect(result.scriptedReplies).toBe(1);
    expect(await readArgsLog(dir)).toHaveLength(2);
  }, 15_000);

  it("does NOT answer the star ask — that transcript is complete", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-agent-star-"));
    const fakeBin = await writeFakeClaude(dir, { firstResult: STAR_ASK_RESULT, resumeResult: KEY_QUESTION_RESULT });

    const result = await runInstallAgent({
      prompt: "p",
      cwd: dir,
      transcriptPath: path.join(dir, "logs", "transcript.jsonl"),
      model: "haiku",
      maxBudgetUsd: 2.5,
      timeBudgetMs: 30_000,
      claudeBin: fakeBin,
      sessionId: SESSION_ID,
      env: { PATH: process.env["PATH"] ?? "" },
    });

    expect(result.scriptedReplies).toBe(0);
    expect(await readArgsLog(dir)).toHaveLength(1);
  }, 15_000);
});

describe("runInstallAgent", () => {
  it("enforces the time budget with a group kill, keeps the transcript pure JSONL, and never resumes a timed-out run", async () => {
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
    expect(result.scriptedReplies).toBe(0);
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
