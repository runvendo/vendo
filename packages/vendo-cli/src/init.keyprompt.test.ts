import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { runInit } from "./init.js";
import type { Interactor } from "./interact.js";
import { textModel } from "./test-helpers.js";

const ROUTE_REPLY = JSON.stringify([{
  name: "list_things", description: "List things.", method: "get", path: "/api/things",
  inputSchema: { type: "object", properties: {} },
}]);
const COMPONENT_REPLY = JSON.stringify({
  include: true, reason: "primitive", name: "Badge", description: "A badge.",
  imports: ["Badge"], props: [{ name: "text", type: "string", optional: false, description: "Text." }],
  jsx: "<Badge>{p.text}</Badge>",
});
// Interactive runs show the catalog picker: a batch proposal precedes the
// per-component analyze call.
const PROPOSE_REPLY = JSON.stringify({
  proposals: [{ file: "components/ui/badge.tsx", wrappable: true, reason: "Status primitive." }],
});

/** Provider vars the key-prompt path reads — cleared so tests drive resolution
 *  themselves (the real process may carry a developer's keys). */
const PROVIDER_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "VENDO_MODEL",
  "VENDO_CLI_MODEL",
];

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of PROVIDER_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of PROVIDER_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** A fake masked-input seam that replays `inputs` in order (last repeats) and
 *  counts invocations, so tests can assert it was (never) reached. The catalog
 *  picker (multiSelect) defaults to accepting all offered candidates — these
 *  tests exercise the key prompt, not picker selection. */
function fakeInteractor(inputs: Array<string | null>): { interactor: Interactor; count: () => number } {
  let i = 0;
  let calls = 0;
  return {
    count: () => calls,
    interactor: {
      async maskedInput() {
        calls++;
        return inputs[Math.min(i++, inputs.length - 1)] ?? null;
      },
      async multiSelect(opts) {
        return opts.options.map((o) => o.value);
      },
    },
  };
}

/** A dynamic-import fake that satisfies BOTH the `resolveModel` contract
 *  (`mod[provider](id)`) and the `validateKey` contract (`mod.createX({apiKey})(id)`),
 *  handing back `model` in every case — no optional peer or network needed. */
function openaiImporter(model: LanguageModel) {
  return async () => ({
    openai: (_id: string) => model,
    createOpenAI: (_settings: { apiKey: string }) => (_id: string) => model,
  });
}

/** A Next.js App Router fixture with one API route + one component (LLM steps
 *  have something to do). */
async function fixtureWithRoute(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "init-keyprompt-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "host-app", dependencies: { next: "15.0.0" } }));
  await writeFile(path.join(dir, "tsconfig.json"), "{}");
  await mkdir(path.join(dir, "app/api/things"), { recursive: true });
  await mkdir(path.join(dir, "components/ui"), { recursive: true });
  await writeFile(
    path.join(dir, "app/layout.tsx"),
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  await writeFile(path.join(dir, "app/globals.css"), ":root { --color-bg: #ffffff; --color-ink: #111111; }");
  await writeFile(path.join(dir, "app/api/things/route.ts"), "export async function GET() { return Response.json([]); }\n");
  await writeFile(path.join(dir, "components/ui/badge.tsx"), "export const Badge = () => null");
  return dir;
}

/** A fixture with theme CSS but NO API routes and NO components — the LLM steps
 *  have nothing to scan, so a real (Anthropic) model is never actually called. */
async function fixtureNoLlmWork(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "init-keyprompt-"));
  await writeFile(path.join(dir, "package.json"), "{}");
  await writeFile(path.join(dir, "globals.css"), ":root { --color-bg: #ffffff; }");
  return dir;
}

