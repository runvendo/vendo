import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, ToolDescriptor } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractionHarness } from "./extract/harness.js";
import { runInit, starViaGh } from "./init.js";
import type { Output } from "./shared.js";

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
    [{ dependencies: { react: "19.0.0" } }, "unknown"],
  ] as const)("detects the host framework from package.json", async (manifest, expected) => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-detect-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify(manifest));
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    expect(JSON.parse(sink.logs.join("\n"))).toMatchObject({ framework: expected });
  });

  it("wires a fresh Next host with no prompts: route + hooks + .vendo, never touching the layout", async () => {
    const root = await fixture();
    const layoutBefore = await readFile(join(root, "app", "layout.tsx"), "utf8");
    const sink = output();
    expect(await run(root, sink)).toBe(0);

    // The two generated code files: model-less createVendo (model is optional)
    // wired to the empty shared registry.
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain('import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";');
    expect(route).toContain('import { registry } from ' + '"../../../../vendo/registry";');
    expect(route).toContain("catalog: registry,");
    expect(route).toContain("principal: async () => null");
    expect(route).not.toContain("model");
    const registry = await readFile(join(root, "vendo", "registry.tsx"), "utf8");
    // The type comes from @vendoai/vendo (the root contract-types entry), not
    // @vendoai/core — hosts only get @vendoai/vendo (or @vendoai/ui) as a
    // direct dependency; @vendoai/core is transitive and pnpm strict linking
    // won't let the host resolve it (TS2307).
    expect(registry).toContain('import type { ComponentRegistry } from "@vendoai/vendo";');
    expect(registry).toContain("export const registry = {} satisfies ComponentRegistry;");
    expect(registry).toContain("SpendingDonut"); // the commented example entry

    // package.json gains the sync hooks.
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.predev).toBe("vendo sync");
    expect(manifest.scripts?.prebuild).toBe("vendo sync --strict");

    // User-authored code is never edited; no model module is scaffolded.
    expect(await readFile(join(root, "app", "layout.tsx"), "utf8")).toBe(layoutBefore);
    await expect(readFile(join(root, "lib", "ai.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    // .vendo artifacts land; no encryption key is ever generated.
    for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
      await expect(readFile(join(root, ".vendo", file), "utf8")).resolves.toBeTruthy();
    }
    await expect(readFile(join(root, ".vendo", "data", ".gitignore"), "utf8")).resolves.toBe("*\n!.gitignore\n");
    await expect(readFile(join(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });

    // The summary lists what changed and hands the paste + next steps over.
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Wired (3 files):");
    expect(logs).toContain("+ " + join("vendo", "registry.tsx"));
    expect(logs).toContain("+ " + join("app", "api", "vendo", "[...vendo]", "route.ts"));
    expect(logs).toContain("~ package.json");
    // No auth dependency in the fixture: one calm advisory, nothing guessed.
    expect(logs).toContain("Auth: no provider detected");
    expect(logs).toContain("Last steps are yours:");
    expect(logs).toContain('import { VendoRoot } from "@vendoai/vendo/react";');
    expect(logs).toContain('import { registry } from "../vendo/registry";');
    expect(logs).toContain("<VendoRoot components={registry} theme={theme as VendoTheme}>{children}</VendoRoot>");
    expect(logs).toContain("npx vendo doctor");
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
    // The second run's agent tail reflects what THIS run did: no composition
    // was created (no auth line), no registry was generated (no registry edit
    // line) — only the still-manual layout paste and the doctor gate remain.
    const tail = again.logs.join("\n").split("Agent tail:")[1]!;
    expect(tail).not.toContain("auth:");
    expect(tail).not.toContain(join("vendo", "registry.tsx"));
    expect(tail).toContain(`edit ${join("app", "layout.tsx")} — `);
    expect(tail).toContain("vendo doctor --json");
  });

  it("computes the theme paste specifier from a src/app layout (../../ to project root)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-srcapp-"));
    cleanup.push(root);
    await mkdir(join(root, "src", "app"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "16.0.0" } }));
    await writeFile(join(root, "src", "app", "layout.tsx"),
      "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const route = await readFile(join(root, "src", "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain('import { registry } from ' + '"../../../../vendo/registry";');
    // The registry mirrors the app dir: src/app → src/vendo/registry.tsx.
    await expect(readFile(join(root, "src", "vendo", "registry.tsx"), "utf8")).resolves.toContain("ComponentRegistry");
    const logs = sink.logs.join("\n");
    expect(logs).toContain('import theme from "../../.vendo/theme.json";');
    expect(logs).toContain('import { registry } from "../vendo/registry";');
  });

  it("prints a theme-less paste when the project disables resolveJsonModule", async () => {
    const root = await fixture();
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { resolveJsonModule: false } }));
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("<VendoRoot components={registry}>{children}</VendoRoot>");
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
    expect(route).toContain('import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";');
    expect(route).toContain(`auth: ${preset}(),`);
    // The detected line carries its escape hatch, and the preset owns the
    // principal seam — no hand-wired anonymous resolver remains.
    expect(route).toContain("docs/act-as-presets.md");
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
    expect(asked).toEqual([{ question: "Detected next-auth — wire auth: authJs()?", defaultYes: true }]);
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
    expect(route).toContain("principal: async () => null");
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
    expect(route).toContain("docs/act-as-presets.md");
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
    expect(route).toContain("principal: async () => null");
    const advisories = sink.logs.filter((line) => line.includes("Auth:"));
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain("auth: jwt({ secret:");
    expect(advisories[0]).toContain("docs/act-as-presets.md");
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
    expect(route).toContain("principal: async () => null");
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
    expect(declinedRoute).toContain("principal: async () => null");
    expect(declinedSink.logs.join("\n")).toContain("left anonymous");

    // --auth jwt: nothing wired, the recipe is the answer.
    const jwt = await fixture();
    const jwtSink = output();
    expect(await run(jwt, jwtSink, { yes: true, auth: "jwt" })).toBe(0);
    const jwtRoute = await readFile(join(jwt, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(jwtRoute).toContain("principal: async () => null");
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
    // …the exact files the agent must now hand-edit, each described…
    expect(tail).toContain(`edit ${join("vendo", "registry.tsx")} — `);
    expect(tail).toContain(`edit ${join("app", "layout.tsx")} — `);
    expect(tail).toContain(`edit ${join(".vendo", "brief.md")} — `);
    // …and the machine gate, as the run's FINAL line.
    expect(tail).toContain("vendo doctor --json");
    expect(sink.logs[sink.logs.length - 1]).toContain("vendo doctor --json");
    expect(sink.logs[sink.logs.length - 1]).toContain("green");
  });

  // Agent-install-dx Layer 2 (key-mint integration): a keyless run's tail
  // carries the complete in-band key story — the auth.md discovery URL, the
  // device-login ceremony, and both flag fallbacks — so the agent never
  // detours to a browser signup it can't drive.
  it("a keyless run's tail points at the auth.md key flow; a run with a key stays silent about it", async () => {
    const keyless = await fixture();
    const keylessSink = output();
    expect(await run(keyless, keylessSink)).toBe(0);
    const keylessTail = keylessSink.logs.join("\n").split("Agent tail:")[1]!;
    expect(keylessTail).toContain("cloud key: none");
    expect(keylessTail).toContain("https://vendo.run/auth.md");
    expect(keylessTail).toContain("vendo cloud device-login");
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
    expect(tail).toContain(`edit ${join("vendo", "registry.tsx")} — `);
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

  it("interactive init on an undetectable framework is unchanged: it still scaffolds the Next layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-init-nofw-tty-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "host", dependencies: { react: "19.0.0" } }));
    const sink = output();
    expect(await run(root, sink, { interactive: true })).toBe(0);
    await expect(readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8"))
      .resolves.toContain("createVendo");
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
        mint: async () => {
          minted += 1;
          return `vnd_${"e".repeat(40)}`;
        },
      },
    })).toBe(0);
    expect(offered).toBe(0);
    expect(minted).toBe(0);
    await expect(readFile(join(root, ".env.local"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(sink.logs.join("\n")).toContain("vendo cloud login");
  });

  it("--ai-polish is the consent: non-interactive runs reach the harness instead of skipping", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      yes: true,
      aiPolish: true,
      // No available harness: the gate must still OPEN (proving the
      // non-interactive skip was bypassed) and then report unavailability.
      extract: {
        harnesses: [],
        confirm: async () => { throw new Error("prompted"); },
      },
    })).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("AI polish: unavailable");
    expect(logs).not.toContain("needs an interactive run");

    // Without the flag, the non-interactive skip is unchanged.
    const skipped = await fixture();
    const skippedSink = output();
    expect(await run(skipped, skippedSink, { yes: true, extract: { harnesses: [] } })).toBe(0);
    expect(skippedSink.logs.join("\n")).toContain("needs an interactive run");
  });

  it("--theme answers uncertain slots; the review prompt covers only what the flags left open", async () => {
    const root = await fixture();
    const reviewed: string[] = [];
    const sink = output();
    expect(await run(root, sink, {
      aiPolish: true,
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
      aiPolish: true,
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
      aiPolish: true,
      themeAnswers: { accent: "#00ff00" },
      extract: { harnesses: [themeHarness({ slots: { accent: "#196b46", mutedText: "#908c85" } })] },
    })).toBe(0);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#00ff00");
    // The model's other fill still lands — only the contested slot changed.
    expect(theme.colors.muted).toBe("#908c85");
  });

  it("never clobbers an existing registry and still wires the route to it", async () => {
    const root = await fixture();
    await mkdir(join(root, "vendo"), { recursive: true });
    const custom = "export const registry = { /* host-authored */ };\n";
    await writeFile(join(root, "vendo", "registry.tsx"), custom);
    expect(await run(root, output())).toBe(0);
    expect(await readFile(join(root, "vendo", "registry.tsx"), "utf8")).toBe(custom);
    const route = await readFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(route).toContain('import { registry } from ' + '"../../../../vendo/registry";');
  });

  it("does not scaffold a registry next to a hand-written route that ignores it", async () => {
    const root = await fixture();
    await mkdir(join(root, "app", "api", "vendo", "[...vendo]"), { recursive: true });
    await writeFile(join(root, "app", "api", "vendo", "[...vendo]", "route.ts"),
      'import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";\n' +
      "const vendo = createVendo({ principal: async () => null });\n" +
      "export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);\n");
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    await expect(readFile(join(root, "vendo", "registry.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
    // The paste line stays honest: no components prop without a registry file.
    expect(sink.logs.join("\n")).not.toContain("components={registry}");
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

  it("points a keyless host at .env.local and `vendo cloud login`", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("No model key yet");
    expect(logs).toContain("vendo cloud login");
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
        promptEmail: async () => "dev@example.com",
        login: async () => 0,
        mint: async () => key,
      },
    })).toBe(0);

    expect(await readFile(join(root, ".env.local"), "utf8")).toContain(`VENDO_API_KEY=${key}`);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Wrote VENDO_API_KEY to .env.local");
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
    expect(example).toContain("production fails loud");
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
    expect(manifest.scripts.predev).toBe("vendo sync && echo pre");
    expect(manifest.scripts.prebuild).toBe("vendo sync --strict");
    expect(manifest.scripts.dev).toBe("next dev");
  });

  it("generates the server-action registration map and wires an existing route (ENG-248)", async () => {
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

    // A route generated BEFORE actions existed gets rewired on the next init.
    const bare = await fixture();
    expect(await run(bare, output())).toBe(0);
    await mkdir(join(bare, "app", "actions"), { recursive: true });
    await writeFile(join(bare, "app", "actions", "later.ts"),
      '"use server";\n\nexport async function later() {\n  return 1;\n}\n');
    expect(await run(bare, output())).toBe(0);
    const rewired = await readFile(join(bare, "app", "api", "vendo", "[...vendo]", "route.ts"), "utf8");
    expect(rewired).toContain("serverActions,");
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
    expect(server).toContain('import { registry } from "./registry";');
    expect(server).toContain("catalog: registry,");
    expect(server).not.toContain("model");
    await expect(readFile(join(unwired, "vendo", "registry.tsx"), "utf8")).resolves.toContain("ComponentRegistry");
    await expect(readFile(join(unwired, "vendo", "ai.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(sink.logs.join("\n")).toContain('app.use("/api/vendo", mountVendo());');
    expect(sink.logs.join("\n")).toContain("components={registry}");
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
    expect(route).toContain("policy: {},");

    const express = await expressFixture(false);
    expect(await run(express, output())).toBe(0);
    const server = await readFile(join(express, "vendo", "server.ts"), "utf8");
    expect(server).toContain("policy: {},");

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

      // The documented edge (quickstart/install): deleting the init-written
      // file while keeping `policy: {}` degrades to auto-run WITHOUT the
      // unconfigured notice — the default file is read fail-soft, and
      // status() reads any policy object as configured.
      await rm(join(root, ".vendo", "policy.json"));
      const fileless = createGuard({ store, policy: {} });
      await expect(fileless.check({ id: "call_3", tool: destructive.name, args: {} }, destructive, ctx))
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
    // re-run between scaffold and the manual <VendoRoot> paste.
    expect(logs).not.toContain("Auth:");
  });

  it("leaves a hand-wired Express composition at a custom path alone", async () => {
    const root = await expressFixture(false);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "agent.ts"),
      'import { createVendo } from "@vendoai/vendo/server";\nexport const vendo = createVendo({ principal: async () => null });\n');
    const sink = output();
    expect(await run(root, sink)).toBe(0);
    // No duplicate server module, no orphaned registry, no advisory about a
    // composition init does not own — and the paste line stays honest.
    await expect(readFile(join(root, "vendo", "server.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "vendo", "registry.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
    const logs = sink.logs.join("\n");
    expect(logs).not.toContain("Auth:");
    expect(logs).not.toContain("components={registry}");
  });

  it("uses an ESM scaffold when an Express host has no tsconfig", async () => {
    const root = await expressFixture(false);
    await rm(join(root, "tsconfig.json"));
    expect(await run(root, output())).toBe(0);
    const server = await readFile(join(root, "vendo", "server.mjs"), "utf8");
    expect(server).not.toContain(": Headers");
    expect(server).toContain("mountVendo");
    expect(server).toContain('import { registry } from "./registry.mjs";');
    await expect(readFile(join(root, "vendo", "registry.mjs"), "utf8")).resolves.toContain("export const registry = {};");
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

  // Task 4(a): without consent (no --ai-polish, not interactive), theme
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
      aiPolish: true,
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
      aiPolish: true,
      extract: { harnesses: [themeHarness({ slots: { accent: "#2b7fff" } })] },
      themeReview: async () => { throw new Error("must never be asked"); },
    })).toBe(0);
    const theme = JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"));
    expect(theme.colors.accent).toBe("#2b7fff");
  });

  it("fills next/font gaps via the model pass and prints the one-glance summary", async () => {
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
      aiPolish: true,
      extract: { harnesses: [themeHarness({ slots: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" } })] },
    })).toBe(0);

    expect(JSON.parse(await readFile(join(root, ".vendo", "theme.json"), "utf8"))).toMatchObject({
      colors: { background: "#fafafa", surface: "#ffffff", text: "#171717", muted: "#737373", accent: "#2b7fff" },
      typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
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
      aiPolish: true,
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
      cloud: { confirm: async () => false },
    })).toBe(0);
    expect(seenEnv[0]?.ANTHROPIC_API_KEY).toBe("sk-ant-quoted");
    expect(seenEnv[0]?.OPENAI_API_KEY).toBe("sk-openai-plain");
    expect(seenEnv[0]?.VENDO_API_KEY).toBe(key);
    // The default cloud probe sees the unquoted key: well-formed, not "malformed".
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Vendo Cloud: VENDO_API_KEY present and well-formed.");
    expect(sink.errors.join("\n")).not.toContain("not usable");
  });

  // Agent-install-dx (§CLI-5): the star ask — ONE consent question at the end
  // of a fully successful INTERACTIVE run. Yes stars via gh (any failure
  // degrades to the repo URL, one line, no error noise); no does nothing.
  // Never shown non-interactively, and never able to change init's exit code.
  it("interactive success ends with the star ask; yes stars runvendo/vendo via gh", async () => {
    const root = await fixture();
    const asked: Array<{ question: string; defaultYes: boolean }> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      confirmStar: async (question, defaultYes) => {
        asked.push({ question, defaultYes });
        return true; // Enter/Y
      },
      spawnStar: (command, args) => {
        spawned.push({ command, args });
        const child = new EventEmitter();
        setImmediate(() => child.emit("exit", 0));
        return child;
      },
    })).toBe(0);
    expect(asked).toEqual([{ question: "Star runvendo/vendo to support the project?", defaultYes: true }]);
    expect(spawned).toEqual([{ command: "gh", args: ["api", "-X", "PUT", "user/starred/runvendo/vendo"] }]);
    // The star landed: no fallback URL line.
    expect(sink.logs.join("\n")).not.toContain("github.com/runvendo/vendo");
  });

  it("a missing or failing gh degrades to one repo-URL line and leaves the exit code alone", async () => {
    // gh absent: spawn emits ENOENT.
    const missing = await fixture();
    const missingSink = output();
    expect(await run(missing, missingSink, {
      interactive: true,
      confirmStar: async () => true,
      spawnStar: () => {
        const child = new EventEmitter();
        setImmediate(() => child.emit("error", new Error("spawn gh ENOENT")));
        return child;
      },
    })).toBe(0);
    const missingUrls = missingSink.logs.filter((line) => line.includes("https://github.com/runvendo/vendo"));
    expect(missingUrls).toHaveLength(1);
    expect(missingSink.errors.join("\n")).not.toContain("gh"); // no error noise

    // gh present but the call fails (non-zero exit): same one-line fallback.
    const failing = await fixture();
    const failingSink = output();
    expect(await run(failing, failingSink, {
      interactive: true,
      confirmStar: async () => true,
      spawnStar: () => {
        const child = new EventEmitter();
        setImmediate(() => child.emit("exit", 1));
        return child;
      },
    })).toBe(0);
    expect(failingSink.logs.filter((line) => line.includes("https://github.com/runvendo/vendo"))).toHaveLength(1);

    // Even a spawn seam that throws synchronously never fails the init.
    const throwing = await fixture();
    const throwingSink = output();
    expect(await run(throwing, throwingSink, {
      interactive: true,
      confirmStar: async () => true,
      spawnStar: () => { throw new Error("no spawn at all"); },
    })).toBe(0);
    expect(throwingSink.logs.filter((line) => line.includes("https://github.com/runvendo/vendo"))).toHaveLength(1);
  });

  it("declining the star ask does nothing: no gh, no URL, no guilt text", async () => {
    const root = await fixture();
    let spawnCount = 0;
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      confirmStar: async () => false,
      spawnStar: () => {
        spawnCount += 1;
        return new EventEmitter();
      },
    })).toBe(0);
    expect(spawnCount).toBe(0);
    const logs = sink.logs.join("\n");
    expect(logs).not.toContain("github.com/runvendo/vendo");
    expect(logs).not.toContain("Star");
  });

  it("the star ask never fires non-interactively: --yes, non-TTY, and --agent stay deterministic", async () => {
    const seams = {
      confirmStar: async () => { throw new Error("star prompted"); },
      spawnStar: (): EventEmitter => { throw new Error("star spawned"); },
    };
    // Non-TTY (vitest default interactivity): no prompt.
    const nonTty = await fixture();
    expect(await run(nonTty, output(), seams)).toBe(0);
    // --yes on a TTY: no prompt.
    const flagged = await fixture();
    expect(await run(flagged, output(), { yes: true, interactive: true, ...seams })).toBe(0);
    // --agent: the read-only JSON plan carries no prompt either.
    const agent = await fixture();
    const agentSink = output();
    expect(await run(agent, agentSink, { agent: true, ...seams })).toBe(0);
    expect(agentSink.logs.join("\n")).not.toContain("Star");
  });

  it("an unshown prompt is never a yes: interactive override without a TTY stdin means no star", async () => {
    // A programmatic runInit({ interactive: true }) with piped stdin (vitest
    // has no TTY) must not auto-star off the confirm's Y default — the
    // question was never actually shown, so the answer is false.
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, {
      interactive: true,
      // No confirmStar seam: the real default path must decline on its own.
      spawnStar: (): EventEmitter => { throw new Error("star spawned"); },
    })).toBe(0);
    expect(sink.logs.join("\n")).not.toContain("github.com/runvendo/vendo");
  });

  it("a gh that hangs resolves the star as false after the timeout", async () => {
    // A child that never emits: the timer settles the promise instead.
    await expect(starViaGh(() => new EventEmitter(), 25)).resolves.toBe(false);
  });

  it("a star step that blows up entirely never changes init's exit code", async () => {
    const root = await fixture();
    expect(await run(root, output(), {
      interactive: true,
      confirmStar: async () => { throw new Error("terminal went away"); },
    })).toBe(0);
  });

  it("emits a read-only agent plan with code changes, extraction, and paste steps", async () => {
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
      aiPolish: { instructions: string; draftSchema: Record<string, unknown>; apply: string };
    };
    expect(plan.framework).toBe("next");
    expect(plan.writes).toContain(".vendo/tools.json");
    expect(plan.writes).not.toContain(".env");
    expect(plan.codeChanges.map((change) => change.path)).toContain(join("app", "api", "vendo", "[...vendo]", "route.ts"));
    expect(plan.codeChanges.map((change) => change.path)).toContain(join("vendo", "registry.tsx"));
    expect(plan.manualSteps.join("\n")).toContain("<VendoRoot");
    expect(Array.isArray(plan.extraction.tools)).toBe(true);
    expect(Array.isArray(plan.riskRecommendations)).toBe(true);
    // The delegation contract rides the plan: instructions an external agent
    // executes, the draft schema, and the apply command that runs the guards.
    expect(plan.aiPolish.instructions).toContain("never lower");
    expect(plan.aiPolish.instructions).toContain("Statically extracted tools");
    expect(plan.aiPolish.draftSchema).toMatchObject({ type: "object", required: ["brief", "tools"] });
    expect(plan.aiPolish.apply).toContain("vendo extract --apply");
    expect(await tree(root)).toEqual(before); // --agent wrote nothing
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
});
