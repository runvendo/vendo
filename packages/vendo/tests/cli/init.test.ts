import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractServerActions } from "@vendoai/actions/sync";
import type { RunContext, ToolDescriptor } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractionHarness } from "../../src/cli/extract/harness.js";
import { firstSentence, prettyThemeReview, runInit } from "../../src/cli/init.js";
import { CLI_VERSION, type Output } from "../../src/cli/shared.js";

const cleanup: string[] = [];

afterEach(async () => {
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

/** How the generated map reaches `app/actions/*` out of the route dir.
    Assembled rather than written literally: an escaping relative specifier
    spelled inline reads to the dependency guard as a real import. */
const ACTION_SPECIFIER = ["..", "..", "..", "actions", "later"].join("/");

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
    expect(JSON.parse(sink.logs.join("\n"))).toMatchObject({ framework: expected });
  });

  it("wires a fresh Next host with no prompts: route + hooks + .vendo, and one paste", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);

    // The generated code file: a model-less createVendo (model is optional).
    // No client file is generated at all — the host writes its own.
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain('import { createVendo, guard, nextVendoHandler } from "@vendoai/vendo/server";');
    // The anonymous principal matches the docs' chat-route demo principal —
    // a null wire principal makes chat-created apps invisible to the embeds
    // (0.4.1 E2E cert B4).
    expect(route).toContain('principal: async () => ({ kind: "user" as const, subject: "demo-user" })');
    expect(route).not.toContain("model");
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
    expect(logs).toContain("Wired (2 files):");
    expect(logs).toContain("+ " + join("app", "api", "vendo", "[...vendo]", "route.ts"));
    expect(logs).not.toContain("~ " + join("app", "layout.tsx"));
    expect(logs).toContain("~ package.json");
    // No auth dependency in the fixture: one calm advisory, nothing guessed.
    expect(logs).toContain("Auth: no provider detected");
    expect(logs).toContain("ONE STEP LEFT — paste this yourself (init never edits your files)");
    // The mount block replaces the compact list; nothing is printed twice.
    expect(logs).not.toContain("Last steps are yours:");
    expect(logs).toContain("npx vendo doctor");
    // No interview, no per-diff consent, no refine offer, no finale.
    expect(logs).not.toContain("[y/N]");
    expect(logs).not.toContain("vendo refine");
  });

  // A plain transcript is parsed as often as it is read, so the MCP steps keep
  // their exact strings there — the newline inside a step becomes an indent and
  // nothing else. (The pretty run numbers the same strings; mcpStepLines owns
  // that half.)
  it("mcp: the plain transcript indents each step's detail under its headline", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-mcp-plain-"));
    cleanup.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "mcp-host",
      dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" },
    }));
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await writeFile(join(root, "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    const sink = output();
    expect(await run(root, sink, {
      useCase: "mcp", yes: true, auth: "clerk", baseUrl: "https://app.acme.com",
    })).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain(
      "  Set `VENDO_BASE_URL` in your deploy platform\n"
      + "    `https://app.acme.com` — captured earlier, already in .env.example",
    );
    // The headline of a step is never indented past two spaces, so a reader
    // (and a grep) can still tell a step from its detail.
    expect(logs).toContain("  Point any MCP client at `https://app.acme.com/api/vendo/mcp`\n    your users' setup page");
  });

  it("is idempotent: a re-run changes nothing and says so", async () => {
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    const first = await tree(root);
    const again = output();
    expect(await run(root, again)).toBe(0);
    expect(await tree(root)).toEqual(first);
    expect(again.logs.join("\n")).toContain("Already wired — nothing to change.");
    // The second run's agent tail reflects what THIS run did: no composition
    // was created (no auth line), the layout is already mounted (no layout
    // line) — only the doctor gate remains.
    const tail = again.logs.join("\n").split("Agent tail:")[1]!;
    expect(tail).not.toContain("auth:");
    expect(tail).toContain("vendo doctor --json");
  });

  it("computes the paste's theme specifier from a src/app layout (../../ to project root)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-srcapp-"));
    cleanup.push(root);
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
    await writeFile(join(root, "src", "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    await expect(readFile(join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8")).resolves.toContain("nextVendoHandler");
    // The layout is untouched; the specifier rides the printed paste instead.
    expect(await readFile(join(root, "src", "app", "layout.tsx"), "utf8")).not.toContain("VendoProvider");
    const logs = sink.logs.join("\n");
    expect(logs).toContain('import theme from "../../.vendo/theme.json";');
    expect(logs).toContain('import { VendoProvider } from "@vendoai/vendo/react";');
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
    expect(await readdir(root)).not.toContain("app");
  });

  it("prints a theme-less paste when the project disables resolveJsonModule", async () => {
    const root = await fixture();
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { resolveJsonModule: false } }));
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain('<VendoProvider baseUrl="/api/vendo">');
    expect(logs).not.toContain("import theme from");
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
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    // The preset comes from its own subpath — never "@vendoai/vendo/server" —
    // so importing it never resolves the other presets' optional peer deps
    // (corpus-triage Task 9).
    expect(route).toContain(`import { ${preset} } from "${specifier}";`);
    expect(route).toContain('import { createVendo, guard, nextVendoHandler } from "@vendoai/vendo/server";');
    expect(route).toContain(`auth: ${preset}(),`);
    // The detected line carries its escape hatch, and the preset owns the
    // principal seam — no hand-wired anonymous resolver remains.
    expect(route).toContain("https://docs.vendo.run/connect/act-as-presets");
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain("auth: authJs(),");
    expect(sink.logs.join("\n")).not.toContain("Auth:");
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).not.toContain("auth:");
    expect(route).toContain('principal: async () => ({ kind: "user" as const, subject: "demo-user" })');
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("left anonymous");
    expect(advisories[0]).toContain("@clerk/nextjs");
    expect(advisories[0]).toContain("auth: clerk()");
    expect(advisories[0]).toContain(join("app", "api", "vendo", "[...vendo]", "route.ts"));
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain("auth: clerk(),");
    expect(route).toContain("// Selected Clerk — clerk() fills the identity seams");
    expect(route).not.toContain("Detected");
    expect(route).toContain("https://docs.vendo.run/connect/act-as-presets");
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).not.toContain("auth:");
    expect(route).toContain('principal: async () => ({ kind: "user" as const, subject: "demo-user" })');
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("auth: jwt({ secret:");
    expect(advisories[0]).toContain("https://docs.vendo.run/connect/act-as-presets");
  });

  it("ambiguous detection offers the picker with detected families first (after none)", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@supabase/supabase-js": "2.0.0", "@auth0/nextjs-auth0": "3.0.0" },
    }));
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).not.toContain("auth:");
    expect(route).toContain('principal: async () => ({ kind: "user" as const, subject: "demo-user" })');
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
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
    const detectedSink = output();
    expect(await run(detected, detectedSink, { yes: true, auth: "supabase" })).toBe(0);
    const detectedRoute = await readFile(join(detected, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
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
    const declinedRoute = await readFile(join(declined, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(declinedRoute).toContain('subject: "demo-user"');
    expect(declinedSink.logs.join("\n")).toContain("left anonymous");

    // --auth jwt: nothing wired, the recipe is the answer.
    const jwt = await fixture();
    const jwtSink = output();
    expect(await run(jwt, jwtSink, { yes: true, auth: "jwt" })).toBe(0);
    const jwtRoute = await readFile(join(jwt, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(jwtRoute).toContain('subject: "demo-user"');
    expect(jwtSink.logs.join("\n")).toContain("auth: jwt({ secret:");
  });

  // Agent-install-dx: a non-interactive scaffold run is agent-driven — the
  // run ENDS with the repo-specific agent tail (the wired auth preset and
  // what's still stubbed, the exact files to hand-edit, the doctor gate),
  // every line derived from what this run actually wrote.
  it("non-interactive runs end with the agent tail: wired preset, hand-edit files, doctor gate", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "next-auth": "5.0.0" },
    }));
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");
    const tailAt = logs.indexOf("Agent tail:");
    expect(tailAt).toBeGreaterThan(-1);
    const tail = logs.slice(tailAt);
    // The wired preset with its provenance — real run facts, not prose…
    expect(tail).toContain("auth: authJs() wired (detected next-auth)");
    // …the exact files the agent must now hand-edit, including the mount
    // paste init will never make for it…
    expect(tail).toContain(`edit ${join("app", "layout.tsx")} — wrap the app in the <VendoProvider> lines above`);
    expect(tail).toContain(`edit ${join(".vendo", "brief.md")} — `);
    // …and the machine gate, closing the tail block.
    expect(tail).toContain("vendo doctor --json");
    expect(sink.logs[sink.logs.length - 2]).toContain("vendo doctor --json");
    expect(sink.logs[sink.logs.length - 2]).toContain("green");
    // The one line after it is the outstanding-paste echo: with a mount still
    // pending, the run's LAST word is the step the human owns (audit F5).
    expect(sink.logs[sink.logs.length - 1]).toBe(`\n→ Don't forget the paste in ${join("app", "layout.tsx")} (frame above)`);
  });

  // Agent-install-dx Layer 2 (key-mint integration): a keyless run's tail
  // carries the complete in-band key story — the auth.md discovery URL, the
  // `vendo login` ceremony, and both flag fallbacks — so the agent never
  // detours to a browser signup it can't drive.
  it("a keyless run's tail points at the auth.md key flow; a run with a key stays silent about it", async () => {
    const keyless = await fixture();
    const keylessSink = output();
    expect(await run(keyless, keylessSink)).toBe(0);
    const keylessTail = keylessSink.logs.join("\n").split("Agent tail:")[1]!;
    expect(keylessTail).toContain("cloud key: none");
    expect(keylessTail).toContain("https://vendo.run/auth.md");
    expect(keylessTail).toContain("vendo login");
    expect(keylessTail).toContain("--cloud-key");
    expect(keylessTail).toContain("--byo");

    const keyed = await fixture();
    const keyedSink = output();
    expect(await run(keyed, keyedSink, { env: { ANTHROPIC_API_KEY: "sk-ant-test" } })).toBe(0);
    const keyedTail = keyedSink.logs.join("\n").split("Agent tail:")[1]!;
    expect(keyedTail).not.toContain("cloud key: none");
  });

  it("the tail states auth stubs honestly: anonymous scaffolds point at the composition, a picked preset names its missing SDK", async () => {
    // No auth dependency: the tail says so and points the hand-edit at the
    // generated composition file.
    const anonymous = await fixture();
    const anonymousSink = output();
    expect(await run(anonymous, anonymousSink)).toBe(0);
    const anonymousTail = anonymousSink.logs.join("\n").split("Agent tail:")[1]!;
    expect(anonymousTail).toContain("auth: none wired");
    expect(anonymousTail).toContain(`edit ${join("app", "api", "vendo", "[...vendo]", "route.ts")} — `);
    // The advisory count stays exact: the tail never repeats the "Auth:" line.
    expect(anonymousSink.logs.filter((line) => line.includes("Auth:"))).toHaveLength(1);

    // --auth clerk without the SDK: the stub is the missing runtime package.
    const picked = await fixture();
    const pickedSink = output();
    expect(await run(picked, pickedSink, { yes: true, auth: "clerk" })).toBe(0);
    const pickedTail = pickedSink.logs.join("\n").split("Agent tail:")[1]!;
    expect(pickedTail).toContain("auth: clerk() wired");
    expect(pickedTail).toContain("@clerk/backend");
  });

  it("interactive runs keep the clack-style summary — no agent tail; --yes brings it back even on a TTY", async () => {
    const interactive = await fixture();
    const interactiveSink = output();
    expect(await run(interactive, interactiveSink, { interactive: true })).toBe(0);
    expect(interactiveSink.logs.join("\n")).not.toContain("Agent tail");

    // --yes IS the non-interactive path, TTY or not.
    const flagged = await fixture();
    const flaggedSink = output();
    expect(await run(flagged, flaggedSink, { yes: true, interactive: true })).toBe(0);
    expect(flaggedSink.logs.join("\n")).toContain("Agent tail:");
  });

  it("the Express tail points at the printed wiring lines (no exact entry file exists to name)", async () => {
    const root = await expressFixture(false);
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const tail = sink.logs.join("\n").split("Agent tail:")[1]!;
    expect(tail).toContain("auth: none wired");
    expect(tail).toContain(`edit ${join("vendo", "server.ts")} — `);
    expect(tail).toContain("mountVendo()");
    expect(tail).toContain("vendo doctor --json");
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
    expect(errors).toContain("vendo init --yes --framework next"); // one example invocation
    expect(await readdir(root)).toEqual(["package.json"]); // nothing was written

    // The flag answers it: the same host scaffolds as the named framework.
    const answered = output();
    expect(await run(root, answered, { yes: true, framework: "next" })).toBe(0);
    await expect(readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .resolves.toContain("createVendo");
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

  it("--theme answers uncertain slots; the review prompt covers only what the flags left open", async () => {
    const root = await fixture();
    const reviewed: string[] = [];
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
      themeReview: async (summary) => {
        reviewed.push(...summary.uncertain.map((entry) => entry.slot));
        return {};
      },
    })).toBe(0);
    expect(reviewed).toEqual(["border"]); // accent was answered by flag
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#facc15");
    // The contrast-derived accentText follows the flag-replaced accent.
    expect(theme.colors.accentText).toBe("#000000");

    // With --yes the flag still applies — no prompt existed to answer.
    const quiet = await fixture();
    expect(await run(quiet, output(), {
      yes: true,
      ai: true,
      themeAnswers: { accent: "#facc15" },
      extract: {
        harnesses: [themeHarness({
          slots: { accent: "#196b46" },
          uncertain: [{ slot: "accent", note: "green may be data-only" }],
        })],
      },
      themeReview: async () => { throw new Error("prompted"); },
    })).toBe(0);
    const quietTheme = JSON.parse(await readFile(join(quiet, ".vendo", "theme.json"), "utf8"));
    expect(quietTheme.colors.accent).toBe("#facc15");
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

  it("prints ONE paste — <VendoProvider>, with no overlay line", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const printed = sink.logs.join("\n");
    expect(printed).toContain("<VendoProvider");
    expect(printed).not.toContain("VendoOverlay");
    expect(printed).not.toContain("vendo-root");
  });

  it("states an env key in one line and skips the cloud offer", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, { env: { ANTHROPIC_API_KEY: "sk-a" } })).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Model: explicit ANTHROPIC_API_KEY (anthropic)");
    expect(logs).not.toContain("No model key yet");
    // The credential story leads the run — before the AI passes and the summary.
    expect(logs.indexOf("Model: explicit")).toBeLessThan(logs.indexOf("Wired ("));
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
    // Post server-wiring semantics: dev trusts its own origin; production
    // fails loud without the variable — no silent credential drop.
    expect(example).toContain("Dev trusts the request's own");
    expect(example).toContain("fails loud without this set");
    expect(example).not.toContain("disabled without it");
    expect(await run(root, output())).toBe(0);
    expect((await readFile(join(root, ".env.example"), "utf8")).match(/VENDO_BASE_URL/g)).toHaveLength(1);
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

    const actions = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "vendo-actions.ts"), "utf8");
    expect(actions).toContain("createInvoice");
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain('import { serverActions } from "./vendo-actions";');
    expect(route).toContain("serverActions,");
  });

  it("never regenerates an existing route.ts or vendo-actions.ts — it prints the paste instead", async () => {
    const routeDir = join("app", "api", "vendo", "[...vendo]");
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    const routePath = join(root, routeDir, "route.ts");
    const routeBefore = await readFile(routePath, "utf8");

    // Actions appear AFTER the route was generated: the wiring the route now
    // needs is the developer's paste, and the route on disk does not move.
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    const second = output();
    expect(await run(root, second)).toBe(0);
    expect(await readFile(routePath, "utf8")).toBe(routeBefore);
    const secondLogs = second.logs.join("\n");
    expect(secondLogs).toContain(`File: ${join(routeDir, "route.ts")}`);
    expect(secondLogs).toContain('import { serverActions } from "./vendo-actions";');
    expect(secondLogs).toContain("… then add inside createVendo({ … }): serverActions,");

    // The map that run CREATED now exists, so a surface change afterwards is a
    // printed paste of ONLY the missing entries — the file stays byte-identical,
    // and the alias continues the file's own numbering (action0 is taken).
    const mapPath = join(root, routeDir, "vendo-actions.ts");
    const mapBefore = await readFile(mapPath, "utf8");
    expect(mapBefore).toContain("later");
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function renamed() {\n  return 1;\n}\n');
    const third = output();
    expect(await run(root, third)).toBe(0);
    expect(await readFile(mapPath, "utf8")).toBe(mapBefore);
    expect(await readFile(routePath, "utf8")).toBe(routeBefore);
    const thirdLogs = third.logs.join("\n");
    // The outstanding layout mount, the route wiring, and the unregistered action.
    expect(thirdLogs).toContain("3 STEPS LEFT — paste these yourself (init never edits your files)");
    expect(thirdLogs).toContain(`File: ${join(routeDir, "vendo-actions.ts")}`);
    expect(thirdLogs).toContain(`import { renamed as action1 } from ${JSON.stringify(ACTION_SPECIFIER)};`);
    expect(thirdLogs).toContain("… then add inside the serverActions map:");
    expect(thirdLogs).toContain('"app/actions/later.ts#renamed": action1,');
    // Only the missing entry — never the whole file, and never the entry the
    // map already carries.
    expect(thirdLogs).not.toContain("--- a/");
    expect(thirdLogs).not.toContain("app/actions/later.ts#later");
  });

  // Regression (review B2): the map is compared by the KEYS it registers, never
  // byte-for-byte. A host carrying a previous release's generated map — whose
  // header comment Vendo has since reworded — must hear nothing at all while
  // its action surface is unchanged, or every existing install nags forever
  // with a "the surface moved" message that is simply false.
  it("says nothing about a map whose surface is unchanged, however far its text has drifted", async () => {
    const routeDir = join("app", "api", "vendo", "[...vendo]");
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
    const routeDir = join("app", "api", "vendo", "[...vendo]");
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

  it("carries the pastes it will not write into the --agent plan", async () => {
    const routeDir = join("app", "api", "vendo", "[...vendo]");
    const root = await fixture();
    expect(await run(root, output())).toBe(0);
    await mkdir(join(root, "app", "actions"), { recursive: true });
    await writeFile(join(root, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    const sink = output();
    expect(await runInit({ targetDir: root, agent: true, output: sink.output })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as {
      edits?: Array<{ file: string; lines: string[]; why: string }>;
      manualSteps: string[];
    };
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits?.[0]?.file).toBe(join(routeDir, "route.ts"));
    expect(plan.edits?.[0]?.lines).toContain('import { serverActions } from "./vendo-actions";');
    expect(plan.edits?.[0]?.why).toContain("fails closed");
    expect(plan.manualSteps.join("\n")).toContain(`In ${join(routeDir, "route.ts")}:`);
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
    expect(sink.logs.join("\n")).toContain('app.use("/api/vendo", mountVendo());');
    expect(sink.logs.join("\n")).toContain('<VendoProvider baseUrl="/api/vendo"');
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
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
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

  // Task 4(d): the uncertain review is asked ONLY about slots the model
  // actually flagged — a clean model reply never reaches the review prompt.
  it("never opens the uncertain review when the model reports no uncertainty", async () => {
    const root = await fixture();
    expect(await run(root, output(), {
      ai: true,
      extract: { harnesses: [themeHarness({ slots: { accent: "#2b7fff" } })] },
      themeReview: async () => { throw new Error("must never be asked"); },
    })).toBe(0);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#2b7fff");
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

  it("asks about the theme ONLY when the model reports uncertainty, and applies the answer", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      'import "./globals.css";\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n');
    await writeFile(join(root, "app", "globals.css"),
      ":root { --color-ink: #111111; --color-evergreen-600: #196b46; }\n");

    const reviewed: string[] = [];
    const sink = output();
    expect(await run(root, sink, {
      ai: true,
      extract: {
        harnesses: [themeHarness({
          slots: { accent: "#196b46", text: "#111111" },
          uncertain: [{ slot: "accent", note: "green may be data-only" }],
        })],
      },
      themeReview: async (summary) => {
        reviewed.push(...summary.uncertain.map((entry) => entry.slot));
        return { accent: "#facc15", border: "#ecebe8", danger: "chartreuse-ish", sparkle: "#123456" };
      },
    })).toBe(0);

    expect(reviewed).toEqual(["accent"]);
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

  it("emits a read-only agent plan with code changes, extraction, and the layout mount", async () => {
    const root = await fixture();
    const before = await tree(root);
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as {
      framework: string;
      writes: string[];
      codeChanges: Array<{ path: string; diff: string }>;
      manualSteps: string[];
      extraction: { tools: unknown[]; warnings: string[] };
      riskRecommendations: unknown[];
      aiPolish?: unknown;
    };
    expect(plan.framework).toBe("next");
    expect(plan.writes).toContain(".vendo/tools.json");
    expect(plan.writes).not.toContain(".env");
    expect(plan.codeChanges.map((change) => change.path)).toContain(join("app", "api", "vendo", "[...vendo]", "route.ts"));
    // Init writes no client file at all, and the host's layout never is a
    // planned change: the paste rides manualSteps + `mount`.
    expect(plan.codeChanges.map((change) => change.path)).not.toContain(join("vendo", "vendo-root.tsx"));
    expect(plan.codeChanges.map((change) => change.path)).not.toContain(join("app", "layout.tsx"));
    expect(plan.manualSteps[0]).toBe(`In ${join("app", "layout.tsx")}:`);
    expect(Array.isArray(plan.extraction.tools)).toBe(true);
    expect(Array.isArray(plan.riskRecommendations)).toBe(true);
    // The delegated AI-polish contract is GONE with the draft channel it fed:
    // there is no `vendo extract --apply` for an external agent to land a draft
    // through, and judgment now needs quoted evidence a delegated draft cannot
    // carry. The plan stays deterministic facts only.
    expect(plan.aiPolish).toBeUndefined();
    expect(await tree(root)).toEqual(before); // --agent wrote nothing
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

describe("the mount paste (init never edits user-authored source)", () => {
  /** The whole point of decision 1: a host layout that init COULD have
      rewritten unambiguously is left byte-identical, and the paste is
      printed instead. */
  it("leaves an existing layout.tsx byte-identical and prints the mount block", async () => {
    const root = await fixture();
    const before = await readFile(join(root, "app", "layout.tsx"), "utf8");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    expect(await readFile(join(root, "app", "layout.tsx"), "utf8")).toBe(before);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("ONE STEP LEFT — paste this yourself (init never edits your files)");
    expect(logs).toContain(`File: ${join("app", "layout.tsx")}`);
    expect(logs).toContain('import { VendoProvider } from "@vendoai/vendo/react";');
    expect(logs).toContain('<VendoProvider baseUrl="/api/vendo" theme={theme as VendoTheme}>{children}</VendoProvider>');
    // Doctor is named ONCE, at the ending — never a second time inside the
    // paste frame (#1164).
    expect(logs).not.toContain("Then confirm it landed: npx vendo doctor");
    expect(logs.match(/npx vendo doctor/g)).toHaveLength(1);
    // No layout diff is even proposed.
    expect(logs).not.toContain("~ " + join("app", "layout.tsx"));
  });

  it("an ambiguous layout gets the same paste — nothing about the file changes", async () => {
    const root = await fixture();
    const twoSites = "export default function Layout({ children }) {\n" +
      "  return <html><body><main>{children}</main><aside>{children}</aside></body></html>;\n}\n";
    await writeFile(join(root, "app", "layout.tsx"), twoSites);
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    expect(await readFile(join(root, "app", "layout.tsx"), "utf8")).toBe(twoSites);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("ONE STEP LEFT");
    expect(logs).toContain('import { VendoProvider } from "@vendoai/vendo/react";');
    expect(logs).toContain("<VendoProvider baseUrl=");
  });

  it("carries the same file and lines in the --agent plan's `mount`", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as {
      mount?: { file: string; lines: string[]; why: string };
      manualSteps: string[];
      codeChanges: Array<{ path: string }>;
    };
    expect(plan.mount?.file).toBe(join("app", "layout.tsx"));
    expect(plan.mount?.lines).toEqual([
      'import { VendoProvider } from "@vendoai/vendo/react";',
      'import theme from "../.vendo/theme.json";',
      'import type { VendoTheme } from "@vendoai/vendo";',
      '… then wrap: <VendoProvider baseUrl="/api/vendo" theme={theme as VendoTheme}>{children}</VendoProvider>',
    ]);
    expect(plan.mount?.why).toContain("nothing on the page can reach it");
    // The same lines still ride manualSteps, and no layout diff is planned.
    expect(plan.manualSteps.join("\n")).toContain('<VendoProvider baseUrl="/api/vendo"');
    expect(plan.codeChanges.map((change) => change.path)).not.toContain(join("app", "layout.tsx"));
  });

  /** A host that already mounts the provider IS mounted — init has nothing
      left to print, whatever surface it renders inside. */
  it("a layout that already mounts <VendoProvider> gets no paste", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      'import { VendoProvider } from "@vendoai/vendo/react";\n' +
      "export default function Layout({ children }) { return <html><body><VendoProvider>{children}</VendoProvider></body></html>; }\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).not.toContain("ONE STEP LEFT");
  });

  it("a host with its own surface (BYO embeds) is left entirely alone", async () => {
    const root = await fixture();
    await writeFile(join(root, "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body><VendoProvider>{children}</VendoProvider></body></html>; }\n");
    await mkdir(join(root, "app", "chat"), { recursive: true });
    await writeFile(join(root, "app", "chat", "page.tsx"),
      "export default () => <VendoToolResult output={null} />;\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    await expect(readFile(join(root, "vendo", "vendo-root.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(sink.logs.join("\n")).not.toContain("Last steps are yours:");
  });

  /** The nextcrm shape (corpus, pinned 5b6a555): every route lives under
      app/[locale]/, so the app router's ROOT layout is app/[locale]/layout.tsx
      and app/layout.tsx does not exist. Naming the phantom told the user to
      create a second root layout — the one edit that breaks such a host. */
  it("names the shallowest nested layout when the host has no app/layout.tsx", async () => {
    const root = await fixture();
    await rm(join(root, "app", "layout.tsx"));
    await mkdir(join(root, "app", "[locale]", "(auth)"), { recursive: true });
    await writeFile(join(root, "app", "[locale]", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    await writeFile(join(root, "app", "[locale]", "(auth)", "layout.tsx"),
      "export default function AuthLayout({ children }) { return <main>{children}</main>; }\n");
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as { mount?: { file: string; lines: string[] } };
    expect(plan.mount?.file).toBe(join("app", "[locale]", "layout.tsx"));
    // The paste still wraps {children}, and the theme import walks out of the
    // deeper directory.
    expect(plan.mount?.lines.at(-1)).toContain("{children}</VendoProvider>");
    expect(plan.mount?.lines).toContain('import theme from "../../.vendo/theme.json";');
  });

  it("keeps naming app/layout.tsx when a root layout sits beside nested ones", async () => {
    const root = await fixture();
    await mkdir(join(root, "app", "(shop)"), { recursive: true });
    await writeFile(join(root, "app", "(shop)", "layout.tsx"),
      "export default function ShopLayout({ children }) { return <main>{children}</main>; }\n");
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    expect((JSON.parse(sink.logs.join("\n")) as { mount?: { file: string } }).mount?.file)
      .toBe(join("app", "layout.tsx"));
  });

  it("still names pages/_app.tsx on a Pages-Router host with no layouts at all", async () => {
    const root = await fixture();
    await rm(join(root, "app", "layout.tsx"));
    await mkdir(join(root, "pages"), { recursive: true });
    await writeFile(join(root, "pages", "index.tsx"), "export default () => <main />;\n");
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as { mount?: { file: string; lines: string[] } };
    expect(plan.mount?.file).toBe(join("pages", "_app.tsx"));
    expect(plan.mount?.lines.at(-1)).toContain("<Component {...pageProps} /></VendoProvider>");
  });

  /** No layout and no pages/ means the host has no client root yet — the
      conventional app/layout.tsx is the address of the one it must create. */
  it("falls back to app/layout.tsx only when the host has no client root at all", async () => {
    const root = await fixture();
    await rm(join(root, "app", "layout.tsx"));
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    expect((JSON.parse(sink.logs.join("\n")) as { mount?: { file: string } }).mount?.file)
      .toBe(join("app", "layout.tsx"));
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

    const log = sink.logs.join("\n");
    expect(log).toContain("handleVendoRequest(request, env)");
    expect(log).toContain("VENDO_BASE_URL");
  });

  it("an undetectable host falls through to the custom scaffold interactively, never the Next layout", async () => {
    const root = await customFixture();
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const plan = JSON.parse(sink.logs.join("\n")) as { framework: string; writes: string[] };
    expect(plan.framework).toBe("custom");
    expect(plan.writes.join("\n")).not.toContain("app/api/vendo");
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

  it("--use-case agent-loop adds the snippet for the loop package.json already names", async () => {
    const aiSdk = await fixture();
    await writeFile(join(aiSdk, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", ai: "6.0.0" },
    }));
    const aiSink = output();
    expect(await run(aiSdk, aiSink, { useCase: "agent-loop" })).toBe(0);
    const aiLogs = aiSink.logs.join("\n");
    expect(aiLogs).toContain("2 STEPS LEFT");
    expect(aiLogs).toContain('import { vendoTools } from "@vendoai/vendo/ai-sdk";');

    // Mastra's principal step is a step of its own — a call without one fails
    // closed, so an install that skips it looks broken at the first tool call.
    const mastra = await fixture();
    await writeFile(join(mastra, "package.json"), JSON.stringify({
      name: "host",
      dependencies: { next: "16.0.0", "@mastra/core": "1.0.0" },
    }));
    const mastraSink = output();
    expect(await run(mastra, mastraSink, { useCase: "agent-loop" })).toBe(0);
    const mastraLogs = mastraSink.logs.join("\n");
    expect(mastraLogs).toContain("3 STEPS LEFT");
    expect(mastraLogs).toContain("vendoMastraTools");
    expect(mastraLogs).toContain("VENDO_PRINCIPAL_KEY");
  });

  it("--base-url replaces init's own .env.example placeholder and never touches .env.local", async () => {
    const root = await fixture();
    expect(await run(root, output(), { baseUrl: "https://app.acme.com" })).toBe(0);
    const example = await readFile(join(root, ".env.example"), "utf8");
    expect(example).toContain("VENDO_BASE_URL=https://app.acme.com");
    expect(example).not.toContain("VENDO_BASE_URL=http://localhost:3000");
    // A production URL in .env.local would repoint local dev's discovery,
    // callbacks and forwarding at the deployed origin.
    await expect(readFile(join(root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });

    // Enter declines: the placeholder stands, byte for byte.
    const skipped = await fixture();
    expect(await run(skipped, output(), { interactive: true, askText: async () => "" })).toBe(0);
    expect(await readFile(join(skipped, ".env.example"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:3000");
  });

  it("offers the live check only when nothing is left to paste, and never changes the exit code", async () => {
    // A run that still owes the mount paste: doctor would grade that paste,
    // so offering the check would fail a run that did nothing wrong.
    const owing = await fixture();
    expect(await run(owing, output(), {
      interactive: true,
      confirmCheck: async () => { throw new Error("prompted"); },
      runCheck: async () => { throw new Error("ran"); },
    })).toBe(0);

    // Already mounted: the ask fires, and a check that blows up is still 0.
    const mounted = await fixture();
    await writeFile(join(mounted, "app", "layout.tsx"),
      'import { VendoProvider } from "@vendoai/vendo/react";\n'
      + "export default function Layout({ children }) { return <VendoProvider>{children}</VendoProvider>; }\n");
    const asked: string[] = [];
    expect(await run(mounted, output(), {
      interactive: true,
      confirmCheck: async (question) => { asked.push(question); return true; },
      runCheck: async () => { throw new Error("doctor exploded"); },
    })).toBe(0);
    expect(asked).toEqual(["Start your dev server and run a live check now?"]);
  });
});

/**
 * #1165 — the uncertain-slot review used to hand a raw readline prompt a
 * ~450-character string, so it landed at column 0 with no rail, no wrapping and
 * the model's first person intact: the only place in the run where the rail
 * died. On the rail it is a `◇` question with the reasoning as a dim hint.
 */
describe("the uncertain-theme-slot review", () => {
  const NOTE = "app/page.module.css defines two neutrals: `--background: #fafafa` on the "
    + "full-height `.page` wrapper and `--foreground: #fff` painting the `.main` content "
    + "panel. I picked #fafafa because it is the only neutral distinct from the "
    + "already-fixed background (#ffffff); a literal cards/panels reading of `.main` would "
    + "instead give #ffffff, identical to background.";
  const summary = {
    slots: { surface: "#fafafa" },
    uncertain: [{ slot: "surface", note: NOTE }],
  } as unknown as Parameters<ReturnType<typeof prettyThemeReview>>[0];

  it("asks through the renderer, with the model's reasoning trimmed to the reading it chose", async () => {
    const asked: { question: string; hint?: string }[] = [];
    const review = prettyThemeReview({
      text: async (question: string, hint?: string) => { asked.push({ question, hint }); return ""; },
    });
    await expect(review(summary)).resolves.toEqual({});
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe(
      "Theme surface is uncertain — extracted #fafafa. Replacement value, or Enter to keep",
    );
    // The hint is the reading it CHOSE. The rejected alternative and the "I
    // picked…" first person behind it are what made the line a wall.
    expect(asked[0]!.hint!.length).toBeLessThan(NOTE.length / 2);
    expect(asked[0]!.hint).not.toContain("I picked");
    expect(asked[0]!.hint).toContain("app/page.module.css defines two neutrals");
  });

  it("keeps a typed replacement and treats Enter as keep", async () => {
    await expect(prettyThemeReview({ text: async () => "#ffffff" })(summary))
      .resolves.toEqual({ surface: "#ffffff" });
    await expect(prettyThemeReview({ text: async () => "" })(summary)).resolves.toEqual({});
  });

  it("firstSentence caps a note that never ends a sentence", () => {
    expect(firstSentence("x".repeat(400))).toHaveLength(160);
    expect(firstSentence("Short and done. And more.")).toBe("Short and done");
  });
});
