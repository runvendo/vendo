import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { composedAuthPreset } from "../../src/cli/init-auth.js";
import { authOwnSeamLines, compositionModulePath, compositionModuleSource, compositionSpecifier, customServerSource, devScriptPort, expressServerSource, routeSource, vendoEnvExample } from "../../src/cli/init-scaffolds.js";
import { createVendo, guard } from "../../src/server.js";
import type { HostAuthPreset } from "../../src/auth-presets/index.js";

const run = promisify(execFile);

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Node's own parser is the only honest judge of "is this valid JavaScript" —
    a substring assertion misses the next type annotation that sneaks in. */
async function parses(source: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vendo-scaffold-check-"));
  cleanup.push(root);
  const file = join(root, "server.mjs");
  await writeFile(file, source);
  await run(execPath, ["--check", file]);
}

/**
 * Self-serve audit B2: the JS-emitted scaffolds carried TypeScript syntax —
 * `kind: "user" as const` in the principal line and a `as Headers & {…}` cast
 * around getSetCookie — so every plain-JS host threw `SyntaxError: Unexpected
 * identifier 'as'` on its first `node server.js`.
 */
describe("JS-emitted scaffolds are valid JavaScript", () => {
  it("the Express composition parses as .mjs", async () => {
    await parses(expressServerSource(false));
  });

  it("the runtime-neutral composition parses as .mjs", async () => {
    await parses(customServerSource(false));
  });

  it("neither JS scaffold carries a type annotation", () => {
    for (const source of [expressServerSource(false), customServerSource(false)]) {
      expect(source).not.toContain(" as const");
      expect(source).not.toContain(" as Headers");
    }
  });

  it("the TypeScript scaffolds keep the annotations they need", () => {
    expect(expressServerSource(true)).toContain(`kind: "user" as const`);
    expect(expressServerSource(true)).toContain("as Headers & { getSetCookie?: () => string[] }");
    expect(customServerSource(true)).toContain(`kind: "user" as const`);
  });
});

/**
 * "Write my own": the seam init scaffolds for a host with no auth provider. It
 * has to BOOT — a stub that only compiles is a dead feature — so the proof runs
 * the scaffold's own text through the real `createVendo`, with the door on. No
 * stub on either side: the producer is the scaffold, the consumer is the
 * runtime that would reject a seam it cannot use.
 */
