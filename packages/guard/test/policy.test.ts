import { VENDO_POLICY_FORMAT } from "@vendoai/core";
import type { GuardDecision } from "@vendoai/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { call, context, descriptor } from "./fixtures/tools.js";

const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vendo-guard-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function policyFile(document: unknown): Promise<string> {
  const directory = await temporaryDirectory();
  const file = join(directory, "policy.json");
  await writeFile(file, JSON.stringify(document), "utf8");
  return file;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("policy files, rules, directions, and code", () => {
  it("uses first-match-wins with anchored globs and exact venue/presence fields", async () => {
    const guard = createGuard({
      store: createMemoryStore(),
      policy: {
        rules: [
          { match: { tool: "gmail_*", presence: "present" }, action: "run" },
          { match: { tool: "gmail_*" }, action: "block", note: "email blocked" },
          { match: { venue: "mcp" }, action: "block", note: "mcp blocked" },
          { match: { presence: "away" }, action: "ask" },
        ],
      },
    });
    const gmail = descriptor("write", { name: "gmail_send" });
    const lookalike = descriptor("write", { name: "xgmail_send" });

    await expect(guard.check(call(gmail.name), gmail, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
    await expect(guard.check(call(gmail.name), gmail, context({ presence: "away" }))).resolves.toEqual({
      action: "block",
      reason: "email blocked",
      decidedBy: "rule",
    });
    await expect(guard.check(call(lookalike.name), lookalike, context({ venue: "mcp" }))).resolves.toEqual({
      action: "block",
      reason: "mcp blocked",
      decidedBy: "rule",
    });
    await expect(
      guard.check(call(lookalike.name), lookalike, context({ venue: "automation", presence: "away" })),
    ).resolves.toMatchObject({ action: "ask", decidedBy: "rule" });
  });

  it("loads a valid file lazily and resolves file directions", async () => {
    const file = await policyFile({
      format: VENDO_POLICY_FORMAT,
      directions: ["Refer tax questions to an accountant."],
      rules: [{ match: { risk: "destructive" }, action: "block", note: "file says no" }],
    });
    const guard = createGuard({ store: createMemoryStore(), policy: { file } });
    const destructive = descriptor("destructive");

    await expect(guard.directions(context())).resolves.toEqual(["Refer tax questions to an accountant."]);
    await expect(guard.check(call(destructive.name), destructive, context())).resolves.toEqual({
      action: "block",
      reason: "file says no",
      decidedBy: "rule",
    });
  });

  it("does not merge inline rules or directions with file values", async () => {
    const file = await policyFile({
      format: VENDO_POLICY_FORMAT,
      directions: ["file direction"],
      rules: [{ match: { tool: "host_read" }, action: "block" }],
    });
    const guard = createGuard({
      store: createMemoryStore(),
      policy: {
        file,
        directions: ["inline direction"],
        rules: [{ match: { tool: "host_read" }, action: "run" }],
      },
    });
    const read = descriptor("read");

    await expect(guard.directions(context())).resolves.toEqual(["inline direction"]);
    await expect(guard.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "rule",
    });
  });

  it("fails loud with validation errors for malformed or explicitly missing files", async () => {
    const malformed = await policyFile({ format: "vendo/policy@999", rules: "not-an-array" });
    const malformedGuard = createGuard({ store: createMemoryStore(), policy: { file: malformed } });
    await expect(malformedGuard.check(call(), descriptor(), context())).rejects.toMatchObject({
      code: "validation",
    });

    const directory = await temporaryDirectory();
    const missingGuard = createGuard({
      store: createMemoryStore(),
      policy: { file: join(directory, "does-not-exist.json") },
    });
    await expect(missingGuard.directions(context())).rejects.toMatchObject({ code: "validation" });
  });

  it("silently treats a missing default file as absent but never loads one without policy config", async () => {
    const directory = await temporaryDirectory();
    process.chdir(directory);
    const read = descriptor("read");
    const defaultFileGuard = createGuard({ store: createMemoryStore(), policy: {} });
    await expect(defaultFileGuard.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "default",
    });
    await expect(defaultFileGuard.directions(context())).resolves.toEqual([]);

    const noPolicyGuard = createGuard({ store: createMemoryStore() });
    await expect(noPolicyGuard.check(call(read.name), read, context())).resolves.toMatchObject({ action: "run" });
  });

  it("uses inline rules and directions without loading a configured file", async () => {
    // A malformed file that inline config makes irrelevant must never abort:
    // inline wins with no merge, so the file is not even read.
    const malformed = await policyFile({ format: "vendo/policy@999", rules: "nope" });
    const guard = createGuard({
      store: createMemoryStore(),
      policy: {
        file: malformed,
        rules: [{ match: { tool: "host_read" }, action: "block", note: "inline wins" }],
        directions: ["inline only"],
      },
    });
    const read = descriptor("read");
    await expect(guard.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "block",
      decidedBy: "rule",
    });
    await expect(guard.directions(context())).resolves.toEqual(["inline only"]);
  });

  it("lets code decide or pass through and fails closed when code throws", async () => {
    const read = descriptor("read");
    const decided = createGuard({
      store: createMemoryStore(),
      policy: {
        code: (): GuardDecision => ({ action: "block", reason: "code denied", decidedBy: "rule" }),
      },
    });
    await expect(decided.check(call(read.name), read, context())).resolves.toEqual({
      action: "block",
      reason: "code denied",
      decidedBy: "rule",
    });

    const passed = createGuard({
      store: createMemoryStore(),
      policy: { code: () => undefined },
      judge: { decide: async () => ({ action: "run", rationale: "judge fallback" }) },
    });
    await expect(passed.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "run",
      decidedBy: "judge",
    });

    const threw = createGuard({
      store: createMemoryStore(),
      policy: {
        code: () => {
          throw new Error("policy bug");
        },
      },
    });
    await expect(threw.check(call(read.name), read, context())).resolves.toMatchObject({
      action: "ask",
      decidedBy: "rule",
    });
  });
});
