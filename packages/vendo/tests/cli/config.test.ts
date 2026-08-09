import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfig } from "../../src/cli/config.js";
import type { CloudFetcher } from "../../src/cli/cloud/command.js";
import type { Output } from "../../src/cli/shared.js";

// `vendo config` (unified auth): push/pull/status are PROJECT-SCOPED, so they
// authenticate with the single project credential — VENDO_API_KEY — and hit the
// key-authed console plane (project derived from the key), NEVER the user
// session (~/.vendo/cloud-session.json). push writes the key-authed console
// DRAFT (`/api/v1/config/draft`; publish stays a console action); pull defaults
// to the PUBLISHED value (`/api/v1/config`), `--draft` reads the draft plane.

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

const KEY = { VENDO_API_KEY: `vnd_${"a".repeat(40)}` };

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
      env: KEY,
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

  it("reads the published surface with the KEY, never the user session", async () => {
    const dir = await tempProject({ "brief.md": "b" });
    const fetcher: CloudFetcher = vi.fn(async () => PUBLISHED);
    await runConfig(["status"], { targetDir: dir, fetcher, output: capture().output, env: KEY });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/config", expect.objectContaining({ auth: "key" }));
    for (const [, options] of (fetcher as unknown as { mock: { calls: Array<[string, { auth?: string }]> } }).mock.calls) {
      expect(options.auth).not.toBe("user");
    }
  });

  it("prints the overrides enablement note (#557 landed)", async () => {
    const dir = await tempProject();
    const fetcher: CloudFetcher = vi.fn(async () => ({ version: null, config: null }));
    const cap = capture();
    await runConfig(["status"], { targetDir: dir, fetcher, output: cap.output, env: KEY });
    const joined = cap.lines.join("\n");
    expect(joined.toLowerCase()).toContain("enablement");
    expect(joined).toContain("boot-once");
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
  it("merges the one surface into the KEY-authed console draft and PUTs it — no session, no project", async () => {
    const dir = await tempProject({ "design-rules.md": "# local rules" });
    const calls: Array<{ path: string; method: string; body: unknown; auth?: string }> = [];
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body, auth: options?.auth });
      if (path === "/api/v1/config/draft" && (options?.method ?? "GET") === "GET") {
        return { draft: { "brief.md": "keep me" }, draftUpdatedAt: "t", draftUpdatedBy: "u" };
      }
      if (path === "/api/v1/config/draft" && options?.method === "PUT") {
        return { draft: options.body && (options.body as { draft: unknown }).draft, draftUpdatedAt: "t2" };
      }
      throw new Error(`unexpected ${path} ${options?.method}`);
    });
    const confirm = vi.fn(async () => true);
    const cap = capture();
    const code = await runConfig(["push", "design-rules.md"], {
      targetDir: dir,
      fetcher,
      output: cap.output,
      confirm,
      env: KEY,
    });
    expect(code).toBe(0);
    const put = calls.find((c) => c.method === "PUT");
    // The whole draft is replaced, so the surface is MERGED onto the current
    // draft (brief.md preserved), never dropped.
    expect(put?.body).toEqual({ draft: { "brief.md": "keep me", "design-rules.md": "# local rules" } });
    expect(put?.path).toBe("/api/v1/config/draft");
    // Every call authenticated with the KEY, never the user session.
    expect(calls.every((c) => c.auth === "key")).toBe(true);
    // Delete offered and accepted → local file gone (cloud is now the source).
    expect(confirm).toHaveBeenCalled();
    await expect(readFile(join(dir, ".vendo", "design-rules.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("errors with a `vendo login` hint when no key is present, before any network call", async () => {
    const dir = await tempProject({ "design-rules.md": "# local" });
    const fetcher = vi.fn();
    const cap = capture();
    const code = await runConfig(["push", "design-rules.md"], {
      targetDir: dir,
      fetcher: fetcher as unknown as CloudFetcher,
      output: cap.output,
      env: {},
    });
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cap.errors.join("\n")).toMatch(/vendo login/);
    // The local file is untouched — nothing was pushed.
    expect(await readFile(join(dir, ".vendo", "design-rules.md"), "utf8")).toBe("# local");
  });

  it("--yes skips the prompt and deletes the local file", async () => {
    const dir = await tempProject({ "policy.json": "{}" });
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      if ((options?.method ?? "GET") === "GET") return { draft: {} };
      return { draft: (options!.body as { draft: unknown }).draft };
    });
    const confirm = vi.fn(async () => false);
    const code = await runConfig(["push", "policy.json", "--yes"], {
      targetDir: dir,
      fetcher,
      output: capture().output,
      confirm,
      env: KEY,
    });
    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(join(dir, ".vendo", "policy.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the local file when the delete offer is declined", async () => {
    const dir = await tempProject({ "policy.json": "{}" });
    const fetcher: CloudFetcher = vi.fn(async (path, options) =>
      (options?.method ?? "GET") === "GET" ? { draft: {} } : { draft: (options!.body as { draft: unknown }).draft });
    const code = await runConfig(["push", "policy.json"], {
      targetDir: dir,
      fetcher,
      output: capture().output,
      confirm: async () => false,
      env: KEY,
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, ".vendo", "policy.json"), "utf8")).toBe("{}");
  });

  it("prints the enablement note when pushing overrides, but not for other surfaces (#557 landed)", async () => {
    const fetcher: CloudFetcher = vi.fn(async (path, options) =>
      (options?.method ?? "GET") === "GET" ? { draft: {} } : { draft: (options!.body as { draft: unknown }).draft });
    // overrides.json → note present
    const over = capture();
    await runConfig(["push", "overrides.json", "--yes"], {
      targetDir: await tempProject({ "overrides.json": "{}" }),
      fetcher, output: over.output, env: KEY,
    });
    expect(over.lines.join("\n")).toContain("boot-once");
    // design-rules.md → no note
    const rules = capture();
    await runConfig(["push", "design-rules.md", "--yes"], {
      targetDir: await tempProject({ "design-rules.md": "# rules" }),
      fetcher, output: rules.output, env: KEY,
    });
    expect(rules.lines.join("\n")).not.toContain("boot-once");
  });

  it("errors on an unknown surface", async () => {
    const cap = capture();
    const code = await runConfig(["push", "tools.json"], {
      targetDir: await tempProject(),
      fetcher: vi.fn(),
      output: cap.output,
      env: KEY,
    });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toMatch(/unknown surface/i);
  });

  it("errors when the local file is missing", async () => {
    const cap = capture();
    const code = await runConfig(["push", "brief.md"], {
      targetDir: await tempProject(),
      fetcher: vi.fn(),
      output: cap.output,
      env: KEY,
    });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toMatch(/no .*brief\.md|not found|does not exist/i);
  });
});