describe("the hand-written auth seam", () => {
  /** The seam object as the scaffold writes it — the hoisted spelling, which
      is a `const auth = { … };` statement. The JS variant is plain JavaScript by
      construction, so evaluating it needs no transpiler, and it is
      character-for-character the TS one minus the annotations. */
  const seamObject = (): HostAuthPreset =>
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    (new Function(`${authOwnSeamLines(false, true)}return auth;`) as () => HostAuthPreset)();

  it("composes — createVendo accepts it, and `mcp: true` opens over its oauth half", () => {
    expect(() => createVendo({
      auth: seamObject(),
      guard: guard({ policy: {} }),
      mcp: true,
    })).not.toThrow();
  });

  it("resolves the fixed dev subject on both seams", async () => {
    const auth = seamObject();
    await expect(auth.principal(new Request("https://host.example/api/vendo")))
      .resolves.toEqual({ kind: "user", subject: "dev-user" });
    await expect(auth.oauth?.principal("someone-else"))
      .resolves.toEqual({ kind: "user", subject: "someone-else" });
    await expect(auth.oauth?.session?.(new Request("https://host.example/"), { returnTo: "/" } as never))
      .resolves.toEqual({ subject: "dev-user" });
  });

  it("says in the file itself that a fixed subject is not shippable", () => {
    expect(authOwnSeamLines(true)).toContain("// replace before production");
    expect(authOwnSeamLines(true)).toContain("https://docs.vendo.run/howto/auth");
    expect(authOwnSeamLines(true)).toContain("EVERY caller is the same person");
  });

  /** It rides the SAME one `auth:` door the anonymous composition does — the
      host who later adds facts or actAs adds a member, not a second shape. */
  it("goes through the one auth door, inline everywhere and hoisted on the agent-loop arm", () => {
    for (const source of [
      compositionModuleSource({ serverActions: false, auth: { kind: "custom" } }),
      expressServerSource(true, { kind: "custom" }),
      customServerSource(true, { kind: "custom" }),
    ]) {
      expect(source).toMatch(/^\s+auth: \{$/m);
      expect(source).toContain("oauth: {");
      // Nothing is imported for it — the seam is the host's own object.
      expect(source).not.toContain("@vendoai/vendo/auth/");
    }
    const loop = compositionModuleSource({ serverActions: false, auth: { kind: "custom" }, agentLoop: true });
    expect(loop).toContain("const auth = {\n");
    expect(loop).toMatch(/^  auth,$/m);
    expect(loop).toContain("export const resolvePrincipal = (_req: Request) => auth.principal();\n");
  });

  it("keeps the JS spelling free of TypeScript syntax", async () => {
    await parses(expressServerSource(false, { kind: "custom" }));
    await parses(customServerSource(false, { kind: "custom" }));
    expect(authOwnSeamLines(false)).not.toContain(" as const");
    expect(authOwnSeamLines(false)).not.toContain("subject: string");
  });
});

/** JWT is a wired answer now, not a printed recipe: it satisfies the runtime
    already (jwt() composes through the same composeHostAuthPreset the vendor
    presets do) and the only thing in its way was that it cannot be zero-arg.
    The scaffold supplies the argument. */
describe("the JWT answer", () => {
  it("imports jwt from its own subpath and reads the secret from the env variable", () => {
    const source = compositionModuleSource({ serverActions: false, auth: { kind: "jwt" } });
    expect(source).toContain(`import { jwt } from "@vendoai/vendo/auth/jwt";`);
    expect(source).toContain("auth: jwt({ secret: () => process.env.HOST_API_JWT_SECRET }),");
    expect(source).not.toContain("demo-user");
  });

  it("hoists onto the agent-loop arm like any other preset", () => {
    const source = compositionModuleSource({ serverActions: false, auth: { kind: "jwt" }, agentLoop: true });
    expect(source).toContain("const auth = jwt({ secret: () => process.env.HOST_API_JWT_SECRET });\n");
    expect(source).toContain("export const resolvePrincipal = (req: Request) => auth.principal(req);\n");
  });

  it("reads back as wired, so a later MCP run is not refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-composed-jwt-"));
    cleanup.push(root);
    const composition = join(root, "vendo.ts");
    await writeFile(composition, compositionModuleSource({ serverActions: false, auth: { kind: "jwt" } }));
    expect(await composedAuthPreset(composition)).toBe("jwt");
  });

  it("so does the hand-written seam — `oauth` in the composition IS the wiring", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-composed-own-"));
    cleanup.push(root);
    const composition = join(root, "vendo.ts");
    await writeFile(composition, compositionModuleSource({ serverActions: false, auth: { kind: "custom" } }));
    expect(await composedAuthPreset(composition)).toBe("custom");
  });
});

describe("the scaffolds init writes", () => {
  it("does not import or pass a registry — the host writes its own client file", () => {
    const source = compositionModuleSource({ serverActions: false, auth: null });
    expect(source).not.toContain("./registry");
    expect(source).not.toContain("catalog:");
  });

  it("leaves the server compositions registry-free too", () => {
    for (const source of [expressServerSource(true), customServerSource(true)]) {
      expect(source).not.toContain("catalog: registry");
      expect(source).not.toContain(`from "./registry`);
    }
  });
});

/** The Next composition lives in ONE file — `lib/vendo.ts` — on every path, so
    the wire route, the discovery route and the host's own agent loop all import
    the SAME instance. A route module may export only handlers, so createVendo
    can never live in one. */
