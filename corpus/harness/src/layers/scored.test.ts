import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runScoredLayer } from "./scored.js";
import type { RepoExpectations } from "../expectations.js";

const tempRoots: string[] = [];

const expectedTheme = {
  background: "#ffffff",
  surface: "#f5f7fa",
  accent: "#0a7cff",
  text: "#111418",
  mutedText: "#5b6470",
  radius: 8,
  fontFamily: "Inter, sans-serif",
};

const baseExpectations: RepoExpectations = {
  version: 1,
  theme: expectedTheme,
  tools: [
    { name: "listInvoices", method: "GET", path: "/api/invoices", readOrWrite: "read" },
    { name: "createInvoice", method: "POST", path: "/api/invoices", readOrWrite: "write" },
  ],
  annotations: [
    { name: "listInvoices", mutating: false, dangerous: false },
    { name: "createInvoice", mutating: true, dangerous: false },
  ],
  components: [],
};

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeFixture(): Promise<{ repoDir: string; expectationsRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-scored-"));
  tempRoots.push(root);
  return {
    repoDir: path.join(root, ".repos/repo-one"),
    expectationsRoot: path.join(root, "expectations"),
  };
}

async function writeExpected(expectationsRoot: string, repoName: string, value: RepoExpectations, baseline?: number): Promise<void> {
  const dir = path.join(expectationsRoot, repoName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "expected.json"), JSON.stringify(value, null, 2) + "\n");
  if (baseline !== undefined) {
    await writeFile(
      path.join(dir, "baseline.json"),
      JSON.stringify({ version: 1, score: { passed: baseline * 10, total: 10, value: baseline } }, null, 2) + "\n",
    );
  }
}

