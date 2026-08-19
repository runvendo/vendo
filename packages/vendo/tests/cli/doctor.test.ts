import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractServerActions } from "@vendoai/actions/sync";
import { afterEach, describe, expect, it } from "vitest";
import { doctorErrorCodes, doctorFixRef } from "../../src/cli/doctor-codes.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { CLI_VERSION } from "../../src/cli/shared.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

/** A resolved model credential, pinned. Every fixture below is about WIRING,
 *  and a host with no model now carries a visible E-MODEL-001 warning — which
 *  would otherwise land in each of those suites' `errors` as noise. The
 *  credential tests pass their own `env` and override this. */
const MODEL_PINNED = { VENDO_DEV_CREDENTIAL: "env-key:anthropic", ANTHROPIC_API_KEY: "sk-test" };

/** Doctor is static: the only seam the suite holds is the environment, which
 *  it pins so no stray .env file or shell variable decides a check. */
async function doctor(options: Parameters<typeof runDoctor>[0]): Promise<number> {
  return runDoctor({ env: MODEL_PINNED, ...options });
}

async function healthy(base?: string): Promise<string> {
  // A caller-supplied base nests the fixture (e.g. inside a workspace dir the
  // caller creates and cleans up); the default is a standalone temp root.
  const root = base ?? (await mkdtemp(join(tmpdir(), "vendo-doctor-")));
  if (base === undefined) cleanup.push(() => rm(root, { recursive: true, force: true }));
  else await mkdir(root, { recursive: true });
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({ dependencies: { "@vendoai/vendo": "0.3.0", next: "16" } }));
  await write("next.config.ts", 'export default { serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"] };\n');
  await write("app/layout.tsx", "export default ({children}) => <VendoProvider>{children}<VendoOverlay /></VendoProvider>;");
  await write("app/api/vendo/[...vendo]/route.ts", "export const GET = () => {};\n");
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

/** A package the host can RESOLVE — the evidence the resolvability check reads
    (#1153), which package.json cannot supply: a nested dependency is declared
    by nobody the host imports from. */
async function installedPackage(root: string, name: string): Promise<void> {
  const dir = join(root, "node_modules", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: CLI_VERSION }));
}

async function expressHost(wired: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-express-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({
    dependencies: { "@vendoai/vendo": "0.3.0", express: "5.0.0" },
  }));
  if (wired) {
    await write("src/server.ts", 'import { createVendo } from "@vendoai/vendo/server";\ncreateVendo({ models: { default: model }, principal });\n');
    await write("src/client.tsx", "export const App = () => <VendoProvider><main /><VendoOverlay /></VendoProvider>;\n");
  } else {
    await write("src/notes.ts", "/* TODO: import createVendo from @vendoai/vendo/server and render <VendoRoot> */\n");
  }
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

/** A host doctor cannot pattern-match: no next, no express (Cloudflare
 *  Worker + Vite was the field case — E-WIRE-003/004 false positives). */
async function customHost(wired: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-doctor-custom-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, body: string): Promise<void> => {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body);
  };
  await write("package.json", JSON.stringify({
    dependencies: { "@vendoai/vendo": "0.3.0", vite: "6.0.0" },
  }));
  if (wired) {
    await write("src/worker.ts", 'import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ models: { default: model }, principal });\n');
    await write("src/app.tsx", "export const App = () => <VendoProvider><main /><VendoOverlay /></VendoProvider>;\n");
  } else {
    await write("src/worker.ts", "export default { fetch: () => new Response('ok') };\n");
  }
  for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) await write(`.vendo/${file}`, "{}\n");
  await write(".vendo/data/.gitignore", "*\n");
  return root;
}

interface CodedCheck {
  id: string;
  status: string;
  message: string;
  error_code?: string;
  fix_ref?: string;
}

/** The machine surface, parsed: --json prints exactly one object. */
async function jsonChecks(options: Parameters<typeof runDoctor>[0]): Promise<{ exit: number; report: { exit: number; wired: boolean; checks: CodedCheck[] } }> {
  const logs: string[] = [];
  const exit = await doctor({
    json: true,
    output: { log: (m) => logs.push(m), error: () => {} },
    telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    ...options,
  });
  return { exit, report: JSON.parse(logs[0]!) as { exit: number; wired: boolean; checks: CodedCheck[] } };
}

function output(): { logs: string[]; errors: string[]; sink: { log(message: string): void; error(message: string): void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    sink: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  };
}

describe("vendo doctor", () => {
  it("checks Express server and client wiring instead of Next files", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await expressHost(true),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
    expect(messages.logs).toContain("ok: Express server is wired");
    expect(messages.logs).toContain("ok: <VendoProvider> wraps the client");
    expect(messages.logs.join("\n")).not.toContain("catch-all handler");
  });

  it("returns one when an Express host is missing server and client wiring", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await expressHost(false),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors).toEqual(expect.arrayContaining([
      "broken: Express server is not wired with createVendo from @vendoai/vendo/server",
      "broken: Express client is not wrapped in <VendoProvider>",
    ]));
  });

  it("judges an unknown-framework host by its wiring, not Next's file layout", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await customHost(true),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
    const log = messages.logs.join("\n");
    expect(log).not.toContain("catch-all handler");
    expect(log).toContain("ok: createVendo server wiring found");
  });

  it("an unknown-framework host with no createVendo anywhere fails the generic wiring check", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await customHost(false),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toContain("no createVendo server wiring found");
    expect(messages.errors.join("\n")).not.toContain("app/api/vendo/[...vendo]/route.ts");
  });

  it("fails when the extracted tool surface has zero live tools (the agent cannot act on the host)", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_internal_hook", description: "d", inputSchema: { type: "object" }, risk: "write", disabled: true,
        binding: { kind: "route", method: "POST", path: "/api/hook", argsIn: "body" },
      }],
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toMatch(/zero live host tools/i);
  });

  it("warns (does not fail) when extraction produced zero tools — connector-only hosts are legitimate", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: "vendo/tools@3", tools: [] }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors.join("\n")).toMatch(/tool surface is empty/i);
  });

  it("a live tool surface passes the zero-live-tools check", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
  });

  it("grades the live-surface check through an overrides.json disable too", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
        srcHash: "sha256:abc",
      }],
    }));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_invoices_list: { disabled: true } },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toMatch(/zero live host tools/i);
  });

  it("grades the live-surface check through a judgments.json disable — the layer runtime applies", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    await writeFile(join(root, ".vendo", "judgments.json"), JSON.stringify({
      format: "vendo/judgments@1",
      tools: {
        host_invoices_list: {
          binding: "GET /api/invoices",
          fields: { disabled: true },
          evidence: "the handler requires an admin session",
        },
      },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(messages.errors.join("\n")).toMatch(/zero live host tools/i);
  });

  it("a human overrides.json wake beats a judgments.json disable in the live-surface count", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    await writeFile(join(root, ".vendo", "judgments.json"), JSON.stringify({
      format: "vendo/judgments@1",
      tools: {
        host_invoices_list: {
          binding: "GET /api/invoices",
          fields: { disabled: true },
          evidence: "the handler requires an admin session",
        },
      },
    }));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_invoices_list: { disabled: false } },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
  });

  it("ignores a judgments.json entry whose binding moved (an inert judgment never disables)", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "read",
        // A synced host: both slots carry a source marker, so the coverage
        // check (E-TOOLS-004) has nothing to report about this catalog.
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    await writeFile(join(root, ".vendo", "judgments.json"), JSON.stringify({
      format: "vendo/judgments@1",
      tools: {
        host_invoices_list: {
          binding: "GET /api/old-invoices",
          fields: { disabled: true },
          evidence: "stale — the handler moved",
        },
      },
    }));
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors).toEqual([]);
  });

  it("returns one for broken wiring", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-broken-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const messages = output();
    expect(await doctor({ targetDir: root, output: messages.sink })).toBe(1);
    expect(messages.errors.join("\n")).toContain("no createVendo server wiring found");
  });
});

/**
 * The install's own answer to "how will people reach the agent?", which init
 * records in `.vendo/install.json`. An agent-loop or MCP install mounts no
 * Vendo UI by design, so E-WIRE-004 and E-WIRE-006 failed a host that was
 * correct by construction — doctor could not be a gate for either path.
 */