describe("the split Next composition", () => {
  const clerk = { kind: "preset", preset: "clerk", dependency: "@clerk/nextjs" } as const;

  it("makes route.ts thin — a route module may export only handlers", () => {
    const thin = routeSource("@/lib/vendo");
    expect(thin).toContain(`import { vendo } from "@/lib/vendo";`);
    expect(thin).toContain("export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);");
    expect(thin).not.toMatch(/import\s*\{[^}]*\bcreateVendo\b/);
    // Nothing the route exports may be a non-handler, so the preset and the
    // action map stay in the composition.
    expect(thin).not.toContain("@vendoai/vendo/auth/clerk");
    expect(thin).not.toContain("./vendo-actions");
  });

  it("exports the instance, and opens the MCP door only when that arm is passed", () => {
    const plain = compositionModuleSource({ serverActions: true, auth: clerk });
    expect(plain).toContain("export const vendo = createVendo({");
    expect(plain).toContain("auth: clerk(),");
    expect(plain).toContain("serverActions,");
    expect(plain).toContain(`import { serverActions } from "./vendo-actions";`);
    expect(plain).not.toContain("mcp:");

    const door = compositionModuleSource({ serverActions: true, auth: clerk, mcp: { serviceAuth: false } });
    expect(door).toContain("mcp: true,");
    expect(door).not.toContain("VENDO_SERVICE_KEY");

    const service = compositionModuleSource({ serverActions: false, auth: clerk, mcp: { serviceAuth: true } });
    expect(service).toContain(`const serviceKey = process.env.VENDO_SERVICE_KEY ?? "";`);
    expect(service).toContain(`mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },`);
    expect(service).not.toContain("./vendo-actions");
  });

  /** No preset still writes the ONE DOOR — the demo principal goes INSIDE
   *  `auth: { … }`, which is where facts, orgs, actAs and the door's oauth half
   *  also live. The host who outgrows the stand-in adds a member to an object
   *  that already exists rather than learning a second config shape. */
  it("keeps the anonymous principal when no preset is wired, under `auth:`", () => {
    const anonymous = compositionModuleSource({ serverActions: false, auth: null });
    expect(anonymous).toContain(`  auth: {\n    principal: async () => ({ kind: "user" as const, subject: "demo-user" }),\n  },\n`);
    // …and no preset was invented to get there: the object is the host's own.
    expect(anonymous).not.toMatch(/auth: \w+\(\)/);
    expect(anonymous).not.toContain("@vendoai/vendo/auth/");
  });

  /** The agent-loop arm's host resolves the caller in its OWN loop, so the
   *  module exports a resolver over the same identity the wire composed — the
   *  one line every agent-loop host used to hand-add to a file init had just
   *  written. Both shapes hoist, because a second `clerk()` (or a second demo
   *  principal) in the chat route is a second subject the wire never sees.
   *
   *  Since the one door, the two shapes differ in ONE line — what `auth` is
   *  bound to. Binding name, config key and resolver are identical, which is
   *  the point: a host swapping the demo object for `clerk()` changes that
   *  line and nothing else. */
  it("exports the caller resolver on the agent-loop arm, over the identity the wire shares", () => {
    const preset = compositionModuleSource({ serverActions: false, auth: clerk, agentLoop: true });
    expect(preset).toContain("const auth = clerk();\n");
    expect(preset).toContain("\n  auth,\n");
    expect(preset).not.toContain("auth: clerk(),");
    expect(preset).toContain("export const resolvePrincipal = (req: Request) => auth.principal(req);\n");

    const anonymous = compositionModuleSource({ serverActions: false, auth: null, agentLoop: true });
    expect(anonymous).toContain(`const auth = {\n  principal: async () => ({ kind: "user" as const, subject: "demo-user" }),\n};\n`);
    expect(anonymous).toContain("\n  auth,\n");
    // The stand-in ignores the request, so the resolver may not hand it one: a
    // zero-parameter literal takes no argument, and `auth.principal(req)` would
    // not compile in the host's own file.
    expect(anonymous).toContain("export const resolvePrincipal = (_req: Request) => auth.principal();\n");
  });

  /** The seam: a LATER `--use-case mcp` run over a composition it did not
   *  write re-decides nothing, so this file is the only evidence a preset is
   *  wired. Read back through the real reader — the hoisted spelling is a
   *  wiring too, or the MCP arm refuses a host that is already wired. */
  it("reads back as a wired preset, so a later MCP run is not refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-composed-auth-"));
    cleanup.push(root);
    const composition = join(root, "vendo.ts");
    await writeFile(composition, compositionModuleSource({ serverActions: false, auth: clerk, agentLoop: true }));
    expect(await composedAuthPreset(composition)).toBe("clerk");
  });

  /** Every other arm shares this file. An export none of their readers import
   *  is noise, so the resolver appears on the agent-loop arm only. */
  it("leaves the resolver off every other arm", () => {
    for (const source of [
      compositionModuleSource({ serverActions: false, auth: null }),
      compositionModuleSource({ serverActions: true, auth: clerk }),
      compositionModuleSource({ serverActions: false, auth: clerk, mcp: { serviceAuth: false } }),
      compositionModuleSource({ serverActions: false, auth: clerk, agentLoop: false }),
    ]) {
      expect(source).not.toContain("resolvePrincipal");
    }
  });
});

/** The specifier has to COMPILE: `@/lib/vendo` is what every docs page shows,
    but only a host that declares the alias can resolve it. */
