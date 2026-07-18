import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiExpectedToolIdentity,
  discoverAiConfiguredRepoNames,
  loadRepoAiExpectations,
  parseRepoAiExpectations,
  repoAiExpectedPath,
} from "./expectations.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeExpectationsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-ai-expectations-"));
  tempRoots.push(root);
  return root;
}

describe("ai-expected.json format", () => {
  it("parses HTTP, tRPC, GraphQL, and server-action entries with risk labels", () => {
    const parsed = parseRepoAiExpectations({
      version: 1,
      tools: [
        { name: "listInvoices", method: "GET", path: "/api/invoices", risk: "read" },
        { name: "deleteInvoice", method: "DELETE", path: "/api/invoices/{id}", risk: "destructive", critical: true },
        { name: "wipeAll", method: "POST", path: "/api/admin/wipe", risk: "destructive", wake: false },
        { name: "invoices.list", kind: "trpc", procedure: "invoices.list", risk: "read" },
        { name: "createUser", kind: "graphql", operation: "createUser", risk: "write" },
        { name: "archive", kind: "server-action", module: "app/actions.ts", export: "archive", risk: "write" },
      ],
    });

    expect(parsed.tools).toHaveLength(6);
    expect(parsed.tools[1]).toMatchObject({ risk: "destructive", critical: true });
    expect(parsed.tools[2]).toMatchObject({ wake: false });
  });

  it("rejects unknown fields and missing risk", () => {
    expect(() => parseRepoAiExpectations({
      version: 1,
      tools: [{ name: "x", method: "GET", path: "/api/x" }],
    })).toThrow();
    expect(() => parseRepoAiExpectations({
      version: 1,
      tools: [{ name: "x", method: "GET", path: "/api/x", risk: "read", bogus: true }],
    })).toThrow();
  });

  it("keys entries by the same binding identity convention as expected.json", () => {
    expect(aiExpectedToolIdentity({ name: "a", method: "GET", path: "/api/x", risk: "read" }))
      .toBe("GET\t/api/x");
    expect(aiExpectedToolIdentity({ name: "b", kind: "trpc", procedure: "x.y", risk: "read" }))
      .toBe("trpc\tx.y");
    expect(aiExpectedToolIdentity({ name: "c", kind: "graphql", operation: "op", risk: "read" }))
      .toBe("graphql\top");
    expect(aiExpectedToolIdentity({ name: "d", kind: "server-action", module: "m.ts", export: "e", risk: "read" }))
      .toBe("server-action\tm.ts#e");
  });
});

describe("loadRepoAiExpectations", () => {
  it("returns null when the file is absent and parses it when present", async () => {
    const root = await makeExpectationsRoot();
    expect(await loadRepoAiExpectations(root, "umami")).toBeNull();

    await mkdir(path.join(root, "umami"), { recursive: true });
    await writeFile(
      repoAiExpectedPath(root, "umami"),
      JSON.stringify({
        version: 1,
        tools: [{ name: "getWebsites", method: "GET", path: "/api/websites", risk: "read" }],
      }),
    );
    const loaded = await loadRepoAiExpectations(root, "umami");
    expect(loaded?.tools[0]?.risk).toBe("read");
  });

  it("throws on malformed files instead of silently skipping them", async () => {
    const root = await makeExpectationsRoot();
    await mkdir(path.join(root, "umami"), { recursive: true });
    await writeFile(repoAiExpectedPath(root, "umami"), "{ not json");
    await expect(loadRepoAiExpectations(root, "umami")).rejects.toThrow();
  });
});

describe("discoverAiConfiguredRepoNames", () => {
  it("lists only repo directories that carry an ai-expected.json, sorted", async () => {
    const root = await makeExpectationsRoot();
    for (const name of ["umami", "dub", "taxonomy"]) {
      await mkdir(path.join(root, name), { recursive: true });
    }
    await writeFile(repoAiExpectedPath(root, "umami"), "{}");
    await writeFile(repoAiExpectedPath(root, "dub"), "{}");
    await writeFile(path.join(root, "README.md"), "not a repo");

    expect(await discoverAiConfiguredRepoNames(root)).toEqual(["dub", "umami"]);
  });
});
