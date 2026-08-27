import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractServerActions } from "@vendoai/actions/sync";
import type { RunContext, ToolDescriptor } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../../src/cli/doctor.js";
import type { ExtractionHarness } from "../../src/cli/extract/harness.js";
import { NEXT_SERVER_EXTERNALS, NEXT_SERVER_EXTERNALS_LINE } from "../../src/cli/framework.js";
import { runInit, type InitReceipt } from "../../src/cli/init.js";
import type { InitQuestions } from "../../src/cli/init-questions.js";
import { CLI_VERSION, type Output } from "../../src/cli/shared.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Cloud step stub: absent key, no offer accepted — the quiet default. */
const NO_CLOUD = {
  cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance"] as readonly string[] }),
};

function fenced(payload: object): string {
  return "```json\n" + JSON.stringify(payload) + "\n```";
}

/** A scripted harness answering the AI-polish stages: trivial (empty) tool
    passes and briefs, plus the given theme-stage payload. Used to exercise
    init's consent-gated theme merge without a real Claude Code login/binary
    (Task 4: theme finalization now rides this same harness seam). */
function themeHarness(payload: object): ExtractionHarness {
  return {
    id: "test-theme-harness",
    availability: async () => "a scripted harness",
    run: async ({ instructions }) => {
      if (instructions.includes("extraction surveyor")) return fenced({ surfaces: [{ name: "app", tools: [] }] });
      if (instructions.includes("drafting the product brief")) return fenced({ brief: "A test product." });
      if (instructions.includes("filling the theme's brand slots")) return fenced(payload);
      return fenced({ tools: [] });
    },
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-init-"));
  cleanup.push(root);
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
  }));
  await writeFile(join(root, "app", "layout.tsx"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
  return root;
}

async function expressFixture(wired: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-init-express-"));
  cleanup.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "express-host",
    dependencies: { express: "5.0.0", "@vendoai/vendo": "0.3.0" },
  }));
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  if (wired) {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "server.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nconst vendo = createVendo({ principal: async () => null });\n');
    await writeFile(join(root, "src", "client.tsx"),
      'import { VendoRoot } from "@vendoai/vendo/react";\nexport const App = () => <VendoRoot><main /></VendoRoot>;\n');
  }
  return root;
}

async function customFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-init-custom-"));
  cleanup.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "worker-host",
    dependencies: { vite: "6.0.0", "@vendoai/vendo": "0.3.0" },
  }));
  await writeFile(join(root, "tsconfig.json"), "{}\n");
  return root;
}

/** How a generated or pasted file reaches the composition module. Assembled
    rather than written literally, for the same reason as ACTION_SPECIFIER. */
const LIB_VENDO = (up: number): string => [...Array<string>(up).fill(".."), "lib", "vendo"].join("/");

/** How the generated map reaches `app/actions/*` out of the composition dir
    (`lib/`). Assembled rather than written literally: an escaping relative
    specifier spelled inline reads to the dependency guard as a real import. */
const ACTION_SPECIFIER = ["..", "app", "actions", "later"].join("/");

function output(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (message) => logs.push(message), error: (message) => errors.push(message) }, logs, errors };
}

async function tree(root: string, at = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of await readdir(at, { withFileTypes: true })) {
    if (name.name === "node_modules") continue;
    const path = join(at, name.name);
    if (name.isDirectory()) Object.assign(result, await tree(root, path));
    else result[path.slice(root.length + 1)] = await readFile(path, "utf8");
  }
  return result;
}

function run(root: string, sink: { output: Output }, extra: Partial<Parameters<typeof runInit>[0]> = {}): Promise<number> {
  return runInit({
    targetDir: root,
    output: sink.output,
    env: {},
    cloud: NO_CLOUD,
    telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    ...extra,
  });
}

/** An --agent run with every question already answered: the WRITE pass, whose
    last line is the receipt. Leaving any one of them off makes it the ask
    pass instead.

    `harnesses: []` because agent mode GRADES now (2026-08-18): without an empty
    ladder these runs would probe the developer's own machine and, where Claude
    Code is installed, spend a real model call per test. A test that wants the
    pass to run supplies its own scripted harness. */
function agentRun(
  root: string,
  sink: { output: Output },
  extra: Partial<Parameters<typeof runInit>[0]> = {},
): Promise<number> {
  return run(root, sink, {
    agent: true, useCase: "embedded", auth: "none", byo: true, baseUrl: "http://localhost:3000",
    extract: { harnesses: [] }, ...extra,
  });
}

const receiptOf = (logs: string[]): InitReceipt => JSON.parse(logs.at(-1)!) as InitReceipt;
const questionsOf = (logs: string[]): InitQuestions => JSON.parse(logs.join("\n")) as InitQuestions;