describe("how a file reaches the composition module", () => {
  const fixture = async (files: Record<string, string>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "vendo-composition-"));
    cleanup.push(root);
    for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
    return root;
  };

  it("takes the @/ alias when tsconfig maps it onto the base that holds lib/", async () => {
    const root = await fixture({ "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }) });
    expect(await compositionModulePath(root)).toBe(join(root, "lib", "vendo.ts"));
    expect(await compositionSpecifier(root, join(root, "app", "api", "vendo", "[...vendo]"))).toBe("@/lib/vendo");
  });

  it("falls back to a relative path when the host declares no alias", async () => {
    const root = await fixture({ "tsconfig.json": "{}" });
    expect(await compositionSpecifier(root, join(root, "app", "api", "vendo", "[...vendo]")))
      .toBe("../../../../lib/vendo");
  });

  it("refuses an alias that points somewhere else — the generated route has to compile", async () => {
    const root = await fixture({ "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }) });
    // No src/app and no src/pages, so lib/ is at the root while @/ maps to src/.
    expect(await compositionSpecifier(root, join(root, "app"))).toBe("../lib/vendo");
  });
});

/** ENG: the placeholder named :3000 to hosts served on another port, and the
    developer copied it into .env.local before debugging it for an hour. */
describe("the .env.example base URL", () => {
  it("reads the host's own dev port off its dev script, in every spelling", () => {
    expect(devScriptPort("next dev")).toBe(3000);
    expect(devScriptPort(undefined)).toBe(3000);
    expect(devScriptPort("next dev -p 4000")).toBe(4000);
    expect(devScriptPort("next dev --port 8080")).toBe(8080);
    expect(devScriptPort("next dev --port=4321")).toBe(4321);
    expect(devScriptPort("PORT=5050 node server.js")).toBe(5050);
  });

  it("names that port, and reads as an instruction rather than a value to fill in", () => {
    expect(vendoEnvExample(4000)).toContain("VENDO_BASE_URL=http://localhost:4000\n");
    // Dev was answered into .env.local by init's own question; production is
    // set where the app deploys, and belongs in neither file here.
    const example = vendoEnvExample(3000);
    expect(example).toContain("Dev is already done");
    expect(example).toContain("platform's environment settings to the public URL");
    expect(example).toContain("in neither a committed file nor .env.local");
    expect(example).toContain("Production fails loud without it");
  });
});

/** SPEC 4b: env keys are credentials and CONFIG selects the model, so a stray
    ANTHROPIC_API_KEY no longer picks one. The scaffold is the migration path —
    init writes the explicit selection into the composition it authors, ONCE. */
describe("the models line a detected provider key writes", () => {
  const clerk = { kind: "preset", preset: "clerk", dependency: "@clerk/nextjs" } as const;
  const anthropicKey = { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" } as const;

  it("writes the import and the config line exactly once into the composition", () => {
    const composition = compositionModuleSource({ serverActions: false, auth: null, models: anthropicKey });
    expect(composition).toContain(`import { anthropic } from "@ai-sdk/anthropic";\n`);
    expect(composition).toContain(`  models: { default: anthropic("claude-sonnet-4-6") }, // ANTHROPIC_API_KEY supplies the key\n`);
    expect(composition.match(/@ai-sdk\/anthropic/g)).toHaveLength(1);
    expect(composition.match(/models:/g)).toHaveLength(1);
    // The import leads the file — the same order the runtime-neutral scaffold
    // already uses — and the line lands inside the createVendo call.
    expect(composition.indexOf("@ai-sdk/anthropic")).toBeLessThan(composition.indexOf("@vendoai/vendo/server"));
    expect(composition.indexOf("createVendo({")).toBeLessThan(composition.indexOf("models:"));
  });

  it("names each provider's own default instance and flagship id", () => {
    expect(compositionModuleSource({ serverActions: false, auth: null, models: { provider: "openai", envVar: "OPENAI_API_KEY" } }))
      .toContain(`  models: { default: openai("gpt-5") }, // OPENAI_API_KEY supplies the key\n`);
    expect(compositionModuleSource({ serverActions: false, auth: null, models: { provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" } }))
      .toContain(`  models: { default: google("gemini-2.5-flash") }, // GOOGLE_GENERATIVE_AI_API_KEY supplies the key\n`);
  });

  it("writes neither the import nor the line when no provider key resolved", () => {
    for (const composition of [
      compositionModuleSource({ serverActions: false, auth: null }),
      compositionModuleSource({ serverActions: false, auth: null, models: null }),
    ]) {
      expect(composition).not.toContain("@ai-sdk/");
      expect(composition).not.toContain("models:");
    }
  });

  it("keeps it out of the thin route — one models line per host", () => {
    // The route composes nothing (it imports the module), so a models line
    // there would be a second, dead selection plus a dangling import.
    const thin = routeSource("@/lib/vendo");
    expect(thin).not.toContain("@ai-sdk/anthropic");
    expect(thin).not.toContain("models:");

    const composition = compositionModuleSource({ serverActions: false, auth: clerk, models: anthropicKey, mcp: { serviceAuth: false } });
    expect(composition.match(/models:/g)).toHaveLength(1);
    // The pair init writes carries exactly one of each.
    expect(`${thin}${composition}`.match(/models:/g)).toHaveLength(1);
  });
});
