import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureRemixSources, SOURCE_CAP_BYTES } from "./capture";

const NOW = () => "2026-07-04T00:00:00.000Z";

/** Build a fixture app tree: { "src/app/page.tsx": "..." } */
function app(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-sync-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
});

const WIDGET = `import { Badge } from "@/components/ui/badge"
export function DeadlineList({ className }: { className?: string }) {
  return <Badge>due</Badge>
}
`;

describe("captureRemixSources", () => {
  it("captures a literal-id wrapper's child through an @/* alias, extensionless", () => {
    const dir = app({
      "tsconfig.json": TSCONFIG,
      "src/components/dashboard/deadline-list.tsx": WIDGET,
      "src/app/page.tsx": `import { FlowletRemix } from "@flowlet/shell"
import { DeadlineList } from "@/components/dashboard/deadline-list"
export default function Page() {
  return <FlowletRemix id="upcoming-deadlines" label="Deadlines"><DeadlineList className="col-span-2" /></FlowletRemix>
}
`,
    });
    const { records, report } = captureRemixSources(dir, { now: NOW });
    const record = records["upcoming-deadlines"]!;
    expect(record.file).toBe(path.join("src", "components", "dashboard", "deadline-list.tsx"));
    expect(record.exportName).toBe("DeadlineList");
    expect(record.source).toContain("export function DeadlineList");
    expect(record.sourceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(record.capturedAt).toBe(NOW());
    expect(report.join("\n")).toContain("captured upcoming-deadlines");
  });

  it("resolves relative imports, index barrels, and default imports (no exportName)", () => {
    const dir = app({
      "src/widgets/index.tsx": `export { default } from "./chart"`,
      "src/widgets/chart.tsx": `export default function Chart() { return null }`,
      "src/app/page.tsx": `import Chart from "../widgets"
import { FlowletRemix } from "@flowlet/shell"
export default function Page() {
  return <FlowletRemix id="chart"><Chart /></FlowletRemix>
}
`,
    });
    const { records } = captureRemixSources(dir, { now: NOW });
    expect(records["chart"]!.file).toBe(path.join("src", "widgets", "index.tsx"));
    expect(records["chart"]!.exportName).toBeUndefined();
  });

  it("skips dynamic ids with a report entry", () => {
    const dir = app({
      "src/app/page.tsx": `import { FlowletRemix } from "@flowlet/shell"
export default function Page({ id }: { id: string }) {
  return <FlowletRemix id={id}><div /></FlowletRemix>
}
`,
    });
    const { records, report } = captureRemixSources(dir, { now: NOW });
    expect(Object.keys(records)).toHaveLength(0);
    expect(report.join("\n")).toContain("dynamic FlowletRemix id");
  });

  it("multi-child and inline markup capture the ENCLOSING file", () => {
    const dir = app({
      "src/app/page.tsx": `import { FlowletRemix } from "@flowlet/shell"
export default function Page() {
  return <FlowletRemix id="multi"><div>a</div><div>b</div></FlowletRemix>
}
`,
    });
    const { records } = captureRemixSources(dir, { now: NOW });
    expect(records["multi"]!.file).toBe(path.join("src", "app", "page.tsx"));
    expect(records["multi"]!.exportName).toBeUndefined();
  });

  it("refuses server-only files AFTER alias resolution (use server, server/, api/)", () => {
    const dir = app({
      "tsconfig.json": TSCONFIG,
      "src/server/secret-widget.tsx": `export function SecretWidget() { return null }`,
      "src/actions/mutate.tsx": `"use server"
export function Mutate() { return null }`,
      "src/app/page.tsx": `import { FlowletRemix } from "@flowlet/shell"
import { SecretWidget } from "@/server/secret-widget"
import { Mutate } from "@/actions/mutate"
export default function Page() {
  return <>
    <FlowletRemix id="a"><SecretWidget /></FlowletRemix>
    <FlowletRemix id="b"><Mutate /></FlowletRemix>
  </>
}
`,
    });
    const { records, report } = captureRemixSources(dir, { now: NOW });
    expect(records["a"]).toBeUndefined();
    expect(records["b"]).toBeUndefined();
    expect(report.join("\n")).toContain("server/ directory");
    expect(report.join("\n")).toContain('"use server" directive');
  });

  it("caps oversized sources with a visible marker", () => {
    const dir = app({
      "src/big.tsx": `export function Big() { return null }\n// ${"x".repeat(SOURCE_CAP_BYTES)}`,
      "src/app/page.tsx": `import { FlowletRemix } from "@flowlet/shell"
import { Big } from "../big"
export default function Page() {
  return <FlowletRemix id="big"><Big /></FlowletRemix>
}
`,
    });
    const { records } = captureRemixSources(dir, { now: NOW });
    expect(records["big"]!.source.endsWith("[truncated]")).toBe(true);
    expect(records["big"]!.source.length).toBeLessThanOrEqual(SOURCE_CAP_BYTES + 20);
  });

  it("reports the empty case as fine (fresh install)", () => {
    const dir = app({ "src/app/page.tsx": `export default function Page() { return null }` });
    const { records, report } = captureRemixSources(dir, { now: NOW });
    expect(records).toEqual({});
    expect(report.join("\n")).toContain("fine on a fresh install");
  });
});