describe("vendo config pull", () => {
  it("writes the PUBLISHED value to the local .vendo file by default, KEY-authed", async () => {
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
      env: KEY,
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, ".vendo", "design-rules.md"), "utf8")).toBe("# cloud rules");
  });

  it("--draft pulls the KEY-authed console draft plane instead of the published value", async () => {
    const dir = await tempProject();
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      expect(path).toBe("/api/v1/config/draft");
      expect(options?.auth).toBe("key");
      return { draft: { "brief.md": "draft brief" } };
    });
    const code = await runConfig(["pull", "brief.md", "--draft"], {
      targetDir: dir,
      fetcher,
      output: capture().output,
      env: KEY,
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, ".vendo", "brief.md"), "utf8")).toBe("draft brief");
  });

  it("errors with a `vendo login` hint when no key is present, before any network call", async () => {
    const fetcher = vi.fn();
    const cap = capture();
    const code = await runConfig(["pull", "design-rules.md"], {
      targetDir: await tempProject(),
      fetcher: fetcher as unknown as CloudFetcher,
      output: cap.output,
      env: {},
    });
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cap.errors.join("\n")).toMatch(/vendo login/);
  });

  it("errors when the surface is not present in the published config", async () => {
    const cap = capture();
    const code = await runConfig(["pull", "overrides.json"], {
      targetDir: await tempProject(),
      fetcher: vi.fn(async () => PUBLISHED),
      output: cap.output,
      env: KEY,
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
      env: KEY,
    });
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cap.errors.join("\n")).toMatch(/unknown surface/i);
  });
});

