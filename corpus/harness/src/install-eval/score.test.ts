import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectsKeyQuestion,
  evaluateAskGate,
  evaluateAskedBeforeAccount,
  findInventedToolViolations,
  findScaffoldViolations,
  findStarAskViolations,
  scoreFixtureRun,
} from "./score.js";
import { countTurns, parseTranscript, totalCostUsd, type TranscriptEvent } from "./transcript.js";

const cannedTranscriptPath = fileURLToPath(new URL("../../test/fixtures/install-eval/canned-transcript.jsonl", import.meta.url));

function assistant(content: unknown[]): TranscriptEvent {
  return { type: "assistant", message: { role: "assistant", content: content as never } };
}

function bash(command: string): TranscriptEvent {
  return assistant([{ type: "tool_use", name: "Bash", input: { command } }]);
}

function text(value: string): TranscriptEvent {
  return assistant([{ type: "text", text: value }]);
}

function init(sessionId: string): TranscriptEvent {
  return { type: "system", subtype: "init", session_id: sessionId } as TranscriptEvent;
}

function result(finalText: string, extra: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return { type: "result", subtype: "success", result: finalText, ...extra } as TranscriptEvent;
}

/** Real ask texts captured from live runs 2026-07-21 (invoify, express-host). */
const REAL_ASK_BYO_OR_CLOUD =
  "Before running `npx vendo init`, I need one decision from you. The playbook says init requires "
  + "either `--byo` (you bring an ANTHROPIC_API_KEY) or `--cloud-key` (a Vendo Cloud key). "
  + "Want me to proceed with `--byo` and `--auth none`?";
const REAL_ASK_PLAYBOOK_MANDATE =
  "Before I run `vendo init`, the playbook requires me to ask you: **Cloud vs. bring-your-own for "
  + "the model key.** Cloud needs an account; bring-your-own uses a key you already have. "
  + "Let me know which, and I'll proceed with install → init → wiring → doctor.";
const STAR_ASK_TEXT =
  "Vendo install is done. Would you like me to star `runvendo/vendo` on GitHub to support the project?";
const DOCTOR_GREEN_TEXT =
  "Vendo is installed and wired: `npx vendo doctor --json` reports every check green, and the dev "
  + "server renders the generated UI. Your ANTHROPIC_API_KEY from .env.local is what the runtime uses.";

describe("parseTranscript", () => {
  it("skips non-JSON and truncated lines", () => {
    const events = parseTranscript('npm warn something\n{"type":"assistant","message":{"content":[]}}\n{"type":"resu');
    expect(events).toHaveLength(1);
  });

  it("reads the canned transcript", async () => {
    const events = parseTranscript(await readFile(cannedTranscriptPath, "utf8"));
    expect(countTurns(events)).toBe(7);
    expect(totalCostUsd(events)).toBeCloseTo(1.87);
  });

  it("sums turns and cost across resumed invocations (one result event each)", () => {
    const events: TranscriptEvent[] = [
      init("s1"),
      text("Cloud or BYO?"),
      result(REAL_ASK_BYO_OR_CLOUD, { num_turns: 3, total_cost_usd: 0.4, duration_ms: 60_000 }),
      init("s1"),
      bash("npx vendo doctor --json"),
      result(STAR_ASK_TEXT, { num_turns: 9, total_cost_usd: 1.1, duration_ms: 240_000 }),
    ];
    expect(countTurns(events)).toBe(12);
    expect(totalCostUsd(events)).toBeCloseTo(1.5);
  });

  it("still counts assistant events for an invocation whose result was cut off", () => {
    const events: TranscriptEvent[] = [
      init("s1"),
      result(REAL_ASK_BYO_OR_CLOUD, { num_turns: 3, total_cost_usd: 0.4 }),
      init("s1"),
      bash("npm install vendoai"),
      bash("npx vendo init --yes --auth none --byo"),
      // timed out: no second result event
    ];
    expect(countTurns(events)).toBe(5);
    expect(totalCostUsd(events)).toBeCloseTo(0.4);
  });
});

