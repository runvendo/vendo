import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverRemixCandidates } from "./discover.js";
import { textModel, countingModel } from "../test-helpers.js";

/** Build a fixture app tree: { "src/components/Foo.tsx": "..." } */
function app(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vendo-remix-discover-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** A mock model that replies with the given proposals payload. */
function proposalModel(proposals: Array<{ file: string; id: string; label: string; reason: string }>) {
  return textModel([JSON.stringify({ proposals })]);
}

describe("discoverRemixCandidates", () => {
  it("keeps a good widget and drops server-only, api-path, anchored, and hallucinated proposals", async () => {
    const dir = app({
      "src/components/DeadlineList.tsx": "export function DeadlineList() { return <ul><li>x</li></ul>; }",
      "src/actions/SaveReport.tsx": '"use server";\nexport function SaveReport() { return null; }',
      "src/app/api/report/ReportWidget.tsx": "export function ReportWidget() { return <div/>; }",
      "src/components/Wrapped.tsx":
        'export function Wrapped() { return <VendoRemix id="existing"><Inner/></VendoRemix>; }',
    });
    const model = proposalModel([
      { file: "src/components/DeadlineList.tsx", id: "deadline-list", label: "Deadline list", reason: "list of deadlines" },
      { file: "src/actions/SaveReport.tsx", id: "save", label: "Save", reason: "no" },
      { file: "src/app/api/report/ReportWidget.tsx", id: "report", label: "Report", reason: "no" },
      { file: "src/components/Wrapped.tsx", id: "wrapped", label: "Wrapped", reason: "no" },
      { file: "src/components/Ghost.tsx", id: "ghost", label: "Ghost", reason: "hallucinated" },
    ]);

    const { candidates, excluded } = await discoverRemixCandidates(dir, model);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      file: "src/components/DeadlineList.tsx",
      componentName: "DeadlineList",
      suggestedId: "deadline-list",
      suggestedLabel: "Deadline list",
      reason: "list of deadlines",
    });
    expect(candidates[0]!.file).not.toContain("\\");

    const reasons = Object.fromEntries(excluded.map((e) => [e.file, e.reason]));
    expect(reasons["src/actions/SaveReport.tsx"]).toMatch(/use server/i);
    expect(reasons["src/app/api/report/ReportWidget.tsx"]).toMatch(/api/i);
    expect(reasons["src/components/Wrapped.tsx"]).toMatch(/anchor/i);
    expect(reasons["src/components/Ghost.tsx"]).toMatch(/scanned/i);
  });

  it("sanitizes ids to kebab-case, dedupes collisions, and falls back label to component name", async () => {
    const dir = app({
      "src/components/Alpha.tsx": "export function Alpha() { return <div/>; }",
      "src/components/Beta.tsx": "export function Beta() { return <div/>; }",
      "src/components/Gamma.tsx": "export function Gamma() { return <div/>; }",
    });
    const model = proposalModel([
      { file: "src/components/Alpha.tsx", id: "MyWidget", label: "My Widget", reason: "r" },
      { file: "src/components/Beta.tsx", id: "My Widget!!", label: "   ", reason: "r" },
      { file: "src/components/Gamma.tsx", id: "   ", label: "Gamma Panel", reason: "r" },
    ]);

    const { candidates } = await discoverRemixCandidates(dir, model);

    expect(candidates.map((c) => c.suggestedId)).toEqual(["my-widget", "my-widget-2", "gamma"]);
    expect(candidates.map((c) => c.suggestedLabel)).toEqual(["My Widget", "Beta", "Gamma Panel"]);
  });

  it("makes no LLM call and returns empty when no source files are scanned", async () => {
    const dir = app({ "package.json": "{}", "README.md": "# hi" });
    const { model, count } = countingModel(["{}"]);

    const result = await discoverRemixCandidates(dir, model);

    expect(result).toEqual({ candidates: [], excluded: [] });
    expect(count()).toBe(0);
  });
});