describe("vendo init (zero-question)", () => {
  it.each([
    [{ dependencies: { express: "5.0.0" } }, "express"],
    [{ dependencies: { express: "5.0.0", next: "16.0.0" } }, "next"],
    // detection "unknown" lands on the runtime-neutral custom scaffold — the
    // safe default (guessing Next into a Worker host was the field failure).
    [{ dependencies: { react: "19.0.0" } }, "custom"],
  ] as const)("detects the host framework from package.json", async (manifest, expected) => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-detect-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    expect(questionsOf(sink.logs).detected).toMatchObject({ framework: expected });
  });

  it("wires a fresh Next host with no prompts: route + hooks + .vendo", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);

    // The generated code file: a model-less createVendo (model is optional),
    // in the ONE module `@/lib/vendo` every docs page already imports. No
    // client file is generated at all — the host writes its own.
    const composition = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(composition).toContain('import { createVendo, guard } from "@vendoai/vendo/server";');
    expect(composition).toContain("export const vendo = createVendo({");
    // The anonymous principal matches the docs' chat-route demo principal —
    // a null wire principal makes chat-created apps invisible to the embeds
    // (0.4.1 E2E cert B4).
    expect(composition).toContain('principal: async () => ({ kind: "user" as const, subject: "demo-user" })');
    expect(composition).not.toContain("model");
    // …and the route is a thin handler over it: a Next route module may export
    // only route handlers, so createVendo can never live in one.
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain(`import { vendo } from ${JSON.stringify(LIB_VENDO(4))};`);
    expect(route).toContain("export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);");
    expect(route).not.toMatch(/\bcreateVendo\b/);
    // The install records the answer doctor grades against.
    expect(JSON.parse(await readFile(join(root, ".vendo", "install.json"), "utf8")))
      .toEqual({ format: "vendo/install@1", useCase: "embedded" });
    await expect(readFile(join(root, "vendo", "registry.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "vendo", "vendo-root.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
    // The host's own layout is NOT touched: mounting the provider is the
    // developer's paste (init never writes user-authored files).
    const layout = await readFile(join(root, "app", "layout.tsx"), "utf8");
    expect(layout).not.toContain("VendoProvider");

    // package.json gains the sync hooks.
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.predev).toBe("vendo sync --no-ai");
    expect(manifest.scripts?.prebuild).toBe("vendo sync --strict --no-ai");

    // No model module is scaffolded.
    await expect(readFile(join(root, "lib", "ai.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    // .vendo artifacts land; no encryption key is ever generated.
    for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
      await expect(readFile(join(root, ".vendo", file), "utf8")).resolves.toBeTruthy();
    }
    await expect(readFile(join(root, ".vendo", "data", ".gitignore"), "utf8")).resolves.toBe("*\n!.gitignore\n");
    await expect(readFile(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    // Everything init writes is format v3: the pair, and NO retired files.
    expect(JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8"))).toMatchObject({ format: "vendo/tools@3" });
    expect(JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8")))
      .toEqual({ format: "vendo/overrides@3", tools: {}, remix: { ignoreSlots: [] } });
    await expect(readFile(join(root, ".vendo", "capabilities.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".vendo", "semantics.json"))).rejects.toMatchObject({ code: "ENOENT" });

    // The summary lists what changed; nothing is left to paste.
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Wired (4 files):");
    expect(logs).toContain("+ " + join("app", "api", "vendo", "[...vendo]", "route.ts"));
    expect(logs).toContain("+ " + join("lib", "vendo.ts"));
    expect(logs).toContain("+ next.config.mjs");
    expect(logs).not.toContain("~ " + join("app", "layout.tsx"));
    expect(logs).toContain("~ package.json");
    // No auth dependency in the fixture: one calm advisory, nothing guessed.
    expect(logs).toContain("Auth: no provider detected");
    // No interview, no per-diff consent, no refine offer, no finale.
    expect(logs).not.toContain("[y/N]");
    expect(logs).not.toContain("vendo refine");
  });

  it("is idempotent: a re-run changes nothing and says so", async () => {
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    const first = await tree(root);
    const again = output();
    expect(await run(root, again)).toBe(0);
    expect(await tree(root)).toEqual(first);
    expect(again.logs.join("\n")).toContain("Already wired — nothing to change.");
  });

  it("scaffolds into a src/app layout and never touches the host's own layout file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-srcapp-"));
    cleanup.push(root);
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
    await writeFile(join(root, "src", "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    await expect(readFile(join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8")).resolves.toContain("nextVendoHandler");
    expect(await readFile(join(root, "src", "app", "layout.tsx"), "utf8")).not.toContain("VendoProvider");
    expect(sink.logs.join("\n")).toContain(`+ ${join("src", "app", "api", "vendo", "[...vendo]", "route.ts")}`);
  });

  it("scaffolds app/ under src/ when the host's pages router lives there (teable: pages+app must share one base)", async () => {
    // Next hard-fails ("pages and app directories should be under the same
    // folder") when app/ and pages/ sit at different bases. A host with
    // src/pages/ but no app/ anywhere must get its scaffold at src/app, not
    // root-level app/, even though appDirectory has no src/app to find yet.
    const root = await mkdtemp(join(tmpdir(), "vendo-init-srcpages-"));
    cleanup.push(root);
    await mkdir(join(root, "src", "pages"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
    await writeFile(join(root, "src", "pages", "index.tsx"), "export default function Home() { return null; }\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const route = await readFile(join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain("nextVendoHandler");
    // The composition follows the app directory under src/ — appDirectory's own
    // rule, so the two can never land on different bases.
    await expect(readFile(join(root, "src", "lib", "vendo.ts"), "utf8")).resolves.toContain("createVendo({");
    expect(await readdir(root)).not.toContain("app");
  });

  it.each([
    ["next-auth", "authJs", "@vendoai/vendo/auth/auth-js"],
    ["@auth/core", "authJs", "@vendoai/vendo/auth/auth-js"],
    ["@clerk/nextjs", "clerk", "@vendoai/vendo/auth/clerk"],
    ["@supabase/supabase-js", "supabase", "@vendoai/vendo/auth/supabase"],
    ["@auth0/nextjs-auth0", "auth0", "@vendoai/vendo/auth/auth0"],
  ] as const)("non-interactive runs silently wire auth from %s → %s()", async (dependency, preset, specifier) => {
    // No `interactive` override and vitest has no TTY: the detected default
    // is accepted without a question (--yes behaves identically).
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", [dependency]: "1.0.0" },
    }));
    // ENG-422 / #1338: a supabase or clerk host with no server env would
    // rightly carry the env advisory — a satisfied env keeps this test about
    // SILENT wiring (the advisories have their own tests in init-auth.test.ts).
    await writeFile(join(root, ".env.local"), "SUPABASE_URL=http://127.0.0.1:54321\nCLERK_SECRET_KEY=sk_test_x\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    // The preset comes from its own subpath — never "@vendoai/vendo/server" —
    // so importing it never resolves the other presets' optional peer deps
    // (corpus-triage Task 9).
    expect(route).toContain(`import { ${preset} } from "${specifier}";`);
    expect(route).toContain('import { createVendo, guard } from "@vendoai/vendo/server";');
    expect(route).toContain(`auth: ${preset}(),`);
    // The detected line carries its escape hatch, and the preset owns the
    // principal seam — no hand-wired anonymous resolver remains.
    expect(route).toContain("https://docs.vendo.run/howto/auth");
    expect(route).not.toContain("principal");
    // Detection is silent: no question, no advisory.
    expect(sink.logs.join("\n")).not.toContain("Auth:");
  });

  it("interactive runs confirm the detected preset with one [Y/n]-style question — accept wires it", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0" },
    }));
    const asked: Array<{ question: string; defaultYes: boolean }> = [];
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      confirmAuth: async (question, defaultYes) => {
        asked.push({ question, defaultYes });
        return true; // Enter/Y
      },
    })).toBe(0);
    // The question says what is being DECIDED — whether the agent acts as the
    // person at the keyboard — not the mechanism it wires.
    expect(asked).toEqual([{ question: "Should the agent act as your signed-in Auth.js user?", defaultYes: true }]);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain("auth: authJs(),");
    expect(sink.logs.join("\n")).not.toContain("Auth:");
  });

  /** The landing prompt promises "read what it detects". Gating the read-back
      on the pretty renderer meant a terminal with CI or NO_COLOR set — still a
      human, still asked questions — opened on "How will people use your
      agent?" with nothing above it to read. */
  it("reads the detected stack back before it asks the first question", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "6.0.0" },
    }));
    const sink = output();
    let readBack = "";
    expect(await run(root, sink, {
      interactive: true,
      selectUseCase: async () => (readBack = sink.logs.join("\n"), "embedded"),
      confirmAuth: async () => true,
    })).toBe(0);
    expect(readBack).toContain("Next.js · App Router · JavaScript · npm");
    expect(readBack).toContain("Clerk auth (@clerk/nextjs)");
  });

  it("reads the detected stack back on a --yes run too", async () => {
    const sink = output();
    expect(await run(await fixture(), sink, { yes: true })).toBe(0);
    expect(sink.logs.join("\n")).toContain("Next.js · App Router · JavaScript · npm");
  });

  it("interactive decline + picking none keeps the composition anonymous and names the exact line to add later", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "6.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      confirmAuth: async () => false,
      selectAuth: async () => "none",
    })).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    // Anonymous still writes `auth:` — the one door — but as the host's OWN
    // object: no preset call, no preset import, nothing to uninstall.
    expect(route).not.toMatch(/auth: \w+\(/);
    expect(route).not.toContain("@vendoai/vendo/auth/");
    expect(route).toContain(`  auth: {\n    principal: async () => ({ kind: "user" as const, subject: "demo-user" }),\n  },\n`);
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("left anonymous");
    expect(advisories[0]).toContain("@clerk/nextjs");
    expect(advisories[0]).toContain("auth: clerk()");
    expect(advisories[0]).toContain(join("lib", "vendo.ts"));
  });

  it("--yes never asks even in an interactive run: the detected default is accepted, no picker either", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0" },
    }));
    let askedCount = 0;
    let pickedCount = 0;
    expect(await run(root, output(), {
      yes: true,
      interactive: true,
      confirmAuth: async () => {
        askedCount += 1;
        return false;
      },
      selectAuth: async () => {
        pickedCount += 1;
        return "clerk";
      },
    })).toBe(0);
    expect(askedCount).toBe(0);
    expect(pickedCount).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain("auth: authJs(),");
  });

  it("decline → picker → clerk wires clerk() and hints the missing SDK install", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0" },
    }));
    const askedSelects: Array<{ question: string; options: Array<{ value: string; label: string; hint?: string }> }> = [];
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      confirmAuth: async () => false,
      selectAuth: async (question, options) => {
        askedSelects.push({ question, options });
        return "clerk";
      },
    })).toBe(0);

    // One picker: none first (the default), detected authJs named, jwt last.
    expect(askedSelects).toHaveLength(1);
    expect(askedSelects[0]!.question).toBe("Which auth should Vendo wire?");
    const values = askedSelects[0]!.options.map((option) => option.value);
    expect(values[0]).toBe("none");
    expect(values[values.length - 1]).toBe("jwt");
    expect(askedSelects[0]!.options[1]).toMatchObject({ value: "authJs", hint: "detected next-auth" });

    // clerk() is wired exactly like a detection-accept, with an honest
    // lead-in: it was picked, not detected.
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain("auth: clerk(),");
    expect(route).toContain("// Selected Clerk — clerk() fills the identity seams");
    expect(route).not.toContain("Detected");
    expect(route).toContain("https://docs.vendo.run/howto/auth");
    expect(route).not.toContain("principal");
    // …plus one install hint, since @clerk/backend is not in package.json.
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("clerk() wired");
    expect(advisories[0]).toContain("npm install @clerk/backend");
  });

  it("decline → picker → jwt wires nothing and prints the jwt recipe", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      confirmAuth: async () => false,
      selectAuth: async () => "jwt",
    })).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    // Anonymous still writes `auth:` — the one door — but as the host's OWN
    // object: no preset call, no preset import, nothing to uninstall.
    expect(route).not.toMatch(/auth: \w+\(/);
    expect(route).not.toContain("@vendoai/vendo/auth/");
    expect(route).toContain(`  auth: {\n    principal: async () => ({ kind: "user" as const, subject: "demo-user" }),\n  },\n`);
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("auth: jwt({ secret:");
    expect(advisories[0]).toContain("https://docs.vendo.run/howto/auth");
  });

  it("ambiguous detection offers the picker with detected families first (after none)", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@supabase/supabase-js": "2.0.0", "@auth0/nextjs-auth0": "3.0.0" },
    }));
    // ENG-422: satisfied env keeps the supabase pick advisory-free here.
    await writeFile(join(root, ".env.local"), "SUPABASE_URL=http://127.0.0.1:54321\n");
    const askedSelects: Array<Array<{ value: string; hint?: string }>> = [];
    let confirmCount = 0;
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      confirmAuth: async () => {
        confirmCount += 1;
        return true;
      },
      selectAuth: async (_question, options) => {
        askedSelects.push(options);
        return "supabase";
      },
    })).toBe(0);

    // Ambiguity never gets the single-family confirm — straight to the picker.
    expect(confirmCount).toBe(0);
    expect(askedSelects).toHaveLength(1);
    expect(askedSelects[0]!.map((option) => option.value))
      .toEqual(["none", "supabase", "auth0", "authJs", "clerk", "jwt"]);
    expect(askedSelects[0]![1]).toMatchObject({ hint: "detected @supabase/supabase-js" });
    expect(askedSelects[0]![2]).toMatchObject({ hint: "detected @auth0/nextjs-auth0" });

    // The detected pick wires like a detection-accept: no advisory at all.
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain("auth: supabase(),");
    expect(sink.logs.join("\n")).not.toContain("Auth:");
  });

  it("stays anonymous and advises once when several auth providers are present", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0", "@clerk/nextjs": "6.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    // Anonymous still writes `auth:` — the one door — but as the host's OWN
    // object: no preset call, no preset import, nothing to uninstall.
    expect(route).not.toMatch(/auth: \w+\(/);
    expect(route).not.toContain("@vendoai/vendo/auth/");
    expect(route).toContain(`  auth: {\n    principal: async () => ({ kind: "user" as const, subject: "demo-user" }),\n  },\n`);
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("next-auth, @clerk/nextjs");
    expect(advisories[0]).toContain("auth: authJs() or auth: clerk()");
  });

  // Agent-install-dx: --auth answers the confirm AND the picker in one flag,
  // wiring exactly like the equivalent interactive pick — no prompt ever.
  it("--auth wires the named preset without any prompt, install hint included when the SDK is absent", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink, {
      auth: "clerk",
      interactive: true,
      confirmAuth: async () => { throw new Error("prompted"); },
      selectAuth: async () => { throw new Error("prompted"); },
    })).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain("auth: clerk(),");
    expect(route).toContain("// Selected Clerk — clerk() fills the identity seams");
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("npm install @clerk/backend");
  });

  it("--auth on the detected family wires like a detection-accept; none and jwt mirror their picks", async () => {
    const detected = await fixture();
    await writeFile(join(detected, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@supabase/supabase-js": "2.0.0" },
    }));
    // ENG-422: satisfied env keeps the detection-accept advisory-free here.
    await writeFile(join(detected, ".env.local"), "SUPABASE_URL=http://127.0.0.1:54321\n");
    const detectedSink = output();
    expect(await run(detected, detectedSink, { yes: true, auth: "supabase" })).toBe(0);
    const detectedRoute = await readFile(join(detected, "lib", "vendo.ts"), "utf8");
    expect(detectedRoute).toContain("auth: supabase(),");
    expect(detectedRoute).toContain("Detected @supabase/supabase-js");
    expect(detectedSink.logs.join("\n")).not.toContain("Auth:");

    // --auth none: stay anonymous even though detection would have wired.
    const declined = await fixture();
    await writeFile(join(declined, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0" },
    }));
    const declinedSink = output();
    expect(await run(declined, declinedSink, { yes: true, auth: "none" })).toBe(0);
    const declinedRoute = await readFile(join(declined, "lib", "vendo.ts"), "utf8");
    expect(declinedRoute).toContain('subject: "demo-user"');
    expect(declinedSink.logs.join("\n")).toContain("left anonymous");

    // --auth jwt: nothing wired, the recipe is the answer.
    const jwt = await fixture();
    const jwtSink = output();
    expect(await run(jwt, jwtSink, { yes: true, auth: "jwt" })).toBe(0);
    const jwtRoute = await readFile(join(jwt, "lib", "vendo.ts"), "utf8");
    expect(jwtRoute).toContain('subject: "demo-user"');
    expect(jwtSink.logs.join("\n")).toContain("auth: jwt({ secret:");
  });

  // Agent-install-dx: a non-interactive scaffold run is agent-driven — the
  // run ENDS with the repo-specific agent tail (the wired auth preset and
  // what's still stubbed, the exact files to hand-edit, the doctor gate),
  // every line derived from what this run actually wrote.
  /** Every fix-it text that reaches a NON-INTERACTIVE audience has to name the
      command that actually works there: a bare `vendo sync` skips the judgment
      pass unless a human answers the consent prompt, so an agent or a CI job
      following that advice runs it and nothing changes. */
  it("tells an agent to run `vendo sync --ai`, never the bare command that would skip", async () => {
    const root = await fixture();
    await mkdir(join(root, "app", "api", "customers"), { recursive: true });
    await writeFile(join(root, "app", "api", "customers", "route.ts"),
      "export async function GET() { return Response.json({ customers: [] }); }\n");
    const sink = output();
    expect(await agentRun(root, sink)).toBe(0);

    // The keyless run's judgment line…
    const logs = sink.logs.join("\n");
    expect(logs).toContain("run `vendo sync --ai` to grade the catalog");
    // The bare form never appears as advice (the sync hooks still use it with
    // their own explicit --no-ai, so scope the check to the advice lines).
    expect(logs).not.toContain("run `vendo sync` ");
  });

  // Agent-install-dx: an undetectable framework has NO safe default — a
  // non-interactive run errors with the exact flag instead of guessing the
  // Next layout into an unknown host (or hanging on a prompt it can't show).
  it("non-interactive init on an undetectable framework errors with --framework and an example", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-nofw-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { react: "19.0.0" } }));
    const sink = output();
    expect(await run(root, sink, { yes: true })).toBe(1);
    const errors = sink.errors.join("\n");
    expect(errors).toContain("--framework");
    expect(errors).toContain("vendo init --framework next"); // one example invocation
    expect(await readdir(root)).toEqual(["package.json"]); // nothing was written

    // The flag answers it: the same host scaffolds as the named framework.
    const answered = output();
    expect(await run(root, answered, { yes: true, framework: "next" })).toBe(0);
    await expect(readFile(join(root, "lib", "vendo.ts"), "utf8")).resolves.toContain("createVendo");
  });

  it("interactive init on an undetectable framework scaffolds the runtime-neutral module, never the Next layout", async () => {
    // The old fall-through guessed the Next layout into unknown hosts — the
    // exact failure that scaffolded app/api routes into a Cloudflare Worker
    // (field report 2026-07-21). Unknown now lands on the custom scaffold.
    const root = await mkdtemp(join(tmpdir(), "vendo-init-nofw-tty-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { react: "19.0.0" } }));
    const sink = output();
    expect(await run(root, sink, { interactive: true })).toBe(0);
    await expect(readFile(join(root, "vendo", "server.mjs"), "utf8"))
      .resolves.toContain("handleVendoRequest");
    await expect(readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8")).rejects.toThrow();
  });

  it("--cloud-key lands the key in .env.local and the login offer never fires", async () => {
    const root = await fixture();
    const key = `vnd_${"c".repeat(40)}`;
    const sink = output();
    let offered = 0;
    // No cloudProbe stub: the default probe must see the flag-landed key.
    expect(await runInit({
      targetDir: root,
      output: sink.output,
      env: {},
      cloudKey: key,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      cloud: {
        confirm: async () => {
          offered += 1;
          return false;
        },
      },
    })).toBe(0);
    expect(offered).toBe(0);
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain(`VENDO_API_KEY=${key}`);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Vendo Cloud: VENDO_API_KEY present and well-formed.");
    expect(logs).not.toContain("No model key yet");
  });

  it("--cloud-key upserts into an existing .env.local without dropping unrelated lines", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env.local"), "FOO=bar\n");
    const key = `vnd_${"f".repeat(40)}`;
    // No cloudProbe stub: the default probe sees the flag-landed key, so the
    // offer (which would throw here) never fires.
    expect(await run(root, output(), {
      cloudKey: key,
      cloud: { confirm: async () => { throw new Error("offered"); } },
    })).toBe(0);
    const envLocal = await readFile(join(root, ".env.local"), "utf8");
    expect(envLocal).toContain("FOO=bar");
    expect(envLocal).toContain(`VENDO_API_KEY=${key}`);
  });

  it("--byo declines the Cloud offer explicitly: no question, no mint, just the pointer", async () => {
    const root = await fixture();
    const sink = output();
    let offered = 0;
    let minted = 0;
    expect(await run(root, sink, {
      byo: true,
      cloud: {
        ...NO_CLOUD,
        confirm: async () => {
          offered += 1;
          return true;
        },
        deviceLogin: async () => {
          minted += 1;
          return 0;
        },
      },
    })).toBe(0);
    expect(offered).toBe(0);
    expect(minted).toBe(0);
    await expect(readFile(join(root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(sink.logs.join("\n")).toContain("vendo login");
  });

  it("--ai is the consent: non-interactive runs reach the harness instead of skipping", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      yes: true,
      ai: true,
      // No available harness: the gate must still OPEN (proving the
      // non-interactive skip was bypassed) and then report unavailability.
      extract: {
        harnesses: [],
        confirm: async () => { throw new Error("prompted"); },
      },
    })).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("AI polish: unavailable");
    expect(logs).not.toContain("this run cannot ask");

    // Without the flag, the non-interactive skip is unchanged.
    const skipped = await fixture();
    const skippedSink = output();
    expect(await run(skipped, skippedSink, { yes: true, extract: { harnesses: [] } })).toBe(0);
    expect(skippedSink.logs.join("\n")).toContain("this run cannot ask");
  });

  it("--theme answers an uncertain slot; the rest are kept as extracted and reported", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      ai: true,
      themeAnswers: { accent: "#facc15" },
      extract: {
        harnesses: [themeHarness({
          slots: { accent: "#196b46", text: "#111111" },
          uncertain: [
            { slot: "accent", note: "green may be data-only" },
            { slot: "border", note: "no border evidence" },
          ],
        })],
      },
    })).toBe(0);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#facc15");
    // The contrast-derived accentText follows the flag-replaced accent.
    expect(theme.colors.accentText).toBe("#000000");
    // The slot the flags left open is a FACT, not a question: it keeps what was
    // extracted and the run names it.
    expect(sink.logs.join("\n")).toContain("Kept as extracted (uncertain): border");
  });

  // Task 3(c): a --theme answer beats a model value for the same slot, even
  // when the model didn't flag it uncertain at all.
  it("--theme answers beat a model-filled value for the same slot outright", async () => {
    const root = await fixture();
    expect(await run(root, output(), {
      ai: true,
      themeAnswers: { accent: "#00ff00" },
      extract: { harnesses: [themeHarness({ slots: { accent: "#196b46", mutedText: "#908c85" } })] },
    })).toBe(0);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#00ff00");
    // The model's other fill still lands — only the contested slot changed.
    expect(theme.colors.muted).toBe("#908c85");
  });

  // Reversal (ENG-421 / #1370): the paste used to omit the overlay, and a
  // verbatim install rendered nothing — wired and invisible reads as broken,
  // while doctor E-WIRE-006 hard-fails exactly that state. One paste now
  // yields a visible agent; hosts with their own surface delete the line.
  it("states an env key in one line and skips the cloud offer", async () => {
    const root = await fixture();
    const sink = output();
    // A bare provider key selects nothing since the selection law, so a host on
    // the env-key rung got there through the internal VENDO_DEV_CREDENTIAL pin —
    // which is what keeps this line (init's REPORT of the winning rung) covered.
    expect(await run(root, sink, {
      env: { VENDO_DEV_CREDENTIAL: "env-key:anthropic", ANTHROPIC_API_KEY: "sk-a" },
    })).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Model: explicit ANTHROPIC_API_KEY (anthropic)");
    expect(logs).not.toContain("No model key yet");
    // The credential story leads the run — before the AI passes and the summary.
    expect(logs.indexOf("Model: explicit")).toBeLessThan(logs.indexOf("Wired ("));
  });

  /** SPEC 4b: a provider key in the environment is a CREDENTIAL now — it no
      longer selects a model by itself. Init detected the key, so init writes
      the explicit selection into the composition it authors; without it a host
      that "just worked" off an ambient key would fail on its first boot. */
  it("writes the models line and its import once into the route it authors, and names the file", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      env: { ANTHROPIC_API_KEY: "sk-a" },
      installProvider: async () => 0,
    })).toBe(0);

    const compositionPath = join("lib", "vendo.ts");
    const composition = await readFile(join(root, compositionPath), "utf8");
    expect(composition).toContain(`import { anthropic } from "@ai-sdk/anthropic";`);
    expect(composition).toContain(`  models: { default: anthropic("claude-sonnet-4-6") }, // ANTHROPIC_API_KEY supplies the key`);
    expect(composition.match(/@ai-sdk\/anthropic/g)).toHaveLength(1);
    expect(composition.match(/models:/g)).toHaveLength(1);

    expect(sink.logs.join("\n")).toContain(`models: anthropic — written into ${compositionPath}`);
  });

  /** A key that only ever lived in .env.local counts the same way — it is the
      same key the runtime will read, and the ONLY reason the old ambient
      behaviour looked like it worked. */
  it("counts a provider key that lives only in .env.local", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env.local"), 'ANTHROPIC_API_KEY="sk-ant-local"\n');
    const sink = output();
    expect(await run(root, sink, { installProvider: async () => 0 })).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain(`models: { default: anthropic("claude-sonnet-4-6") }`);
  });

  /** `vendo init --byo` asks for a provider key and lands it in .env.local — but
      the ceremony runs AFTER the composition was planned, so the key used to be
      saved into a run that had already authored a keyless composition: a key that
      selected nothing, in a file the same run reported as wired. Real cloud step,
      real paste, real file on disk — only the TTY and the secret prompt are
      seams. */
  it("--byo: a key pasted mid-run still lands in the composition it authored", async () => {
    const root = await fixture();
    const installs: Array<{ args: string[] }> = [];
    const sink = output();
    expect(await run(root, sink, {
      byo: true,
      cloud: { ...NO_CLOUD, isTty: true, askSecret: async () => "sk-ant-api03-pasted" },
      installProvider: async (_command, args) => {
        installs.push({ args });
        return 0;
      },
    })).toBe(0);

    // The re-render's provider is also the one that gets INSTALLED — a written
    // import the host cannot resolve is the same dead end one file over.
    expect(installs).toEqual([{ args: ["install", "ai@^6", "@ai-sdk/anthropic@^3"] }]);

    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-api03-pasted");
    const compositionPath = join("lib", "vendo.ts");
    const composition = await readFile(join(root, compositionPath), "utf8");
    expect(composition).toContain(`import { anthropic } from "@ai-sdk/anthropic";`);
    expect(composition).toContain(`  models: { default: anthropic("claude-sonnet-4-6") }, // ANTHROPIC_API_KEY supplies the key`);
    // Exactly once, and the run says where — never the dead-end advice.
    expect(composition.match(/models:/g)).toHaveLength(1);
    const logs = sink.logs.join("\n");
    expect(logs).toContain(`models: anthropic — written into ${compositionPath}`);
    expect(logs).not.toContain("No model key yet");
  });

  /** The same contradiction one step later: a provider key in the environment
      resolves to `rung: "none"` since the selection law, so the closing summary
      printed "No model key yet" directly under the models line it had just
      written into the file. */
  it("never advises a model key on a run that wrote the models line", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      env: { ANTHROPIC_API_KEY: "sk-a" },
      installProvider: async () => 0,
    })).toBe(0);
    expect(sink.logs.join("\n")).not.toContain("No model key yet");
  });

  /** The import init writes has to RESOLVE when the host builds. `ensureProviderDeps`
      asked the runtime credential which provider to install, and since the
      selection law a bare OPENAI_API_KEY is `rung: "none"` — so init wrote
      `import { openai } from "@ai-sdk/openai"` and installed nothing, leaving a
      generated app that cannot resolve its own import. Whole path, one run: the
      real scaffold decides, the real install seam records. */
  it.each([
    ["OPENAI_API_KEY", "openai", "@ai-sdk/openai@^3"],
    ["GOOGLE_GENERATIVE_AI_API_KEY", "google", "@ai-sdk/google@^3"],
  ])("installs the provider it wrote for a bare %s", async (envVar, provider, spec) => {
    const root = await fixture();
    const installs: Array<{ args: string[] }> = [];
    const sink = output();
    expect(await run(root, sink, {
      env: { [envVar]: "sk-test" },
      installProvider: async (_command, args) => {
        installs.push({ args });
        return 0;
      },
    })).toBe(0);

    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain(`import { ${provider} } from "@ai-sdk/${provider}";`);
    // The import is written AND the dependency that satisfies it is installed.
    expect(installs).toEqual([{ args: ["install", "ai@^6", spec] }]);
  });

  it("leaves a keyless host's route model-free — no line, no dangling import", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).not.toContain("@ai-sdk/");
    expect(route).not.toContain("models:");
    const logs = sink.logs.join("\n");
    expect(logs).not.toContain("models: anthropic");
    expect(logs).toContain("No model key yet");
  });

  /** The MCP arm re-renders the SAME composition module the wire route already
      imports, so the line lands there — and the summary must name THAT file.
      Naming route.ts here would send the reader to a file with no `models:` in
      it (the bug this pins). */
  it("keeps the models line in the composition the MCP arm re-renders, and names that file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-mcp-models-"));
    cleanup.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "mcp-host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" },
    }));
    await writeFile(join(root, "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    const sink = output();
    expect(await run(root, sink, {
      useCase: "mcp",
      yes: true,
      auth: "clerk",
      baseUrl: "https://app.acme.com",
      env: { ANTHROPIC_API_KEY: "sk-a" },
      installProvider: async () => 0,
    })).toBe(0);

    const wiringDir = join(root, "app", "api", "vendo", "[...vendo]");
    const route = await readFile(join(wiringDir, "route.ts"), "utf8");
    // The thin route carries neither half — it composes nothing at all.
    expect(route).toContain(`import { vendo } from ${JSON.stringify(LIB_VENDO(4))};`);
    expect(route).not.toContain("@ai-sdk/");
    expect(route).not.toContain("models:");

    const composition = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(composition).toContain(`import { anthropic } from "@ai-sdk/anthropic";`);
    expect(composition).toContain(`  models: { default: anthropic("claude-sonnet-4-6") }, // ANTHROPIC_API_KEY supplies the key`);
    expect(composition).toContain('mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },');
    // One selection per host, across BOTH files init wrote on this path.
    expect(`${route}${composition}`.match(/models:/g)).toHaveLength(1);
    expect(`${route}${composition}`.match(/@ai-sdk\/anthropic/g)).toHaveLength(1);
    // The discovery route reaches the SAME module (instance identity is how
    // wellKnownVendoHandler resolves its path set).
    await expect(readFile(join(root, "app", ".well-known", "[...vendo]", "route.ts"), "utf8"))
      .resolves.toContain(`import { vendo } from ${JSON.stringify(LIB_VENDO(3))};`);

    // The summary names the composition module, not the route that imports it.
    expect(sink.logs.join("\n")).toContain(`models: anthropic — written into ${join("lib", "vendo.ts")}`);
  });

  /** A Cloud key is not a provider key: its models resolve through the
      gateway's own family names, so nothing is written for it. */
  it("writes nothing for a Vendo Cloud key", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      env: { VENDO_API_KEY: `vnd_${"c".repeat(40)}` },
      installProvider: async () => 0,
    })).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).not.toContain("@ai-sdk/");
    expect(route).not.toContain("models:");
    expect(sink.logs.join("\n")).not.toContain("written into");
  });

  it("points a keyless host at .env.local and `vendo login`", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("No model key yet");
    expect(logs).toContain("vendo login");
    // The Cloud offer runs FIRST (before theme capture and the wired summary);
    // the end of the run keeps only the short one-line reminder.
    expect(logs.indexOf("Vendo Cloud")).toBeLessThan(logs.indexOf("Theme:"));
    expect(logs.indexOf("Vendo Cloud")).toBeLessThan(logs.indexOf("Wired ("));
    expect(logs.indexOf("No model key yet")).toBeGreaterThan(logs.indexOf("Wired ("));
    expect(logs.match(/Vendo Cloud \(optional\)/g)).toHaveLength(1);
  });

  it("a starter key minted mid-run lands in .env.local and suppresses the end-of-run reminder", async () => {
    // Task 4: theme finalization no longer runs its own model resolution
    // (devModel/generateObject) — a freshly minted key now only matters to
    // the consent-gated AI-polish harness ladder, exercised elsewhere. This
    // keeps the mint → .env.local → "no key" reminder story covered here.
    const root = await fixture();
    const sink = output();
    const key = `vnd_${"a".repeat(40)}`;
    expect(await run(root, sink, {
      cloud: {
        cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance"] as readonly string[] }),
        confirm: async () => true,
        deviceLogin: async () => {
          await writeFile(join(root, ".env.local"), `VENDO_API_KEY=${key}\n`);
          return 0;
        },
      },
    })).toBe(0);

    expect(await readFile(join(root, ".env.local"), "utf8")).toContain(`VENDO_API_KEY=${key}`);
    const logs = sink.logs.join("\n");
    // A key now exists — the end-of-run reminder is suppressed.
    expect(logs).not.toContain("No model key yet");
  });

  it("preserves an existing env example while appending the trusted Vendo origin once", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env.example"), "HOST_FLAG=1\n");
    expect(await run(root, output())).toBe(0);
    const example = await readFile(join(root, ".env.example"), "utf8");
    expect(example).toContain("HOST_FLAG=1");
    expect(example).toContain("VENDO_BASE_URL=http://localhost:3000");
    // The line is an INSTRUCTION now, not a value to fill in at init: dev was
    // answered into .env.local, production is set where the app deploys, and a
    // public URL belongs in neither this file nor .env.local. The security
    // phrasing is unchanged — the behaviour it describes did not change.
    expect(example).toContain("Dev is already done");
    expect(example).toContain("wrote your");
    expect(example).toContain("platform's environment settings to the public URL");
    expect(example).toContain("in neither a committed file nor .env.local");
    expect(example).toContain("Production fails loud without it");
    expect(example).not.toContain("disabled without it");
    expect(await run(root, output())).toBe(0);
    // The ASSIGNMENT, not the name: the block's comment names the variable too,
    // and what must never double is the line.
    expect((await readFile(join(root, ".env.example"), "utf8")).match(/^VENDO_BASE_URL=/gm)).toHaveLength(1);
  });

  /** The illustrative line used to name :3000 on every host, so a dev on
      another port read a base URL that pointed at nothing. */
  it("names the host's OWN dev port in .env.example, and no answer ever rewrites that file", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0" },
      scripts: { dev: "next dev -p 4000" },
    }));
    expect(await run(root, output())).toBe(0);
    expect(await readFile(join(root, ".env.example"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:4000");

    // The dev answer lands in .env.local. .env.example is documentation now, so
    // a run that captures an answer leaves it byte for byte.
    expect(await run(root, output(), { baseUrl: "http://localhost:4100" })).toBe(0);
    expect(await readFile(join(root, ".env.example"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:4000");
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:4100");
  });

  it("merges the sync hooks into existing scripts without clobbering them", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0" },
      scripts: { dev: "next dev", predev: "echo pre" },
    }, null, 2));
    expect(await run(root, output())).toBe(0);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts.predev).toBe("vendo sync --no-ai && echo pre");
    expect(manifest.scripts.prebuild).toBe("vendo sync --strict --no-ai");
    expect(manifest.scripts.dev).toBe("next dev");
  });

  it("generates the server-action registration map and the wired route on a fresh install (ENG-248)", async () => {
    const root = await fixture();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "invoices.ts"),
      '"use server";\n\nexport async function createInvoice(input: { amount: number }) {\n  return { ok: true, amount: input.amount };\n}\n');
    const sink = output();
    expect(await run(root, sink)).toBe(0);

    // The map lives NEXT TO the composition that imports it.
    const actions = await readFile(join(root, "lib", "vendo-actions.ts"), "utf8");
    expect(actions).toContain("createInvoice");
    const composition = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(composition).toContain('import { serverActions } from "./vendo-actions";');
    expect(composition).toContain("serverActions,");
  });

  it("never regenerates an existing composition or vendo-actions.ts, and says nothing about either", async () => {
    const libDir = "lib";
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    const routePath = join(root, libDir, "vendo.ts");
    const routeBefore = await readFile(routePath, "utf8");

    // Actions appear AFTER the route was generated: the wiring the route now
    // needs is the developer's paste, and the route on disk does not move.
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    const second = output();
    expect(await run(root, second)).toBe(0);
    expect(await readFile(routePath, "utf8")).toBe(routeBefore);
    // Init states facts and links out: the wiring gap is doctor's to grade
    // (E-WIRE-009), so no snippet is printed here.
    expect(second.logs.join("\n")).not.toContain("serverActions,");

    // The map that run CREATED now exists, so a surface change afterwards is a
    // printed paste of ONLY the missing entries — the file stays byte-identical,
    // and the alias continues the file's own numbering (action0 is taken).
    const mapPath = join(root, libDir, "vendo-actions.ts");
    const mapBefore = await readFile(mapPath, "utf8");
    expect(mapBefore).toContain("later");
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function renamed() {\n  return 1;\n}\n');
    const third = output();
    expect(await run(root, third)).toBe(0);
    expect(await readFile(mapPath, "utf8")).toBe(mapBefore);
    expect(await readFile(routePath, "utf8")).toBe(routeBefore);
    const thirdLogs = third.logs.join("\n");
    // Nothing is printed for either file: they are the developer's, and doctor
    // is what grades the missing registration.
    expect(thirdLogs).not.toContain("action1");
    expect(thirdLogs).not.toContain("--- a/");
  });

  // Regression (review B2): the map is compared by the KEYS it registers, never
  // byte-for-byte. A host carrying a previous release's generated map — whose
  // header comment Vendo has since reworded — must hear nothing at all while
  // its action surface is unchanged, or every existing install nags forever
  // with a "the surface moved" message that is simply false.
  it("says nothing about a map whose surface is unchanged, however far its text has drifted", async () => {
    const routeDir = "lib";
    const root = await fixture();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    expect(await run(root, output())).toBe(0);
    const mapPath = join(root, routeDir, "vendo-actions.ts");

    // A previous release's header, plus a hand edit of exactly the kind the new
    // header invites ("yours from here"): a comment, and a reordered import.
    const drifted = [
      "/**",
      " * Server-action registration map — generated by `vendo init`; re-run init",
      ' * when the "use server" surface changes.',
      " */",
      '// our own note: keep this in sync with the ops runbook',
      `import { later as handler } from ${JSON.stringify(ACTION_SPECIFIER)};`,
      "",
      "export const serverActions = {",
      '  "app/actions/later.ts#later": handler,',
      "};",
      "",
    ].join("\n");
    await writeFile(mapPath, drifted);
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    expect(await readFile(mapPath, "utf8")).toBe(drifted);
    const logs = sink.logs.join("\n");
    expect(logs).not.toContain(`File: ${join(routeDir, "vendo-actions.ts")}`);
    expect(logs).not.toContain("not registered here");
  });

  // Regression (review 4): a tool a human disabled in overrides.json is one the
  // runtime will never dispatch, so demanding its registration is a nag for
  // work that buys nothing. Init and doctor resolve the same live set.
  it("does not demand registration of an action disabled in overrides.json", async () => {
    const routeDir = "lib";
    const root = await fixture();
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    expect(await run(root, output())).toBe(0);
    const mapPath = join(root, routeDir, "vendo-actions.ts");
    const mapBefore = await readFile(mapPath, "utf8");

    // A SECOND action appears and is immediately disabled by a human. It is
    // never dispatched, so its absence from the map costs nothing — init must
    // not ask for it.
    await writeFile(join(root, "app", "actions", "internal.ts"),
      '"use server";\n\nexport async function internal() {\n  return 2;\n}\n');
    const overrides = JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8")) as {
      tools: Record<string, { disabled: boolean }>;
    };
    const { tools } = await extractServerActions(root);
    for (const tool of tools.filter((entry) =>
      entry.binding.kind === "server-action" && entry.binding.module.endsWith("internal.ts"))) {
      overrides.tools[tool.name] = { disabled: true };
    }
    await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify(overrides, null, 2));

    const sink = output();
    expect(await run(root, sink)).toBe(0);
    expect(await readFile(mapPath, "utf8")).toBe(mapBefore);
    // The coverage line is a REPORT, not a demand: it names every tool whose
    // schema nothing could read, disabled or not. Everything else init prints
    // about this action would be the nag this test forbids.
    const logs = sink.logs.filter((line) => !line.startsWith("tool schemas:")).join("\n");
    expect(logs).not.toContain(`File: ${join(routeDir, "vendo-actions.ts")}`);
    expect(logs).not.toContain("internal");
  });

  it("leaves a hand-customized route that passes its own serverActions untouched (no conflicting import)", async () => {
    const root = await fixture();
    const routeDir = join(root, "app", "api", "vendo", "[...vendo]");
    await mkdir(routeDir, { recursive: true });
    // A host that relocated the map: local `const serverActions` passed to
    // createVendo. Injecting `import { serverActions } from "./vendo-actions"`
    // here would conflict with the local declaration and break the build.
    const custom = [
      'import { createVendo } from "@vendoai/vendo/server";',
      "",
      "const serverActions = { later: async () => 1 };",
      "",
      "const vendo = createVendo({",
      "  serverActions,",
      "});",
      "",
      "export const { GET, POST } = vendo;",
      "",
    ].join("\n");
    await writeFile(join(routeDir, "route.ts"), custom);
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    expect(await run(root, output())).toBe(0);
    const route = await readFile(join(routeDir, "route.ts"), "utf8");
    expect(route).not.toContain('from "./vendo-actions"');
    expect(route).toBe(custom);
  });

  it("scaffolds an unwired Express host (server only, no model module) and leaves a wired one untouched", async () => {
    const unwired = await expressFixture(false);
    const sink = output();
    expect(await run(unwired, sink)).toBe(0);
    const server = await readFile(join(unwired, "vendo", "server.ts"), "utf8");
    expect(server).toContain("createVendo({");
    expect(server).not.toContain("model");
    await expect(readFile(join(unwired, "vendo", "registry.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(unwired, "vendo", "ai.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    // The mount lines live on the continue page, never in the terminal.
    expect(sink.logs.join("\n")).not.toContain("mountVendo()");
    // Fresh composition creation with no auth dependency: one calm advisory.
    expect(sink.logs.join("\n")).toContain("Auth: no provider detected");

    const wired = await expressFixture(true);
    expect(await run(wired, output())).toBe(0);
    const first = await tree(wired);
    expect(await run(wired, output())).toBe(0);
    expect(await tree(wired)).toEqual(first);
    await expect(readFile(join(wired, "vendo", "server.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(wired, "vendo", "registry.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("activates the init-written policy file in both scaffolds: destructive asks, reads run", async () => {
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    const route = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(route).toContain("guard: guard({ policy: {} }),");

    const express = await expressFixture(false);
    expect(await run(express, output())).toBe(0);
    const server = await readFile(join(express, "vendo", "server.ts"), "utf8");
    expect(server).toContain("guard: guard({ policy: {} }),");

    // End to end: the config the scaffold passes plus the file init wrote
    // really produce the documented posture (destructive asks, reads run).
    const store = createStore({ dataDir: join(root, ".vendo", "data") });
    await store.ensureSchema();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const guard = createGuard({ store, policy: {} });
      const destructive: ToolDescriptor = {
        name: "host_delete",
        description: "destructive fixture tool",
        inputSchema: { type: "object", additionalProperties: true },
        risk: "destructive",
      };
      const read: ToolDescriptor = {
        name: "host_read",
        description: "read fixture tool",
        inputSchema: { type: "object", additionalProperties: true },
        risk: "read",
      };
      const ctx: RunContext = {
        principal: { kind: "user", subject: "user_1", display: "User" },
        venue: "chat",
        presence: "present",
        sessionId: "session_1",
      };
      await expect(guard.check({ id: "call_1", tool: destructive.name, args: {} }, destructive, ctx))
        .resolves.toMatchObject({ action: "ask", decidedBy: "rule" });
      await expect(guard.check({ id: "call_2", tool: read.name, args: {} }, read, ctx))
        .resolves.toMatchObject({ action: "run", decidedBy: "rule" });

      // ENG-370 hardening line: vendo_knowledge_* over MCP asks even though
      // the tool is read-class — the rule must outrank read→run (first match
      // wins). Everywhere else the same tool keeps the read posture.
      const knowledgeSearch: ToolDescriptor = {
        name: "vendo_knowledge_search",
        description: "knowledge fixture tool",
        inputSchema: { type: "object", additionalProperties: true },
        risk: "read",
      };
      await expect(guard.check({ id: "call_mcp", tool: knowledgeSearch.name, args: {} }, knowledgeSearch, { ...ctx, venue: "mcp" }))
        .resolves.toMatchObject({ action: "ask", decidedBy: "rule" });
      await expect(guard.check({ id: "call_chat", tool: knowledgeSearch.name, args: {} }, knowledgeSearch, ctx))
        .resolves.toMatchObject({ action: "run", decidedBy: "rule" });

      // The documented edge (quickstart/install): deleting the init-written
      // file while keeping `policy: {}` degrades to the guard's own blank
      // state WITHOUT the unconfigured notice — the default file is read
      // fail-soft, and status() reads any policy object as configured. What
      // the blank state means is the guard's to say, and for a destructive
      // tool it says ask (`default`, not the file's `rule`) — so losing the
      // file costs the audit trail's attribution, never the consent.
      await rm(join(root, ".vendo", "policy.json"));
      const fileless = createGuard({ store, policy: {} });
      await expect(fileless.check({ id: "call_3", tool: destructive.name, args: {} }, destructive, ctx))
        .resolves.toMatchObject({ action: "ask", decidedBy: "default" });
      await expect(fileless.check({ id: "call_4", tool: read.name, args: {} }, read, ctx))
        .resolves.toMatchObject({ action: "run", decidedBy: "default" });
      expect(fileless.status()).toEqual({ posture: "rules" });
    } finally {
      process.chdir(cwd);
      await store.close();
    }
  });

  it("re-init on a scaffolded, not-yet-client-wired Express host changes nothing and stays silent", async () => {
    const root = await expressFixture(false);
    expect(await run(root, output())).toBe(0);
    const first = await tree(root);
    const again = output();
    expect(await run(root, again)).toBe(0);
    expect(await tree(root)).toEqual(first);
    const logs = again.logs.join("\n");
    expect(logs).toContain("Already wired — nothing to change.");
    // The advisory fires only when the composition is created, never on the
    // re-run between scaffold and the manual <VendoProvider> paste.
    expect(logs).not.toContain("Auth:");
  });

  it("leaves a hand-wired Express composition at a custom path alone", async () => {
    const root = await expressFixture(false);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "agent.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ principal: async () => null });\n');
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    // No duplicate server module and no advisory about a composition init
    // does not own.
    await expect(readFile(join(root, "vendo", "server.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    const logs = sink.logs.join("\n");
    expect(logs).not.toContain("Auth:");
  });

  it("uses an ESM scaffold when an Express host has no tsconfig", async () => {
    const root = await expressFixture(false);
    await rm(join(root, "tsconfig.json"));
    expect(await run(root, output())).toBe(0);
    const server = await readFile(join(root, "vendo", "server.mjs"), "utf8");
    expect(server).not.toContain(": Headers");
    expect(server).toContain("mountVendo");
    await expect(readFile(join(root, "vendo", "registry.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes the setup skill silently when .claude exists and respects an edited copy", async () => {
    const root = await fixture();
    await mkdir(join(root, ".claude"), { recursive: true });
    expect(await run(root, output())).toBe(0);
    const skill = join(root, ".claude", "skills", "vendo-setup", "SKILL.md");
    const body = await readFile(skill, "utf8");
    expect(body.length).toBeGreaterThan(0);

    await writeFile(skill, "edited by host\n");
    expect(await run(root, output())).toBe(0);
    expect(await readFile(skill, "utf8")).toBe("edited by host\n");
  });

  it("extracts host CSS variables into the Vendo theme as concrete values", async () => {
    const root = await fixture();
    // hex, shadcn hsl triple behind a var() chain, oklch, rem radius — all
    // resolve to concrete hex/px (the jail knows no host custom properties).
    await writeFile(join(root, "app", "globals.css"),
      ":root { --background: #fafafa; --brand-hue: 262 83% 58%; --primary: hsl(var(--brand-hue)); " +
      "--primary-foreground: #ffffff; --foreground: oklch(0.205 0 0); --card: 0 0% 100%; " +
      "--border: #dedede; --destructive: #b91c1c; --font-heading: Newsreader, serif; " +
      "--density: compact; --motion: reduced; --radius: 0.625rem; }\n");
    expect(await run(root, output(), { yes: true })).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"))).toMatchObject({
      colors: {
        background: "#fafafa",
        accent: "#7c3bed",
        accentText: "#ffffff",
        border: "#dedede",
        danger: "#b91c1c",
        text: "#171717",
        surface: "#ffffff",
      },
      typography: { headingFamily: "Newsreader, serif" },
      radius: { medium: "10px" },
      density: "compact",
      motion: "reduced",
    });
  });

  // Task 4(a): without consent (no --ai, not interactive), theme
  // finalization never reaches the harness at all — exact reads and visible
  // defaults are the whole story.
  it("a non-consented run finalizes the theme from exact reads and defaults, with zero model involvement", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "globals.css"), ":root { --primary: #2b7fff; --border: #e5e7eb; }\n");
    let harnessCalled = false;
    const sink = output();
    expect(await run(root, sink, {
      extract: {
        harnesses: [{
          id: "spy",
          availability: async () => { harnessCalled = true; return "spy"; },
          run: async () => { throw new Error("must never run without consent"); },
        }],
      },
    })).toBe(0);
    expect(harnessCalled).toBe(false);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#2b7fff"); // exact read
    expect(theme.colors.border).toBe("#e5e7eb"); // exact read
    expect(theme.colors.background).toBe("#ffffff"); // no evidence — neutral default
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Theme:");
    expect(logs).toContain("No host evidence for");
  });

  // Task 4(e): the never-overwrite law holds even when this run has consent
  // and a harness that WOULD fill brand slots — a pre-existing theme.json
  // stays the sole source of truth.
  it("never touches a pre-existing theme.json, even with AI-polish consent and a theme-filling harness", async () => {
    const root = await fixture();
    await mkdir(join(root, ".vendo"), { recursive: true });
    const existing = `${JSON.stringify({ colors: { accent: "#123456" } }, null, 2)}\n`;
    await writeFile(join(root, ".vendo", "theme.json"), existing);
    const sink = output();
    expect(await run(root, sink, {
      ai: true,
      extract: { harnesses: [themeHarness({ slots: { accent: "#ff0000" } })] },
    })).toBe(0);
    expect(await readFile(join(root, ".vendo", "theme.json"), "utf8")).toBe(existing);
    expect(sink.logs.join("\n")).not.toContain("Theme:");
  });

  // Task 4(f): the consent prompt now covers theme too, not just tools.
  it("the AI-polish consent prompt mentions theme alongside tools, risk, and the brief", async () => {
    const root = await fixture();
    const questions: string[] = [];
    const sink = output();
    expect(await run(root, sink, {
      extract: {
        // The extract-level seam's own `interactive`, distinct from init's —
        // it just needs to reach the confirm() call without granting consent.
        interactive: true,
        harnesses: [themeHarness({ slots: {} })],
        confirm: async (question) => { questions.push(question); return true; },
      },
    })).toBe(0);
    expect(questions[0]).toContain("theme");
  });

  // A clean model reply names no uncertain slot, so the facts carry no
  // kept-as-extracted line at all.
  it("says nothing about uncertainty when the model reports none", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      ai: true,
      extract: { harnesses: [themeHarness({ slots: { accent: "#2b7fff" } })] },
    })).toBe(0);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#2b7fff");
    expect(sink.logs.join("\n")).not.toContain("Kept as extracted");
  });

  it("derives an applied next/font family deterministically — the model's fontFamily proposal never overrides it — and prints the one-glance summary", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      'import "./global.css";\n' +
      'import { Inter as FontSans } from "next/font/google";\n' +
      'const fontSans = FontSans({ variable: "--font-sans" });\n' +
      'export default function Layout({ children }) { return <html><body className={`font-sans ${fontSans.variable}`}>{children}</body></html>; }\n');
    await writeFile(join(root, "app", "global.css"),
      '@import "./tokens.css";\n' +
      ':root { --font-body: var(--font-sans); }\n');
    await writeFile(join(root, "app", "tokens.css"),
      ':root { --background: #fafafa; --card: #ffffff; --foreground: #171717; ' +
      '--muted-foreground: #737373; --primary: #2b7fff; --radius: 0.375rem; }\n');

    const sink = output();
    expect(await run(root, sink, {
      yes: true,
      ai: true,
      // The model still proposes a fontFamily — it must be IGNORED: the
      // aliased next/font import (Inter as FontSans, applied on the body)
      // derives deterministically, and exact-derived reads are never
      // overwritten (font-stack.ts; extraction-quality-1 lane).
      extract: { harnesses: [themeHarness({ slots: { fontFamily: "Comic Sans MS, fantasy" } })] },
    })).toBe(0);

    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"))).toMatchObject({
      colors: { background: "#fafafa", surface: "#ffffff", text: "#171717", muted: "#737373", accent: "#2b7fff" },
      // The source declares no fallback tail, so the derived stack is the
      // bare family plus the generic — full source-declared stack semantics.
      typography: { fontFamily: "Inter, sans-serif" },
      radius: { medium: "6px" },
    });
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Theme: accent #2b7fff");
    expect(logs).toContain(".vendo/theme.json");
  });

  it("keeps an uncertain slot as extracted, reports it, and still honours a --theme answer", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n');
    await writeFile(join(root, "app", "globals.css"),
      ":root { --color-ink: #111111; --color-evergreen-600: #196b46; }\n");

    const sink = output();
    expect(await run(root, sink, {
      ai: true,
      extract: {
        harnesses: [themeHarness({
          slots: { accent: "#196b46", text: "#111111" },
          uncertain: [{ slot: "accent", note: "green may be data-only" }],
        })],
      },
      themeAnswers: { accent: "#facc15", border: "#ecebe8", danger: "chartreuse-ish", sparkle: "#123456" },
    })).toBe(0);

    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    // The human answer wins; invalid values and unknown slots are ignored.
    expect(theme.colors.accent).toBe("#facc15");
    expect(theme.colors.border).toBe("#ecebe8");
    expect(theme.colors.danger).toBe("#dc2626");
    expect(theme.colors.text).toBe("#111111");
    expect(sink.errors.join("\n")).toContain('unknown theme slot "sparkle"');
    // The contrast-derived accentText follows the replaced accent.
    expect(theme.colors.accentText).toBe("#000000");
  });

  it("the cloud step honors the run's env: a supplied VENDO_API_KEY skips the offer", async () => {
    const root = await fixture();
    const sink = output();
    let offered = 0;
    // No cloudProbe stub: the default probe must see the RUN's env (not
    // process.env) and report the programmatically supplied key.
    expect(await runInit({
      targetDir: root,
      output: sink.output,
      env: { VENDO_API_KEY: `vnd_${"b".repeat(40)}` },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      cloud: {
        confirm: async () => {
          offered += 1;
          return false;
        },
      },
    })).toBe(0);
    expect(offered).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Vendo Cloud: VENDO_API_KEY present and well-formed.");
    expect(logs).not.toContain("No model key yet");
  });

  it("a starter key from a PRIOR run's .env.local counts: no offer, no reminder", async () => {
    const root = await fixture();
    const key = `vnd_${"d".repeat(40)}`;
    await writeFile(join(root, ".env.local"), `VENDO_API_KEY=${key}\n`);
    const sink = output();
    let offered = 0;
    expect(await run(root, sink, {
      cloud: {
        confirm: async () => {
          offered += 1;
          return false;
        },
      },
    })).toBe(0);

    expect(offered).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Vendo Cloud: VENDO_API_KEY present and well-formed.");
    expect(logs).not.toContain("No model key yet");
  });

  it("reads quoted .env.local values per dotenv semantics: quotes stripped, inline comments dropped", async () => {
    const root = await fixture();
    const key = `vnd_${"e".repeat(40)}`;
    // Hand-authored .env.local entries are commonly quoted and commented —
    // Next.js's dotenv loader strips both, so init's merge must too or the
    // literal quoted string poisons every credential consumer.
    await writeFile(join(root, ".env.local"), [
      'ANTHROPIC_API_KEY="sk-ant-quoted"',
      "OPENAI_API_KEY=sk-openai-plain # dev key",
      `VENDO_API_KEY='${key}'`,
      "",
    ].join("\n"));
    const seenEnv: Array<Record<string, string | undefined>> = [];
    const installs: Array<{ command: string; args: string[] }> = [];
    const sink = output();
    expect(await runInit({
      targetDir: root,
      output: sink.output,
      env: {},
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      resolveCredential: async ({ env }) => {
        seenEnv.push(env);
        return { rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" };
      },
      installProvider: async (command, args) => {
        installs.push({ command, args });
        return 0;
      },
      cloud: { confirm: async () => false },
    })).toBe(0);
    // A resolved credential installs the provider its runtime ladder loads
    // (0.4.2): the fixture resolves neither ai nor @ai-sdk/anthropic.
    expect(installs).toEqual([{ command: "npm", args: ["install", "ai@^6", "@ai-sdk/anthropic@^3"] }]);
    expect(seenEnv[0]?.ANTHROPIC_API_KEY).toBe("sk-ant-quoted");
    expect(seenEnv[0]?.OPENAI_API_KEY).toBe("sk-openai-plain");
    expect(seenEnv[0]?.VENDO_API_KEY).toBe(key);
    // The default cloud probe sees the unquoted key: well-formed, not "malformed".
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Vendo Cloud: VENDO_API_KEY present and well-formed.");
    expect(sink.errors.join("\n")).not.toContain("not usable");
  });


  /** #1153: init writes `@vendoai/vendo/*` imports into the route it just
      created, so it owes the host a resolvable @vendoai/vendo. A host that
      installed only the `vendoai` alias keeps that package inside the alias's
      own nested resolution — under pnpm the route never compiles and every
      wired request 500s, which doctor's live probes could only report as an
      unreachable server. */
  it("adds @vendoai/vendo when the host installed only the vendoai alias", async () => {
    const root = await fixture();
    await mkdir(join(root, "node_modules", "vendoai"), { recursive: true });
    await writeFile(join(root, "node_modules", "vendoai", "package.json"),
      JSON.stringify({ name: "vendoai", version: CLI_VERSION }));
    const installs: Array<{ command: string; args: string[] }> = [];
    const sink = output();
    expect(await run(root, sink, {
      installVendo: async (command, args) => {
        installs.push({ command, args });
        return 0;
      },
    })).toBe(0);
    expect(installs).toEqual([{ command: "npm", args: ["install", `@vendoai/vendo@${CLI_VERSION}`] }]);
    expect(await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .toContain(`from "@vendoai/vendo/server"`);
  });
});

