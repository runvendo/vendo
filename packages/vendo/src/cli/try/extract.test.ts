import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { toolsFileV3Schema } from "@vendoai/actions";
import { vendoThemeSchema } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { runDeterministicPass } from "./extract.js";
import { assembleTryProfile } from "./profile.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

/** A minimal Next-ish host: one shadcn-token stylesheet the theme allowlist
 *  reads exactly, one app-router API route the route scan extracts. */
async function nextFixture(): Promise<string> {
  const root = await tempDir("vendo-try-fixture-");
  await write(root, "package.json", `${JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.4.0" },
  }, null, 2)}\n`);
  await write(root, "app/layout.tsx", [
    'import "./globals.css";',
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    "",
  ].join("\n"));
  await write(root, "app/globals.css", [
    ":root {",
    "  --background: #fffdf8;",
    "  --foreground: #1c1917;",
    "  --primary: #7c3aed;",
    "  --radius: 10px;",
    "}",
    "",
  ].join("\n"));
  await write(root, "app/api/invoices/route.ts",
    "export async function GET() { return Response.json([]); }\n");
  return root;
}

/** Full recursive inventory of a tree: every directory (trailing slash) and
 *  every file with a content hash — the zero-commit comparison unit. */
async function inventory(root: string, at = root): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    const relative = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      entries[`${relative}/`] = "dir";
      Object.assign(entries, await inventory(root, path));
    } else {
      entries[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return entries;
}

describe("runDeterministicPass zero-commit contract", () => {
  it("never writes a byte under repoRoot: full before/after inventories are identical", async () => {
    const repoRoot = await nextFixture();
    const before = await inventory(repoRoot);

    await runDeterministicPass({ repoRoot, profileRoot: await tempDir("vendo-try-profile-") });

    expect(await inventory(repoRoot)).toEqual(before);
  });

  it("rejects a profileRoot inside repoRoot instead of breaking the guarantee", async () => {
    const repoRoot = await nextFixture();

    await expect(runDeterministicPass({ repoRoot, profileRoot: join(repoRoot, ".vendo") }))
      .rejects.toThrow(/repoRoot/);
    await expect(runDeterministicPass({ repoRoot, profileRoot: repoRoot }))
      .rejects.toThrow(/repoRoot/);
  });
});

describe("runDeterministicPass artifacts", () => {
  it("writes theme.json (frozen shape) and tools.json (vendo/tools@3) into profileRoot", async () => {
    const repoRoot = await nextFixture();
    const profileRoot = await tempDir("vendo-try-profile-");

    const result = await runDeterministicPass({ repoRoot, profileRoot });

    expect(result.profileRoot).toBe(profileRoot);
    const theme = vendoThemeSchema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "theme.json"), "utf8")));
    expect(theme.colors.accent).toBe("#7c3aed");
    expect(theme.colors.background).toBe("#fffdf8");
    expect(theme.radius.medium).toBe("10px");

    const tools = toolsFileV3Schema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "tools.json"), "utf8")));
    expect(tools.tools.map((tool) => tool.name)).toContain("host_invoices_list");

    expect(result.theme.status).toBe("written");
    expect(result.theme.slotsMatched).toBeGreaterThan(0);
    expect(result.tools.status).toBe("written");
    expect(result.tools.count).toBe(tools.tools.length);
  });

  it("produces a profileRoot that assembleTryProfile boots from directly", async () => {
    const repoRoot = await nextFixture();
    const { profileRoot } = await runDeterministicPass({ repoRoot, profileRoot: await tempDir("vendo-try-profile-") });

    const profile = await assembleTryProfile(profileRoot);

    expect(profile.theme).not.toBeNull();
    expect(profile.tools.counts.total).toBeGreaterThan(0);
    expect(profile.depth.stages).toMatchObject({ tools: "done", theme: "done" });
  });

  it("creates a recognizable temp profileRoot when the caller omits one", async () => {
    const result = await runDeterministicPass({ repoRoot: await nextFixture() });
    cleanup.push(result.profileRoot);

    expect(basename(result.profileRoot)).toMatch(/^vendo-try-/);
    // The directory is real and populated.
    expect(await readdir(join(result.profileRoot, ".vendo"))).toContain("theme.json");
  });
});

