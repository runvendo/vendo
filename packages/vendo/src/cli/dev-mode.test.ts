import { EventEmitter } from "node:events";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDevSessionConsent } from "../dev-creds/resolve.js";
import { chooseSeedPrompt, detectPackageManager, runDevModeStep, runInitFinale } from "./dev-mode.js";
import type { Output } from "./shared.js";

function sink(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vendo-dev-mode-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runDevModeStep", () => {
  it("states an env-key rung and its production story", async () => {
    const { output, logs } = sink();
    const credential = await runDevModeStep({
      root,
      output,
      yes: false,
      resolve: async () => ({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }),
    });
    expect(credential.rung).toBe("env-key");
    expect(logs.join("\n")).toContain("explicit ANTHROPIC_API_KEY");
    expect(logs.join("\n")).toContain("Production deploys use this same key");
  });

  it("records consent for a session rung and offers the SDK install on the claude rung", async () => {
    const { output, logs } = sink();
    const questions: string[] = [];
    const installs: string[] = [];
    const credential = await runDevModeStep({
      root,
      output,
      yes: false,
      resolve: async () => ({ rung: "claude-session" }),
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
      install: async (_root, packageManager, name) => {
        installs.push(`${packageManager}:${name}`);
        return true;
      },
    });
    expect(credential.rung).toBe("claude-session");
    expect(questions[0]).toContain("Claude Code login");
    expect(questions[0]).toContain("production always needs a real key");
    expect((await readDevSessionConsent(root))?.rung).toBe("claude-session");
    // The bare temp dir cannot resolve the SDK → the install offer fires.
    expect(questions[1]).toContain("@anthropic-ai/claude-agent-sdk");
    expect(installs).toEqual(["npm:@anthropic-ai/claude-agent-sdk"]);
    expect(logs.join("\n")).toContain("Consent recorded");
  });

  it("declined consent records nothing and states the fallback", async () => {
    const { output, logs } = sink();
    const credential = await runDevModeStep({
      root,
      output,
      yes: false,
      resolve: async () => ({ rung: "codex-session" }),
      confirm: async () => false,
    });
    expect(credential.rung).toBe("codex-session");
    expect(await readDevSessionConsent(root)).toBeNull();
    expect(logs.join("\n")).toContain("Production needs a real key");
  });

  it("--yes states findings without prompting", async () => {
    const { output, logs } = sink();
    let prompted = false;
    await runDevModeStep({
      root,
      output,
      yes: true,
      resolve: async () => ({ rung: "codex-session" }),
      confirm: async () => {
        prompted = true;
        return true;
      },
    });
    expect(prompted).toBe(false);
    expect(logs.join("\n")).toContain("VENDO_DEV_ALLOW_SESSIONS=1");
  });

  it("the none rung prints the exact ladder instructions and the production line", async () => {
    const { output, logs } = sink();
    await runDevModeStep({
      root,
      output,
      yes: false,
      resolve: async () => ({ rung: "none" }),
    });
    const text = logs.join("\n");
    expect(text).toContain("no model credential found");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("Production deploys always need a real server-side key.");
  });
});

describe("chooseSeedPrompt (adaptive seeding)", () => {
  it("tools extracted → live tool demo", () => {
    expect(chooseSeedPrompt({ toolCount: 3, hasTheme: true }).kind).toBe("tool-demo");
  });
  it("theme only → on-brand UI generation", () => {
    expect(chooseSeedPrompt({ toolCount: 0, hasTheme: true }).kind).toBe("on-brand-ui");
  });
  it("nothing found → self-aware tour", () => {
    const seed = chooseSeedPrompt({ toolCount: 0, hasTheme: false });
    expect(seed.kind).toBe("tour");
    expect(seed.prompt).toContain("what unlocks next");
  });
});

describe("detectPackageManager", () => {
  it("reads the lockfile", async () => {
    expect(await detectPackageManager(root)).toBe("npm");
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    expect(await detectPackageManager(root)).toBe("pnpm");
  });
});

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: (signal?: string) => boolean };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit("exit", 0);
    return true;
  };
  return child as unknown as ChildProcess;
}

function sseResponse(parts: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("runInitFinale", () => {
  it("starts the dev server, opens the browser, and streams the seeded first turn", async () => {
    await mkdir(join(root, ".vendo"), { recursive: true });
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ tools: [{ name: "t" }] }));
    await writeFile(join(root, ".vendo", "theme.json"), "{}");
    const { output, logs, errors } = sink();
    const opened: string[] = [];
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/api/vendo/status")) return new Response("{}", { status: 200 });
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { message: { parts: Array<{ text: string }> } };
      expect(body.message.parts[0]!.text).toContain("read-only action");
      return sseResponse([
        { type: "start", messageId: "m1" },
        { type: "text-delta", id: "t1", delta: "Hi! " },
        { type: "tool-input-available", toolCallId: "c1", toolName: "vendo_list", input: {} },
        { type: "text-delta", id: "t1", delta: "Here is your data." },
        { type: "finish", finishReason: "stop" },
      ]);
    }) as typeof fetch;

    await runInitFinale({
      root,
      output,
      framework: "next",
      credential: { rung: "codex-session" },
      yes: false,
      confirm: async () => true,
      spawnDev: () => fakeChild(),
      openBrowser: (url) => opened.push(url),
      fetchImpl,
      statusTimeoutMs: 2_000,
      waitForServerExit: false,
    });

    expect(opened).toEqual(["http://localhost:3000"]);
    expect(requests.some((url) => url.endsWith("/api/vendo/threads"))).toBe(true);
    expect(logs.join("\n")).toContain("Seeding a first turn (tool-demo)");
    expect(logs.join("\n")).toContain("That reply came from your app's own agent");
    expect(errors).toEqual([]);
  });

  it("declined launch prints the next-step hint instead", async () => {
    const { output, logs } = sink();
    let spawned = false;
    await runInitFinale({
      root,
      output,
      framework: "next",
      credential: { rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
      yes: false,
      confirm: async () => false,
      spawnDev: () => {
        spawned = true;
        return fakeChild();
      },
      waitForServerExit: false,
    });
    expect(spawned).toBe(false);
    expect(logs.join("\n")).toContain("Production needs a real model key");
  });

  it("skips non-Next frameworks and credential-less rungs", async () => {
    const { output, logs } = sink();
    await runInitFinale({
      root,
      output,
      framework: "express",
      credential: { rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
      yes: false,
      confirm: async () => true,
      waitForServerExit: false,
    });
    await runInitFinale({
      root,
      output,
      framework: "next",
      credential: { rung: "none" },
      yes: false,
      confirm: async () => true,
      waitForServerExit: false,
    });
    expect(logs).toEqual([]);
  });

  it("reports a dev server that never answers /status and kills it", async () => {
    const { output, errors } = sink();
    const child = fakeChild();
    let killed = false;
    (child as unknown as { kill: () => boolean }).kill = () => {
      killed = true;
      return true;
    };
    await runInitFinale({
      root,
      output,
      framework: "next",
      credential: { rung: "claude-session" },
      yes: false,
      confirm: async () => true,
      spawnDev: () => child,
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
      statusTimeoutMs: 100,
      waitForServerExit: false,
    });
    expect(killed).toBe(true);
    expect(errors.join("\n")).toContain("did not answer");
  });
});
