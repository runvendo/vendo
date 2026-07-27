import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResearchReport } from "./research.js";
import {
  assertDisjointOwnership,
  buildAgentJobs,
  buildClaudeArgs,
  cssColorToHex,
  deriveThemeTokens,
  fencedFiles,
  hasCreatorTodos,
  parseAgentOutput,
  parseRewritePlan,
  pickLogoAsset,
  renderBrandBrief,
  runRewrite,
  verifyFencedFiles,
  type AgentRunResult,
  type RewritePlan,
  type ThemeTokens,
} from "./rewrite.js";

const baseTheme: ThemeTokens = {
  colors: {
    background: "#FBFBFA",
    surface: "#FFFFFF",
    text: "#111111",
    muted: "#908C85",
    accent: "#111111",
    accentText: "#FFFFFF",
    danger: "#B42318",
    border: "#ECEBE8",
  },
  typography: { fontFamily: "system-ui, sans-serif", baseSize: "15px" },
  radius: { small: "6px", medium: "12px", large: "16px" },
  density: "comfortable",
  motion: "full",
};

function reportFixture(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    capturedAt: "2026-07-26T00:00:00.000Z",
    urls: ["https://linear.app"],
    operatorScreenshots: [],
    pages: [{
      url: "https://linear.app",
      title: "Linear",
      themeColor: "#5E6AD2",
      favicon: null,
      botChallenge: false,
      screenshots: { viewport: "page-1-viewport.png", fullPage: "page-1-full.png" },
      samples: [
        { target: "body", color: "rgb(20, 20, 20)", backgroundColor: "rgb(255, 255, 255)", fontFamily: "Inter, sans-serif", firstFontFamily: "Inter Variable", borderRadius: "0px" },
        { target: "button[0]", color: "rgb(255, 255, 255)", backgroundColor: "rgb(94, 106, 210)", fontFamily: "Inter", firstFontFamily: "Inter Variable", borderRadius: "8px" },
      ],
      colorRoles: [
        { role: "body-bg", color: "rgb(255, 255, 255)", target: "body" },
        { role: "body-text", color: "rgb(20, 20, 20)", target: "body" },
        { role: "primary-button-bg", color: "rgb(94, 106, 210)", target: "button[0]" },
        { role: "primary-button-text", color: "rgb(255, 255, 255)", target: "button[0]" },
      ],
      fontFaces: [],
      webfontLinks: [],
      assets: [
        { kind: "favicon", source: 'link[rel="icon"]', url: "https://linear.app/favicon.ico", file: "assets/favicon.ico" },
        { kind: "logo", source: "header svg", url: null, file: "assets/logo-1-header.svg" },
        { kind: "logo", source: "logo img", url: "https://linear.app/logo.png", file: "assets/logo-2-logo.png" },
      ],
    }],
    palette: { colors: [], fontFamilies: [] },
    fonts: { families: ["Inter Variable"], faceSrcs: [], webfontLinks: [] },
    ...overrides,
  };
}

describe("cssColorToHex", () => {
  it("converts rgb()/rgba() and normalizes hex", () => {
    expect(cssColorToHex("rgb(94, 106, 210)")).toBe("#5E6AD2");
    expect(cssColorToHex("rgba(94, 106, 210, 0.9)")).toBe("#5E6AD2");
    expect(cssColorToHex("#abc")).toBe("#AABBCC");
    expect(cssColorToHex("#5e6ad2")).toBe("#5E6AD2");
  });

  it("refuses transparent and exotic values", () => {
    expect(cssColorToHex("rgba(0, 0, 0, 0)")).toBeUndefined();
    expect(cssColorToHex("oklch(0.5 0.1 250)")).toBeUndefined();
    expect(cssColorToHex("var(--accent)")).toBeUndefined();
  });
});