// genqa defect 1 (venue self-strangulation): route-scanned GETs extract at
// risk "write" (common.ts's fail-closed default — correct against a real
// host, wrong against try's own synthetic fixtures). The try pass must
// correct it via overrides.json, never by touching the extractor's default.
describe("runDeterministicPass try-venue read downgrade", () => {
  it("downgrades a route-scanned GET from write to read via overrides.json, without touching tools.json", async () => {
    const repoRoot = await nextFixture();
    const profileRoot = await tempDir("vendo-try-profile-");

    const result = await runDeterministicPass({ repoRoot, profileRoot });

    const tools = toolsFileV3Schema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "tools.json"), "utf8")));
    const listTool = tools.tools.find((tool) => tool.name === "host_invoices_list");
    expect(listTool?.binding.kind).toBe("route");
    // tools.json stays the extractor's own fail-closed call — untouched.
    expect(listTool?.risk).toBe("write");

    const overrides = JSON.parse(await readFile(join(profileRoot, ".vendo", "overrides.json"), "utf8")) as {
      format: string;
      tools: Record<string, { risk?: string }>;
    };
    expect(overrides.format).toBe("vendo/overrides@3");
    expect(overrides.tools["host_invoices_list"]?.risk).toBe("read");

    expect(result.tools.status).toBe("written");
  });

  it("never downgrades a destructive-shaped route GET (a real signal, not the extractor's plain fallback)", async () => {
    const repoRoot = await nextFixture();
    await write(repoRoot, "app/api/invoices/[id]/delete/route.ts",
      "export async function GET() { return Response.json({ ok: true }); }\n");
    const profileRoot = await tempDir("vendo-try-profile-");

    await runDeterministicPass({ repoRoot, profileRoot });

    const tools = toolsFileV3Schema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "tools.json"), "utf8")));
    const destructiveTool = tools.tools.find((tool) => tool.risk === "destructive");
    expect(destructiveTool).toBeDefined();

    const overridesRaw = await readFile(join(profileRoot, ".vendo", "overrides.json"), "utf8").catch(() => null);
    if (overridesRaw !== null) {
      const overrides = JSON.parse(overridesRaw) as { tools: Record<string, { risk?: string }> };
      expect(overrides.tools[destructiveTool!.name]).toBeUndefined();
    }
  });

  it("writes no overrides.json when extraction finds nothing to downgrade", async () => {
    const repoRoot = await tempDir("vendo-try-fixture-empty-");
    await write(repoRoot, "package.json", `${JSON.stringify({ name: "empty-host" }, null, 2)}\n`);
    const profileRoot = await tempDir("vendo-try-profile-");

    await runDeterministicPass({ repoRoot, profileRoot });

    await expect(readFile(join(profileRoot, ".vendo", "overrides.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("runDeterministicPass host .vendo carry-over", () => {
  it("carries the host's OWN policy.json, brief.md, design-rules.md, and theme.json — the host's explicit choice wins over fresh extraction", async () => {
    const repoRoot = await nextFixture();
    const hostPolicy = { format: "vendo/policy@1", rules: [{ match: { risk: "write" as const }, action: "ask" as const }] };
    await write(repoRoot, ".vendo/policy.json", `${JSON.stringify(hostPolicy, null, 2)}\n`);
    await write(repoRoot, ".vendo/brief.md", "Acme is a host-authored product brief.\n");
    await write(repoRoot, ".vendo/design-rules.md", "# House rules\nAlways use the brand accent.\n");
    // A host theme with a DIFFERENT accent than nextFixture's globals.css would
    // extract — proof the carried file wins, not a coincidence of matching.
    await write(repoRoot, ".vendo/theme.json", `${JSON.stringify({
      colors: {
        background: "#000000",
        surface: "#111111",
        text: "#ffffff",
        muted: "#888888",
        accent: "#ff0000",
        accentText: "#ffffff",
        danger: "#ff4444",
        border: "#222222",
      },
      typography: { fontFamily: "Georgia", baseSize: "16px" },
      radius: { small: "2px", medium: "4px", large: "8px" },
      density: "comfortable",
      motion: "full",
    }, null, 2)}\n`);
    const profileRoot = await tempDir("vendo-try-profile-");

    const result = await runDeterministicPass({ repoRoot, profileRoot });

    expect(result.carriedHostInputs).toEqual({ theme: true, brief: true, designRules: true, policy: "carried" });
    expect(JSON.parse(await readFile(join(profileRoot, ".vendo", "policy.json"), "utf8"))).toEqual(hostPolicy);
    expect(await readFile(join(profileRoot, ".vendo", "brief.md"), "utf8")).toBe("Acme is a host-authored product brief.\n");
    expect(await readFile(join(profileRoot, ".vendo", "design-rules.md"), "utf8"))
      .toBe("# House rules\nAlways use the brand accent.\n");
    const theme = vendoThemeSchema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "theme.json"), "utf8")));
    expect(theme.colors.accent).toBe("#ff0000");
    expect(result.theme.status).toBe("written");
  });

  it("falls back to fresh theme extraction when the host's OWN theme.json is malformed — present-but-corrupt is never worse than absent", async () => {
    const repoRoot = await nextFixture();
    // Invalid per vendoThemeSchema (colors is a string, not the required
    // object shape) — a real host artifact that just happens to be broken,
    // not literally-unparseable JSON, to prove the SCHEMA check triggers the
    // fallback too, not merely a JSON.parse failure.
    await write(repoRoot, ".vendo/theme.json", `${JSON.stringify({ colors: "not-an-object" }, null, 2)}\n`);
    const profileRoot = await tempDir("vendo-try-profile-");

    const result = await runDeterministicPass({ repoRoot, profileRoot });

    // The host's theme did NOT win — extraction did, from nextFixture's own
    // globals.css allowlist tokens.
    expect(result.carriedHostInputs.theme).toBe(false);
    expect(result.theme.status).toBe("written");
    expect(result.theme.slotsMatched).toBeGreaterThan(0);
    expect(result.theme.error).toMatch(/colors/);
    const theme = vendoThemeSchema.parse(JSON.parse(await readFile(join(profileRoot, ".vendo", "theme.json"), "utf8")));
    // nextFixture's globals.css accent, not anything from the broken host file.
    expect(theme.colors.accent).toBe("#7c3aed");
  });

  it("writes an honest permissive demo policy.json when the host has none, and leaves brief/design-rules absent", async () => {
    const repoRoot = await nextFixture();
    const profileRoot = await tempDir("vendo-try-profile-");

    const result = await runDeterministicPass({ repoRoot, profileRoot });

    expect(result.carriedHostInputs).toEqual({ theme: false, brief: false, designRules: false, policy: "demo" });
    const policy = JSON.parse(await readFile(join(profileRoot, ".vendo", "policy.json"), "utf8")) as {
      format: string;
      directions?: string[];
      rules?: Array<{ match: Record<string, unknown>; action: string }>;
    };
    expect(policy.format).toBe("vendo/policy@1");
    // Permissive: matches every call and runs it — the SAME behavior an
    // unconfigured guard already falls through to (this only changes the
    // REPORTED posture, never what actually executes).
    expect(policy.rules).toEqual([{ match: {}, action: "run" }]);
    expect(policy.directions?.join(" ")).toContain("vendo try");
    await expect(readFile(join(profileRoot, ".vendo", "brief.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(profileRoot, ".vendo", "design-rules.md"), "utf8")).rejects.toThrow();
  });

  it("stays zero-commit even when carrying over host .vendo inputs", async () => {
    const repoRoot = await nextFixture();
    await write(repoRoot, ".vendo/policy.json", `${JSON.stringify({ format: "vendo/policy@1" }, null, 2)}\n`);
    await write(repoRoot, ".vendo/brief.md", "Host brief.\n");
    const before = await inventory(repoRoot);

    await runDeterministicPass({ repoRoot, profileRoot: await tempDir("vendo-try-profile-") });

    expect(await inventory(repoRoot)).toEqual(before);
  });
});

describe("runDeterministicPass degradation", () => {
  it("still returns a paintable profileRoot for a repo where extraction finds nothing", async () => {
    const repoRoot = await tempDir("vendo-try-empty-");

    const result = await runDeterministicPass({ repoRoot });
    cleanup.push(result.profileRoot);

    // Nothing matched, nothing extracted — and the summary says so.
    expect(result.theme.slotsMatched).toBe(0);
    expect(result.tools.count).toBe(0);
    // The surface still paints: a valid (shallow, all-default) profile assembles.
    const profile = await assembleTryProfile(result.profileRoot);
    expect(profile.depth.level).toBe("shallow");
  });

  it("degrades both extractors to failed — carrying the error — when profileRoot cannot be created", async () => {
    const repoRoot = await nextFixture();
    // A FILE where a directory ancestor must go: outside repoRoot (so the
    // placement guard allows it), but every write under it fails (ENOTDIR).
    const blocker = join(await tempDir("vendo-try-blocker-"), "occupied");
    await writeFile(blocker, "not a directory\n");

    const result = await runDeterministicPass({ repoRoot, profileRoot: join(blocker, "sub") });

    expect(result.theme.status).toBe("failed");
    expect(result.theme.error).toMatch(/ENOTDIR/);
    expect(result.tools.status).toBe("failed");
    expect(result.tools.count).toBe(0);
    expect(result.tools.warnings.join("\n")).toMatch(/ENOTDIR/);
  });
});