async function writeInitOutput(
  repoDir: string,
  options: {
    theme?: Record<string, unknown>;
    createMutating?: boolean;
    extraTool?: boolean;
  } = {},
): Promise<void> {
  await mkdir(path.join(repoDir, ".vendo"), { recursive: true });
  await writeFile(
    path.join(repoDir, ".vendo/theme.json"),
    JSON.stringify(
      {
        colors: {
          background: options.theme?.["background"] ?? expectedTheme.background,
          surface: options.theme?.["surface"] ?? expectedTheme.surface,
          text: options.theme?.["text"] ?? expectedTheme.text,
          muted: options.theme?.["mutedText"] ?? expectedTheme.mutedText,
          accent: options.theme?.["accent"] ?? expectedTheme.accent,
          accentText: "#ffffff",
          danger: "#dc2626",
          border: "#e5e7eb",
        },
        typography: { fontFamily: expectedTheme.fontFamily, baseSize: "16px" },
        radius: { small: "4px", medium: `${expectedTheme.radius}px`, large: "12px" },
        density: "comfortable",
        motion: "full",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(repoDir, ".vendo/tools.json"),
    JSON.stringify(
      {
        format: "vendo/tools@1",
        tools: [
          {
            name: "host_listInvoices",
            description: "List invoices.",
            inputSchema: { type: "object", properties: {} },
            risk: "read",
            binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
          },
          {
            name: "host_createInvoice",
            description: "Create invoice.",
            inputSchema: { type: "object", properties: {} },
            risk: options.createMutating === false ? "read" : "write",
            binding: { kind: "route", method: "POST", path: "/api/invoices", argsIn: "body" },
          },
          ...(options.extraTool
            ? [{
                name: "host_listCustomers",
                description: "List customers.",
                inputSchema: { type: "object", properties: {} },
                risk: "read",
                binding: { kind: "route" as const, method: "GET" as const, path: "/api/customers", argsIn: "query" as const },
              }]
            : []),
        ],
      },
      null,
      2,
    ) + "\n",
  );
}

function checkById(layer: Awaited<ReturnType<typeof runScoredLayer>>["layer"]) {
  return Object.fromEntries((layer.checks ?? []).map((check) => [check.id, check]));
}

describe("runScoredLayer", () => {
  it("scores theme dimensions individually and tools as inventory precision/recall", async () => {
    const { repoDir, expectationsRoot } = await makeFixture();
    await writeExpected(expectationsRoot, "repo-one", baseExpectations);
    await writeInitOutput(repoDir, { theme: { background: "#000000" }, extraTool: true });

    const result = await runScoredLayer({
      repoName: "repo-one",
      repoDir,
      expectationsRoot,
      now: () => new Date("2026-07-06T12:00:00.000Z"),
    });
    const checks = checkById(result.layer);

    expect(result.layer.status).toBe("pass");
    expect(result.layer.hardFailure).toBe(false);
    expect(checks["theme.background"]).toMatchObject({ pass: false });
    expect(checks["theme.surface"]).toMatchObject({ pass: true });
    expect(checks["tools.precision"]?.detail).toContain("0.667");
    expect(checks["tools.recall"]?.detail).toContain("1.000");
    expect(result.layer.score).toMatchObject({ total: 10 });
    expect(result.layer.score?.passed).toBeCloseTo(8.666667, 6);
  });

  it("hard-fails when any generated write tool is auto-allowed", async () => {
    const { repoDir, expectationsRoot } = await makeFixture();
    await writeExpected(expectationsRoot, "repo-one", baseExpectations, 0.1);
    await writeInitOutput(repoDir, { createMutating: false });

    const result = await runScoredLayer({
      repoName: "repo-one",
      repoDir,
      expectationsRoot,
      now: () => new Date("2026-07-06T12:00:00.000Z"),
    });
    const checks = checkById(result.layer);

    expect(result.layer.status).toBe("fail");
    expect(result.layer.hardFailure).toBe(true);
    expect(result.baselineUpdate).toBeUndefined();
    expect(checks["annotations.write-safety"]).toMatchObject({ pass: false });
    expect(checks["annotations.write-safety"]?.detail).toContain("createInvoice");
  });

  it("flags baseline regressions and prints an updated baseline when the score improves", async () => {
    const regress = await makeFixture();
    await writeExpected(regress.expectationsRoot, "repo-one", baseExpectations, 0.95);
    await writeInitOutput(regress.repoDir, { theme: { background: "#000000" }, extraTool: true });

    const regression = await runScoredLayer({
      repoName: "repo-one",
      repoDir: regress.repoDir,
      expectationsRoot: regress.expectationsRoot,
      now: () => new Date("2026-07-06T12:00:00.000Z"),
    });

    expect(regression.layer.status).toBe("fail");
    expect(regression.layer.hardFailure).toBe(true);
    expect(checkById(regression.layer)["baseline.regression"]?.detail).toContain("below baseline");

    const improve = await makeFixture();
    await writeExpected(improve.expectationsRoot, "repo-one", baseExpectations, 0.5);
    await writeInitOutput(improve.repoDir);

    const improvement = await runScoredLayer({
      repoName: "repo-one",
      repoDir: improve.repoDir,
      expectationsRoot: improve.expectationsRoot,
      now: () => new Date("2026-07-06T12:00:00.000Z"),
    });

    expect(improvement.layer.status).toBe("pass");
    expect(improvement.baselineUpdate?.path).toBe(path.join(improve.expectationsRoot, "repo-one", "baseline.json"));
    expect(improvement.baselineUpdate?.source).toContain('"value": 1');
    expect(improvement.baselineUpdate?.source).toContain('"generatedAt": "2026-07-06T12:00:00.000Z"');
  });

  it("skips repos that have not been labeled yet", async () => {
    const { repoDir, expectationsRoot } = await makeFixture();
    await writeInitOutput(repoDir);

    const result = await runScoredLayer({
      repoName: "unlabeled",
      repoDir,
      expectationsRoot,
    });

    expect(result.layer).toMatchObject({
      layer: 2,
      name: "scored",
      status: "skip",
      hardFailure: false,
    });
  });
});