describe("deriveThemeTokens", () => {
  it("copies exact sampled values into the token slots", () => {
    const { theme, notes } = deriveThemeTokens(reportFixture(), baseTheme);
    expect(theme.colors.background).toBe("#FFFFFF");
    expect(theme.colors.text).toBe("#141414");
    expect(theme.colors.accent).toBe("#5E6AD2");
    expect(theme.colors.accentText).toBe("#FFFFFF");
    expect(theme.typography.fontFamily).toBe('"Inter Variable", ui-sans-serif, system-ui, sans-serif');
    expect(theme.radius.medium).toBe("8px");
    expect(notes.some((note) => note.includes("accent: #5E6AD2"))).toBe(true);
  });

  it("keeps template defaults when evidence is missing, and says so", () => {
    const empty = reportFixture({ pages: [{ url: "https://x.example", error: "boom" }], fonts: { families: [], faceSrcs: [], webfontLinks: [] } });
    const { theme, notes } = deriveThemeTokens(empty, baseTheme);
    expect(theme).toEqual(baseTheme);
    expect(notes.every((note) => note.includes("kept template default"))).toBe(true);
  });

  it("falls back to the meta theme-color for accent when no primary button was sampled", () => {
    const report = reportFixture();
    const page = report.pages[0] as Exclude<ResearchReport["pages"][number], { error: string }>;
    page.colorRoles = page.colorRoles.filter((role) => !role.role.startsWith("primary-button"));
    expect(deriveThemeTokens(report, baseTheme).theme.colors.accent).toBe("#5E6AD2");
  });
});

describe("pickLogoAsset", () => {
  it("prefers the header SVG over other logos and favicons", () => {
    expect(pickLogoAsset(reportFixture())).toBe("assets/logo-1-header.svg");
  });

  it("returns undefined when only non-logo assets were saved", () => {
    const report = reportFixture();
    const page = report.pages[0] as Exclude<ResearchReport["pages"][number], { error: string }>;
    page.assets = [{ kind: "og-image", source: "meta", url: "https://x/og.png", file: "assets/og-image.png" }];
    expect(pickLogoAsset(report)).toBeUndefined();
  });
});

describe("renderBrandBrief", () => {
  it("lists operator screenshots first with the top-priority framing", () => {
    const report = reportFixture({
      operatorScreenshots: [{ file: "operator-1-board.png", provenance: "operator-provided", source: "/tmp/board.png" }],
    });
    const brief = renderBrandBrief({
      prospect: "Linear",
      url: "https://linear.app",
      derived: deriveThemeTokens(report, baseTheme),
      logoPath: "public/brand/logo-1-header.svg",
      report,
    });
    expect(brief).toContain("operator-1-board.png");
    expect(brief.indexOf("operator-1-board.png")).toBeLessThan(brief.indexOf("page-1-full.png"));
    expect(brief).toContain("public/brand/logo-1-header.svg");
  });
});

const validPlan: RewritePlan = {
  entity: {
    name: "Issue",
    stem: "issues",
    action: "closeIssue",
    fields: ["id: string — issue id", "title: string — issue title", "status: string — backlog/started/done"],
    sampleRecordNames: ["Fix onboarding drop-off", "Dark mode for boards"],
  },
  screens: [
    { slug: "board", route: "/", title: "Board", purpose: "clones the operator board screenshot" },
    { slug: "backlog", route: "/backlog", title: "Backlog", purpose: "list view of backlog issues" },
  ],
  nav: ["Inbox", "My Issues", "Projects"],
  copyTone: "terse, engineering-first",
};

describe("parseRewritePlan", () => {
  it("parses a fenced JSON plan", () => {
    expect(parseRewritePlan("```json\n" + JSON.stringify(validPlan) + "\n```")).toEqual(validPlan);
  });

  it("rejects a plan whose first screen is not the reference clone at /", () => {
    const broken = { ...validPlan, screens: [{ slug: "backlog", route: "/backlog", title: "Backlog", purpose: "x" }] };
    expect(() => parseRewritePlan(JSON.stringify(broken))).toThrow('screens[0].route must be "/"');
  });

  it("rejects non-JSON output with the head of the text", () => {
    expect(() => parseRewritePlan("I could not find the evidence")).toThrow("did not return JSON");
  });
});

describe("buildAgentJobs", () => {
  it("fans out domain + shell-home + one agent per extra screen + beats, with disjoint ownership", () => {
    const jobs = buildAgentJobs({ prospect: "Linear", plan: validPlan, model: "sonnet", shellModel: "opus" });
    expect(jobs.map((job) => job.name)).toEqual(["domain", "shell-home", "screen-backlog", "beats"]);
    expect(() => assertDisjointOwnership(jobs)).not.toThrow();
    const beats = jobs.find((job) => job.name === "beats");
    expect(beats?.ownedRoots).toEqual(["demo.config.json"]);
    expect(beats?.prompt).toContain("Fix onboarding drop-off");
    const shell = jobs.find((job) => job.name === "shell-home");
    expect(shell?.model).toBe("opus");
    expect(shell?.prompt).toContain("STRUCTURAL 1:1");
    for (const job of jobs) {
      expect(job.prompt).toContain("NEVER touch these fenced files");
    }
  });

  it("assertDisjointOwnership rejects overlapping roots", () => {
    const jobs = buildAgentJobs({ prospect: "Linear", plan: validPlan, model: "sonnet", shellModel: "opus" });
    const clash = { ...jobs[0] as (typeof jobs)[number], name: "clash", ownedRoots: ["src/server/types.ts"] };
    expect(() => assertDisjointOwnership([...jobs, clash])).toThrow("redesign the split");
  });
});