/** One personality for init in every mode: detect, ask, log in, write. Agent
    mode only changes how the questions TRAVEL — out as JSON, back as flags on
    a re-run. The read-only plan dump it replaces is gone: there is no mode that
    prints code diffs and stops. */
describe("vendo init --agent (ask first, then write)", () => {
  it("asks and writes NOTHING, then writes on the re-run that carries the answers", async () => {
    const root = await fixture();
    const before = await tree(root);
    const sink = output();

    expect(await run(root, sink, { agent: true })).toBe(0);
    const asked = questionsOf(sink.logs);
    expect(asked.status).toBe("questions");
    expect(asked.detected.framework).toBe("next");
    expect(asked.questions.map((question) => question.id)).toEqual(["use-case", "auth", "models", "dev-url"]);
    // The prompts are chat copy, relayed verbatim: each option carries the
    // literal thing the agent does to pick it.
    expect(asked.questions[0]?.prompt).toContain("real working screens from your data");
    expect(asked.questions[0]?.options[0]).toMatchObject({ flag: "--use-case embedded", recommended: true });
    expect(asked.questions[2]?.options[0]?.command).toBe("npx vendo login --wait 90");
    expect(asked.questions[2]?.options[1]?.flag).toBe("--byo");
    // The dev URL travels like the rest: the recommended option carries the
    // host's own dev port, so relaying it costs the reader one word.
    expect(asked.questions[3]?.prompt).toContain("Vendo writes it to .env.local as VENDO_BASE_URL");
    expect(asked.questions[3]?.options[0])
      .toMatchObject({ flag: "--base-url http://localhost:3000", recommended: true });
    // The mechanical answers never surface: they default like --yes and show
    // up in the diff.
    const ids = asked.questions.map((question) => question.id).join(" ");
    expect(ids).not.toContain("theme");
    expect(ids).not.toContain("check");
    expect(await tree(root)).toEqual(before); // the ask pass wrote nothing

    const wrote = output();
    expect(await agentRun(root, wrote)).toBe(0);
    expect(await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .toContain(`from "@vendoai/vendo/server"`);
  });

  it("writes in ONE pass when the first call already carries every answer", async () => {
    const root = await fixture();
    const sink = output();
    expect(await agentRun(root, sink)).toBe(0);
    const receipt = receiptOf(sink.logs);
    expect(receipt).toMatchObject({
      status: "written",
      root,
      useCase: "embedded",
      judgment: {
        status: "delegated",
        checklist: [
          "task-quality descriptions per tool",
          "risk grades into .vendo/overrides.json",
          "replace the .vendo/brief.md placeholder",
          "fill unresolved slots in .vendo/theme.json",
        ],
      },
    });
    expect(receipt.wrote).toContain(".vendo/tools.json");
    expect(receipt.wrote).toContain(".vendo/install.json");
    expect(receipt.wrote).toContain(join("app", "api", "vendo", "[...vendo]", "route.ts"));
    expect(receipt.wrote).toContain(join("lib", "vendo.ts"));
    // Every named path is one the caller can open: this rejects the plan's
    // static list, which promises a fonts.css only an embedded font creates.
    await Promise.all(receipt.wrote.map((path) => readFile(join(root, path), "utf8")));
    // Init writes no client file, so the host's layout is never a write.
    expect(receipt.wrote).not.toContain(join("app", "layout.tsx"));
    // The retired plan dump's fields are gone with it.
    expect(sink.logs.join("\n")).not.toContain("codeChanges");
    // Agent mode asks for the judgment pass now; no engine resolves in a test
    // fixture, so the checklist comes back as the caller's required work.
    expect(sink.logs.join("\n")).not.toContain("Judgment: delegated to you");
  });

  /** The MCP arm used to relay TWO extra questions — where outside agents sign
      in, and whether a backend needs a service key — and neither is an answer
      anybody has at install time. One Cloud key settles sign-in for BOTH
      environments, so the arm asks whether they want the key, and that is all.
      It takes the models question's slot rather than standing beside it: two
      questions with the same two answers is one question asked twice. */
  it("relays the MCP arm's one Cloud question, and drops it the moment a key exists", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, { agent: true, useCase: "mcp", auth: "clerk" })).toBe(0);
    const asked = questionsOf(sink.logs);
    // The dev URL rides along on every path, MCP included — the door's own
    // discovery derives from it.
    expect(asked.questions.map((question) => question.id)).toEqual(["mcp-sign-in", "dev-url"]);
    const signIn = asked.questions.find((question) => question.id === "mcp-sign-in")!;
    expect(signIn.options[0]).toMatchObject({ command: "npx vendo login --wait 90", recommended: true });
    expect(signIn.options[1]?.flag).toBe("--byo");
    // The deleted question, in every spelling it ever had.
    expect(JSON.stringify(asked)).not.toContain("posture");
    expect(JSON.stringify(asked)).not.toContain("service-key");
    expect(JSON.stringify(asked)).not.toContain("OAuth");

    // …and with a key in .env.local the MCP arm has nothing left to ask.
    await writeFile(join(root, ".env.local"), `VENDO_API_KEY=vnd_${"c".repeat(40)}\n`);
    const keyed = output();
    expect(await run(root, keyed, { agent: true, useCase: "mcp", auth: "clerk" })).toBe(0);
    expect(questionsOf(keyed.logs).questions.map((question) => question.id)).toEqual(["dev-url"]);
  });

  /** detectAuthPreset reports `wired: null` when two families match, precisely
      because that case is ambiguous. Naming the first would assert a provider
      the host may not use and hide the other one entirely. */
  it("falls through to the full list when two auth families match", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0", "@clerk/nextjs": "6.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const asked = questionsOf(sink.logs);
    expect(asked.detected.auth).toBeUndefined();
    const auth = asked.questions.find((question) => question.id === "auth");
    expect(auth?.prompt).toBe("Which auth should Vendo wire?");
    expect(auth?.options.map((option) => option.flag)).toContain("--auth clerk");
    expect(auth?.options.map((option) => option.flag)).toContain("--auth authJs");
  });

  /** The login loop's REAL seam: `vendo login` lands VENDO_API_KEY in
      .env.local, and the next `--agent` call must stop asking. A provider key
      in the environment is a different branch entirely. */
  it("drops the models question once vendo login has left a key in .env.local", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    expect(questionsOf(sink.logs).questions.map((question) => question.id)).toContain("models");
    await writeFile(join(root, ".env.local"), `VENDO_API_KEY=vnd_${"a".repeat(40)}\n`);
    const after = output();
    expect(await run(root, after, { agent: true })).toBe(0);
    expect(questionsOf(after.logs).questions.map((question) => question.id)).toEqual(["use-case", "auth", "dev-url"]);
  });

  /** Agent mode GRADES (2026-08-18, Yousef's direction): the pass is a scripted,
      skeptic-checked engine run, so "delegated to you" meant every agent install
      shipped an ungraded catalog whose every tool asked on each call. It never
      ASKS for consent — the mode is the consent — and the delegated receipt is
      the one fallback left, for a machine with no engine at all. */
  it("grades under --agent with an available engine, and never asks for consent", async () => {
    const root = await fixture();
    const sink = output();
    let ran = 0;
    expect(await agentRun(root, sink, {
      extract: {
        harnesses: [{
          id: "scripted",
          availability: async () => "a scripted harness",
          run: async () => { ran += 1; return "```json\n" + JSON.stringify({ tools: [] }) + "\n```"; },
        }],
        confirm: async () => { throw new Error("asked for AI consent"); },
      },
    })).toBe(0);
    expect(ran).toBeGreaterThan(0);
    expect(sink.logs.join("\n")).not.toContain("Judgment: delegated to you");
    expect(receiptOf(sink.logs).judgment.status).toBe("graded");
  });

  /** …and with NO engine on the machine, the checklist comes back as REQUIRED
      work rather than as a default nobody chose. */
  it("hands the grading back as required work when no engine resolves", async () => {
    const root = await fixture();
    const sink = output();
    expect(await agentRun(root, sink, { extract: { harnesses: [] } })).toBe(0);
    expect(sink.logs.join("\n")).toContain("judgment: REQUIRED, not done");
    const receipt = receiptOf(sink.logs);
    expect(receipt.judgment.status).toBe("delegated");
    expect(receipt.judgment).toHaveProperty("checklist");
  });

  it("writes and receipts the agent-loop and mcp arms too", async () => {
    const loop = await fixture();
    await writeFile(join(loop, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", ai: "6.0.0" },
    }));
    const loopSink = output();
    expect(await agentRun(loop, loopSink, { useCase: "agent-loop" })).toBe(0);
    const loopReceipt = receiptOf(loopSink.logs);
    expect(loopReceipt.useCase).toBe("agent-loop");
    expect(loopReceipt.continueUrl).toBe("https://docs.vendo.run/existing-agent/ai-sdk");

    const mcp = await fixture();
    const mcpSink = output();
    expect(await agentRun(mcp, mcpSink, { useCase: "mcp", auth: "clerk", posture: "local" })).toBe(0);
    const mcpReceipt = receiptOf(mcpSink.logs);
    expect(mcpReceipt.useCase).toBe("mcp");
    expect(mcpReceipt.wrote).toContain("app/.well-known/[...vendo]/route.ts");
  });

  /** The agent-loop host runs its own loop, which needs the caller — so the
   *  composition init writes exports the resolver over the SAME identity the
   *  wire composed. Both walkthroughs used to open by telling the reader to
   *  hand-add that line to a file init had just written. */
  it("the agent-loop arm writes the caller resolver, in both identity shapes", async () => {
    const preset = await fixture();
    await writeFile(join(preset, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "6.0.0" },
    }));
    await writeFile(join(preset, ".env.local"), "CLERK_SECRET_KEY=sk_test_x\n");
    expect(await agentRun(preset, output(), { useCase: "agent-loop", auth: "clerk" })).toBe(0);
    const wired = await readFile(join(preset, "lib", "vendo.ts"), "utf8");
    // Hoisted, not inline: a second clerk() in the chat route would be a second
    // decode the wire never sees.
    expect(wired).toContain("const auth = clerk();");
    expect(wired).toContain("\n  auth,\n");
    expect(wired).toContain("export const resolvePrincipal = (req: Request) => auth.principal(req);");

    const demo = await fixture();
    expect(await agentRun(demo, output(), { useCase: "agent-loop" })).toBe(0);
    const anonymous = await readFile(join(demo, "lib", "vendo.ts"), "utf8");
    // The same hoist, the same key, the same resolver — only what `auth` is
    // bound to differs between a wired preset and a host's own object.
    expect(anonymous).toContain(`const auth = {\n  principal: async () => ({ kind: "user" as const, subject: "demo-user" }),\n};`);
    expect(anonymous).toContain("\n  auth,\n");
    expect(anonymous).toContain("export const resolvePrincipal = (_req: Request) => auth.principal();");
  });

  /** …and nowhere else: the composition is one file across every arm, so an
   *  export the embedded and MCP readers never import is noise in theirs. */
  it.each([
    ["embedded", {}],
    ["mcp", { auth: "clerk", posture: "local" }],
  ] as const)("the %s arm's composition carries no resolver", async (useCase, extra) => {
    const root = await fixture();
    expect(await agentRun(root, output(), { useCase, ...extra })).toBe(0);
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8")).not.toContain("resolvePrincipal");
  });


  it("names the detected auth in the question, and drops the models one once a key exists", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "6.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink, { agent: true, env: { ANTHROPIC_API_KEY: "sk-ant-test" } })).toBe(0);
    const asked = questionsOf(sink.logs);
    expect(asked.detected.auth).toBe("clerk");
    expect(asked.questions.map((question) => question.id)).toEqual(["use-case", "auth", "dev-url"]);
    expect(asked.questions[1]?.prompt)
      .toBe("It detected Clerk. Should the assistant act as your signed-in Clerk user?");
    expect(asked.questions[1]?.options).toEqual([
      { label: "Yes", flag: "--auth clerk", recommended: true },
      {
        label: "A different auth",
        flag: "--auth <authJs|supabase|auth0|jwt>",
        note: "replace the placeholder with one of those four names",
      },
      { label: "No signed-in user", flag: "--auth none" },
    ]);
  });
});