describe("vendo doctor reads the recorded use case", () => {
  /** A host with the wire route and NO client mount at all. */
  async function uiLess(useCase?: string): Promise<string> {
    const root = await healthy();
    await writeFile(join(root, "app", "layout.tsx"), "export default ({children}) => <html>{children}</html>;");
    if (useCase !== undefined) {
      await writeFile(join(root, ".vendo", "install.json"), JSON.stringify({ format: "vendo/install@1", useCase }));
    }
    return root;
  }

  it.each(["agent-loop", "mcp"])("skips the mounted-UI checks for a %s install and says why", async (useCase) => {
    const { exit, report } = await jsonChecks({ targetDir: await uiLess(useCase) });
    expect(exit).toBe(0);
    expect(report.checks.map((check) => check.error_code)).not.toContain("E-WIRE-004");
    expect(report.checks.map((check) => check.error_code)).not.toContain("E-WIRE-006");
    // The skip is stated, not silent — an absent check with no explanation is
    // indistinguishable from a check that never ran.
    expect(report.checks.find((check) => check.id === "wiring/use-case"))
      .toMatchObject({ status: "ok", message: expect.stringContaining(`use case ${useCase}`) });
    // Everything that is NOT about a mounted surface still runs.
    expect(report.checks.find((check) => check.id === "wiring/next-route")).toMatchObject({ status: "ok" });
  });

  it("keeps failing an embedded install, and an install that recorded nothing at all", async () => {
    for (const root of [await uiLess("embedded"), await uiLess()]) {
      const { exit, report } = await jsonChecks({ targetDir: root });
      expect(exit).toBe(1);
      expect(report.checks.map((check) => check.error_code)).toEqual(
        expect.arrayContaining(["E-WIRE-004", "E-WIRE-006"]),
      );
      expect(report.checks.find((check) => check.id === "wiring/use-case")).toBeUndefined();
    }
  });

  it("skips the client half on Express and unknown-framework hosts too", async () => {
    for (const host of [await expressHost(false), await customHost(false)]) {
      await writeFile(join(host, ".vendo", "install.json"), JSON.stringify({ format: "vendo/install@1", useCase: "agent-loop" }));
      const { report } = await jsonChecks({ targetDir: host });
      const codes = report.checks.map((check) => check.error_code);
      expect(codes).not.toContain("E-WIRE-002");
      expect(codes).not.toContain("E-WIRE-008");
      expect(codes).not.toContain("E-WIRE-006");
    }
  });

  it("ignores a malformed or unknown recorded value rather than trusting it", async () => {
    const root = await uiLess("who-knows");
    expect((await jsonChecks({ targetDir: root })).exit).toBe(1);
    await writeFile(join(root, ".vendo", "install.json"), "{ not json");
    expect((await jsonChecks({ targetDir: root })).exit).toBe(1);
  });
});

