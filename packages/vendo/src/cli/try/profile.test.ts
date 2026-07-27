import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleTryProfile,
  fixturesFileSchema,
  tryProfileSchema,
  usecasesFileSchema,
} from "./profile.js";

/** The committed real extraction profile — the assembler's happy path. */
const demoBankRoot = fileURLToPath(new URL("../../../../../apps/demo-bank", import.meta.url));

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function emptyRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-try-profile-"));
  cleanup.push(root);
  return root;
}

/** A minimal valid vendo/tools@1 file with one read and one write tool. */
function toolsFixture(): object {
  return {
    format: "vendo/tools@1",
    tools: [
      {
        name: "host_invoices_list",
        description: "GET /api/invoices",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      },
      {
        name: "host_invoices_delete",
        description: "DELETE /api/invoices/{id}",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: true },
        risk: "write",
        binding: { kind: "route", method: "DELETE", path: "/api/invoices/{id}", argsIn: "query" },
      },
    ],
  };
}

describe("assembleTryProfile on the committed demo-bank profile", () => {
  it("populates tools, theme, catalog, and brief from disk", async () => {
    const profile = await assembleTryProfile(demoBankRoot);

    expect(profile.venue).toBe("local");
    expect(profile.brand).toEqual({ name: null, domain: null, logoUrl: null });

    expect(profile.theme).not.toBeNull();
    expect(profile.theme?.colors.accent).toBe("#111111");
    expect(profile.theme?.density).toBe("comfortable");

    expect(profile.brief).toContain("Maple");

    expect(profile.tools.counts.total).toBeGreaterThan(0);
    expect(profile.tools.list).toHaveLength(profile.tools.counts.total);
    expect(profile.tools.counts.enabled).toBeGreaterThan(0);
    // demo-bank's overrides.json disables the Auth.js endpoints.
    expect(profile.tools.counts.enabled).toBeLessThan(profile.tools.counts.total);
    const authTool = profile.tools.list.find((tool) => tool.name === "host_auth_create");
    expect(authTool?.disabled).toBe(true);
    expect(authTool?.description).toBe("Auth.js endpoint - never agent-callable");

    expect(profile.catalog).toContain("MapleNetWorthCard");

    // No AI try artifacts are committed: usecases/fixtures degrade.
    expect(profile.usecases).toEqual([]);
    expect(profile.fixturesAvailable).toBe(false);

    // brief present without usecases = partially deepened.
    expect(profile.depth.level).toBe("deepening");
    expect(profile.depth.stages).toMatchObject({
      tools: "done",
      theme: "done",
      brief: "done",
      usecases: "pending",
      fixtures: "pending",
    });

    expect(profile.capabilities).toEqual({ liveChat: false, refine: false });
    expect(tryProfileSchema.parse(profile)).toEqual(profile);
  });

  it("honors caller options for venue, brand, capabilities, and stage statuses", async () => {
    const profile = await assembleTryProfile(demoBankRoot, {
      venue: "hosted",
      brand: { name: "Maple", domain: "maple.example", logoUrl: "https://maple.example/logo.svg" },
      capabilities: { liveChat: true },
      stages: { usecases: "failed" },
    });

    expect(profile.venue).toBe("hosted");
    expect(profile.brand).toEqual({
      name: "Maple",
      domain: "maple.example",
      logoUrl: "https://maple.example/logo.svg",
    });
    expect(profile.capabilities).toEqual({ liveChat: true, refine: false });
    // Caller-supplied stage statuses win over the disk derivation…
    expect(profile.depth.stages["usecases"]).toBe("failed");
    // …without erasing the derived ones.
    expect(profile.depth.stages["tools"]).toBe("done");
    expect(tryProfileSchema.parse(profile)).toEqual(profile);
  });
});

describe("assembleTryProfile graceful degradation", () => {
  it("assembles a fully degraded profile from a root with no .vendo directory", async () => {
    const profile = await assembleTryProfile(await emptyRoot());

    expect(profile.theme).toBeNull();
    expect(profile.brief).toBeNull();
    expect(profile.brand).toEqual({ name: null, domain: null, logoUrl: null });
    expect(profile.tools.list).toEqual([]);
    expect(profile.tools.counts).toEqual({ total: 0, enabled: 0 });
    expect(profile.catalog).toEqual([]);
    expect(profile.usecases).toEqual([]);
    expect(profile.fixturesAvailable).toBe(false);
    expect(profile.depth.level).toBe("shallow");
    expect(profile.depth.stages).toEqual({
      tools: "pending",
      theme: "pending",
      brief: "pending",
      usecases: "pending",
      fixtures: "pending",
    });
    expect(tryProfileSchema.parse(profile)).toEqual(profile);
  });

  it("degrades corrupt or mis-shaped files to their empty values instead of throwing", async () => {
    const root = await emptyRoot();
    const extractDir = join(root, ".vendo", "data", "extract");
    await mkdir(extractDir, { recursive: true });
    await writeFile(join(root, ".vendo", "tools.json"), "{ not json");
    await writeFile(join(root, ".vendo", "theme.json"), "also not json");
    await writeFile(join(root, ".vendo", "catalog.json"), JSON.stringify({ format: "vendo/catalog@2" }));
    await writeFile(join(extractDir, "usecases.json"), "[[[");
    await writeFile(join(extractDir, "fixtures.json"), JSON.stringify({ format: "vendo/fixtures@1", fixtures: "nope" }));

    const profile = await assembleTryProfile(root);

    expect(profile.theme).toBeNull();
    expect(profile.tools.list).toEqual([]);
    expect(profile.tools.counts).toEqual({ total: 0, enabled: 0 });
    expect(profile.catalog).toEqual([]);
    expect(profile.usecases).toEqual([]);
    expect(profile.fixturesAvailable).toBe(false);
    // Unparseable artifacts do not count as completed stages.
    expect(profile.depth.stages["tools"]).toBe("pending");
    expect(profile.depth.level).toBe("shallow");
    expect(tryProfileSchema.parse(profile)).toEqual(profile);
  });
});