describe("the AI flag matrix — identical on init and sync (decision 2)", () => {
  /** A harness that proves whether the gate opened: unavailable, so nothing
      is spent, but reaching it means consent was granted. */
  const probeOnly = { harnesses: [], confirm: async () => { throw new Error("prompted"); } };

  it("interactive with no flag ASKS, every run — no answer is ever saved", async () => {
    const root = await fixture();
    for (const pass of [1, 2]) {
      const asked: string[] = [];
      const sink = output();
      expect(await run(root, sink, {
        interactive: true,
        extract: {
          interactive: true,
          // An AVAILABLE engine, so the run reaches the consent question
          // instead of stopping at the availability check.
          harnesses: [themeHarness({ slots: {} })],
          confirm: async (question: string) => { asked.push(question); return false; },
        },
      })).toBe(0);
      // The prompt fires on the FIRST run and again on the second: nothing
      // about the answer is persisted to .vendo/ or anywhere else.
      expect(asked.length, `run ${pass} asked`).toBe(1);
    }
    const vendoFiles = await readdir(join(root, ".vendo"));
    expect(vendoFiles.join(" ")).not.toContain("consent");
  });

  it("interactive with --ai runs without asking; with --no-ai it is off", async () => {
    const on = output();
    expect(await run(await fixture(), on, { interactive: true, ai: true, extract: probeOnly })).toBe(0);
    expect(on.logs.join("\n")).toContain("AI polish: unavailable"); // the gate opened

    const off = output();
    expect(await run(await fixture(), off, {
      interactive: true,
      ai: false,
      extract: { harnesses: [{
        id: "never",
        availability: async () => { throw new Error("must not probe"); },
        run: async () => { throw new Error("must not run"); },
      }], confirm: async () => { throw new Error("prompted"); } },
    })).toBe(0);
    expect(off.logs.join("\n")).toContain("off (--no-ai)");
  });

  it("non-interactive never prompts: no flag = off, --ai = on", async () => {
    const bare = output();
    expect(await run(await fixture(), bare, {
      interactive: false,
      extract: { harnesses: [{
        id: "never",
        availability: async () => { throw new Error("must not probe"); },
        run: async () => { throw new Error("must not run"); },
      }], confirm: async () => { throw new Error("prompted"); } },
    })).toBe(0);
    expect(bare.logs.join("\n")).toContain("this run cannot ask");

    const forced = output();
    expect(await run(await fixture(), forced, { interactive: false, ai: true, extract: probeOnly })).toBe(0);
    expect(forced.logs.join("\n")).toContain("AI polish: unavailable");
  });
});