describe("vendo doctor (model credentials + --json + cloud)", () => {
  it("states the winning model credential rung and any active VENDO_MODEL_* pins — nothing more", async () => {
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      env: {
        // The rung doctor reports is the one the RUNTIME would ride. Since the
        // selection law a bare provider key rides nothing (asserted below), so a
        // host on the env-key rung got there through the internal pin.
        VENDO_DEV_CREDENTIAL: "env-key:anthropic",
        ANTHROPIC_API_KEY: "sk-test",
        VENDO_MODEL: "claude-opus-4-8",
        VENDO_MODEL_REVIEW: "claude-haiku-4-5",
      },
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain("ok: model credential: explicit ANTHROPIC_API_KEY (anthropic)");
    expect(messages.logs).toContain("ok: model pins: VENDO_MODEL=claude-opus-4-8, VENDO_MODEL_REVIEW=claude-haiku-4-5");

    // No pins → no pins line (and never a role/alias table: the client cannot
    // know the gateway's server-side alias mappings).
    const bare = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      env: { VENDO_DEV_CREDENTIAL: "env-key:anthropic", ANTHROPIC_API_KEY: "sk-test" },
      output: bare.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(bare.logs.some((line) => line.includes("model pins:"))).toBe(false);
    expect(bare.logs).toContain("ok: model credential: explicit ANTHROPIC_API_KEY (anthropic)");
  });

  it("reports NO winning credential for a bare provider key — as a VISIBLE warning that still exits 0", async () => {
    // The selection law's honesty requirement: doctor reads the same resolver the
    // runtime rides, so a host whose only key is ANTHROPIC_API_KEY must be told it
    // has no model — not blessed with "ok: model credential". Blessing it is how a
    // certified-healthy composition failed its first turn.
    //
    // It rides `warn`, not `note`: notes are suppressed under --json, so the one
    // agent-facing surface saw a green report on a host that could answer
    // nothing. Still exit 0 — production keys legitimately live where doctor
    // cannot read them.
    const messages = output();
    expect(await runDoctor({
      targetDir: await healthy(),
      env: { ANTHROPIC_API_KEY: "sk-test" },
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.errors.join("\n")).toContain("warning: model credential: none found");
    expect(messages.logs.some((line) => line.startsWith("ok: model credential:"))).toBe(false);

    // …and the machine surface carries the code and its fix_ref.
    const logs: string[] = [];
    expect(await runDoctor({
      targetDir: await healthy(),
      env: { ANTHROPIC_API_KEY: "sk-test" },
      json: true,
      output: { log: (m) => logs.push(m), error: () => {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    const report = JSON.parse(logs[0]!) as { exit: number; wired: boolean; checks: Array<{ id: string; status: string; error_code?: string; fix_ref?: string }> };
    const credential = report.checks.find((check) => check.id === "model/credential");
    expect(credential).toMatchObject({ status: "warning", error_code: "E-MODEL-001", fix_ref: doctorFixRef("E-MODEL-001") });
    expect(report.wired).toBe(true);
    expect(report.exit).toBe(0);
  });

  it("emits one machine-readable JSON object a script can consume", async () => {
    const logs: string[] = [];
    const exit = await doctor({
      targetDir: await healthy(),
      json: true,
      output: { log: (m) => logs.push(m), error: () => {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    // --json prints exactly one object to stdout and nothing else.
    expect(logs).toHaveLength(1);
    const report = JSON.parse(logs[0]!) as {
      vendo: string; wired: boolean; exit: number;
      checks: Array<{ status: string; message: string }>;
      cloud: { present: boolean };
      summary: { failures: number; warnings: number };
    };
    expect(report.vendo).toBe("doctor");
    expect(report.exit).toBe(exit);
    expect(report.wired).toBe(true);
    expect(report.cloud.present).toBe(false);
    expect(report.checks.some((c) => c.status === "ok")).toBe(true);
    expect(report.summary.failures).toBe(0);
  });

  it("reports exit 1 in --json when wiring is broken", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-json-broken-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const logs: string[] = [];
    const exit = await doctor({
      targetDir: root,
      json: true,
      output: { log: (m) => logs.push(m), error: () => {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    const report = JSON.parse(logs[0]!) as { exit: number; wired: boolean };
    expect(exit).toBe(1);
    expect(report.exit).toBe(1);
    expect(report.wired).toBe(false);
  });

  it("reports a present, well-formed VENDO_API_KEY", async () => {
    const messages = output();
    expect(await doctor({
      targetDir: await healthy(),
      env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}` },
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(messages.logs).toContain("ok: Vendo Cloud key present and well-formed");
  });

  it("warns when VENDO_API_KEY is present but invalid", async () => {
    const messages = output();
    await doctor({
      targetDir: await healthy(),
      env: { VENDO_API_KEY: "vnd_nope" },
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(messages.errors).toContain(
      "warning: VENDO_API_KEY is set but not usable: VENDO_API_KEY is malformed (expected vnd_ + 40 hex chars)",
    );
  });

  it("prints what Cloud unlocks when no key is set", async () => {
    const messages = output();
    await doctor({
      targetDir: await healthy(),
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(messages.logs.some((l) => l.includes("A key unlocks a free starter model allowance"))).toBe(true);
  });

  // §4 customization ladder — ejected chrome is the host's code; doctor only
  // raises awareness when it predates the installed @vendoai/ui. Warn, never fail.
  it("warns — never fails — when an ejected surface predates the installed @vendoai/ui", async () => {
    const root = await healthy();
    await mkdir(join(root, "components", "vendo", "thread"), { recursive: true });
    await writeFile(
      join(root, "components", "vendo", "thread", ".vendo-eject.json"),
      JSON.stringify({ surface: "thread", package: "@vendoai/ui", version: "0.2.0" }),
    );
    await mkdir(join(root, "node_modules", "@vendoai", "ui"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "@vendoai", "ui", "package.json"),
      JSON.stringify({ name: "@vendoai/ui", version: "0.3.0" }),
    );
    const messages = output();
    const code = await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(code).toBe(0);
    const warning = messages.errors.find((line) => line.includes("ejected thread"));
    expect(warning).toBeDefined();
    expect(warning).toContain("v0.2.0");
    expect(warning).toContain("v0.3.0");
    expect(warning).toContain("changelog");
    expect(warning).toContain("warning");
  });

  it("skips the drift check quietly when the installed @vendoai/ui package.json is malformed", async () => {
    const root = await healthy();
    await mkdir(join(root, "components", "vendo", "thread"), { recursive: true });
    await writeFile(
      join(root, "components", "vendo", "thread", ".vendo-eject.json"),
      JSON.stringify({ surface: "thread", package: "@vendoai/ui", version: "0.2.0" }),
    );
    await mkdir(join(root, "node_modules", "@vendoai", "ui"), { recursive: true });
    await writeFile(join(root, "node_modules", "@vendoai", "ui", "package.json"), "{not json");
    const messages = output();
    const code = await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(code).toBe(0);
    expect([...messages.logs, ...messages.errors].some((line) => line.includes("ejected"))).toBe(false);
  });

  it("passes the drift check when the ejected surface matches the installed @vendoai/ui", async () => {
    const root = await healthy();
    await mkdir(join(root, "src", "components", "vendo", "thread"), { recursive: true });
    await writeFile(
      join(root, "src", "components", "vendo", "thread", ".vendo-eject.json"),
      JSON.stringify({ surface: "thread", package: "@vendoai/ui", version: "0.3.0" }),
    );
    await mkdir(join(root, "node_modules", "@vendoai", "ui"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "@vendoai", "ui", "package.json"),
      JSON.stringify({ name: "@vendoai/ui", version: "0.3.0" }),
    );
    const messages = output();
    await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    expect(messages.logs.some((line) => line.includes("ejected thread matches @vendoai/ui v0.3.0"))).toBe(true);
    expect(messages.errors.some((line) => line.includes("ejected"))).toBe(false);
  });
});

/** Agent-install DX (design 2026-07-19 §CLI-3) — every check carries a stable
 *  id; failures and warnings additionally carry a registry `error_code` and a
 *  full `fix_ref` URL into the code's own docs.vendo.run troubleshooting page.
 *  Passing checks carry neither (nothing to fix). */
describe("vendo doctor error codes + fix_refs", () => {
  it("stamps every failing check with a registered error_code and a full fix_ref URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-codes-broken-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    expect(report.exit).toBe(1);
    const failures = report.checks.filter((check) => check.status !== "ok");
    expect(failures.length).toBeGreaterThan(0);
    for (const check of failures) {
      expect(check.id).toBeTruthy();
      expect(check.error_code).toMatch(/^E-[A-Z]+-\d{3}$/);
      expect(doctorErrorCodes).toContain(check.error_code);
      expect(check.fix_ref).toBe(`https://docs.vendo.run/production/troubleshooting/${check.error_code!.toLowerCase()}?v=${CLI_VERSION}`);
    }
    // The remediation surface is broad: wiring, config, deps, tools.
    const codes = new Set(failures.map((check) => check.error_code));
    expect(codes.size).toBeGreaterThan(4);
  });

  /** #1153: the alias-only install. `vendoai` DEPENDS on @vendoai/vendo, so
      under pnpm's strict node_modules the host cannot resolve the
      `@vendoai/vendo/*` imports its own wiring makes: the route fails to
      compile and every request 500s with an HTML error page. The static check
      is where the cause gets named. */
  it("names the unresolvable @vendoai/vendo behind a vendoai-alias-only install", async () => {
    const root = await healthy();
    await installedPackage(root, "vendoai");
    const { exit, report } = await jsonChecks({ targetDir: root });
    const check = report.checks.find((candidate) => candidate.id === "wiring/vendo-resolvable");
    expect(check?.status).toBe("broken");
    expect(check?.error_code).toBe("E-WIRE-011");
    expect(check?.message).toContain("@vendoai/vendo is not resolvable");
    expect(exit).toBe(1);
  });

  it("passes resolvability once @vendoai/vendo is reachable from the app", async () => {
    const root = await healthy();
    await installedPackage(root, "vendoai");
    await installedPackage(root, "@vendoai/vendo");
    const { exit, report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((candidate) => candidate.id === "wiring/vendo-resolvable")?.status).toBe("ok");
    expect(exit).toBe(0);
  });

  it("keeps passing checks lean: id always, no error_code or fix_ref", async () => {
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
    });
    expect(exit).toBe(0);
    expect(report.wired).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const check of report.checks) {
      expect(check.status).toBe("ok");
      expect(check.id).toBeTruthy();
      expect(check).not.toHaveProperty("error_code");
      expect(check).not.toHaveProperty("fix_ref");
    }
  });

  it("stamps warnings with codes too without flipping the exit", async () => {
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
      env: { VENDO_API_KEY: "vnd_nope" },
    });
    expect(exit).toBe(0);
    const warning = report.checks.find((check) => check.status === "warning");
    expect(warning).toMatchObject({
      id: "cloud/key",
      error_code: "E-CLOUD-001",
      fix_ref: doctorFixRef("E-CLOUD-001"),
    });
  });

  it("warns E-TOOLS-004 for blind schema slots and passes when both are covered", async () => {
    const tool = (markers: Record<string, string>) => ({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object", properties: {} }, risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
        ...markers,
      }],
    });

    const blindRoot = await healthy();
    await writeFile(join(blindRoot, ".vendo", "tools.json"),
      JSON.stringify(tool({ inputSchemaSource: "declared", outputSchemaSource: "unknown" })));
    const blind = await jsonChecks({ targetDir: blindRoot });
    const warning = blind.report.checks.find((check) => check.id === "tools/schemas");
    expect(warning).toMatchObject({ status: "warning", error_code: "E-TOOLS-004" });
    expect(warning?.message).toContain("inputs 1/1 · outputs 0/1");
    expect(warning?.message).toContain("host_invoices_list");
    // The command that actually does it. Doctor's audience is largely agents
    // and CI, where a bare `vendo sync` skips the judgment pass and the
    // advice never lands.
    expect(warning?.message).toContain("run `vendo sync --ai`");

    const coveredRoot = await healthy();
    await writeFile(join(coveredRoot, ".vendo", "tools.json"),
      JSON.stringify(tool({ inputSchemaSource: "declared", outputSchemaSource: "declared" })));
    const covered = await jsonChecks({ targetDir: coveredRoot });
    expect(covered.report.checks.find((check) => check.error_code === "E-TOOLS-004")).toBeUndefined();
    expect(covered.report.checks.find((check) => check.id === "tools/schemas"))
      .toMatchObject({ status: "ok", message: "catalog: inputs 1/1 · outputs 1/1" });
  });

  it("names `vendo sync --ai` in the ungraded-catalog fix too", async () => {
    const root = await healthy();
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_invoices_list", description: "d", inputSchema: { type: "object" }, risk: "ungraded",
        inputSchemaSource: "declared", outputSchemaSource: "declared",
        binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
      }],
    }));
    const graded = (await jsonChecks({ targetDir: root })).report.checks.find((check) => check.id === "tools/graded");
    expect(graded).toMatchObject({ status: "warning", error_code: "E-TOOLS-003" });
    expect(graded?.message).toContain("run `vendo sync --ai` with a model key to grade");
  });

  it("warns E-TOOLS-005 naming each tool the merge left off, and keeps the exit green", async () => {
    // `live > 0` passed while 3 of 5 tools were gone: the count was the whole
    // report, so a catalog that lost most of itself read as healthy.
    const root = await healthy();
    const tool = (name: string, path: string) => ({
      name, description: "d", inputSchema: { type: "object" }, risk: "read" as const,
      inputSchemaSource: "declared", outputSchemaSource: "declared",
      binding: { kind: "route" as const, method: "GET" as const, path, argsIn: "query" as const },
    });
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: "vendo/tools@3",
      tools: [tool("host_invoices_list", "/api/invoices"), tool("host_customers_list", "/api/customers")],
    }));
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: { host_customers_list: { disabled: true } },
    }));
    const { exit, report } = await jsonChecks({ targetDir: root });
    const check = report.checks.find((entry) => entry.id === "tools/live-surface");
    expect(check).toMatchObject({ status: "warning", error_code: "E-TOOLS-005" });
    expect(check?.message).toContain("1 of 2 extracted host tools are live");
    expect(check?.message).toContain("host_customers_list (turned off in .vendo/overrides.json)");
    // Awareness, not breakage: which exclusions are acceptable is the host's call.
    expect(exit).toBe(0);
  });

  it("check ids are unique across a full run, healthy and broken alike", async () => {
    // Duplicate ids would make fix_ref anchors and agents' remediation notes
    // ambiguous — every check in one run must be individually addressable.
    const healthyRun = await jsonChecks({
      targetDir: await healthy(),
    });
    const brokenRoot = await mkdtemp(join(tmpdir(), "vendo-doctor-ids-broken-"));
    cleanup.push(() => rm(brokenRoot, { recursive: true, force: true }));
    const brokenRun = await jsonChecks({
      targetDir: brokenRoot,
    });
    for (const { report } of [healthyRun, brokenRun]) {
      const ids = report.checks.map((check) => check.id);
      expect(ids.length).toBeGreaterThan(0);
      expect([...new Set(ids)].sort()).toEqual([...ids].sort());
    }
  });

  it("reports per-surface ownership with the overrides enablement note (#557 landed)", async () => {
    const { report } = await jsonChecks({ targetDir: await healthy() });
    const ownership = report.checks.find((check) => check.id === "config/ownership");
    expect(ownership).toBeDefined();
    expect(ownership!.message.toLowerCase()).toContain("enablement");
    expect(ownership!.message).toContain("boot-once");
  });

  // #478 short-term — npm installs the ai@7 peer conflict without failing, the
  // static checks all pass, and then every internal turn throws
  // AI_InvalidPromptError (v7 removed system-role messages). Doctor reads the
  // HOST's installed `ai` and fails fast on an unsupported major.
  it("fails fast with E-DEP-001 when the host has ai@7 installed", async () => {
    const root = await healthy();
    await mkdir(join(root, "node_modules", "ai"), { recursive: true });
    await writeFile(join(root, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version: "7.0.2" }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/ai-sdk-major");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-001",
      fix_ref: doctorFixRef("E-DEP-001"),
    });
    expect(check?.message).toContain("ai@7.0.2");
    expect(check?.message).toContain("ai@6");
    expect(check?.message).toContain("npm install ai@^6 @ai-sdk/anthropic@^3 @ai-sdk/react@^3");
    expect(check?.message).toContain("github.com/runvendo/vendo/issues/478");
  });

  it("passes the ai major check on an ai@6 host", async () => {
    const root = await healthy();
    await mkdir(join(root, "node_modules", "ai"), { recursive: true });
    await writeFile(join(root, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version: "6.0.28" }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(0);
    const check = report.checks.find((entry) => entry.id === "deps/ai-sdk-major");
    expect(check).toMatchObject({ status: "ok" });
    expect(check?.message).toContain("ai@6.0.28");
  });

  it("skips the ai major check silently when ai is not installed", async () => {
    // The missing-dependency story belongs to the wiring checks and the live
    // turn — an absent node_modules/ai must not break (or even mention) this.
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
    });
    expect(exit).toBe(0);
    expect(report.checks.some((entry) => entry.id === "deps/ai-sdk-major")).toBe(false);
  });

  // FINDINGS F3 (linkwarden baseline): a resolvable pre-v6 ai sailed through
  // doctor green and then 500d every turn at runtime — the peer conflict is
  // exactly as fatal below the contract as above it.
  it("fails fast with E-DEP-001 when the host has a pre-v6 ai installed", async () => {
    const root = await healthy();
    await mkdir(join(root, "node_modules", "ai"), { recursive: true });
    await writeFile(join(root, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version: "5.0.59" }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/ai-sdk-major");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-001",
      fix_ref: doctorFixRef("E-DEP-001"),
    });
    expect(check?.message).toContain("ai@5.0.59");
    expect(check?.message).toContain("peer contract");
    expect(check?.message).toContain("npm install ai@^6");
    expect(check?.message).toContain("hoisted");
  });

  it("fails E-DEP-001 when the workspace root hoists an old ai above the app, naming its package manager", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vendo-doctor-ai-workspace-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");
    await mkdir(join(workspace, "node_modules", "ai"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version: "5.0.59" }));
    const root = await healthy(join(workspace, "apps", "web"));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/ai-sdk-major");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-001",
      fix_ref: doctorFixRef("E-DEP-001"),
    });
    expect(check?.message).toContain("ai@5.0.59");
    expect(check?.message).toContain("pnpm add ai@^6");
  });

  it("fails with E-DEP-003 when the installed zod predates the AI SDK's subpaths", async () => {
    // FINDINGS F2 (skateshop): ai@6 imports zod/v3 + zod/v4, which arrive in
    // zod 3.25 — a host pinning older zod builds red the moment the vendo
    // wiring pulls ai into the bundle.
    const root = await healthy();
    await mkdir(join(root, "node_modules", "zod"), { recursive: true });
    await writeFile(join(root, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version: "3.23.8" }));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/zod-floor");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-003",
      fix_ref: doctorFixRef("E-DEP-003"),
    });
    expect(check?.message).toContain("zod@3.23.8");
    expect(check?.message).toContain("3.25");
    expect(check?.message).toContain("npm install zod@^3.25.0");
  });

  it("passes the zod floor check on a 3.25+ or zod 4 host", async () => {
    for (const version of ["3.25.76", "4.1.8"]) {
      const root = await healthy();
      await mkdir(join(root, "node_modules", "zod"), { recursive: true });
      await writeFile(join(root, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version }));
      const { exit, report } = await jsonChecks({
        targetDir: root,
      });
      expect(exit).toBe(0);
      const check = report.checks.find((entry) => entry.id === "deps/zod-floor");
      expect(check).toMatchObject({ status: "ok" });
      expect(check?.message).toContain(`zod@${version}`);
    }
  });

  it("fails E-DEP-003 when the workspace root hoists an old zod above the app", async () => {
    // Hoisted pnpm/yarn workspaces keep zod at the workspace root and the app
    // nested with no node_modules of its own — the version must be resolved
    // the way the host runtime resolves it, and the bump command must match
    // the workspace's package manager.
    const workspace = await mkdtemp(join(tmpdir(), "vendo-doctor-workspace-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeFile(join(workspace, "pnpm-lock.yaml"), "");
    await mkdir(join(workspace, "node_modules", "zod"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", version: "3.23.8" }));
    const root = await healthy(join(workspace, "apps", "web"));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "deps/zod-floor");
    expect(check).toMatchObject({
      status: "broken",
      error_code: "E-DEP-003",
      fix_ref: doctorFixRef("E-DEP-003"),
    });
    expect(check?.message).toContain("zod@3.23.8");
    expect(check?.message).toContain("pnpm add zod@^3.25.0");
  });

  it("skips the zod floor check silently when zod is not installed", async () => {
    // A host without its own zod resolves ai's copy, which always satisfies.
    const { exit, report } = await jsonChecks({
      targetDir: await healthy(),
    });
    expect(exit).toBe(0);
    expect(report.checks.some((entry) => entry.id === "deps/zod-floor")).toBe(false);
  });

  it("exits nonzero while any single check fails", async () => {
    const root = await healthy();
    await rm(join(root, ".vendo", "brief.md"));
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    expect(report.wired).toBe(false);
    const broken = report.checks.filter((check) => check.status === "broken");
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      id: "config/brief.md",
      error_code: "E-CFG-001",
      fix_ref: doctorFixRef("E-CFG-001"),
    });
  });

  // Config resolves in code or from disk, and nowhere else, so a key buys a
  // missing file no leniency: every one of them is a broken install.
  it("keeps missing config files fatal with VENDO_API_KEY set — a key is not a config source", async () => {
    const root = await healthy();
    await rm(join(root, ".vendo", "tools.json"));
    await rm(join(root, ".vendo", "brief.md"));
    const { exit, report } = await jsonChecks({
      targetDir: root,
      env: { VENDO_API_KEY: "vnd_test_key" },
    });
    expect(exit).toBe(1);
    for (const id of ["config/tools.json", "config/brief.md"]) {
      expect(report.checks.find((entry) => entry.id === id)).toMatchObject({
        status: "broken",
        error_code: "E-CFG-001",
      });
    }
  });

  /** Spec 2026-08-06 §B1: the path prefix has ONE home, VENDO_BASE_URL. A spec
   *  declaring a different relative server mount is #914 by another route —
   *  every page renders and every host tool 404s. */
  const specWithMount = JSON.stringify({
    openapi: "3.1.0", info: { title: "t", version: "1" }, servers: [{ url: "/maple" }], paths: {},
  });

  it("fails E-CFG-003 when the OpenAPI server mount and VENDO_BASE_URL's path disagree", async () => {
    const root = await healthy();
    await writeFile(join(root, "openapi.json"), specWithMount, "utf8");
    const { report } = await jsonChecks({
      targetDir: root,
      env: { VENDO_BASE_URL: "https://site.com" },
    });
    expect(report.checks.find((check) => check.id === "config/mount")).toMatchObject({
      status: "broken",
      error_code: "E-CFG-003",
    });
  });

  /** The posture the hazard actually occurs in: no base URL at all, so the wire
   *  learns the bare request ORIGIN and serves every host tool one prefix short.
   *  The check used to return early here — silent in the one case that breaks. */
  it("fails E-CFG-003 when the spec declares a mount and VENDO_BASE_URL is unset", async () => {
    const root = await healthy();
    await writeFile(join(root, "openapi.json"), specWithMount, "utf8");
    const { report } = await jsonChecks({
      targetDir: root,
      env: {},
    });
    expect(report.checks.find((check) => check.id === "config/mount")).toMatchObject({
      status: "broken",
      error_code: "E-CFG-003",
    });
  });

  it("passes config/mount when the spec and VENDO_BASE_URL agree", async () => {
    const root = await healthy();
    await writeFile(join(root, "openapi.json"), specWithMount, "utf8");
    const { report } = await jsonChecks({
      targetDir: root,
      env: { VENDO_BASE_URL: "https://site.com/maple" },
    });
    expect(report.checks.find((check) => check.id === "config/mount")).toMatchObject({ status: "ok" });
  });

  /** A Next host whose config never externalizes esbuild: Next bundles
   *  @vendoai/apps into the server chunk, the checker's runtime esbuild import
   *  then resolves from the app root — where pnpm never hoists it — and every
   *  generated screen fails its checks. */
  it("fails E-CFG-004 when a Next host's config does not externalize esbuild", async () => {
    const root = await healthy();
    await writeFile(join(root, "next.config.ts"), "export default { reactStrictMode: true };\n", "utf8");
    const { exit, report } = await jsonChecks({ targetDir: root });
    const check = report.checks.find((entry) => entry.id === "config/next-externals");
    expect(check).toMatchObject({ status: "broken", error_code: "E-CFG-004" });
    expect(check?.message).toContain('serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"],');
    expect(exit).toBe(1);
  });

  /** The hole a live run found: an "esbuild" entry without @vendoai/apps is
   *  inert (the checker's specifier is a variable the bundler cannot see), so
   *  the check has to fail on the package, not just on esbuild. */
  it("fails E-CFG-004 on a list that has esbuild but not @vendoai/apps", async () => {
    const root = await healthy();
    await writeFile(join(root, "next.config.ts"),
      'export default { serverExternalPackages: ["esbuild", "@electric-sql/pglite", "@vendoai/store"] };\n', "utf8");
    const { exit, report } = await jsonChecks({ targetDir: root });
    const check = report.checks.find((entry) => entry.id === "config/next-externals");
    expect(check).toMatchObject({ status: "broken", error_code: "E-CFG-004" });
    expect(check?.message).toContain("@vendoai/apps");
    expect(exit).toBe(1);
  });

  /** A commented-out list is what a host debugging its bundle leaves behind.
   *  Read as configuration it greened this check on a still-broken host. */
  it("fails E-CFG-004 when the only externals list is commented out", async () => {
    const root = await healthy();
    await writeFile(join(root, "next.config.ts"),
      '// serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"],\n'
      + "export default { reactStrictMode: true };\n", "utf8");
    const { exit, report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((entry) => entry.id === "config/next-externals"))
      .toMatchObject({ status: "broken", error_code: "E-CFG-004" });
    expect(exit).toBe(1);
  });

  it("fails E-CFG-004 when the list is inside a block comment", async () => {
    const root = await healthy();
    await writeFile(join(root, "next.config.ts"),
      '/* serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"], */\n'
      + "export default {};\n", "utf8");
    const { report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((entry) => entry.id === "config/next-externals"))
      .toMatchObject({ status: "broken", error_code: "E-CFG-004" });
  });

  /** Next hard-fatals on a package named in both lists, so the fix is two
   *  steps for a source-linked host and the message has to say so. */
  it("names the transpilePackages conflict in the E-CFG-004 message", async () => {
    const root = await healthy();
    await writeFile(join(root, "next.config.ts"),
      'export default { transpilePackages: ["@vendoai/apps"] };\n', "utf8");
    const { report } = await jsonChecks({ targetDir: root });
    const check = report.checks.find((entry) => entry.id === "config/next-externals");
    expect(check).toMatchObject({ status: "broken", error_code: "E-CFG-004" });
    expect(check?.message).toContain("Remove @vendoai/apps from transpilePackages first");
  });

  it("fails E-CFG-004 when a Next host has no next.config at all", async () => {
    const root = await healthy();
    await rm(join(root, "next.config.ts"));
    const { report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((entry) => entry.id === "config/next-externals"))
      .toMatchObject({ status: "broken", error_code: "E-CFG-004" });
  });

  /** Next 14 keeps the same list under `experimental.serverComponentsExternalPackages`
   *  (renamed in 15) — same wiring, so doctor reads both spellings. */
  it("passes config/next-externals on the Next 14 spelling of the same list", async () => {
    const root = await healthy();
    await writeFile(join(root, "next.config.ts"),
      'export default { experimental: { serverComponentsExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"] } };\n',
      "utf8");
    const { exit, report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((entry) => entry.id === "config/next-externals")).toMatchObject({ status: "ok" });
    expect(exit).toBe(0);
  });

  it("never runs the Next externals check on a host that is not Next", async () => {
    const { report } = await jsonChecks({ targetDir: await expressHost(true) });
    expect(report.checks.find((entry) => entry.id === "config/next-externals")).toBeUndefined();
  });

  // ENG-422 (field: expense.fyi): a composition wiring supabase() with neither
  // server-side env name set passes every static check and then fails its
  // FIRST signed-in turn. Doctor names the pair before the turn does.
  const supabaseRoute =
    'import { supabase } from "@vendoai/vendo/auth/supabase";\n' +
    'import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";\n' +
    "const vendo = createVendo({ auth: supabase() });\n" +
    "export const { GET, POST } = nextVendoHandler(vendo);\n";

  it("warns E-AUTH-009 when supabase() is wired and neither server env name is set", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), supabaseRoute);
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toMatchObject({
      status: "warning",
      error_code: "E-AUTH-009",
    });
  });

  it("passes wiring/supabase-env when either server env name is present", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), supabaseRoute);
    const { report } = await jsonChecks({
      targetDir: root,
      env: { SUPABASE_URL: "http://127.0.0.1:54321" },
    });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toMatchObject({ status: "ok" });
  });

  it("says nothing about supabase env on a host that does not wire supabase()", async () => {
    const root = await healthy();
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toBeUndefined();
  });

  // The check is framework-neutral (greptile on #1374): a non-Next host that
  // wires the preset fails its first signed-in turn just the same, so it gets
  // the same warning — discovered by import marker, not by Next's file layout.
  const supabaseServerModule =
    'import { supabase } from "@vendoai/vendo/auth/supabase";\n' +
    'import { createVendo } from "@vendoai/vendo/server";\n' +
    "createVendo({ auth: supabase(), models: { default: model }, principal });\n";

  it("warns E-AUTH-009 on an Express host wiring supabase() with no server env", async () => {
    const root = await expressHost(true);
    await writeFile(join(root, "src", "server.ts"), supabaseServerModule);
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toMatchObject({
      status: "warning",
      error_code: "E-AUTH-009",
    });
  });

  it("passes wiring/supabase-env on an Express host once a server env name is set", async () => {
    const root = await expressHost(true);
    await writeFile(join(root, "src", "server.ts"), supabaseServerModule);
    const { report } = await jsonChecks({
      targetDir: root,
      env: { SUPABASE_JWT_SECRET: "local-jwt-secret" },
    });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toMatchObject({ status: "ok" });
  });

  it("warns E-AUTH-009 on a custom-runtime host wiring supabase() with no server env", async () => {
    const root = await customHost(true);
    await writeFile(join(root, "src", "worker.ts"), supabaseServerModule);
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toMatchObject({
      status: "warning",
      error_code: "E-AUTH-009",
    });
  });

  it("recognizes the unscoped vendoai alias spelling of the preset import", async () => {
    const root = await expressHost(true);
    // Assembled at runtime: an import-shaped alias literal in this file would
    // read as a real cross-package import to the dependency guard.
    const aliasSpecifier = ["vendoai", "auth", "supabase"].join("/");
    await writeFile(join(root, "src", "server.ts"),
      `import { supabase } from "${aliasSpecifier}";\n` +
      'import { createVendo } from "@vendoai/vendo/server";\n' +
      "createVendo({ auth: supabase(), models: { default: model }, principal });\n");
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toMatchObject({
      status: "warning",
      error_code: "E-AUTH-009",
    });
  });

  it("does not read a commented-out preset import as supabase wiring", async () => {
    const root = await expressHost(true);
    await writeFile(join(root, "src", "server.ts"),
      '// import { supabase } from "@vendoai/vendo/auth/supabase";\n' +
      'import { createVendo } from "@vendoai/vendo/server";\n' +
      "createVendo({ models: { default: model }, principal });\n");
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/supabase-env")).toBeUndefined();
  });

  // The unscoped vendoai alias ships the same wire, so wiring detection must
  // read both spellings — #1374 fixed the supabase preset marker; these pin
  // the server and legacy-root markers, which had the same blindness (an
  // alias-wired host read as not wired at all). Alias specifiers assembled at
  // runtime: an import-shaped literal here would read as a real cross-package
  // import to the dependency guard.
  it("reads an alias-wired Express server as wired, never E-WIRE-001", async () => {
    const root = await expressHost(true);
    const aliasServer = ["vendoai", "server"].join("/");
    await writeFile(join(root, "src", "server.ts"),
      `import { createVendo } from "${aliasServer}";\n` +
      "createVendo({ models: { default: model }, principal });\n");
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/express-server")).toMatchObject({ status: "ok" });
  });

  it("reads an alias-wired custom-runtime server as wired, never E-WIRE-007", async () => {
    const root = await customHost(true);
    const aliasServer = ["vendoai", "server"].join("/");
    await writeFile(join(root, "src", "worker.ts"),
      `import { createVendo } from "${aliasServer}";\n` +
      "export const vendo = createVendo({ models: { default: model }, principal });\n");
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/server")).toMatchObject({ status: "ok" });
  });

  it("flags a VendoRoot import from the alias as legacy, E-WIRE-010", async () => {
    const root = await expressHost(true);
    const aliasReact = ["vendoai", "react"].join("/");
    // A provider is also mounted, so the tag-only fallback (legacyTag with no
    // provider) cannot mask a miss in the import marker.
    await writeFile(join(root, "src", "client.tsx"),
      `import { VendoRoot } from "${aliasReact}";\n` +
      "export const App = () => <VendoProvider><VendoRoot /><main /><VendoOverlay /></VendoProvider>;\n");
    const { report } = await jsonChecks({ targetDir: root, env: {} });
    expect(report.checks.find((check) => check.id === "wiring/vendo-root")).toMatchObject({
      status: "warning",
      error_code: "E-WIRE-010",
    });
  });

  // Visible-surface gate (0.4.1 E2E cert B3): green must mean a user can SEE
  // the agent — <VendoProvider> alone is a provider that renders nothing.
  it("fails E-WIRE-006 when nothing visible is mounted, and exits 1", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "layout.tsx"),
      "export default ({children}) => <VendoProvider>{children}</VendoProvider>;");
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    const errors = messages.errors.join("\n");
    expect(errors).toContain("no visible agent surface is mounted");
    expect(errors).toContain("<VendoOverlay />");
  });

  // Server actions fail closed and nothing else goes red (ENG-248): init only
  // ever CREATES, so a route or a map that predates the host's "use server"
  // surface stays as the developer left it, and doctor is where that surfaces.
  it("fails E-WIRE-009 when detected server actions are neither registered nor wired", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst vendo = createVendo({});\nexport const { GET } = vendo;\n');
    const { exit, report } = await jsonChecks({
      targetDir: root,
    });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "wiring/server-actions");
    expect(check).toMatchObject({ status: "broken", error_code: "E-WIRE-009" });
    expect(check?.message).toContain("vendo-actions.ts is missing");
    expect(check?.message).toContain("does not pass serverActions");
  });

  it("passes wiring/server-actions once the map registers the action and the route passes it", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo-actions.ts"),
      'export const serverActions = {\n  "app/actions/later.ts#later": async () => 1,\n};\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nimport { serverActions } from "./vendo-actions";\nconst vendo = createVendo({ serverActions });\nexport const { GET } = vendo;\n');
    const { report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((entry) => entry.id === "wiring/server-actions")).toMatchObject({ status: "ok" });
  });

  it("says nothing about server actions in a host that has none", async () => {
    const { report } = await jsonChecks({ targetDir: await healthy() });
    expect(report.checks.some((entry) => entry.id === "wiring/server-actions")).toBe(false);
  });

  // Regression (review B1): the import line is NOT wiring — the call is. This
  // is where a half-applied paste lands, so a check that greps the whole file
  // goes green on precisely the state it exists to catch. Init and doctor read
  // it through the same helper so they cannot disagree.
  it("fails E-WIRE-009 when the route imports the map but never passes it to createVendo", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo-actions.ts"),
      'export const serverActions = {\n  "app/actions/later.ts#later": async () => 1,\n};\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nimport { serverActions } from "./vendo-actions";\nconst vendo = createVendo({});\nexport const { GET } = vendo;\n');
    const { exit, report } = await jsonChecks({ targetDir: root });
    expect(exit).toBe(1);
    const check = report.checks.find((entry) => entry.id === "wiring/server-actions");
    expect(check).toMatchObject({ status: "broken", error_code: "E-WIRE-009" });
    expect(check?.message).toContain("does not pass serverActions inside createVendo");
    // The map itself is complete — do not accuse it.
    expect(check?.message).not.toContain("does not register");
  });

  // Regression (review 3): a route that composes its own map is a shape init
  // deliberately leaves alone ("leaves a hand-customized route ... untouched"),
  // so doctor must not report the generated map it never wanted as missing.
  it("stays silent when the route passes a map it composes itself", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst serverActions = { later: async () => 1 };\nconst vendo = createVendo({ serverActions });\nexport const { GET } = vendo;\n');
    const { report } = await jsonChecks({ targetDir: root });
    expect(report.checks.some((entry) => entry.id === "wiring/server-actions")).toBe(false);
  });

  // The MCP path splits the composition out of route.ts — a Next.js route
  // module may export only handlers, and the origin-root discovery route has to
  // import the SAME instance. Doctor must grade the file that holds
  // createVendo, or it goes silent on a host that is correctly wired.
  describe("the split composition the MCP path writes", () => {
    async function splitHost(composition: string): Promise<string> {
      const root = await healthy();
      await mkdir(join(root, "app", "actions"), { recursive: true });
      await writeFile(join(root, "app", "actions", "later.ts"),
        '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
      await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo-actions.ts"),
        'export const serverActions = {\n  "app/actions/later.ts#later": async () => 1,\n};\n');
      await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
        'import { nextVendoHandler } from "@vendoai/vendo/server";\nimport { vendo } from "./vendo";\n\nexport const { GET, POST } = nextVendoHandler(vendo);\n');
      await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo.ts"), composition);
      return root;
    }

    it("reads a thin route.ts as wired, not missing", async () => {
      const root = await splitHost('import { createVendo } from "@vendoai/vendo/server";\nimport { serverActions } from "./vendo-actions";\nexport const vendo = createVendo({ serverActions, mcp: true });\n');
      const { report } = await jsonChecks({
        targetDir: root,
        env: { VENDO_BASE_URL: "https://app.acme.com" },
      });
      expect(report.checks.find((entry) => entry.id === "wiring/next-route")).toMatchObject({ status: "ok" });
      expect(report.checks.find((entry) => entry.id === "wiring/server-actions")).toMatchObject({ status: "ok" });
    });

    it("names the composition, not the thin route, when the wiring is missing there", async () => {
      const root = await splitHost('import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ mcp: true });\n');
      const { report } = await jsonChecks({
        targetDir: root,
        env: { VENDO_BASE_URL: "https://app.acme.com" },
      });
      const check = report.checks.find((entry) => entry.id === "wiring/server-actions");
      expect(check).toMatchObject({ status: "broken", error_code: "E-WIRE-009" });
      expect(check?.message).toContain("app/api/vendo/[...vendo]/vendo.ts does not pass serverActions");
    });
  });

  // The one thing the MCP path must not do: a door whose discovery points at
  // the wrong origin is invisible at install time and surfaces hours later, in
  // someone else's terminal, as "Claude can't find my server". A FAILURE.
  describe("E-MCP-009 — an MCP-wired host with no base URL", () => {
    async function mcpHost(composition: string): Promise<string> {
      const root = await healthy();
      await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo.ts"), composition);
      return root;
    }
    /** The shape init writes TODAY: the composition in its own module, with the
        wire route a thin handler over it. */
    async function libHost(composition: string, base = ""): Promise<string> {
      const root = await healthy();
      await mkdir(join(root, base, "lib"), { recursive: true });
      await writeFile(join(root, base, "lib", "vendo.ts"), composition);
      // The `@/` specifier init writes wherever the host maps the alias — and
      // the one shape of it that is not an escaping relative path spelled
      // inline, which the dependency guard reads as a real import.
      await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
        'import { nextVendoHandler } from "@vendoai/vendo/server";\nimport { vendo } from "@/lib/vendo";\n\nexport const { GET, POST } = nextVendoHandler(vendo);\n');
      return root;
    }
    const wired = 'import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ mcp: true });\n';

    it("fails, and exits 1", async () => {
      const { exit, report } = await jsonChecks({
        targetDir: await mcpHost(wired),
      });
      expect(exit).toBe(1);
      const check = report.checks.find((entry) => entry.id === "mcp/base-url");
      expect(check).toMatchObject({ status: "broken", error_code: "E-MCP-009" });
      expect(check?.message).toContain("VENDO_BASE_URL is not set");
    });

    it("passes once VENDO_BASE_URL is set", async () => {
      const { report } = await jsonChecks({
        targetDir: await mcpHost(wired),
        env: { VENDO_BASE_URL: "https://app.acme.com" },
      });
      expect(report.checks.find((entry) => entry.id === "mcp/base-url")).toMatchObject({ status: "ok" });
    });

    /** The composition moved into `lib/vendo.ts` and this check's path list did
        not follow, so the door it was written to catch became invisible: an
        init-scaffolded MCP host with no base URL graded SILENT — no failure, no
        check, nothing to notice — while the legacy shapes kept failing. Both
        layouts, because the module follows the app directory under `src/`. */
    it.each([["root", ""], ["src", "src"]] as const)(
      "fires on the composition module init writes (%s layout), and passes once the variable is set",
      async (_label, base) => {
        const { exit, report } = await jsonChecks({ targetDir: await libHost(wired, base) });
        expect(exit).toBe(1);
        const check = report.checks.find((entry) => entry.id === "mcp/base-url");
        expect(check).toMatchObject({ status: "broken", error_code: "E-MCP-009" });
        expect(check?.message).toContain("VENDO_BASE_URL is not set");

        const { report: set } = await jsonChecks({
          targetDir: await libHost(wired, base),
          env: { VENDO_BASE_URL: "http://localhost:3000" },
        });
        expect(set.checks.find((entry) => entry.id === "mcp/base-url")).toMatchObject({ status: "ok" });
      },
    );

    // Host config beats the environment default, so a composition that names
    // its own public origin needs no variable.
    it("passes on mcp: { baseUrl } with no variable at all", async () => {
      const { report } = await jsonChecks({
        targetDir: await mcpHost('import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ mcp: { baseUrl: "https://app.acme.com" } });\n'),
      });
      expect(report.checks.find((entry) => entry.id === "mcp/base-url")).toMatchObject({ status: "ok" });
    });

    it("says nothing at all when no door is wired", async () => {
      const { report } = await jsonChecks({ targetDir: await healthy() });
      expect(report.checks.some((entry) => entry.id === "mcp/base-url")).toBe(false);
    });

    // Regression (Greptile P1 on #1142): the scan was `mcp:\s*\{[^}]*baseUrl`,
    // and a character class cannot cross a closing brace — so a NESTED option
    // written before baseUrl (serviceAuth, remoteAs, federation; the local
    // service-key path scaffolds one) ended the window at its own `}` and
    // baseUrl was never seen. E-MCP-009 is a hard FAIL, so that rejected a
    // correctly configured deployment over property ORDER alone.
    it.each([
      ["a nested option BEFORE baseUrl", '{ serviceAuth: { keys: ["k1", "k2"] }, baseUrl: "https://app.acme.com" }'],
      ["a nested option AFTER baseUrl", '{ baseUrl: "https://app.acme.com", serviceAuth: { keys: ["k1"] } }'],
      ["two nested options around it", '{ federation: { secret: "s" }, baseUrl: "https://app.acme.com", remoteAs: { issuer: "https://i", audience: "https://a" } }'],
    ])("passes with %s — order must not decide the verdict", async (_label, mcp) => {
      const { report } = await jsonChecks({
        targetDir: await mcpHost(`import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ mcp: ${mcp} });\n`),
      });
      expect(report.checks.find((entry) => entry.id === "mcp/base-url")).toMatchObject({ status: "ok" });
    });

    // …and the nested option must not smuggle a pass either: a baseUrl that is
    // not the door's own top-level option leaves the deployment unconfigured.
    it("still fails when the only baseUrl sits inside a nested option", async () => {
      const { report } = await jsonChecks({
        targetDir: await mcpHost('import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ mcp: { remoteAs: { issuer: "https://i", audience: "https://a", baseUrl: "https://nope" } } });\n'),
      });
      expect(report.checks.find((entry) => entry.id === "mcp/base-url"))
        .toMatchObject({ status: "broken", error_code: "E-MCP-009" });
    });
  });

  // The registry artifacts a published host keeps on disk. Absent files say
  // nothing; present ones are graded, with no registry round-trip.
  describe("the MCP registry artifacts on disk", () => {
    /** A host that actually opened the MCP door — the evidence `server.json` is
     *  registry metadata at all. It names its own baseUrl so E-MCP-009 stays
     *  out of the way of what these tests are grading. */
    async function publishedHost(): Promise<string> {
      const root = await healthy();
      await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
        'export const { GET } = createVendo({ mcp: { baseUrl: "https://app.acme.com" } });\n');
      return root;
    }

    // Regression (Greptile P1 on #1385): `server.json` is a generic filename,
    // and the fetched half only reached this check once a live door reported an
    // MCP posture. Running it on every root made an unrelated file fail doctor
    // over registry metadata the project never had.
    it("says nothing about a root server.json when no MCP door is wired", async () => {
      const root = await healthy();
      await writeFile(join(root, "server.json"), "{not json");
      const { exit, report } = await jsonChecks({ targetDir: root });
      expect(report.checks.some((entry) => entry.id === "mcp/server-json")).toBe(false);
      expect(exit).toBe(0);
    });

    it("fails E-MCP-004 when server.json does not meet the registry requirements", async () => {
      const root = await publishedHost();
      await writeFile(join(root, "server.json"), JSON.stringify({
        $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "com.example/maple",
        description: "x".repeat(101),
        version: "1.2.3",
        remotes: [{ type: "streamable-http", url: "https://mcp.example.com/api/vendo/mcp" }],
      }));
      const { exit, report } = await jsonChecks({ targetDir: root });
      expect(exit).toBe(1);
      const check = report.checks.find((entry) => entry.id === "mcp/server-json");
      expect(check).toMatchObject({ status: "broken", error_code: "E-MCP-004" });
      expect(check?.message).toContain("server.json is invalid");
    });

    it("fails E-MCP-006 when server.json is not valid JSON", async () => {
      const root = await publishedHost();
      await writeFile(join(root, "server.json"), "{not json");
      const { exit, report } = await jsonChecks({ targetDir: root });
      expect(exit).toBe(1);
      expect(report.checks.find((entry) => entry.id === "mcp/server-json"))
        .toMatchObject({ status: "broken", error_code: "E-MCP-006" });
    });

    it("fails E-MCP-007 when the local registry auth challenge does not start with v=MCPv1", async () => {
      const root = await healthy();
      await mkdir(join(root, "public", ".well-known"), { recursive: true });
      await writeFile(join(root, "public", ".well-known", "mcp-registry-auth"), "not-an-mcp-challenge\n");
      const { exit, report } = await jsonChecks({ targetDir: root });
      expect(exit).toBe(1);
      expect(report.checks.find((entry) => entry.id === "mcp/registry-auth-local"))
        .toMatchObject({ status: "broken", error_code: "E-MCP-007" });
    });
  });

  // Regression (review 4): a tool a human disabled is one the runtime never
  // dispatches — hard-failing on its registration demands work that buys
  // nothing. The rest of doctor honors overrides; this check does too.
  it("stays silent about an action disabled in .vendo/overrides.json", async () => {
    const root = await healthy();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    // Nothing registered, nothing wired — the state that fails without overrides.
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst vendo = createVendo({});\nexport const { GET } = vendo;\n');
    const broken = await jsonChecks({ targetDir: root });
    expect(broken.report.checks.find((entry) => entry.id === "wiring/server-actions")?.status).toBe("broken");

    const { tools } = await extractServerActions(root);
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify({
      format: "vendo/overrides@3",
      tools: Object.fromEntries(tools.map((tool) => [tool.name, { disabled: true }])),
      remix: { ignoreSlots: [] },
    }));
    const { report } = await jsonChecks({ targetDir: root });
    expect(report.checks.some((entry) => entry.id === "wiring/server-actions")).toBe(false);
  });

  /** VendoRoot is gone (spec 2026-08-06 §B2): a host that still names it —
      or still carries the wrapper init used to generate — gets the swap by
      name, as a warning, not a build error it has to decode. */
  it("warns E-WIRE-010 when the host still carries the legacy vendo-root wrapper", async () => {
    const root = await healthy();
    await mkdir(join(root, "vendo"), { recursive: true });
    await writeFile(join(root, "vendo", "vendo-root.tsx"),
      "\"use client\";\nexport function VendoRoot({children}) { return <VendoProvider>{children}<VendoOverlay /></VendoProvider>; }");
    const { report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((check) => check.id === "wiring/vendo-root")).toMatchObject({
      status: "warning",
      error_code: "E-WIRE-010",
    });
  });

  /** …and a host whose OWN component happens to be named VendoRoot is not
      carrying anything legacy: Maple's src/components/vendo/VendoRoot.tsx is a
      local wrapper around <VendoProvider>, and a healthy install was told to
      swap a component Vendo never shipped it. The name alone proves nothing —
      the import source and the missing provider do. */
  it("stays silent on a local component merely NAMED VendoRoot that wraps <VendoProvider>", async () => {
    const root = await healthy();
    await mkdir(join(root, "components"), { recursive: true });
    await writeFile(join(root, "components", "VendoRoot.tsx"),
      "\"use client\";\nimport { VendoProvider } from \"@vendoai/vendo/react\";\n"
      + "export function VendoRoot({children}) { return <VendoProvider baseUrl=\"/api/vendo\">{children}</VendoProvider>; }");
    await writeFile(join(root, "app", "layout.tsx"),
      "import { VendoRoot } from \"@/components/VendoRoot\";\n"
      + "export default ({children}) => <VendoRoot>{children}<VendoOverlay /></VendoRoot>;");
    const { report } = await jsonChecks({ targetDir: root });
    expect(report.checks.find((check) => check.id === "wiring/vendo-root")).toBeUndefined();
  });

  it("accepts a BYO embed (<VendoToolResult>) as the visible surface", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "layout.tsx"),
      "export default ({children}) => <VendoProvider>{children}</VendoProvider>;");
    await mkdir(join(root, "app", "chat"), { recursive: true });
    await writeFile(join(root, "app", "chat", "page.tsx"),
      "export default () => <VendoToolResult output={null} />;");
    expect(await doctor({
      targetDir: root,
      output: output().sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
  });

  // E-WIRE-004 broadened: hosts with route groups or i18n mount in a NESTED
  // layout (invoify: app/[locale]/layout.tsx) — the root-layout-only grep
  // fought exactly that correct wiring in the 0.4.1 E2E cert.
  it("finds the <VendoProvider> mount in a nested layout", async () => {
    const root = await healthy();
    await writeFile(join(root, "app", "layout.tsx"),
      "export default ({children}) => <html><body>{children}</body></html>;");
    await mkdir(join(root, "app", "[locale]"), { recursive: true });
    await writeFile(join(root, "app", "[locale]", "layout.tsx"),
      "export default ({children}) => <VendoProvider>{children}<VendoOverlay /></VendoProvider>;");
    expect(await doctor({
      targetDir: root,
      output: output().sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
  });

  // A pages-only Next host is a shape init explicitly supports: clientRoot()
  // hands the user `pages/_app.tsx` to paste into, because there is no app
  // layout to wrap. Doctor scanning app/ layouts only fails such a host
  // forever, and names a file init never mentioned and that does not exist.
  it("finds the <VendoProvider> mount in a Pages-Router host's pages/_app.tsx", async () => {
    const root = await healthy();
    await rm(join(root, "app", "layout.tsx"));
    await mkdir(join(root, "pages"), { recursive: true });
    await writeFile(join(root, "pages", "_app.tsx"),
      "export default ({Component, pageProps}) => <VendoProvider><Component {...pageProps} /><VendoOverlay /></VendoProvider>;");
    expect(await doctor({
      targetDir: root,
      output: output().sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
  });

  it("names pages/_app.tsx, not app/layout.tsx, when a Pages-Router host has no mount", async () => {
    const root = await healthy();
    await rm(join(root, "app", "layout.tsx"));
    await mkdir(join(root, "pages"), { recursive: true });
    await writeFile(join(root, "pages", "_app.tsx"),
      "export default ({Component, pageProps}) => <Component {...pageProps} />;");
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    const wire004 = messages.errors.join("\n");
    expect(wire004).toContain(join("pages", "_app.tsx"));
    expect(wire004).not.toContain(join("app", "layout.tsx"));
  });

  /** The nextcrm shape (corpus, pinned 5b6a555): an i18n host whose root
      layout IS app/[locale]/layout.tsx. Naming the phantom app/layout.tsx sent
      the user to create a SECOND root layout — the fix doctor asks for must be
      one this host can actually apply. */
  it("names the nested root layout, not a phantom app/layout.tsx, on an i18n host", async () => {
    const root = await healthy();
    await rm(join(root, "app", "layout.tsx"));
    await mkdir(join(root, "app", "[locale]", "(routes)"), { recursive: true });
    await writeFile(join(root, "app", "[locale]", "layout.tsx"),
      "export default ({children}) => <html><body>{children}</body></html>;");
    await writeFile(join(root, "app", "[locale]", "(routes)", "layout.tsx"),
      "export default ({children}) => <main>{children}</main>;");
    const messages = output();
    expect(await doctor({
      targetDir: root,
      output: messages.sink,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    const wire004 = messages.errors.join("\n");
    expect(wire004).toContain(join("app", "[locale]", "layout.tsx"));
    expect(wire004).not.toContain(join("app", "[locale]", "(routes)", "layout.tsx"));
  });
});

describe("readEnvFiles — the CLI's one env reader (doctor and config read it too)", () => {
  it("reads .env.local over .env, parses quotes/comments, never overrides process env at the merge site", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-env-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".env"), "SHARED=from-env\nENV_ONLY=plain\n");
    await writeFile(
      join(root, ".env.local"),
      "# comment\nSHARED=from-local\nVENDO_API_KEY=\"vnd_0123\"\nexport EXPORTED=yes\nEMPTY=\nBROKEN LINE\n",
    );
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    const env = await readEnvFiles(root, {});
    expect(env["SHARED"]).toBe("from-local");
    expect(env["ENV_ONLY"]).toBe("plain");
    expect(env["VENDO_API_KEY"]).toBe("vnd_0123");
    expect(env["EXPORTED"]).toBe("yes");
    expect(env["EMPTY"]).toBe("");
    expect(Object.keys(env)).not.toContain("BROKEN LINE");
  });

  it("strips inline comments from unquoted values, same grammar as envFileValueSync", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-envc-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".env.local"), "VENDO_API_KEY=vnd_abc # dev key\nQUOTED=\"kept # inside\"\n");
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    const env = await readEnvFiles(root, {});
    expect(env["VENDO_API_KEY"]).toBe("vnd_abc");
    expect(env["QUOTED"]).toBe("kept # inside");
  });

  it("blank process values yield to concrete dotenv values at the merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-envm-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, ".env"), "VENDO_API_KEY=vnd_real\nONLY_FILE=x\nSHELL_WINS=from-file\n");
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    const merged = await readEnvFiles(root, { VENDO_API_KEY: "  ", SHELL_WINS: "yes", ONLY_PROC: "" });
    expect(merged["VENDO_API_KEY"]).toBe("vnd_real");
    expect(merged["ONLY_FILE"]).toBe("x");
    expect(merged["SHELL_WINS"]).toBe("yes");
    expect(merged["ONLY_PROC"]).toBe("");
  });

  it("returns only the process env when no env files exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-noenv-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const { readEnvFiles } = await import("../../src/cli/sync-flow.js");
    expect(await readEnvFiles(root, {})).toEqual({});
  });
});