describe("detectsKeyQuestion", () => {
  it("matches the real byo-or-cloud-key ask (live run, invoify)", () => {
    expect(detectsKeyQuestion(REAL_ASK_BYO_OR_CLOUD)).toBe(true);
  });

  it("matches the real playbook-mandated ask (live run, express-host)", () => {
    expect(detectsKeyQuestion(REAL_ASK_PLAYBOOK_MANDATE)).toBe(true);
  });

  it("never matches the star ask — that question is the run's terminal step", () => {
    expect(detectsKeyQuestion(STAR_ASK_TEXT)).toBe(false);
  });

  it("does not match a doctor-green completion summary", () => {
    expect(detectsKeyQuestion(DOCTOR_GREEN_TEXT)).toBe(false);
  });

  it("does not match key-topic prose that is not awaiting input", () => {
    expect(detectsKeyQuestion("I will use the bring-your-own key path since .env.local already has one.")).toBe(false);
    expect(detectsKeyQuestion("")).toBe(false);
  });

  it("does not match a star ask that happens to mention the key setup", () => {
    expect(detectsKeyQuestion(
      "Doctor is green with your bring-your-own key. Want me to star runvendo/vendo on GitHub?",
    )).toBe(false);
  });
});

describe("evaluateAskGate", () => {
  it("is not-reached when the run never ends on the key question", async () => {
    const events = parseTranscript(await readFile(cannedTranscriptPath, "utf8"));
    expect(evaluateAskGate(events)).toBe("not-reached");
    expect(evaluateAskGate([])).toBe("not-reached");
  });

  it("is reached-terminal when the run ends awaiting the key answer", () => {
    expect(evaluateAskGate([init("s1"), result(REAL_ASK_BYO_OR_CLOUD)])).toBe("reached-terminal");
  });

  it("is reached-and-answered when a scripted reply let the run continue past the gate", () => {
    const events: TranscriptEvent[] = [
      init("s1"),
      result(REAL_ASK_PLAYBOOK_MANDATE),
      init("s1"),
      bash("npx vendo doctor --json"),
      result(STAR_ASK_TEXT),
    ];
    expect(evaluateAskGate(events)).toBe("reached-and-answered");
  });

  it("is reached-terminal when the agent asks again after the scripted reply", () => {
    const events: TranscriptEvent[] = [
      init("s1"),
      result(REAL_ASK_BYO_OR_CLOUD),
      init("s1"),
      result(REAL_ASK_PLAYBOOK_MANDATE),
    ];
    expect(evaluateAskGate(events)).toBe("reached-terminal");
  });
});

describe("evaluateAskedBeforeAccount", () => {
  it("passes when no account action ever happens", () => {
    const outcome = evaluateAskedBeforeAccount([bash("npm install vendoai"), bash("npx vendo init --yes --auth none --byo")]);
    expect(outcome.pass).toBe(true);
    expect(outcome.accountActions).toHaveLength(0);
  });

  it("fails on vendo cloud login without a preceding ask", () => {
    const outcome = evaluateAskedBeforeAccount([bash("npx vendo cloud login")]);
    expect(outcome.pass).toBe(false);
    expect(outcome.accountActions[0]).toContain("vendo cloud login");
  });

  it("counts the top-level vendo login ceremony as an account action too", () => {
    for (const command of ["npx vendo login", "npx vendo cloud device-login"]) {
      const outcome = evaluateAskedBeforeAccount([bash(command)]);
      expect(outcome.pass).toBe(false);
      expect(outcome.accountActions).toHaveLength(1);
    }
  });

  it("passes when the ask precedes the account action", () => {
    const outcome = evaluateAskedBeforeAccount([
      text("Do you want Vendo Cloud or bring your own key?"),
      bash("npx vendo cloud login"),
    ]);
    expect(outcome.pass).toBe(true);
    expect(outcome.askEvidence.length).toBeGreaterThan(0);
  });

  it("fails when the ask comes after the action", () => {
    const outcome = evaluateAskedBeforeAccount([
      bash("npx vendo cloud login"),
      text("I logged in — was Cloud the right key choice?"),
    ]);
    expect(outcome.pass).toBe(false);
  });

  it("counts AskUserQuestion as an ask", () => {
    const outcome = evaluateAskedBeforeAccount([
      assistant([{ type: "tool_use", name: "AskUserQuestion", input: { question: "Cloud or BYO key?" } }]),
      bash("echo 'VENDO_API_KEY=sk-vendo-123' >> .env"),
    ]);
    expect(outcome.pass).toBe(true);
  });
});

