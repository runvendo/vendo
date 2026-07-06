import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareE2eRepo } from "./e2e-prep.js";

async function createUmamiFixture(): Promise<{ appRoot: string; logsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-prep-"));
  const appRoot = path.join(root, "umami");
  const logsDir = path.join(root, "logs");
  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await mkdir(path.join(appRoot, "src/app/api/vendo/[...path]"), { recursive: true });
  await mkdir(path.join(appRoot, "src/app"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
  await writeFile(
    path.join(appRoot, "src/app/api/vendo/[...path]/route.ts"),
    `import { createVendoHandler } from "vendoai/server";
export const { GET, POST } = createVendoHandler();
`,
  );
  await writeFile(
    path.join(appRoot, "src/app/vendo-root.tsx"),
    `"use client";
import { VendoRoot } from "vendoai/react";
import type { ReactNode } from "react";
import theme from "../../.vendo/theme.json";
import tools from "../../.vendo/tools.json";

export function AppVendoRoot({ children }: { children: ReactNode }) {
  return (
    <VendoRoot theme={theme} tools={tools} productName="Umami">
      {children}
    </VendoRoot>
  );
}
`,
  );
  return { appRoot, logsDir };
}

describe("prepareE2eRepo", () => {
  it("adds Umami Layer 3 tools, handler guidance, auth fetch, and per-attempt thread ids", async () => {
    const { appRoot, logsDir } = await createUmamiFixture();
    const logs = await prepareE2eRepo({ name: "umami" }, appRoot, logsDir);

    const tools = JSON.parse(await readFile(path.join(appRoot, ".vendo/tools.json"), "utf8")) as {
      tools: Array<{ name: string }>;
    };
    const route = await readFile(path.join(appRoot, "src/app/api/vendo/[...path]/route.ts"), "utf8");
    const root = await readFile(path.join(appRoot, "src/app/vendo-root.tsx"), "utf8");
    const log = await readFile(logs[0]!, "utf8");

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_umami_websites",
      "get_umami_website_metrics",
      "get_umami_pageviews",
      "get_umami_revenue_report",
      "get_umami_funnel_report",
    ]);
    expect(route).toContain("storage: false");
    expect(route).toContain("instructionsExtra");
    expect(route).toContain("visible answer must include labels and numeric values");
    expect(route).toContain("If you render a view");
    expect(root).toContain("threadId={threadId}");
    expect(root).toContain("vendoThread");
    expect(root).toContain("installUmamiAuthFetch");
    expect(root).toContain("umami.auth");
    expect(root).toContain('headers.set("authorization"');
    expect(log).toContain("read-only tools manifest");
    expect(log).toContain("Umami auth headers");
  });

  it("does nothing for repos without a Layer 3 prep fixture", async () => {
    const { appRoot, logsDir } = await createUmamiFixture();

    await expect(prepareE2eRepo({ name: "skateshop" }, appRoot, logsDir)).resolves.toEqual([]);
  });
});
