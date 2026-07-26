import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfig } from "./config.js";
import type { CloudFetcher } from "./cloud/command.js";
import type { Output } from "./shared.js";

// `vendo config` (cse lane 3): push/pull a `.vendo` content surface to/from the
// hosted console, and report each surface's resolved OWNER. push writes the
// console DRAFT (publish stays a console action); pull defaults to the PUBLISHED
// value (--draft pulls the draft). Wire shapes mirror the config-wire fixtures.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vendo-config-"));
  dirs.push(dir);
  await mkdir(join(dir, ".vendo"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, ".vendo", name), body, "utf8");
  }
  return dir;
}

function capture(): { output: Output; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m) => lines.push(m), error: (m) => errors.push(m) }, lines, errors };
}

const PUBLISHED = {
  version: "rel_1",
  config: {
    "design-rules.md": "# cloud rules",
    "theme.json": '{"accent":"#5B21B6"}',
  },
};

describe("vendo config status", () => {
  it("reports each surface as file / cloud / unset and notes explicit is not CLI-visible", async () => {
    const dir = await tempProject({ "brief.md": "on-disk brief" });
    const fetcher: CloudFetcher = vi.fn(async (path) => {
      if (path === "/api/v1/config") return PUBLISHED;
      throw new Error(`unexpected ${path}`);
    });
    const cap = capture();
    const code = await runConfig(["status"], {
      targetDir: dir,
      fetcher,
      output: cap.output,
      env: { VENDO_API_KEY: "vnd_key" },
    });
    expect(code).toBe(0);
    const joined = cap.lines.join("\n");
    // brief lives on disk → file; design-rules only in cloud → cloud;
    // policy/overrides nowhere → unset; theme in cloud → cloud.
    expect(joined).toMatch(/brief\.md\s+file/);
    expect(joined).toMatch(/design-rules\.md\s+cloud/);
    expect(joined).toMatch(/theme\.json\s+cloud/);
    expect(joined).toMatch(/policy\.json\s+unset/);
    expect(joined).toMatch(/overrides\.json\s+unset/);
    expect(joined.toLowerCase()).toContain("explicit");
  });

  it("prints the overrides enablement caveat (#557)", async () => {
    const dir = await tempProject();
    const fetcher: CloudFetcher = vi.fn(async () => ({ version: null, config: null }));
    const cap = capture();
    await runConfig(["status"], { targetDir: dir, fetcher, output: cap.output, env: { VENDO_API_KEY: "vnd_key" } });
    const joined = cap.lines.join("\n");
    expect(joined).toContain("#557");
    expect(joined.toLowerCase()).toContain("enablement");
  });

  it("still reports file ownership when there is no key (cloud column unknown)", async () => {
    const dir = await tempProject({ "brief.md": "b" });
    const fetcher: CloudFetcher = vi.fn(async () => {
      throw Object.assign(new Error("Pass --key or set VENDO_API_KEY"), { code: "missing-api-key" });
    });
    const cap = capture();
    const code = await runConfig(["status"], { targetDir: dir, fetcher, output: cap.output, env: {} });
    expect(code).toBe(0);
    const joined = cap.lines.join("\n");
    expect(joined).toMatch(/brief\.md\s+file/);
    // no key → cloud presence is unknown, not "unset"
    expect(joined).toMatch(/design-rules\.md\s+(unknown|file)/);
  });
});