describe("the sync hooks init installs (decision 2)", () => {
  it("writes both hooks with --no-ai so a dev/build run never prompts or spends", async () => {
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    const scripts = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.predev).toBe("vendo sync --no-ai");
    expect(scripts.prebuild).toBe("vendo sync --strict --no-ai");
  });

  it("upgrades the hookless entry an older init wrote, in place and idempotently", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0" },
      scripts: { predev: "vendo sync && echo pre", prebuild: "vendo sync --strict" },
    }, null, 2));
    expect(await run(root, output())).toBe(0);
    const first = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(first.predev).toBe("vendo sync --no-ai && echo pre");
    expect(first.prebuild).toBe("vendo sync --strict --no-ai");
    // Re-running changes nothing further.
    const before = await readFile(join(root, "package.json"), "utf8");
    expect(await run(root, output())).toBe(0);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("never clobbers a vendo sync call the user wrote themselves", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0" },
      scripts: { predev: "vendo sync --engine codex", prebuild: "vendo sync --strict --ai && tsc" },
    }, null, 2));
    expect(await run(root, output())).toBe(0);
    const scripts = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.predev).toBe("vendo sync --engine codex");
    expect(scripts.prebuild).toBe("vendo sync --strict --ai && tsc");
  });
});

/** Next bundles @vendoai/apps into the server chunk, so the app checker's
    deliberately bundler-hidden `import("esbuild")` resolves at runtime from the
    app root — where pnpm never hoists esbuild — and every generated screen fails
    its checks. Our own examples only escaped it by setting this by hand. */