async function runCaptured(
  opts: Parameters<typeof runInit>[0],
): Promise<{ code: number; out: string; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runInit(opts);
    return { code, out: log.mock.calls.flat().join("\n"), err: err.mock.calls.flat().join("\n") };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("init key prompt (interactive)", () => {
  it("valid pasted key is saved to .env.local and the LLM steps proceed", async () => {
    const dir = await fixtureWithRoute();
    const { interactor, count } = fakeInteractor(["sk-openai-testkey"]);
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      // validateKey succeeds via an injected model (no network, any provider);
      // the post-save re-resolve returns the route/component mock via the importer.
      keyValidateDeps: { model: textModel(["ok"]) },
      modelResolveDeps: { import: openaiImporter(textModel([ROUTE_REPLY, PROPOSE_REPLY, COMPONENT_REPLY])) },
    });
    expect(code).toBe(0);
    expect(count()).toBe(1);
    const envLocal = await readFile(path.join(dir, ".env.local"), "utf8");
    expect(envLocal).toContain("OPENAI_API_KEY=sk-openai-testkey");
    const tools = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(tools.tools[0].name).toBe("list_things");
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
    expect(out).not.toContain("only fills gaps"); // coaching suppressed when a key works
  });

  it("Enter (empty paste) skips into deterministic mode with the coaching line", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor, count } = fakeInteractor([""]);
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
    });
    expect(code).toBe(0);
    expect(count()).toBe(1);
    expect(out).toContain("only fills gaps");
    expect(out).toContain("re-run");
    await readFile(path.join(dir, ".vendo/theme.json"), "utf8"); // deterministic theme still written
  });

  it("Ctrl-C (null) skips the same as Enter", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor } = fakeInteractor([null]);
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
    });
    expect(code).toBe(0);
    expect(out).toContain("only fills gaps");
  });

  it("re-prompts after a rejected key, then accepts a valid one", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor, count } = fakeInteractor(["sk-ant-bad", "sk-ant-good"]);
    // First paste 401s (rejected → re-prompt); second validates. One model,
    // driven by call order: throw a 401-shaped failure first, then succeed.
    let call = 0;
    const { APICallError } = await import("ai");
    const { MockLanguageModelV3 } = await import("ai/test");
    const flakyThenGood = new MockLanguageModelV3({
      doGenerate: async () => {
        if (call++ === 0) {
          throw new APICallError({
            message: "invalid x-api-key",
            url: "https://api.anthropic.test/v1/messages",
            requestBodyValues: {},
            statusCode: 401,
            isRetryable: false,
          });
        }
        return {
          content: [{ type: "text" as const, text: "ok" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const { code, out, err } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      keyValidateDeps: { model: flakyThenGood },
    });
    expect(code).toBe(0);
    expect(count()).toBe(2); // prompted twice
    expect(err).toContain("rejected");
    const envLocal = await readFile(path.join(dir, ".env.local"), "utf8");
    expect(envLocal).toContain("ANTHROPIC_API_KEY=sk-ant-good");
    expect(out).not.toContain("only fills gaps"); // ended with a working key
  });

  it("re-prompts after a rejected key, then Enter skips (telemetry-invalid path)", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor, count } = fakeInteractor(["sk-ant-bad", ""]);
    const { APICallError } = await import("ai");
    const { MockLanguageModelV3 } = await import("ai/test");
    const rejecting = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new APICallError({
          message: "invalid x-api-key",
          url: "https://api.anthropic.test/v1/messages",
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        });
      },
    });
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      keyValidateDeps: { model: rejecting },
    });
    expect(code).toBe(0);
    expect(count()).toBe(2);
    expect(out).toContain("only fills gaps"); // ended in skip → coaching
  });

  it("an unrecognized key shape re-prompts (treated like invalid)", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor, count } = fakeInteractor(["not-a-real-key", ""]);
    const { code, err } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
    });
    expect(code).toBe(0);
    expect(count()).toBe(2);
    expect(err).toContain("doesn't look like a supported key");
  });

  it("unreachable provider does NOT save the key and drops to deterministic mode", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor } = fakeInteractor(["sk-ant-x"]);
    const { throwingModel } = await import("./test-helpers.js");
    const { code, out, err } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      keyValidateDeps: { model: throwingModel("fetch failed") },
    });
    expect(code).toBe(0);
    expect(err).toContain("Couldn't verify the key");
    expect(out).toContain("only fills gaps"); // deterministic + coaching
    await expect(readFile(path.join(dir, ".env.local"), "utf8")).rejects.toThrow(); // not saved
  });

  it("missing optional peer (unavailable) saves the shape-detected key and prints the install hint", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor } = fakeInteractor(["sk-openai-x"]);
    const importer = vi.fn(async () => {
      throw new Error("Cannot find package '@ai-sdk/openai'");
    });
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      keyValidateDeps: { import: importer },
    });
    expect(code).toBe(0);
    const envLocal = await readFile(path.join(dir, ".env.local"), "utf8");
    expect(envLocal).toContain("OPENAI_API_KEY=sk-openai-x"); // saved anyway
    expect(out).toContain("pnpm add @ai-sdk/openai");
    expect(out).not.toContain("only fills gaps"); // its own hint replaces coaching
  });

  it("never echoes the pasted key in any captured output", async () => {
    const dir = await fixtureNoLlmWork();
    const secret = "sk-ant-super-secret-paste";
    const { interactor } = fakeInteractor([secret]);
    const { out, err } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      keyValidateDeps: { model: textModel(["ok"]) },
    });
    expect(`${out}\n${err}`).not.toContain(secret);
  });
});

describe("init key prompt (non-interactive / --yes)", () => {
  it("does NOT prompt when non-interactive, even with no key (env-only, deterministic)", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor, count } = fakeInteractor(["sk-ant-should-not-be-read"]);
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: false,
      interactor,
    });
    expect(code).toBe(0);
    expect(count()).toBe(0); // the seam was never reached
    expect(out).toContain("only fills gaps");
  });

  it("--yes forces non-interactive even when a TTY is claimed", async () => {
    const dir = await fixtureNoLlmWork();
    const { interactor, count } = fakeInteractor(["sk-ant-should-not-be-read"]);
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      yes: true,
      interactive: true,
      interactor,
    });
    expect(code).toBe(0);
    expect(count()).toBe(0);
    expect(out).toContain("only fills gaps");
  });

  it("a key already in .env.local is used without prompting", async () => {
    const dir = await fixtureNoLlmWork();
    await writeFile(path.join(dir, ".env.local"), "ANTHROPIC_API_KEY=sk-ant-preexisting\n");
    const { interactor, count } = fakeInteractor(["sk-ant-should-not-be-read"]);
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
    });
    expect(code).toBe(0);
    expect(count()).toBe(0); // key found → no prompt
    expect(out).not.toContain("only fills gaps"); // a usable key was present
  });
});
