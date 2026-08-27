import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit, type InitReceipt } from "../../src/cli/init.js";
import type { InitQuestions } from "../../src/cli/init-questions.js";
import { CLI_VERSION, type Output } from "../../src/cli/shared.js";

/**
 * The install-DX repairs from the 0.28.0 field audit. Each `it` here is one
 * finding: a run that answered for the developer in silence, a recommendation
 * that ignored evidence the scanner already had, a re-run that refused a
 * correctly wired host, a secret rotated under a caller that was using it, a
 * generated import nothing installed, and a paste that did not compile.
 */

const cleanup: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const NO_CLOUD = {
  cloudProbe: async () => ({ present: false, ok: false, unlocks: ["a starter allowance"] as readonly string[] }),
};

function output(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (message) => logs.push(message), error: (message) => errors.push(message) }, logs, errors };
}

async function fixture(manifest: Record<string, unknown> = {}, name = "vendo-install-dx-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), name));
  cleanup.push(root);
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.3.0" },
    ...manifest,
  }));
  await writeFile(join(root, "app", "layout.tsx"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
  return root;
}

/** The common non-answer seams: no cloud probe, no telemetry, keyless. */
function run(root: string, sink: { output: Output }, extra: Partial<Parameters<typeof runInit>[0]> = {}): Promise<number> {
  return runInit({
    targetDir: root,
    output: sink.output,
    env: {},
    cloud: NO_CLOUD,
    telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    extract: { harnesses: [] },
    ...extra,
  });
}

const receiptOf = (logs: string[]): InitReceipt => JSON.parse(logs.at(-1)!) as InitReceipt;
const questionsOf = (logs: string[]): InitQuestions => JSON.parse(logs.join("\n")) as InitQuestions;

/** A route that runs an agent loop — the evidence the scanner already excludes
 *  on, and (item 3) the evidence the use-case recommendation now reads. */
async function withChatRoute(root: string, at = join("app", "api", "chat")): Promise<void> {
  await mkdir(join(root, at), { recursive: true });
  await writeFile(join(root, at, "route.ts"),
    'import { streamText } from "ai";\nexport async function POST(req: Request) { return streamText({ messages: await req.json() }).toUIMessageStreamResponse(); }\n');
}

/** Item 1 — the guard only fires for a CLI run (no injected `output`), so these
 *  drive the real console and read it back. */
function consoleSink(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logs.push(parts.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => { errors.push(parts.join(" ")); });
  return { logs, errors };
}

describe("a run that cannot ask stops instead of answering for you", () => {
  it("prints the defaults it would take and exits 1", async () => {
    const root = await fixture({ scripts: { dev: "next dev --port 4100" } });
    const sink = consoleSink();
    expect(await runInit({
      targetDir: root,
      env: {},
      cloud: NO_CLOUD,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    const said = sink.errors.join("\n");
    expect(said).toContain("this run cannot ask");
    expect(said).toContain("Pass --yes to take the defaults below");
    expect(said).toContain("--agent");
    // Every default it WOULD have taken, each naming the flag that answers it.
    expect(said).toContain("use case: embedded — --use-case embedded | agent-loop | mcp");
    // A FRESH install has no recorded answer, so it must not claim one.
    expect(said).not.toContain("recorded by an earlier init");
    expect(said).toContain("auth: none");
    expect(said).toContain("VENDO_BASE_URL: not written");
    expect(said).toContain("--base-url http://localhost:4100");
    expect(said).toContain("judgment: skipped");
    // …and it wrote nothing.
    await expect(readFile(join(root, "lib", "vendo.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--yes proceeds, and still says what it settled", async () => {
    const root = await fixture();
    const sink = consoleSink();
    expect(await runInit({
      targetDir: root,
      yes: true,
      env: {},
      cloud: NO_CLOUD,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      extract: { harnesses: [] },
    })).toBe(0);
    const said = sink.logs.join("\n");
    expect(said).toContain("Taking the defaults (--yes):");
    expect(said).toContain("use case: embedded");
    await expect(readFile(join(root, "lib", "vendo.ts"), "utf8")).resolves.toContain("createVendo");
  });

  /** The MCP arm's default is bring-your-own, and `--yes` must SAY so: a
      keyless run gets a door whose deployment fronts its own sign-in, and the
      one thing it must never do is open a browser nobody asked for. */
  it("names the MCP arm's keyless default and opens no browser for it", async () => {
    const root = await fixture({ dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" } });
    const sink = consoleSink();
    expect(await runInit({
      targetDir: root,
      useCase: "mcp",
      auth: "clerk",
      yes: true,
      env: {},
      cloud: { ...NO_CLOUD, deviceLogin: async () => { throw new Error("opened a browser"); } },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      extract: { harnesses: [] },
    })).toBe(0);
    const said = sink.logs.join("\n");
    expect(said).toContain("Taking the defaults (--yes):");
    expect(said).toContain("sign-in and model: your own keys");
    // The question it replaced left no trace in what --yes settles.
    expect(said).not.toMatch(/posture/i);
    expect(said).not.toContain("service key: none minted");
  });

  it("names the recorded answer on a re-run, instead of a default it is not taking", async () => {
    const root = await fixture();
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "install.json"),
      JSON.stringify({ format: "vendo/install@1", useCase: "mcp" }));
    const sink = consoleSink();
    expect(await runInit({
      targetDir: root,
      env: {},
      cloud: NO_CLOUD,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(1);
    expect(sink.errors.join("\n")).toContain("use case: mcp (recorded by an earlier init)");
  });

  it("answer flags are an answer: a fully answered non-TTY run is never stopped", async () => {
    const root = await fixture();
    const sink = consoleSink();
    expect(await runInit({
      targetDir: root,
      useCase: "embedded",
      auth: "none",
      byo: true,
      baseUrl: "http://localhost:3000",
      ai: false,
      env: {},
      cloud: NO_CLOUD,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
    })).toBe(0);
    expect(sink.errors.join("\n")).not.toContain("this run cannot ask");
    expect(sink.logs.join("\n")).not.toContain("Taking the defaults");
  });
});

describe("the use-case recommendation reads the loop detection", () => {
  it("recommends agent-loop, with its reason, when the host already runs one", async () => {
    const root = await fixture({ dependencies: { next: "16.0.0", ai: "6.0.0" } });
    await withChatRoute(root);
    const asked: Array<{ value: string; hint?: string }> = [];
    expect(await run(root, output(), {
      interactive: true,
      selectUseCase: async (_question, options) => {
        asked.push(...options.map((option) => ({ value: option.value, ...(option.hint === undefined ? {} : { hint: option.hint }) })));
        return "agent-loop";
      },
      askText: async (_question, _hint, prefill) => prefill ?? "",
    })).toBe(0);
    // Recommended means FIRST: index 0 is what the select defaults to.
    expect(asked[0]?.value).toBe("agent-loop");
    expect(asked[0]?.hint).toContain("recommended");
    expect(asked[0]?.hint).toContain(join("app", "api", "chat").split("\\").join("/"));
    expect(asked.map((option) => option.value)).toEqual(["agent-loop", "embedded", "mcp"]);
  });

  it("keeps embedded recommended for a host with no loop", async () => {
    const root = await fixture();
    const asked: Array<{ value: string; hint?: string }> = [];
    expect(await run(root, output(), {
      interactive: true,
      selectUseCase: async (_question, options) => {
        asked.push(...options.map((option) => ({ value: option.value, ...(option.hint === undefined ? {} : { hint: option.hint }) })));
        return "embedded";
      },
      askText: async (_question, _hint, prefill) => prefill ?? "",
    })).toBe(0);
    expect(asked[0]).toEqual({ value: "embedded", hint: "recommended" });
  });

  it("moves the recommendation in the --agent question form too", async () => {
    const root = await fixture({ dependencies: { next: "16.0.0", ai: "6.0.0" } });
    await withChatRoute(root);
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const useCase = questionsOf(sink.logs).questions.find((question) => question.id === "use-case");
    expect(useCase?.options[0]).toMatchObject({ flag: "--use-case agent-loop", recommended: true });
    expect(useCase?.options[0]?.note).toContain("detected an agent loop in");
    expect(useCase?.prompt).toContain("already runs an agent loop in");
  });
});

describe("the --agent auth question carries the detection", () => {
  const ALL_ANSWERS = [
    "--auth authJs", "--auth clerk", "--auth supabase", "--auth auth0",
    "--auth jwt", "--auth custom", "--auth none",
  ];

  it("asks the same question with the same seven answers, and recommends nothing when nothing is detected", async () => {
    const root = await fixture();
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const auth = questionsOf(sink.logs).questions.find((question) => question.id === "auth");
    expect(auth?.prompt).toContain("How do your users sign in?");
    expect(auth?.prompt).toContain("Nothing was detected");
    expect(auth?.options.map((option) => option.flag)).toEqual(ALL_ANSWERS);
    // Init used to recommend `none` here and then write an anonymous
    // composition nobody chose. An unread scan recommends nothing.
    expect(auth?.options.some((option) => option.recommended === true)).toBe(false);
  });

  it("recommends the DETECTED family when there is one, with its dependency as evidence", async () => {
    const root = await fixture({ dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" } });
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const questions = questionsOf(sink.logs);
    expect(questions.detected.auth).toBe("clerk");
    const auth = questions.questions.find((question) => question.id === "auth");
    expect(auth?.options.map((option) => option.flag)).toEqual(ALL_ANSWERS);
    expect(auth?.options.find((option) => option.flag === "--auth clerk"))
      .toMatchObject({ recommended: true, note: "detected @clerk/nextjs" });
  });

  it("recommends nothing when the scan is ambiguous — naming one would hide the other", async () => {
    const root = await fixture({ dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0", "next-auth": "5.0.0" } });
    const sink = output();
    expect(await run(root, sink, { agent: true })).toBe(0);
    const auth = questionsOf(sink.logs).questions.find((question) => question.id === "auth");
    expect(auth?.prompt).toContain("Several auth dependencies");
    expect(auth?.options.some((option) => option.recommended === true)).toBe(false);
  });
});

/** The MCP fixture: a Next host with a real auth family, so the door can open. */
async function mcpFixture(): Promise<string> {
  const root = await fixture({ dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" } }, "vendo-install-dx-mcp-");
  return root;
}

describe("the MCP re-run false alarm", () => {
  it("does not refuse a host whose existing composition already wires auth", async () => {
    const root = await mcpFixture();
    const first = output();
    expect(await run(root, first, {
      useCase: "mcp", auth: "clerk", yes: true, baseUrl: "http://localhost:3000",
    })).toBe(0);
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8")).toContain("auth: clerk()");
    expect(await readFile(join(root, "app", ".well-known", "[...vendo]", "route.ts"), "utf8"))
      .toContain("wellKnownVendoHandler");

    // The re-run: no --auth, and init never re-opens a composition it did not
    // write this run — so the ONLY evidence auth is wired is the file itself.
    const again = output();
    expect(await run(root, again, { useCase: "mcp", yes: true, baseUrl: "http://localhost:3000" })).toBe(0);
    expect(again.errors.join("\n")).not.toContain("nothing MCP was written");
    expect(again.logs.join("\n")).toContain("Continue: https://docs.vendo.run/outside-agents/quickstart");
  });

  /**
   * "none yet" on the MCP path is the use case failing whole, so it is an
   * EXPECTED FAILURE: exit 1, nothing written, and the answer stated. Init used
   * to print a warning, write the anonymous composition anyway and exit 0 —
   * which then made the "re-run" it advised useless, because init never
   * rewrites a composition it already wrote. Nothing lands now, so answering
   * the question again is the entire fix.
   */
  it("fails the run on an anonymous composition instead of exiting 0 over a doorless install", async () => {
    const root = await fixture({}, "vendo-install-dx-mcp-anon-");
    const first = output();
    expect(await run(root, first, { useCase: "mcp", auth: "none", yes: true })).toBe(1);
    const errors = first.errors.join("\n");
    // What / why / how, plus the recipe.
    expect(errors).toContain("wired no door, so nothing was written at all");
    expect(errors).toContain("mints its own principals through an OAuth adapter");
    expect(errors).toContain("How do your users sign in?");
    expect(errors).toContain("write my own");
    expect(errors).toContain('session: async () => ({ subject: "dev-user" })');
    expect(errors).toContain("https://docs.vendo.run/outside-agents/quickstart");
    // The false claim is gone: jwt() carries the oauth half like every preset.
    expect(errors).not.toContain("do not carry the oauth half");
    expect(first.logs.join("\n")).not.toContain("Wired");
    // NOTHING was written, so the next answer is not blocked by this run.
    expect(await readdir(root)).not.toContain("lib");
    expect(await readdir(root)).not.toContain(".vendo");

    // …and answering the question opens the door on the very next run.
    const again = output();
    expect(await run(root, again, { useCase: "mcp", auth: "custom", yes: true, baseUrl: "http://localhost:3000" })).toBe(0);
    expect(await readFile(join(root, "app", ".well-known", "[...vendo]", "route.ts"), "utf8"))
      .toContain("wellKnownVendoHandler");
  });

  it("opens the door for jwt and for the hand-written seam — both carry the oauth half", async () => {
    for (const auth of ["jwt", "custom"] as const) {
      const root = await fixture({}, `vendo-install-dx-mcp-${auth}-`);
      const sink = output();
      expect(await run(root, sink, { useCase: "mcp", auth, yes: true, baseUrl: "http://localhost:3000" })).toBe(0);
      expect(await readFile(join(root, "lib", "vendo.ts"), "utf8")).toContain("mcp:");
      expect(await readFile(join(root, "app", ".well-known", "[...vendo]", "route.ts"), "utf8"))
        .toContain("wellKnownVendoHandler");
    }
  });
});

describe("VENDO_SERVICE_KEY", () => {
  const keyIn = (envLocal: string): string | undefined =>
    /^VENDO_SERVICE_KEY=(.+)$/m.exec(envLocal)?.[1];

  it("is reused on a re-run instead of rotated under the backend using it", async () => {
    const root = await mcpFixture();
    const answers = { useCase: "mcp" as const, yes: true, posture: "local" as const, serviceKey: true, baseUrl: "http://localhost:3000" };
    const first = output();
    expect(await run(root, first, { ...answers, auth: "clerk" })).toBe(0);
    const minted = keyIn(await readFile(join(root, ".env.local"), "utf8"));
    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect(first.logs.join("\n")).toContain("Generated VENDO_SERVICE_KEY");

    const again = output();
    expect(await run(root, again, answers)).toBe(0);
    expect(keyIn(await readFile(join(root, ".env.local"), "utf8"))).toBe(minted);
    expect(again.logs.join("\n")).toContain("VENDO_SERVICE_KEY already set — reused");
    expect(again.logs.join("\n")).not.toContain("Generated VENDO_SERVICE_KEY");
  });

  /** The `--service-key --force` field report: the env key landed and the
      composition still said `mcp: true`. Init never rewrites a file it did not
      author, so the key is honest and the WIRING is the developer's — a fact
      the receipt has to carry, because nothing else on the run can say it. */
  it("says so in the receipt when the composition it did not author holds no serviceAuth", async () => {
    const root = await mcpFixture();
    const answers = { useCase: "mcp" as const, auth: "clerk" as const, posture: "local" as const, baseUrl: "http://localhost:3000" };
    // A local door wires the key by default now, so the composition WITHOUT
    // serviceAuth — the one this whole scenario needs — is the explicit opt-out.
    expect(await run(root, output(), { ...answers, yes: true, serviceKey: false })).toBe(0);
    const composition = await readFile(join(root, "lib", "vendo.ts"), "utf8");
    expect(composition).toContain("mcp: true,");

    const again = output();
    expect(await run(root, again, { ...answers, agent: true, byo: true, serviceKey: true, force: true })).toBe(0);
    // The file is untouched and the key is real…
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8")).toBe(composition);
    expect(keyIn(await readFile(join(root, ".env.local"), "utf8"))).toMatch(/^[0-9a-f]{64}$/);
    // …so the receipt names the one line still missing, and the page that has it.
    const receipt = JSON.parse(again.logs.at(-1)!) as InitReceipt;
    expect(receipt.serviceAuthUnwired).toBe(true);
    expect(receipt.continueUrl).toBe("https://docs.vendo.run/outside-agents/quickstart");

    // A run that authored the composition itself wires it, and says nothing.
    const fresh = await mcpFixture();
    const freshSink = output();
    expect(await run(fresh, freshSink, { ...answers, agent: true, byo: true, serviceKey: true })).toBe(0);
    expect(await readFile(join(fresh, "lib", "vendo.ts"), "utf8"))
      .toContain('mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },');
    expect((JSON.parse(freshSink.logs.at(-1)!) as InitReceipt).serviceAuthUnwired).toBeUndefined();
  });

  it("replaces a value that is not a key this door could exchange", async () => {
    const root = await mcpFixture();
    await writeFile(join(root, ".env.local"), "VENDO_SERVICE_KEY=not-a-key\n");
    const sink = output();
    expect(await run(root, sink, {
      useCase: "mcp", auth: "clerk", yes: true, posture: "local", serviceKey: true, baseUrl: "http://localhost:3000",
    })).toBe(0);
    expect(keyIn(await readFile(join(root, ".env.local"), "utf8"))).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.logs.join("\n")).toContain("Generated VENDO_SERVICE_KEY");
  });
});

describe("what the generated files import becomes a host dependency", () => {
  /** `hasInstalledTree`: a host that has installed nothing is not this repair's
   *  business, so the fixture has to have a tree for the repair to be reached. */
  async function installedHost(manifest: Record<string, unknown>): Promise<string> {
    const root = await fixture(manifest, "vendo-install-dx-deps-");
    await mkdir(join(root, "node_modules"), { recursive: true });
    return root;
  }

  it("installs @vendoai/vendo when the host's package.json never declared it", async () => {
    // The backend path: the docs there wire the composition without ever
    // installing the package the scaffold imports.
    const root = await installedHost({ dependencies: { next: "16.0.0" } });
    const installs: Array<{ command: string; args: string[] }> = [];
    const sink = output();
    expect(await run(root, sink, {
      yes: true,
      installVendo: async (command, args) => { installs.push({ command, args }); return 0; },
    })).toBe(0);
    expect(installs).toHaveLength(1);
    expect(installs[0]?.args).toContain(`@vendoai/vendo@${CLI_VERSION}`);
    expect(sink.logs.join("\n")).toContain("Installing what the generated files import");
    // The generated file really does import it — the claim is not canned.
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8")).toContain('from "@vendoai/vendo/server"');
  });

  /** The gate has to be the app's OWN tree, or the nearest lockfile root — never a
   *  free walk to `/`. A stray `/tmp/node_modules` (this machine has one) made a
   *  scratch directory look installed, and init shelled a real `pnpm add` at it. */
  it("never touches a host that has installed nothing yet", async () => {
    const root = await fixture({ dependencies: { next: "16.0.0" } }, "vendo-install-dx-fresh-");
    const installs: string[][] = [];
    expect(await run(root, output(), {
      yes: true,
      installVendo: async (_command, args) => { installs.push(args); return 0; },
    })).toBe(0);
    expect(installs).toEqual([]);
    // …and the composition it wrote really does import the package it did not
    // install, so this is a deliberate deferral and not a missed case.
    expect(await readFile(join(root, "lib", "vendo.ts"), "utf8")).toContain('from "@vendoai/vendo/server"');
  });

  it("stays quiet when the host already declares it (alias included)", async () => {
    for (const dependencies of [
      { next: "16.0.0", "@vendoai/vendo": "0.28.0" },
      { next: "16.0.0", vendoai: "0.28.0" },
    ]) {
      const root = await installedHost({ dependencies });
      const installs: string[][] = [];
      expect(await run(root, output(), {
        yes: true,
        installVendo: async (_command, args) => { installs.push(args); return 0; },
      })).toBe(0);
      expect(installs).toEqual([]);
    }
  });

  it("names the exact command when the install fails, instead of shipping a build that cannot compile", async () => {
    const root = await installedHost({ dependencies: { next: "16.0.0" } });
    const sink = output();
    expect(await run(root, sink, { yes: true, installVendo: async () => 1 })).toBe(0);
    const warned = sink.errors.join("\n");
    expect(warned).toContain("could not install");
    expect(warned).toContain("@vendoai/vendo");
    expect(warned).toContain("which your package.json does not declare");
  });
});

describe("the mount is doctor's to grade, and only for an embedded install", () => {
  it.each(["agent-loop", "mcp"] as const)("records %s, so doctor skips the mounted-UI checks", async (useCase) => {
    const root = await fixture({ dependencies: { next: "16.0.0", "@clerk/nextjs": "7.0.0" } });
    const sink = output();
    expect(await run(root, sink, { useCase, auth: "clerk", yes: true, baseUrl: "http://localhost:3000" })).toBe(0);
    // The terminal never prints the mount either way — that is the docs' —
    // but the RECORD is what tells doctor this install owes no surface.
    expect(sink.logs.join("\n")).not.toContain("VendoProvider");
    expect(JSON.parse(await readFile(join(root, ".vendo", "install.json"), "utf8"))).toMatchObject({ useCase });
  });
});

describe("VENDO_BASE_URL reaches .env.local from an attended terminal", () => {
  /** The condition that made the field observations disagree: init's run-wide
   *  `interactive` folds in `invokedByPackageScript()`, and npm sets
   *  `npm_lifecycle_event` for EVERY `npm run …` — so the same person in the same
   *  terminal got the question from `npx vendo init` (event "npx", excluded) and
   *  no question at all through any wrapper script. This question's posture is
   *  its own now: a terminal is all it asks for. */
  it("asks and writes even when a package script launched init", async () => {
    vi.stubEnv("npm_lifecycle_event", "setup");
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const root = await fixture({ scripts: { dev: "next dev --port 4200", setup: "vendo init" } });
    const sink = output();
    try {
      expect(await run(root, sink, {
        ai: false,
        cloud: { ...NO_CLOUD, models: "later" },
        askText: async (_question, _hint, prefill) => prefill ?? "",
      })).toBe(0);
    } finally {
      process.stdin.isTTY = tty.in;
      process.stdout.isTTY = tty.out;
    }
    expect(await readFile(join(root, ".env.local"), "utf8")).toContain("VENDO_BASE_URL=http://localhost:4200");
    expect(sink.logs.join("\n")).toContain("Wrote VENDO_BASE_URL=http://localhost:4200 to .env.local");
  });
});

describe("agent mode grades", () => {
  it("runs the judgment pass with an available engine and receipts the file", async () => {
    const root = await fixture();
    const sink = output();
    let ran = 0;
    expect(await runInit({
      targetDir: root,
      output: sink.output,
      env: {},
      cloud: NO_CLOUD,
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      agent: true,
      useCase: "embedded",
      auth: "none",
      byo: true,
      baseUrl: "http://localhost:3000",
      extract: {
        harnesses: [{
          id: "scripted",
          availability: async () => "a scripted harness",
          run: async () => "```json\n" + JSON.stringify({ tools: [] }) + "\n```",
        }],
        confirm: async () => { throw new Error("agent mode must never ask for consent"); },
      },
    }).then((code) => { ran += 1; return code; })).toBe(0);
    expect(ran).toBe(1);
    const receipt = receiptOf(sink.logs);
    expect(receipt.judgment.status).toBe("graded");
    expect(receipt.judgment).toMatchObject({ file: join(".vendo", "judgments.json") });
  });

  // #478 — Vendo speaks ai@6 AND ai@7, so a v7 host is no longer something init
  // warns about: telling it to downgrade would break a working install. The
  // ceiling simply moved one major up, where nobody has run Vendo yet.
  it("stops telling an ai@7 host to downgrade, and still names a major above the supported pair", async () => {
    const warningFor = async (version: string): Promise<string> => {
      const root = await fixture();
      await mkdir(join(root, "node_modules", "ai"), { recursive: true });
      await writeFile(join(root, "node_modules", "ai", "package.json"), JSON.stringify({ name: "ai", version }));
      const sink = output();
      await run(root, sink);
      return sink.errors.join("\n");
    };
    expect(await warningFor("7.0.2")).not.toContain("ai@7.0.2");
    expect(await warningFor("8.0.0")).toContain("ai@6 and ai@7");
  });
});