describe("the next.config repair (Next hosts)", () => {
  /** Never trim this entry. The checker reaches esbuild through a VARIABLE
      specifier behind bundler-ignore comments, so once @vendoai/apps is bundled
      there is no static "esbuild" request for Next to match — a bare "esbuild"
      entry is inert, and the list only ever worked in this repo because the
      monorepo root hoists esbuild. Proven live: stage G rendered a screen in 28s
      once the PACKAGE was externalized. */
  it("keeps @vendoai/apps on the externals list — an esbuild entry alone is inert", () => {
    expect(NEXT_SERVER_EXTERNALS).toContain("@vendoai/apps");
  });

  it("adds serverExternalPackages to the config object the host already exports", async () => {
    const root = await fixture();
    await writeFile(join(root, "next.config.ts"),
      'import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {\n  reactStrictMode: true,\n};\n\nexport default nextConfig;\n');
    expect(await run(root, output())).toBe(0);
    const config = await readFile(join(root, "next.config.ts"), "utf8");
    expect(config).toContain('serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"],');
    expect(config).toContain("reactStrictMode: true");
  });

  /** A commented-out list is what a host debugging its bundle leaves behind.
      Reading one as real configuration skipped the repair AND, on the branch
      that splices, wrote the names into the comment. */
  it("ignores a commented-out list and adds the real property", async () => {
    const root = await fixture();
    await writeFile(join(root, "next.config.ts"),
      'const nextConfig = {\n  // serverExternalPackages: ["esbuild"],\n  reactStrictMode: true,\n};\n\nexport default nextConfig;\n');
    expect(await run(root, output())).toBe(0);
    const config = await readFile(join(root, "next.config.ts"), "utf8");
    expect(config).toContain('serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"],');
    expect(config, "the host's comment is left exactly as they wrote it").toContain('  // serverExternalPackages: ["esbuild"],');
  });

  it("ignores a commented-out export when picking the object to edit", async () => {
    const root = await fixture();
    await writeFile(join(root, "next.config.ts"),
      "/* export default { reactStrictMode: false }; */\nexport default { reactStrictMode: true };\n");
    expect(await run(root, output())).toBe(0);
    const config = await readFile(join(root, "next.config.ts"), "utf8");
    expect(config).toContain("/* export default { reactStrictMode: false }; */");
    expect(config).toMatch(/export default \{\n {2}serverExternalPackages/);
  });

  it("splices only the missing names into a list the host already keeps", async () => {
    const root = await fixture();
    await writeFile(join(root, "next.config.ts"),
      'const nextConfig = {\n  serverExternalPackages: ["@electric-sql/pglite"],\n};\n\nexport default nextConfig;\n');
    expect(await run(root, output())).toBe(0);
    expect(await readFile(join(root, "next.config.ts"), "utf8"))
      .toContain('serverExternalPackages: ["@vendoai/apps", "esbuild", "@vendoai/store", "@electric-sql/pglite"],');
  });

  it("writes a minimal config when the host has none, and re-running changes nothing", async () => {
    const root = await fixture();
    const sink = output();
    expect(await agentRun(root, sink)).toBe(0);
    const written = await readFile(join(root, "next.config.mjs"), "utf8");
    expect(written).toContain('serverExternalPackages: ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"],');
    expect(receiptOf(sink.logs).wrote).toContain("next.config.mjs");
    expect(await run(root, output())).toBe(0);
    expect(await readFile(join(root, "next.config.mjs"), "utf8")).toBe(written);
  });

  /** Next hard-fatals at boot on a package named in BOTH transpilePackages and
      serverExternalPackages (our own demo-bank hit it). A source-linked host
      that transpiles @vendoai/apps must therefore get the paste, never the
      write: init following its own advice would brick their dev server. */
  // Next hard-fatals on a package named in both lists, so writing the property
  // for a host that transpiles one would brick the dev server this run just
  // wired. Doctor grades the gap (E-CFG-004) and its page carries the caveat.
  it("leaves a config alone when the host transpiles a package we would externalize", async () => {
    const root = await fixture();
    const source = 'const nextConfig = {\n  transpilePackages: ["@vendoai/apps"],\n};\n\nexport default nextConfig;\n';
    await writeFile(join(root, "next.config.ts"), source);
    const sink = output();
    expect(await agentRun(root, sink)).toBe(0);
    expect(await readFile(join(root, "next.config.ts"), "utf8"), "init must not brick the host").toBe(source);
    expect(sink.logs.join("\n")).not.toContain(NEXT_SERVER_EXTERNALS_LINE);
  });

  it("still edits when the transpilePackages entry is only a comment", async () => {
    const root = await fixture();
    await writeFile(join(root, "next.config.ts"),
      'const nextConfig = {\n  // transpilePackages: ["@vendoai/apps"],\n};\n\nexport default nextConfig;\n');
    expect(await run(root, output())).toBe(0);
    expect(await readFile(join(root, "next.config.ts"), "utf8")).toContain(NEXT_SERVER_EXTERNALS_LINE);
  });

  it("leaves a config it cannot read as an object literal untouched", async () => {
    const root = await fixture();
    const dynamic = "export default (phase) => ({ reactStrictMode: true });\n";
    await writeFile(join(root, "next.config.mjs"), dynamic);
    const sink = output();
    expect(await agentRun(root, sink)).toBe(0);
    expect(await readFile(join(root, "next.config.mjs"), "utf8")).toBe(dynamic);
    expect(receiptOf(sink.logs).wrote).not.toContain("next.config.mjs");
  });

  it("leaves an Express host's tree alone", async () => {
    const root = await expressFixture(true);
    expect(await run(root, output())).toBe(0);
    expect(Object.keys(await tree(root)).filter((path) => path.startsWith("next.config"))).toEqual([]);
  });
});

describe("init telemetry enrichment", () => {
  /** Injected telemetry seam: a real client pointed at a mock PostHog fetch
      and a temp home, with a clean consent env (no CI/DNT). */
  async function telemetrySink(env: Record<string, string | undefined> = {}) {
    const home = await mkdtemp(join(tmpdir(), "vendo-init-tele-home-"));
    cleanup.push(home);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const events = (): Array<{ event: string; properties: Record<string, unknown> }> =>
      fetchImpl.mock.calls.map((call) =>
        JSON.parse((call[1] as { body: string }).body) as { event: string; properties: Record<string, unknown> });
    return { events, telemetry: { home, env, posthogKey: "phc_test", fetchImpl } };
  }



  it("init_completed carries the project-shape enums and versions (anonymous lane)", async () => {
    const root = await fixture();
    const sink = output();
    const tele = await telemetrySink();
    expect(await run(root, sink, { telemetry: tele.telemetry })).toBe(0);
    const completed = tele.events().find((entry) => entry.event === "init_completed");
    expect(completed).toBeDefined();
    expect(completed!.properties).toMatchObject({
      framework: "next",
      command: "init",
      typescript: false,
      router: "app",
      engine: "none", // non-interactive run: the AI polish never ran
      apiDetectMethod: "none",
      routeCount: 0,
      themeExtracted: true,
      frameworkVersion: "16.0.0",
    });
    expect(typeof completed!.properties.durationMs).toBe("number");
    // Cloud-only props never ride the anonymous lane, even though init
    // passes them unconditionally.
    for (const key of ["detectMs", "engineMs", "themeMs", "wiringMs", "projectName", "repoHost"]) {
      expect(key in completed!.properties, key).toBe(false);
    }
  });

  it("init_completed adds timings and projectName in the cloud lane", async () => {
    const root = await fixture();
    const sink = output();
    const tele = await telemetrySink({ VENDO_API_KEY: `vnd_${"a".repeat(40)}` });
    expect(await run(root, sink, { telemetry: tele.telemetry })).toBe(0);
    const completed = tele.events().find((entry) => entry.event === "init_completed");
    expect(completed).toBeDefined();
    expect(completed!.properties.cloud).toBe(true);
    expect(completed!.properties.projectName).toBe("host");
    for (const key of ["detectMs", "engineMs", "themeMs", "wiringMs"]) {
      expect(typeof completed!.properties[key], key).toBe("number");
    }
  });

  it("init_failed carries errorClass (and no errorDetail anonymously)", async () => {
    const root = await fixture();
    const sink = output();
    const tele = await telemetrySink();
    const exit = await run(root, sink, {
      telemetry: tele.telemetry,
      cloud: { cloudProbe: async () => { throw new TypeError("boom at /Users/alice/app/x.ts"); } },
    });
    expect(exit).toBe(1);
    const failed = tele.events().find((entry) => entry.event === "init_failed");
    expect(failed).toBeDefined();
    expect(failed!.properties).toMatchObject({ framework: "next", failedStep: "wiring", errorClass: "TypeError" });
    expect("errorDetail" in failed!.properties).toBe(false);
  });

  it("init_failed carries a scrubbed errorDetail in the cloud lane", async () => {
    const root = await fixture();
    const sink = output();
    const tele = await telemetrySink({ VENDO_API_KEY: `vnd_${"a".repeat(40)}` });
    const exit = await run(root, sink, {
      telemetry: tele.telemetry,
      cloud: { cloudProbe: async () => { throw new TypeError("boom at /Users/alice/app/x.ts"); } },
    });
    expect(exit).toBe(1);
    const failed = tele.events().find((entry) => entry.event === "init_failed");
    expect(failed!.properties.errorDetail).toBe("boom at [path]");
    expect(failed!.properties.errorClass).toBe("TypeError");
  });

  it("a pre-existing VENDO_API_KEY in the target's .env.local activates the cloud lane (P1 review)", async () => {
    const root = await fixture();
    const key = `vnd_${"c".repeat(40)}`;
    await writeFile(join(root, ".env.local"), `VENDO_API_KEY=${key}\n`);
    const sink = output();
    const tele = await telemetrySink(); // NO key in the telemetry env
    expect(await run(root, sink, { telemetry: tele.telemetry })).toBe(0);
    const completed = tele.events().find((entry) => entry.event === "init_completed");
    expect(completed!.properties.cloud).toBe(true);
    // The whole run rides the lane: the first client already read .env.local.
    const started = tele.events().find((entry) => entry.event === "init_started");
    expect(started!.properties.cloud).toBe(true);
  });

  it("a --cloud-key landed THIS run activates the cloud lane for init_completed (P1 review)", async () => {
    const root = await fixture();
    const key = `vnd_${"d".repeat(40)}`;
    const sink = output();
    const tele = await telemetrySink(); // NO key anywhere until the flag lands it
    expect(await run(root, sink, { telemetry: tele.telemetry, cloudKey: key })).toBe(0);
    // init_started fired before the key existed — anonymous.
    const started = tele.events().find((entry) => entry.event === "init_started");
    expect("cloud" in started!.properties).toBe(false);
    // The rebuilt client picked the freshly written key up from .env.local.
    const completed = tele.events().find((entry) => entry.event === "init_completed");
    expect(completed!.properties.cloud).toBe(true);
  });
});


describe("vendo init (custom runtime)", () => {
  it("scaffolds the runtime-neutral lazy module: Request→Response, env-passed, Cloud adapters explicit", async () => {
    const root = await customFixture();
    const sink = output();
    expect(await run(root, sink, { framework: "custom" })).toBe(0);

    const server = await readFile(join(root, "vendo", "server.ts"), "utf8");
    // Lazy singleton — never construct at module scope (Workers global-scope ban).
    expect(server).toContain("let vendo: ReturnType<typeof createVendo> | null = null;");
    expect(server).toContain("export function handleVendoRequest(request: Request, env: VendoEnv = {}): Promise<Response>");
    // Adapter rule: with a Cloud key the seams wire EXPLICITLY (model via the
    // stock Anthropic provider at the console gateway — the dev ladder cannot
    // resolve provider installs inside a Worker bundle).
    expect(server).toContain('createAnthropic({ apiKey: cloud.apiKey, baseURL: `${cloud.baseUrl}/api/v1` })("vendo")');
    expect(server).toContain("store: hostedStore(cloud),");
    expect(server).toContain("sandbox: cloudSandbox(cloud),");
    // No framework file-layout assumptions, and no client file.
    await expect(readFile(join(root, "vendo", "registry.tsx"))).rejects.toMatchObject({ code: "ENOENT" });

    // The routing lines the host still owes live in the generated module's own
    // header comment and on the continue page — never printed at the terminal.
    expect(server).toContain("handleVendoRequest(request, env)");
    expect(sink.logs.join("\n")).not.toContain("handleVendoRequest(request, env)");
  });

  it("an undetectable host falls through to the custom scaffold interactively, never the Next layout", async () => {
    const root = await customFixture();
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    expect(questionsOf(sink.logs).detected.framework).toBe("custom");
    // …and the fall-through survives into the write: still no Next layout.
    const wrote = output();
    expect(await agentRun(root, wrote)).toBe(0);
    expect(receiptOf(wrote.logs).wrote.join("\n")).not.toContain("app/api/vendo");
  });
});

describe("the five questions", () => {
  it("asks the use case first and takes embedded unattended; --use-case answers it without asking", async () => {
    const asked: Array<{ question: string; values: string[] }> = [];
    const root = await fixture();
    expect(await run(root, output(), {
      interactive: true,
      selectUseCase: async (question, options) => {
        asked.push({ question, values: options.map((option) => option.value) });
        return "embedded";
      },
    })).toBe(0);
    expect(asked).toEqual([{
      question: "How will people use your agent?",
      values: ["embedded", "agent-loop", "mcp"],
    }]);

    // Unattended: no question, and the plan stays byte-identical to today's.
    const quiet = await fixture();
    const quietSink = output();
    expect(await run(quiet, quietSink, {
      yes: true,
      selectUseCase: async () => { throw new Error("prompted"); },
    })).toBe(0);
    expect(quietSink.logs.join("\n")).not.toContain("How will people use your agent?");
  });

  // The interactivity JUDGMENT, not the `interactive` flag: `npx vendo init` —
  // the command every doc prints — carries npm exec's synthetic
  // `npm_lifecycle_event=npx`, which read as a lifecycle hook and defaulted the
  // whole run to embedded in silence. A real hook still gets nothing.
  it.each([
    ["npx", true],
    ["predev", false],
  ] as const)("a real TTY under npm_lifecycle_event=%s asks the use case: %s", async (event, asks) => {
    vi.stubEnv("npm_lifecycle_event", event);
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const asked: string[] = [];
    // Every other prompt seam stubbed to its decline, because a real TTY means
    // an unstubbed one would read this process's own stdin and hang: only the
    // use case is under test here.
    expect(await run(await fixture(), output(), {
      ai: false,
      cloud: { ...NO_CLOUD, models: "later" },
      selectUseCase: async (question) => { asked.push(question); return "embedded"; },
      confirmAuth: async () => false,
      selectAuth: async () => "none",
      askText: async () => "",
    }).finally(() => {
      process.stdin.isTTY = tty.in;
      process.stdout.isTTY = tty.out;
    })).toBe(0);
    expect(asked).toEqual(asks ? ["How will people use your agent?"] : []);
  });

  /** Doctor grades against the recorded answer now, so an unattended re-run
      must not silently re-answer the question this project already settled —
      that would turn an MCP install's doctor green into two false failures. */
  it("records the answer, and an unattended re-run keeps it instead of falling back to embedded", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" },
    }));
    expect(await run(root, output(), { useCase: "mcp", yes: true, auth: "clerk", baseUrl: "https://app.acme.com" })).toBe(0);
    const recorded = join(root, ".vendo", "install.json");
    expect(JSON.parse(await readFile(recorded, "utf8"))).toEqual({ format: "vendo/install@1", useCase: "mcp" });

    expect(await run(root, output(), { yes: true })).toBe(0);
    expect(JSON.parse(await readFile(recorded, "utf8"))).toMatchObject({ useCase: "mcp" });

    // An explicit answer still wins over the record.
    expect(await run(root, output(), { yes: true, useCase: "embedded" })).toBe(0);
    expect(JSON.parse(await readFile(recorded, "utf8"))).toMatchObject({ useCase: "embedded" });
  });

  /** The dev URL is a QUESTION now, and its answer is WRITTEN. An agent loop, a
      backend process and the MCP door each send real HTTP requests back at the
      host's own API, and none of them sees a wire request to learn the origin
      from — so every one of those installs used to meet "Cannot execute … set
      VENDO_BASE_URL" on its first turn. One Enter now settles it. */
  it("asks where the app runs in dev, prefilled with the host's own port, and writes the answer to .env.local", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0" },
      scripts: { dev: "next dev --port 4000" },
    }));
    const asked: Array<{ question: string; hint?: string; prefill?: string }> = [];
    const sink = output();
    // A bare Enter is resolved by the prompt itself — the seam stands in for a
    // terminal, so it answers with the default it was handed.
    expect(await run(root, sink, {
      interactive: true,
      askText: async (question, hint, prefill) => {
        asked.push({ question, hint, prefill });
        return prefill ?? "";
      },
    })).toBe(0);

    expect(asked).toEqual([{
      question: "Where does this app run in dev?",
      hint: "Enter to accept http://localhost:4000",
      prefill: "http://localhost:4000",
    }]);
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:4000");
    expect(sink.logs.join("\n")).toContain("Wrote VENDO_BASE_URL=http://localhost:4000 to .env.local");
    // The question that used to live here is gone: production is told at deploy
    // time, never asked at init.
    expect(sink.logs.join("\n")).not.toContain("Where will this deploy?");
  });

  /** Writing the prefill unasked would be a GUESS wearing an answer's clothes:
      unset, dev still learns the request's own origin and production fails
      loud, so silence is the honest outcome. */
  it("never asks and never writes .env.local on an unattended run", async () => {
    const root = await fixture();
    expect(await run(root, output(), {
      yes: true,
      askText: async () => { throw new Error("prompted"); },
    })).toBe(0);
    await expect(readFile(join(root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });

    // --base-url is the same answer arriving as a flag, and it writes.
    const answered = await fixture();
    expect(await run(answered, output(), { yes: true, baseUrl: "http://localhost:5173" })).toBe(0);
    expect(await readFile(join(answered, ".env.local"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:5173");
  });

  /** The MCP arm's own question, answered from the same prompt — and then graded
      by the OTHER side of the seam: a REAL `vendo doctor` run over the repo init
      just wrote, with no env override, so E-MCP-009 reads the same .env.local
      init produced. Nothing is stubbed on either end. Local posture in dev is
      the point: the door's client URL and its discovery both want the origin the
      developer is looking at. */
  it("MCP: the dev answer opens the door locally, and a real doctor run greens E-MCP-009", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-mcp-dev-url-"));
    cleanup.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "mcp-host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" },
      scripts: { dev: "next dev -p 4300" },
    }));
    await writeFile(join(root, "app", "layout.tsx"),
      'import { VendoProvider } from "@vendoai/vendo/react";\n'
      + "export default function Layout({ children }) { return <VendoProvider>{children}<VendoOverlay /></VendoProvider>; }\n");
    const sink = output();
    expect(await run(root, sink, {
      useCase: "mcp",
      auth: "clerk",
      interactive: true,
      askText: async (_question, _hint, prefill) => prefill ?? "",
      confirmAuth: async () => false,
      selectUseCase: async () => "byo",
    })).toBe(0);

    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:4300");
    // The client URL, the deploy variable and the broker values all live on the
    // page the run points at — the terminal states what it wired and links out.
    expect(sink.logs.join("\n")).toContain("Continue: https://docs.vendo.run/outside-agents/quickstart");

    // The read-back: doctor over the repo init just wrote. No env override, so
    // it loads .env.local itself — the file this run produced. (Only this check
    // is this test's business; the fixture owes other things doctor grades.)
    const doctorLogs: string[] = [];
    await runDoctor({
      targetDir: root,
      json: true,
      output: { log: (message) => doctorLogs.push(message), error: () => {} },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    });
    const report = JSON.parse(doctorLogs[0]!) as { checks: Array<{ id: string; status: string; message: string }> };
    expect(report.checks.find((check) => check.id === "mcp/base-url"))
      .toMatchObject({ status: "ok", message: expect.stringContaining("VENDO_BASE_URL is set") });
  });

  // The flag pair is refused in cli.ts, which reads argv. A programmatic caller
  // never passes through it, so the same mistake arrived here silently and the
  // key was dropped — the one path where a user could still believe it landed.
  // Same refusal, same words, whichever way they got here.
  it("refuses a service key on a broker door however the pair arrived, not only off argv", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      useCase: "mcp",
      auth: "clerk",
      baseUrl: "http://localhost:3000",
      interactive: true,
      serviceKey: true,
      posture: "broker",
      cloud: { cloudProbe: async () => ({ present: true, ok: true, unlocks: [] as readonly string[] }) },
      askText: async (_question, _hint, prefill) => prefill ?? "",
      confirmAuth: async () => false,
    })).toBe(1);

    const errors = sink.errors.join("\n");
    expect(errors).toContain("--service-key does not apply");
    expect(errors).toContain("provisioned with the tenant on first use");
    expect(errors).toContain("https://docs.vendo.run/outside-agents/service-keys-and-broker");
    // It refuses INSTEAD of writing: no composition landed on the way out.
    expect(await readdir(root)).not.toContain("lib");

    // The control: the SAME broker door with no key asked for still writes. The
    // guard fires on the key, not on the door. (An https origin, because Cloud
    // refuses to front any other — the refusal directly below.)
    const cloudOnly = await fixture();
    expect(await run(cloudOnly, output(), {
      useCase: "mcp",
      auth: "clerk",
      baseUrl: "https://app.acme.com",
      interactive: true,
      posture: "broker",
      cloud: { cloudProbe: async () => ({ present: true, ok: true, unlocks: [] as readonly string[] }) },
      askText: async (_question, _hint, prefill) => prefill ?? "",
      confirmAuth: async () => false,
    })).toBe(0);
    expect(await readdir(cloudOnly)).toContain("lib");
  });

  // The blocker a live proof against production Cloud hit: Cloud registers
  // VENDO_BASE_URL as the tenant's forwarding address and answers
  // `400 The forwarding address must be an https:// URL`, so the dev origin the
  // previous question just captured and the Cloud posture cannot coexist. The
  // pair used to pass init and print `Wired (5 files)` over a door that was
  // already dead.
  it("refuses a Cloud-fronted door on an http origin instead of writing one that cannot work", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      useCase: "mcp",
      auth: "clerk",
      baseUrl: "http://localhost:3004",
      interactive: true,
      posture: "broker",
      cloud: { cloudProbe: async () => ({ present: true, ok: true, unlocks: [] as readonly string[] }) },
      askText: async (_question, _hint, prefill) => prefill ?? "",
      confirmAuth: async () => false,
    })).toBe(1);

    const errors = sink.errors.join("\n");
    // It names the origin it refused, why Cloud refuses it, and both ways out.
    expect(errors).toContain("http://localhost:3004");
    expect(errors).toContain("forwarding address");
    expect(errors).toContain("Take the local posture");
    expect(errors).toContain("--base-url");
    // …and it refuses INSTEAD of reporting success over a dead door.
    expect(await readdir(root)).not.toContain("lib");
    expect(sink.logs.join("\n")).not.toContain("Wired");
  });
});

