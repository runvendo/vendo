import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
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
    expect(metrics.violations).toHaveLength(0);
  });
});