describe("vendo config push", () => {
  it("merges the one surface into the console draft, PUTs it, and offers to delete the local file", async () => {
    const dir = await tempProject({ "design-rules.md": "# local rules" });
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body });
      if (path.endsWith("/config") && (options?.method ?? "GET") === "GET") {
        return { draft: { "brief.md": "keep me" }, draftUpdatedAt: "t", draftUpdatedBy: "u" };
      }
      if (path.endsWith("/config") && options?.method === "PUT") {
        return { draft: options.body && (options.body as { draft: unknown }).draft, draftUpdatedAt: "t2", draftUpdatedBy: "u" };
      }
      throw new Error(`unexpected ${path} ${options?.method}`);
    });
    const confirm = vi.fn(async () => true);
    const cap = capture();
    const code = await runConfig(["push", "design-rules.md", "--project", "proj_1"], {
      targetDir: dir,
      fetcher,
      output: cap.output,
      confirm,
      env: {},
    });
    expect(code).toBe(0);
    const put = calls.find((c) => c.method === "PUT");
    // The whole draft is replaced, so the surface is MERGED onto the current
    // draft (brief.md preserved), never dropped.
    expect(put?.body).toEqual({ draft: { "brief.md": "keep me", "design-rules.md": "# local rules" } });
    expect(put?.path).toBe("/api/v1/projects/proj_1/config");
    // Delete offered and accepted → local file gone (cloud is now the source).
    expect(confirm).toHaveBeenCalled();
    await expect(readFile(join(dir, ".vendo", "design-rules.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--yes skips the prompt and deletes the local file", async () => {
    const dir = await tempProject({ "policy.json": "{}" });
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      if ((options?.method ?? "GET") === "GET") return { draft: {} };
      return { draft: (options!.body as { draft: unknown }).draft };
    });
    const confirm = vi.fn(async () => false);
    const code = await runConfig(["push", "policy.json", "--project", "p", "--yes"], {
      targetDir: dir,
      fetcher,
      output: capture().output,
      confirm,
      env: {},
    });
    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(join(dir, ".vendo", "policy.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the local file when the delete offer is declined", async () => {
    const dir = await tempProject({ "policy.json": "{}" });
    const fetcher: CloudFetcher = vi.fn(async (path, options) =>
      (options?.method ?? "GET") === "GET" ? { draft: {} } : { draft: (options!.body as { draft: unknown }).draft });
    const code = await runConfig(["push", "policy.json", "--project", "p"], {
      targetDir: dir,
      fetcher,
      output: capture().output,
      confirm: async () => false,
      env: {},
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, ".vendo", "policy.json"), "utf8")).toBe("{}");
  });

  it("prints the enablement caveat when pushing overrides, but not for other surfaces (#557)", async () => {
    const fetcher: CloudFetcher = vi.fn(async (path, options) =>
      (options?.method ?? "GET") === "GET" ? { draft: {} } : { draft: (options!.body as { draft: unknown }).draft });
    // overrides.json → caveat present
    const over = capture();
    await runConfig(["push", "overrides.json", "--project", "p", "--yes"], {
      targetDir: await tempProject({ "overrides.json": "{}" }),
      fetcher, output: over.output, env: {},
    });
    expect(over.lines.join("\n")).toContain("#557");
    // design-rules.md → no caveat
    const rules = capture();
    await runConfig(["push", "design-rules.md", "--project", "p", "--yes"], {
      targetDir: await tempProject({ "design-rules.md": "# rules" }),
      fetcher, output: rules.output, env: {},
    });
    expect(rules.lines.join("\n")).not.toContain("#557");
  });

  it("errors on an unknown surface", async () => {
    const cap = capture();
    const code = await runConfig(["push", "tools.json", "--project", "p"], {
      targetDir: await tempProject(),
      fetcher: vi.fn(),
      output: cap.output,
      env: {},
    });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toMatch(/unknown surface/i);
  });

  it("errors when the local file is missing", async () => {
    const cap = capture();
    const code = await runConfig(["push", "brief.md", "--project", "p"], {
      targetDir: await tempProject(),
      fetcher: vi.fn(),
      output: cap.output,
      env: {},
    });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toMatch(/no .*brief\.md|not found|does not exist/i);
  });
});