describe("assembleTryProfile override merge semantics", () => {
  it("applies overrides as corrections: disabled excluded from enabled, risk and description replaced", async () => {
    const root = await emptyRoot();
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(toolsFixture()));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@1",
      tools: {
        host_invoices_list: { disabled: true },
        host_invoices_delete: { risk: "destructive", description: "Permanently deletes an invoice." },
      },
    }));

    const profile = await assembleTryProfile(root);

    expect(profile.tools.counts).toEqual({ total: 2, enabled: 1 });
    const listTool = profile.tools.list.find((tool) => tool.name === "host_invoices_list");
    expect(listTool?.disabled).toBe(true);
    const deleteTool = profile.tools.list.find((tool) => tool.name === "host_invoices_delete");
    expect(deleteTool).toEqual({
      name: "host_invoices_delete",
      description: "Permanently deletes an invoice.",
      risk: "destructive",
      disabled: false,
    });
  });

  it("ignores a malformed overrides.json and keeps the extracted tool surface", async () => {
    const root = await emptyRoot();
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(toolsFixture()));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({ format: "vendo/overrides@1", tools: { host_invoices_list: { risk: "chaotic" } } }));

    const profile = await assembleTryProfile(root);

    expect(profile.tools.counts).toEqual({ total: 2, enabled: 2 });
  });
});

describe("try artifacts and depth", () => {
  it("reads usecases + fixtures and reports deep when brief and usecases both exist", async () => {
    const root = await emptyRoot();
    const extractDir = join(root, ".vendo", "data", "extract");
    await mkdir(extractDir, { recursive: true });
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(toolsFixture()));
    await writeFile(join(root, ".vendo", "brief.md"), "# Acme\nAcme is a demo product.\n");
    await writeFile(join(extractDir, "usecases.json"), JSON.stringify({
      format: "vendo/usecases@1",
      usecases: [{ label: "See spending", prompt: "Show my spending this month", icon: "chart" }],
    }));
    await writeFile(join(extractDir, "fixtures.json"), JSON.stringify({
      format: "vendo/fixtures@1",
      fixtures: { host_invoices_list: [{ id: "inv_1", totalCents: 1200 }] },
    }));

    const profile = await assembleTryProfile(root);

    // Passthrough fields a future producer emits survive into the profile.
    expect(profile.usecases).toEqual([{ label: "See spending", prompt: "Show my spending this month", icon: "chart" }]);
    expect(profile.fixturesAvailable).toBe(true);
    expect(profile.depth.level).toBe("deep");
    expect(profile.depth.stages).toMatchObject({ tools: "done", brief: "done", usecases: "done", fixtures: "done" });
    expect(tryProfileSchema.parse(profile)).toEqual(profile);
  });

  it("reports deepening when only one AI artifact (usecases without brief) exists", async () => {
    const root = await emptyRoot();
    const extractDir = join(root, ".vendo", "data", "extract");
    await mkdir(extractDir, { recursive: true });
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(toolsFixture()));
    await writeFile(join(extractDir, "usecases.json"), JSON.stringify({
      format: "vendo/usecases@1",
      usecases: [{ label: "See spending", prompt: "Show my spending this month" }],
    }));

    const profile = await assembleTryProfile(root);

    expect(profile.depth.level).toBe("deepening");
  });

  it("counts usecases by content: a parsed file with zero chips deepens nothing", async () => {
    const root = await emptyRoot();
    const extractDir = join(root, ".vendo", "data", "extract");
    await mkdir(extractDir, { recursive: true });
    await writeFile(join(root, ".vendo", "brief.md"), "# Acme\nAcme is a demo product.\n");
    await writeFile(join(extractDir, "usecases.json"), JSON.stringify({ format: "vendo/usecases@1", usecases: [] }));

    const profile = await assembleTryProfile(root);

    // Brief counts, the empty usecases file does not — matching the
    // empty-brief rule; the stage itself still reads done (the pass ran).
    expect(profile.depth.level).toBe("deepening");
    expect(profile.depth.stages["usecases"]).toBe("done");
  });

  it("reports shallow for a pure-deterministic profile (tools without AI artifacts)", async () => {
    const root = await emptyRoot();
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(toolsFixture()));

    const profile = await assembleTryProfile(root);

    expect(profile.depth.level).toBe("shallow");
    expect(profile.tools.counts.total).toBe(2);
  });
});

describe("artifact file schemas", () => {
  it("usecasesFileSchema pins the versioned format literal", () => {
    expect(usecasesFileSchema.safeParse({ format: "vendo/usecases@1", usecases: [] }).success).toBe(true);
    expect(usecasesFileSchema.safeParse({ format: "vendo/usecases@2", usecases: [] }).success).toBe(false);
    expect(usecasesFileSchema.safeParse({ format: "vendo/usecases@1", usecases: [{ label: "", prompt: "x" }] }).success).toBe(false);
  });

  it("fixturesFileSchema pins the versioned format literal and row-array values", () => {
    expect(fixturesFileSchema.safeParse({ format: "vendo/fixtures@1", fixtures: {} }).success).toBe(true);
    expect(fixturesFileSchema.safeParse({ format: "vendo/fixtures@1", fixtures: { a: [{ id: 1 }] } }).success).toBe(true);
    expect(fixturesFileSchema.safeParse({ format: "vendo/fixtures@1", fixtures: { a: "rows" } }).success).toBe(false);
  });
});