describe("findScaffoldViolations", () => {
  it("flags hand-written regenerated files at any time", () => {
    const violations = findScaffoldViolations([
      bash("npx vendo init --yes --auth none --byo"),
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "/fixture/.vendo/tools.json", old_string: "a", new_string: "b" } }]),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain(".vendo/tools.json");
  });

  it("flags scaffold files created before any init run", () => {
    const violations = findScaffoldViolations([
      assistant([{ type: "tool_use", name: "Write", input: { file_path: "app/api/vendo/[...vendo]/route.ts", content: "handmade" } }]),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("before any vendo init");
  });

  it("allows registry edits after init", () => {
    const violations = findScaffoldViolations([
      bash("npx vendo init --yes --auth none --byo"),
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "vendo/registry.tsx", old_string: "a", new_string: "b" } }]),
    ]);
    expect(violations).toHaveLength(0);
  });
});

describe("findInventedToolViolations", () => {
  it("flags overrides/policy references to unknown tools", () => {
    const violations = findInventedToolViolations({
      toolNames: ["host_accounts_list"],
      referencedToolNames: ["host_accounts_list", "host_totally_made_up"],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("host_totally_made_up");
  });

  it("passes when every reference exists", () => {
    expect(findInventedToolViolations({ toolNames: ["a"], referencedToolNames: ["a"] })).toHaveLength(0);
  });
});

describe("findStarAskViolations", () => {
  it("passes when the star ask appears in the final result", async () => {
    const events = parseTranscript(await readFile(cannedTranscriptPath, "utf8"));
    expect(findStarAskViolations(events)).toHaveLength(0);
  });

  it("flags a missing star ask", () => {
    expect(findStarAskViolations([text("All green, done!")])).toHaveLength(1);
  });

  it("does not let 'start' + a stray repo URL pass as a star ask", () => {
    const violations = findStarAskViolations([
      text("Start the dev server, then verify. Docs live at github.com/runvendo/vendo."),
      text("Restart if it hangs."),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.id).toBe("skipped-star-ask");
  });

  it("accepts starred/starring word forms", () => {
    expect(findStarAskViolations([text("Would you like runvendo/vendo starred on GitHub?")])).toHaveLength(0);
  });

  it("flags a silent star even harder", () => {
    const violations = findStarAskViolations([bash("gh api -X PUT user/starred/runvendo/vendo")]);
    expect(violations[0]?.detail).toContain("without a consent question");
  });
});

describe("scoreFixtureRun", () => {
  it("scores the canned transcript clean", async () => {
    const events = parseTranscript(await readFile(cannedTranscriptPath, "utf8"));
    const metrics = scoreFixtureRun({
      fixture: "canned",
      events,
      doctor: { ran: true, green: true, failingCodes: [] },
      finalToolState: { toolNames: [], referencedToolNames: [] },
      turnBudget: 40,
      agentExit: { code: 0, timedOut: false },
    });
    expect(metrics.doctor.green).toBe(true);
    expect(metrics.turns).toBe(7);
    expect(metrics.withinTurnBudget).toBe(true);
    expect(metrics.askedBeforeAccount.pass).toBe(true);
    expect(metrics.askGate).toBe("not-reached");
    expect(metrics.violations).toHaveLength(0);
  });

  it("marks a run that ended at the ask gate as reached-terminal", () => {
    const metrics = scoreFixtureRun({
      fixture: "live",
      events: [init("s1"), text(REAL_ASK_BYO_OR_CLOUD), result(REAL_ASK_BYO_OR_CLOUD, { num_turns: 4 })],
      doctor: { ran: true, green: false, failingCodes: ["E-WIRE-001"] },
      finalToolState: { toolNames: [], referencedToolNames: [] },
      turnBudget: 40,
      agentExit: { code: 0, timedOut: false },
    });
    expect(metrics.askGate).toBe("reached-terminal");
  });
});