describe("vendo config pull", () => {
  it("writes the PUBLISHED value to the local .vendo file by default", async () => {
    const dir = await tempProject();
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      expect(path).toBe("/api/v1/config");
      expect(options?.auth).toBe("key");
      return PUBLISHED;
    });
    const code = await runConfig(["pull", "design-rules.md"], {
      targetDir: dir,
      fetcher,
      output: capture().output,
      env: { VENDO_API_KEY: "vnd_key" },
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, ".vendo", "design-rules.md"), "utf8")).toBe("# cloud rules");
  });

  it("--draft pulls the console draft instead of the published value", async () => {
    const dir = await tempProject();
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      expect(path).toBe("/api/v1/projects/proj_1/config");
      expect(options?.auth).toBe("user");
      return { draft: { "brief.md": "draft brief" } };
    });
    const code = await runConfig(["pull", "brief.md", "--draft", "--project", "proj_1"], {
      targetDir: dir,
      fetcher,
      output: capture().output,
      env: {},
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, ".vendo", "brief.md"), "utf8")).toBe("draft brief");
  });

  it("errors when the surface is not present in the published config", async () => {
    const cap = capture();
    const code = await runConfig(["pull", "overrides.json"], {
      targetDir: await tempProject(),
      fetcher: vi.fn(async () => PUBLISHED),
      output: cap.output,
      env: { VENDO_API_KEY: "vnd_key" },
    });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toMatch(/not (present|published)|no .*overrides/i);
  });

  it("errors on an unknown surface before any network call", async () => {
    const fetcher = vi.fn();
    const cap = capture();
    const code = await runConfig(["pull", "secrets.json"], {
      targetDir: await tempProject(),
      fetcher: fetcher as unknown as CloudFetcher,
      output: cap.output,
      env: {},
    });
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cap.errors.join("\n")).toMatch(/unknown surface/i);
  });
});

// A bare `--project X` (and --org/--key/--api-url) must never have its VALUE
// read as the surface or the target dir, in EITHER order (Devin/Greptile P2 —
// same class as cli.ts's --engine target() fix). These exercise the positional
// path (no options.targetDir), so the dir comes from the args.
describe("vendo config positional parsing (value-flag orderings)", () => {
  function pushFetcher(calls: Array<{ path: string; method: string; body: unknown }>): CloudFetcher {
    return vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body });
      if (path.endsWith("/config") && (options?.method ?? "GET") === "GET") return { draft: {} };
      if (path.endsWith("/config") && options?.method === "PUT") {
        return { draft: (options.body as { draft: unknown }).draft };
      }
      throw new Error(`unexpected ${path} ${options?.method}`);
    }) as unknown as CloudFetcher;
  }

  it("push resolves surface+dir with the value-flag BEFORE the surface", async () => {
    const dir = await tempProject({ "design-rules.md": "# local" });
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const cap = capture();
    const code = await runConfig(["push", "--project", "proj_1", "design-rules.md", dir], {
      fetcher: pushFetcher(calls),
      output: cap.output,
      confirm: async () => false, // keep the local file
      env: {},
    });
    expect(code).toBe(0);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/api/v1/projects/proj_1/config");
    expect(put?.body).toEqual({ draft: { "design-rules.md": "# local" } });
  });

  it("push resolves surface+dir with the value-flag AFTER the surface and dir", async () => {
    const dir = await tempProject({ "design-rules.md": "# local" });
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const cap = capture();
    const code = await runConfig(["push", "design-rules.md", dir, "--project", "proj_1"], {
      fetcher: pushFetcher(calls),
      output: cap.output,
      confirm: async () => false,
      env: {},
    });
    expect(code).toBe(0);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/api/v1/projects/proj_1/config");
    expect(put?.body).toEqual({ draft: { "design-rules.md": "# local" } });
  });

  it("push still reports an unknown surface when a value-flag precedes it", async () => {
    const cap = capture();
    const code = await runConfig(["push", "--project", "proj_1", "not-a-surface"], {
      fetcher: vi.fn(async () => {
        throw new Error("must not fetch");
      }) as unknown as CloudFetcher,
      output: cap.output,
      env: {},
    });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toMatch(/unknown surface/i);
  });

  it("status resolves its dir positional in either order, never reading the --project value as the dir", async () => {
    const dir = await tempProject({ "brief.md": "on disk" });
    for (const args of [
      ["status", "--project", "X", dir],
      ["status", dir, "--project", "X"],
    ]) {
      const cap = capture();
      const code = await runConfig(args, {
        fetcher: vi.fn(async () => ({ version: null, config: null })) as unknown as CloudFetcher,
        output: cap.output,
        env: { VENDO_API_KEY: "vnd_key" },
      });
      expect(code).toBe(0);
      // brief.md is on disk in `dir` → "file". Had the dir resolved to "X" or
      // cwd, this would read "unset".
      expect(cap.lines.join("\n")).toMatch(/brief\.md\s+file/);
    }
  });
});