/**
 * Cloud once, and never a sign-in question.
 *
 * Init used to ask WHERE outside agents sign in. That answer is not one answer:
 * the dev machine wants the door's own OAuth (it works on http, zero config)
 * and the deployment wants the broker — and nobody knows their deployment while
 * they are installing. A Cloud key settles both, because the runtime resolves
 * the door per environment (compose-mcp.ts's `declaredBrokerage`) and the key
 * init writes for the dev machine lives in `.env.local`, which never ships. So
 * the only thing left worth asking is whether they want a key at all, and only
 * when they have none.
 */
describe("the MCP arm asks about Cloud once, and never about sign-in", () => {
  const serviceKeyIn = (envLocal: string): string | undefined =>
    /^VENDO_SERVICE_KEY=(.+)$/m.exec(envLocal)?.[1];
  const refuse = (what: string) => async (question: string): Promise<never> => {
    throw new Error(`${what}: ${question}`);
  };

  /** A real key in the real file init reads, never a probe stub: "a key is in
      hand" is the whole precondition, so a test that mocks the detection cannot
      prove the run holds one. */
  async function mcpHost(cloudKey = false): Promise<string> {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" },
    }));
    if (cloudKey) await writeFile(join(root, ".env.local"), `VENDO_API_KEY=vnd_${"e".repeat(40)}\n`);
    return root;
  }

  /** Everything an interactive MCP run needs answered EXCEPT sign-in, with
      every remaining prompt wired to throw — so a question that comes back
      fails the test by name instead of by silence. */
  const interactiveMcp = {
    useCase: "mcp" as const,
    auth: "clerk" as const,
    baseUrl: "http://localhost:3000",
    interactive: true,
    askText: async (): Promise<string> => "",
    confirmAuth: refuse("confirmed"),
    selectUseCase: refuse("selected"),
  };

  /** The wiring a run holding a Cloud key lays down, with nobody asked. */
  async function expectCloudWiring(root: string, logs: string): Promise<void> {
    expect(serviceKeyIn(await readFile(join(root, ".env.local"), "utf8"))).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8"))
      .toContain('mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },');
    expect(logs).toContain(
      "Sign-in: Vendo Cloud — dev runs on this machine; your deployment uses the Cloud broker automatically.",
    );
  }

  it("wires both environments in silence when a Cloud key is already in hand", async () => {
    const root = await mcpHost(true);
    const sink = output();
    expect(await run(root, sink, { ...interactiveMcp, cloud: {} })).toBe(0);

    await expectCloudWiring(root, sink.logs.join("\n"));
    // The deleted question, and the vocabulary it taught.
    const everything = [...sink.logs, ...sink.errors].join("\n");
    expect(everything).not.toContain("How should outside agents sign in?");
    expect(everything).not.toMatch(/posture/i);
    expect(everything).not.toContain("serves its own OAuth");
    expect(everything).not.toContain("machine-to-machine");
  });

  it("offers the key once when there is none, and runs the login inline", async () => {
    const root = await mcpHost();
    const sink = output();
    let asked = "";
    let logins = 0;
    expect(await run(root, sink, {
      ...interactiveMcp,
      selectUseCase: async (question) => { asked = question; return "cloud"; },
      cloud: {
        ...NO_CLOUD,
        deviceLogin: async () => {
          logins += 1;
          await writeFile(join(root, ".env.local"), `VENDO_API_KEY=vnd_${"d".repeat(40)}\n`);
          return 0;
        },
      },
    })).toBe(0);

    expect(asked).toBe("Vendo Cloud (recommended) or bring your own keys?");
    expect(logins).toBe(1);
    await expectCloudWiring(root, sink.logs.join("\n"));
    // The key the install records is the one its wiring will actually resolve —
    // minted after the cloud step had already answered "no key".
    expect(JSON.parse(await readFile(join(root, ".vendo", "install.json"), "utf8")))
      .toMatchObject({ modelKey: "VENDO_API_KEY" });
  });

  /** A login that never completes must not take the install with it: the door
      it would have written is the SAME door, minus the promise about the
      deployment. Init states what it wired and moves on. */
  it("finishes the install on the bring-your-own path when the login does not complete", async () => {
    const root = await mcpHost();
    const sink = output();
    expect(await run(root, sink, {
      ...interactiveMcp,
      selectUseCase: async () => "cloud",
      cloud: { ...NO_CLOUD, deviceLogin: async () => 1 },
    })).toBe(0);

    expect(sink.errors.join("\n")).toContain("Vendo Cloud sign-in did not complete");
    expect(sink.logs.join("\n")).not.toContain("Sign-in: Vendo Cloud");
    // The door still landed, and so did the key that signs dev in.
    expect(await readFile(join(root, "app", ".well-known", "[...vendo]", "route.ts"), "utf8"))
      .toContain("wellKnownVendoHandler");
    expect(serviceKeyIn(await readFile(join(root, ".env.local"), "utf8"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("opens no browser for a run that answered bring-your-own", async () => {
    const root = await mcpHost();
    const sink = output();
    expect(await run(root, sink, {
      ...interactiveMcp,
      selectUseCase: async () => "byo",
      cloud: { ...NO_CLOUD, deviceLogin: async () => { throw new Error("opened a browser"); } },
    })).toBe(0);
    expect(sink.logs.join("\n")).not.toContain("Sign-in: Vendo Cloud");
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8"))
      .toContain('mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },');
  });

  /** --yes is "take the defaults", and no default may open a browser. With a
      key the defaults ARE the Cloud wiring; without one they are the keyless
      install, stated out loud. */
  it("takes the silent Cloud wiring under --yes with a key, and never logs in without one", async () => {
    const keyed = await mcpHost(true);
    const keyedSink = output();
    expect(await run(keyed, keyedSink, {
      useCase: "mcp", auth: "clerk", yes: true, baseUrl: "http://localhost:3000",
      cloud: { deviceLogin: async () => { throw new Error("opened a browser"); } },
    })).toBe(0);
    await expectCloudWiring(keyed, keyedSink.logs.join("\n"));

    const keyless = await mcpHost();
    const keylessSink = output();
    expect(await run(keyless, keylessSink, {
      useCase: "mcp", auth: "clerk", yes: true, baseUrl: "http://localhost:3000",
      cloud: { ...NO_CLOUD, deviceLogin: async () => { throw new Error("opened a browser"); } },
    })).toBe(0);
    expect(keylessSink.logs.join("\n")).not.toContain("Sign-in: Vendo Cloud");
    // The door still opened; only the promise about the deployment is missing.
    expect(await readFile(join(keyless, "app", ".well-known", "[...vendo]", "route.ts"), "utf8"))
      .toContain("wellKnownVendoHandler");
  });
});

/**
 * The redesign: init states FACTS and links out. Every instruction it used to
 * print — the mount paste, the loop snippet, the MCP steps, the doctor gate —
 * was a second copy of something the docs already carry, and a terminal cannot
 * keep a copy correct. Four lines, computed per run, and one URL.
 */
describe("the closing output is facts, never code or steps", () => {
  it("ends on Wired / Detected / Guard / Continue and prints no snippet at all", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");

    expect(logs).toContain("Wired: ");
    expect(logs).toContain(join("lib", "vendo.ts"));
    expect(logs).toContain("Detected: Next.js · no auth detected · npm · port 3000");
    expect(logs).toContain("Guard: writes run without approval — how to tighten: vendo.run/agents.md");
    expect(logs).toContain("Continue: https://docs.vendo.run/product/quickstart");

    // Nothing that reads as code or as homework.
    expect(logs).not.toContain("STEP LEFT");
    expect(logs).not.toContain("STEPS LEFT");
    expect(logs).not.toContain("VendoProvider");
    expect(logs).not.toContain("VendoOverlay");
    expect(logs).not.toContain("Last steps are yours");
    expect(logs).not.toContain("Agent tail:");
    // Doctor is a standalone command; init never sends anyone there.
    expect(logs).not.toContain("vendo doctor");
  });

  it.each([
    ["embedded", {}, "https://docs.vendo.run/product/quickstart"],
    ["agent-loop", { ai: "6.0.0" }, "https://docs.vendo.run/existing-agent/ai-sdk"],
    ["agent-loop", { "@mastra/core": "1.0.0" }, "https://docs.vendo.run/existing-agent/mastra"],
  ] as const)("continues at the page for %s", async (useCase, extraDeps, url) => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", ...extraDeps },
    }));
    const sink = output();
    expect(await run(root, sink, { useCase })).toBe(0);
    expect(sink.logs.join("\n")).toContain(`Continue: ${url}`);
  });

  it("sends an MCP install to the door's own page", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink, {
      useCase: "mcp", yes: true, auth: "clerk", baseUrl: "http://localhost:3000",
    })).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Continue: https://docs.vendo.run/outside-agents/quickstart");
    // The steps the docs page owns are no longer echoed at the terminal.
    expect(logs).not.toContain("Point any MCP client at");
    expect(logs).not.toContain("Set where you deploy");
  });

  it("carries the same facts in the --agent receipt, and no pastes", async () => {
    const root = await fixture();
    const sink = output();
    expect(await agentRun(root, sink)).toBe(0);
    const receipt = receiptOf(sink.logs) as unknown as Record<string, unknown>;
    expect(receipt).toMatchObject({
      status: "written",
      root,
      useCase: "embedded",
      detected: { framework: "Next.js", auth: "no auth detected", packageManager: "npm", port: 3000 },
      guardPosture: "writes run without approval — how to tighten: vendo.run/agents.md",
      continueUrl: "https://docs.vendo.run/product/quickstart",
      judgment: { status: "delegated" },
    });
    expect(receipt["wrote"]).toContain(join("lib", "vendo.ts"));
    expect(receipt["pasteEdits"]).toBeUndefined();
  });
});

