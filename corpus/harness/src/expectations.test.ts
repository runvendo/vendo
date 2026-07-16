import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  THEME_RUBRIC_DIMENSIONS,
  expectedToolIdentity,
  loadRepoBaseline,
  loadRepoExpectations,
  parseRepoBaseline,
  parseRepoExpectations,
} from "./expectations.js";

const tempRoots: string[] = [];

const theme = {
  background: "#ffffff",
  surface: "#f5f7fa",
  accent: "#0a7cff",
  text: "#111418",
  mutedText: "#5b6470",
  radius: 8,
  fontFamily: "Inter, sans-serif",
};

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeExpectationsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-expectations-"));
  tempRoots.push(root);
  return root;
}

describe("repo expectations format", () => {
  it("uses the seven PR #63 theme rubric dimensions and parses the per-repo shape", () => {
    const parsed = parseRepoExpectations({
      version: 1,
      theme,
      tools: [
        { name: "listInvoices", method: "GET", path: "/api/invoices", readOrWrite: "read" },
        { name: "createInvoice", method: "POST", path: "/api/invoices", readOrWrite: "write" },
      ],
      annotations: [
        { name: "listInvoices", mutating: false, dangerous: false },
        { name: "createInvoice", mutating: true, dangerous: false },
      ],
      components: [
        {
          name: "InvoiceBadge",
          descriptionIncludes: ["invoice", "status"],
          props: ["status"],
        },
      ],
    });

    expect(THEME_RUBRIC_DIMENSIONS).toEqual([
      "background",
      "surface",
      "accent",
      "text",
      "mutedText",
      "radius",
      "fontFamily",
    ]);
    expect(parsed.tools[1]).toEqual({
      name: "createInvoice",
      method: "POST",
      path: "/api/invoices",
      readOrWrite: "write",
    });
    expect(parsed.components[0]).toEqual({
      name: "InvoiceBadge",
      descriptionIncludes: ["invoice", "status"],
      props: ["status"],
    });
  });

  it("parses binding-kind-aware inventory rows and keys each by its own identity", () => {
    const parsed = parseRepoExpectations({
      version: 1,
      theme,
      tools: [
        { name: "listInvoices", method: "GET", path: "/api/invoices", readOrWrite: "read" },
        { name: "pollsList", kind: "trpc", procedure: "polls.list", readOrWrite: "read" },
        { name: "createApiKey", kind: "graphql", operation: "createApiKey", readOrWrite: "write" },
      ],
      annotations: [],
      components: [],
    });
    expect(parsed.tools.map(expectedToolIdentity)).toEqual([
      "GET\t/api/invoices",
      "trpc\tpolls.list",
      "graphql\tcreateApiKey",
    ]);

    // A graphql row without its operation never parses.
    expect(() => parseRepoExpectations({
      version: 1,
      theme,
      tools: [{ name: "createApiKey", kind: "graphql", readOrWrite: "write" }],
      annotations: [],
      components: [],
    })).toThrow();
  });

  it("rejects incomplete theme labels and incomplete tool inventory rows", () => {
    expect(() => parseRepoExpectations({
      version: 1,
      theme: { ...theme, fontFamily: undefined },
      tools: [{ name: "listInvoices", method: "GET", path: "/api/invoices" }],
      annotations: [],
      components: [],
    })).toThrow(/fontFamily|readOrWrite/);
  });

  it("loads expected.json and baseline.json from corpus/expectations/<repo>", async () => {
    const expectationsRoot = await makeExpectationsRoot();
    const repoDir = path.join(expectationsRoot, "repo-one");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      path.join(repoDir, "expected.json"),
      JSON.stringify({ version: 1, theme, tools: [], annotations: [], components: [] }, null, 2) + "\n",
    );
    await writeFile(
      path.join(repoDir, "baseline.json"),
      JSON.stringify({ version: 1, score: { passed: 9, total: 10, value: 0.9 } }, null, 2) + "\n",
    );

    await expect(loadRepoExpectations(expectationsRoot, "repo-one")).resolves.toMatchObject({ theme });
    await expect(loadRepoExpectations(expectationsRoot, "missing-repo")).resolves.toBeNull();
    await expect(loadRepoBaseline(expectationsRoot, "repo-one")).resolves.toEqual({
      version: 1,
      score: { passed: 9, total: 10, value: 0.9 },
    });
    expect(parseRepoBaseline(JSON.parse(await readFile(path.join(repoDir, "baseline.json"), "utf8")))).toMatchObject({
      score: { value: 0.9 },
    });
  });
});