describe("buildClaudeArgs", () => {
  it("locks the headless run down: bypassPermissions but no Bash/Web, no settings", () => {
    const args = buildClaudeArgs({ prompt: "do it", maxBudgetUsd: 5, model: "sonnet" });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
    expect(args).toContain("Write");
    expect(args).toContain("Bash");
    expect(args.indexOf("Bash")).toBeGreaterThan(args.indexOf("--disallowedTools"));
    expect(args).toContain("--setting-sources");
    expect(args).toContain("--max-budget-usd");
  });

  it("drops Write/Edit for read-only runs", () => {
    const args = buildClaudeArgs({ prompt: "plan", maxBudgetUsd: 3, model: "sonnet" }, { readOnly: true });
    expect(args).not.toContain("Write");
    expect(args).not.toContain("Edit");
  });
});

describe("parseAgentOutput", () => {
  it("extracts result, cost and is_error from --output-format json", () => {
    expect(parseAgentOutput(JSON.stringify({ result: "done", total_cost_usd: 1.23 })))
      .toEqual({ output: "done", costUsd: 1.23, isError: false });
    expect(parseAgentOutput(JSON.stringify({ result: "budget exceeded", is_error: true })).isError).toBe(true);
  });

  it("falls back to raw stdout", () => {
    expect(parseAgentOutput("not json")).toEqual({ output: "not json", isError: false });
  });
});

describe("hasCreatorTodos", () => {
  it("detects leftover fences", () => {
    expect(hasCreatorTodos('{"prompt": "TODO(creator): x"}')).toBe(true);
    expect(hasCreatorTodos('{"prompt": "Build me a board"}')).toBe(false);
  });
});

describe("verifyFencedFiles", () => {
  it("restores a strayed fenced file and reports it", async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "vendo-demo-fence-"));
    const file = path.join(appDir, "src", "server", "caps.ts");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "original");
    const snapshot = new Map([["src/server/caps.ts", "original"]]);
    await writeFile(file, "tampered");
    expect(await verifyFencedFiles(appDir, snapshot)).toEqual(["src/server/caps.ts"]);
    expect(await readFile(file, "utf8")).toBe("original");
    expect(await verifyFencedFiles(appDir, snapshot)).toEqual([]);
  });
});