// `vendo login` writes VENDO_API_KEY to .env.local, so the config commands must
// load .env (then .env.local, local wins) from the project dir before resolving
// the key — matching how init/the runtime source credentials. Precedence: an
// already-set process env VENDO_API_KEY wins; an unset one falls back to
// .env.local. Without this a fresh shell after `vendo login` would fail the
// guard until the user manually `source`d the file (the decoupling the live
// e2e caught).
describe("vendo config key resolution (.env.local)", () => {
  const FILE_KEY = `vnd_${"f".repeat(40)}`;

  it("push resolves VENDO_API_KEY from .env.local when the process env has none", async () => {
    const dir = await tempProject({ "design-rules.md": "# local" });
    await writeFile(join(dir, ".env.local"), `VENDO_API_KEY=${FILE_KEY}\n`, "utf8");
    const seen: Array<{ auth?: string; env?: Record<string, string | undefined> }> = [];
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      seen.push({ auth: options?.auth, env: options?.env });
      if (path === "/api/v1/config/draft" && (options?.method ?? "GET") === "GET") return { draft: {} };
      return { draft: (options!.body as { draft: unknown }).draft };
    });
    const code = await runConfig(["push", "design-rules.md"], {
      targetDir: dir, fetcher, output: capture().output, confirm: async () => false, env: {},
    });
    expect(code).toBe(0);
    // The .env.local key reached the fetcher (the server reads env.VENDO_API_KEY).
    expect(seen[0]?.auth).toBe("key");
    expect(seen[0]?.env?.VENDO_API_KEY).toBe(FILE_KEY);
  });

  it("pull resolves VENDO_API_KEY from .env.local when the process env has none", async () => {
    const dir = await tempProject();
    await writeFile(join(dir, ".env.local"), `VENDO_API_KEY=${FILE_KEY}\n`, "utf8");
    const fetcher: CloudFetcher = vi.fn(async (path, options) => {
      expect(options?.auth).toBe("key");
      expect(options?.env?.VENDO_API_KEY).toBe(FILE_KEY);
      return PUBLISHED;
    });
    const code = await runConfig(["pull", "design-rules.md"], {
      targetDir: dir, fetcher, output: capture().output, env: {},
    });
    expect(code).toBe(0);
    expect(await readFile(join(dir, ".vendo", "design-rules.md"), "utf8")).toBe("# cloud rules");
  });

  it("a set process env VENDO_API_KEY wins over .env.local (env wins, like the runtime)", async () => {
    const dir = await tempProject();
    await writeFile(join(dir, ".env.local"), `VENDO_API_KEY=${FILE_KEY}\n`, "utf8");
    const envKey = `vnd_${"e".repeat(40)}`;
    let seenEnvKey: string | undefined;
    const fetcher: CloudFetcher = vi.fn(async (_path, options) => {
      seenEnvKey = options?.env?.VENDO_API_KEY;
      return PUBLISHED;
    });
    await runConfig(["pull", "design-rules.md"], {
      targetDir: dir, fetcher, output: capture().output, env: { VENDO_API_KEY: envKey },
    });
    expect(seenEnvKey).toBe(envKey);
  });

  it("still fires the `vendo login` guard when neither env nor .env.local carries a key", async () => {
    const dir = await tempProject({ "design-rules.md": "# local" });
    await writeFile(join(dir, ".env.local"), "FOO=bar\n", "utf8"); // present but no key
    const fetcher = vi.fn();
    const cap = capture();
    const code = await runConfig(["push", "design-rules.md"], {
      targetDir: dir, fetcher: fetcher as unknown as CloudFetcher, output: cap.output, env: {},
    });
    expect(code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cap.errors.join("\n")).toMatch(/vendo login/);
  });
});

// A bare `--key X` (and --api-url) must never have its VALUE read as the
// surface or the target dir, in EITHER order (Devin/Greptile P2 — same class as
// cli.ts's --engine target() fix). These exercise the positional path (no
// options.targetDir), so the dir comes from the args.
describe("vendo config positional parsing (value-flag orderings)", () => {
  function pushFetcher(calls: Array<{ path: string; method: string; body: unknown }>): CloudFetcher {
    return vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body });
      if (path === "/api/v1/config/draft" && (options?.method ?? "GET") === "GET") return { draft: {} };
      if (path === "/api/v1/config/draft" && options?.method === "PUT") {
        return { draft: (options.body as { draft: unknown }).draft };
      }
      throw new Error(`unexpected ${path} ${options?.method}`);
    }) as unknown as CloudFetcher;
  }

  it("push resolves surface+dir with the value-flag BEFORE the surface", async () => {
    const dir = await tempProject({ "design-rules.md": "# local" });
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const cap = capture();
    const code = await runConfig(["push", "--key", KEY.VENDO_API_KEY, "design-rules.md", dir], {
      fetcher: pushFetcher(calls),
      output: cap.output,
      confirm: async () => false, // keep the local file
      env: {},
    });
    expect(code).toBe(0);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/api/v1/config/draft");
    expect(put?.body).toEqual({ draft: { "design-rules.md": "# local" } });
  });

  it("push resolves surface+dir with the value-flag AFTER the surface and dir", async () => {
    const dir = await tempProject({ "design-rules.md": "# local" });
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const cap = capture();
    const code = await runConfig(["push", "design-rules.md", dir, "--key", KEY.VENDO_API_KEY], {
      fetcher: pushFetcher(calls),
      output: cap.output,
      confirm: async () => false,
      env: {},
    });
    expect(code).toBe(0);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/api/v1/config/draft");
    expect(put?.body).toEqual({ draft: { "design-rules.md": "# local" } });
  });

  it("push still reports an unknown surface when a value-flag precedes it", async () => {
    const cap = capture();
    const code = await runConfig(["push", "--key", KEY.VENDO_API_KEY, "not-a-surface"], {
      fetcher: vi.fn(async () => {
        throw new Error("must not fetch");
      }) as unknown as CloudFetcher,
      output: cap.output,
      env: {},
    });
    expect(code).toBe(1);
    expect(cap.errors.join("\n")).toMatch(/unknown surface/i);
  });

  it("status resolves its dir positional in either order, never reading the --key value as the dir", async () => {
    const dir = await tempProject({ "brief.md": "on disk" });
    for (const args of [
      ["status", "--key", KEY.VENDO_API_KEY, dir],
      ["status", dir, "--key", KEY.VENDO_API_KEY],
    ]) {
      const cap = capture();
      const code = await runConfig(args, {
        fetcher: vi.fn(async () => ({ version: null, config: null })) as unknown as CloudFetcher,
        output: cap.output,
        env: {},
      });
      expect(code).toBe(0);
      // brief.md is on disk in `dir` → "file". Had the dir resolved to the key
      // value or cwd, this would read "unset".
      expect(cap.lines.join("\n")).toMatch(/brief\.md\s+file/);
    }
  });
});