describe("the judgment question is asked up front, and loosenings never block", () => {
  /** It used to be asked at the TOP of the pass that then runs for minutes —
      past the point the person who started the install has walked away. It is
      knowable before that (the engine ladder is a read-only probe), so it is
      asked with the other questions and the flow is handed the answer.

      The discriminator is init's own WRITE step: the question phase ends when
      init starts writing (`Wired (N files):`), and the pass runs after that. A
      consent asked before the write is up front; one asked after it is the old
      mid-run prompt. Asserting only "before the pass" would pass either way. */
  it("asks for AI consent before init writes a single file, not at the top of the pass", async () => {
    const events: string[] = [];
    const root = await fixture();
    const harness = themeHarness({ slots: { accent: "#2b7fff" } });
    const sink = {
      output: {
        log: (message: string) => { if (message.startsWith("\nWired (")) events.push("wrote-files"); },
        error: () => {},
      },
    };
    expect(await run(root, sink, {
      interactive: true,
      askText: async (_q, _h, prefill) => { events.push("dev-url"); return prefill ?? ""; },
      extract: {
        interactive: true,
        harnesses: [{
          ...harness,
          run: async (input) => { events.push("ai-pass"); return harness.run(input); },
        }],
        confirm: async () => { events.push("ai-consent"); return true; },
      },
    })).toBe(0);

    expect(events).toContain("ai-consent");
    expect(events).toContain("wrote-files");
    expect(events).toContain("ai-pass");
    // Asked ONCE, and before anything was written.
    expect(events.filter((event) => event === "ai-consent")).toHaveLength(1);
    expect(events.indexOf("ai-consent")).toBeLessThan(events.indexOf("wrote-files"));
    // …which is the same side of the write as the other up-front questions.
    expect(events.indexOf("dev-url")).toBeLessThan(events.indexOf("wrote-files"));
  });

  it("declining up front skips the pass, and never asks a second time", async () => {
    const events: string[] = [];
    const root = await fixture();
    const logs: string[] = [];
    const sink = {
      output: {
        log: (message: string) => {
          logs.push(message);
          if (message.startsWith("\nWired (")) events.push("wrote-files");
        },
        error: () => {},
      },
    };
    expect(await run(root, sink, {
      interactive: true,
      extract: {
        interactive: true,
        harnesses: [{
          ...themeHarness({}),
          run: async () => { events.push("ai-pass"); return "```json\n{}\n```"; },
        }],
        confirm: async () => { events.push("ai-consent"); return false; },
      },
    })).toBe(0);
    expect(events.filter((event) => event === "ai-consent")).toHaveLength(1);
    expect(events.indexOf("ai-consent")).toBeLessThan(events.indexOf("wrote-files"));
    expect(events).not.toContain("ai-pass");
    expect(logs.join("\n")).toContain("judgment: structural-only");
  });

  /** A loosening is never applied without a human, and init stopped asking once
      its questions were done — so they QUEUE (init passes `queueLoosenings`)
      and the count becomes a fact the run reports, never a prompt it blocks on.
      The queueing itself is proven against the real pass in judge/pass.test.ts;
      this is init's half: no review prompt, and no line when none are pending. */
  it("never opens the loosening review, and says nothing when none are pending", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, { yes: true, ai: true, extract: { harnesses: [themeHarness({})] } })).toBe(0);
    expect(sink.logs.join("\n")).not.toContain("Pending review:");
  });
});

describe("the models answer decides the wiring", () => {
  it("writes NO models line for a Vendo Cloud key, however many provider keys are lying around", async () => {
    const root = await fixture();
    const sink = output();
    expect(await runInit({
      targetDir: root,
      output: sink.output,
      env: { VENDO_API_KEY: `vnd_${"a".repeat(40)}`, ANTHROPIC_API_KEY: "sk-ant-test" },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    const composition = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(composition).not.toContain("models:");
    expect(composition).not.toContain("@ai-sdk/anthropic");
    // …and the install records the key its wiring actually reads.
    expect(JSON.parse(await readFile(join(root, ".vendo", "install.json"), "utf8")))
      .toMatchObject({ modelKey: "VENDO_API_KEY" });
  });

  it("writes the provider line — and records that key — when the answer is bring-your-own", async () => {
    const root = await fixture();
    expect(await run(root, output(), {
      byo: true,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    })).toBe(0);
    const composition = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(composition).toContain('models: { default: anthropic("claude-sonnet-4-6") }, // ANTHROPIC_API_KEY supplies the key');
    expect(JSON.parse(await readFile(join(root, ".vendo", "install.json"), "utf8")))
      .toMatchObject({ modelKey: "ANTHROPIC_API_KEY" });

    // A re-run wires nothing new — init never rewrites a composition it did not
    // author — so the record must not start claiming a key that file does not
    // read, however the second run's answer came out.
    expect(await runInit({
      targetDir: root,
      output: output().output,
      env: { VENDO_API_KEY: `vnd_${"c".repeat(40)}` },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8")).toBe(composition);
    expect(JSON.parse(await readFile(join(root, ".vendo", "install.json"), "utf8")))
      .toMatchObject({ modelKey: "ANTHROPIC_API_KEY" });
  });
});

describe("nothing blocks after the up-front questions", () => {
  it("asks the dev URL BEFORE the long AI pass, and never reviews theme slots after it", async () => {
    const events: string[] = [];
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n');
    await writeFile(join(root, "app", "globals.css"),
      ":root { --color-ink: #111111; --color-evergreen-600: #196b46; }\n");
    const harness = themeHarness({
      slots: { accent: "#196b46", text: "#111111" },
      uncertain: [{ slot: "accent", note: "green may be data-only" }],
    });
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      ai: true,
      extract: {
        harnesses: [{
          ...harness,
          run: async (input) => {
            events.push("ai-pass");
            return harness.run(input);
          },
        }],
      },
      askText: async (_question, _hint, prefill) => {
        events.push("dev-url");
        return prefill ?? "";
      },
    })).toBe(0);

    expect(events[0]).toBe("dev-url");
    expect(events).toContain("ai-pass");
    // The uncertain slot keeps what was extracted, and the run SAYS so.
    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8")).colors.accent).toBe("#196b46");
    expect(sink.logs.join("\n")).toContain("Kept as extracted (uncertain): accent");
  });
});

// FINDINGS (linkwarden field test 2026-08-08): a package.json saved with a
// UTF-8 BOM — what Notepad and PowerShell's Set-Content produce — crashed
// init with a raw SyntaxError stack. npm and Node's own require() both
// tolerate the BOM, so the manifest is legitimate; and a manifest that is
// GENUINELY broken deserves one clean sentence, never a stack dump.
describe("a package.json the way Windows editors save it", () => {
  it("reads a BOM'd package.json like npm does — init succeeds and the hooks land", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), "﻿" + JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
    }));
    const sink = output();
    expect(await runInit({
      targetDir: root,
      output: sink.output,
      env: {},
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      resolveCredential: async () => ({ rung: "none" }),
    })).toBe(0);
    const written = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(written.scripts?.["predev"]).toContain("vendo sync");
  });

  it("says one clean sentence for a malformed package.json instead of a raw stack", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), "{ not json at all");
    const sink = output();
    expect(await runInit({
      targetDir: root,
      output: sink.output,
      env: {},
      framework: "next",
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      resolveCredential: async () => ({ rung: "none" }),
    })).toBe(1);
    expect(sink.errors.join("\n")).toContain("package.json is not valid JSON");
    expect(sink.errors.join("\n")).toContain("vendo init");
  });
});