describe("runRewrite", () => {
  async function makeAppFixture(): Promise<{ repoRoot: string; appDir: string }> {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "vendo-demo-rewrite-"));
    const appDir = path.join(repoRoot, "apps", "demo-linear");
    await mkdir(path.join(appDir, "RESEARCH", "assets"), { recursive: true });
    await mkdir(path.join(appDir, ".vendo"), { recursive: true });
    await writeFile(path.join(appDir, "RESEARCH", "research.json"), JSON.stringify(reportFixture()));
    await writeFile(path.join(appDir, "RESEARCH", "assets", "logo-1-header.svg"), "<svg/>");
    await writeFile(path.join(appDir, ".vendo", "theme.json"), JSON.stringify(baseTheme));
    for (const fenced of fencedFiles) {
      await mkdir(path.dirname(path.join(appDir, fenced)), { recursive: true });
      await writeFile(path.join(appDir, fenced), `// fenced ${fenced}\n`);
    }
    await writeFile(path.join(appDir, "demo.config.json"), JSON.stringify({
      id: "linear",
      prospect: "Linear",
      ctaUrl: "https://cal.com/yousefhelal",
      beats: [
        { key: "generate-ui", prompt: "Build me a board of open issues — group by status", chip: "Board of open issues", expectsView: true },
        { key: "take-action", prompt: "Close the issue named 'Fix onboarding drop-off'", chip: "Close an issue", expectsApproval: true },
        { key: "save-app", prompt: "Save this board as a reusable app", chip: "Save as app" },
      ],
      caps: { maxTurns: 20, maxSpendUsd: 5 },
      expiresAt: "2026-08-16T00:00:00Z",
    }));
    return { repoRoot, appDir };
  }

  function agentStub(): { calls: string[]; runAgent: (job: { name: string; prompt: string }, options: { readOnly?: boolean }) => Promise<AgentRunResult> } {
    const calls: string[] = [];
    return {
      calls,
      runAgent: async (job) => {
        calls.push(job.name);
        if (job.name === "plan") {
          return { name: "plan", code: 0, output: JSON.stringify(validPlan), costUsd: 0.5, timedOut: false };
        }
        return { name: job.name, code: 0, output: "done", costUsd: 1, timedOut: false };
      },
    };
  }

  it("runs tokens → plan → parallel agents → assembly and sums cost", async () => {
    const { repoRoot, appDir } = await makeAppFixture();
    const { calls, runAgent } = agentStub();
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const result = await runRewrite(
      { prospect: "Linear", url: "https://linear.app", packageName: "demo-linear" },
      { repoRoot, appDir, exec, runAgent, write: () => {}, env: {} },
    );
    expect(calls).toEqual(["plan", "domain", "shell-home", "screen-backlog", "beats"]);
    expect(result.buildRounds).toBe(1);
    expect(result.fencedViolations).toEqual([]);
    expect(result.costUsd).toBeCloseTo(4.5);
    // Deterministic transform actually landed:
    const theme = JSON.parse(await readFile(path.join(appDir, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#5E6AD2");
    expect(existsSync(path.join(appDir, "public", "brand", "logo-1-header.svg"))).toBe(true);
    expect(existsSync(path.join(appDir, "RESEARCH", "BRAND.md"))).toBe(true);
    expect(existsSync(path.join(appDir, "RESEARCH", "PLAN.json"))).toBe(true);
    // Build ran through the repo-root turbo filter:
    expect(exec).toHaveBeenCalledWith(["pnpm", "exec", "turbo", "run", "build", "--filter=demo-linear"], { cwd: repoRoot });
  });

  it("fails the run when demo.config.json still carries TODO(creator)", async () => {
    const { repoRoot, appDir } = await makeAppFixture();
    const config = JSON.parse(await readFile(path.join(appDir, "demo.config.json"), "utf8"));
    config.beats[0].prompt = "TODO(creator): Show me a dashboard";
    await writeFile(path.join(appDir, "demo.config.json"), JSON.stringify(config));
    const { runAgent } = agentStub();
    await expect(runRewrite(
      { prospect: "Linear", url: "https://linear.app", packageName: "demo-linear" },
      { repoRoot, appDir, exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), runAgent, write: () => {}, env: {} },
    )).rejects.toThrow("TODO(creator)");
  });

  it("spawns a repair agent on build failure and rebuilds, capped", async () => {
    const { repoRoot, appDir } = await makeAppFixture();
    const { calls, runAgent } = agentStub();
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "Type error: Property 'status' missing" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const result = await runRewrite(
      { prospect: "Linear", url: "https://linear.app", packageName: "demo-linear" },
      { repoRoot, appDir, exec, runAgent, write: () => {}, env: {} },
    );
    expect(calls).toContain("repair-1");
    expect(result.buildRounds).toBe(2);
  });

  it("gives up after the repair cap and surfaces the build error", async () => {
    const { repoRoot, appDir } = await makeAppFixture();
    const { runAgent } = agentStub();
    const exec = vi.fn(async (command: string[]) =>
      command.includes("build")
        ? { code: 1, stdout: "", stderr: "Type error: still broken" }
        : { code: 0, stdout: "", stderr: "" });
    await expect(runRewrite(
      { prospect: "Linear", url: "https://linear.app", packageName: "demo-linear" },
      { repoRoot, appDir, exec, runAgent, write: () => {}, env: {} },
    )).rejects.toThrow(/still failing after 2 repair round/);
  });

  it("restores fenced files an agent tampered with and flags them", async () => {
    const { repoRoot, appDir } = await makeAppFixture();
    const { runAgent: baseRunAgent } = agentStub();
    const runAgent = async (job: { name: string; prompt: string }, options: { readOnly?: boolean }): Promise<AgentRunResult> => {
      if (job.name === "domain") {
        await writeFile(path.join(appDir, "src", "server", "caps.ts"), "// TAMPERED");
      }
      return baseRunAgent(job, options);
    };
    const result = await runRewrite(
      { prospect: "Linear", url: "https://linear.app", packageName: "demo-linear" },
      { repoRoot, appDir, exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), runAgent, write: () => {}, env: {} },
    );
    expect(result.fencedViolations).toEqual(["src/server/caps.ts"]);
    expect(await readFile(path.join(appDir, "src", "server", "caps.ts"), "utf8")).toBe("// fenced src/server/caps.ts\n");
  });
});
