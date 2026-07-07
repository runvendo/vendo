import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateAssertion,
  parseConversationSuite,
  runE2eLayer,
  scorePassAtK,
  type ConversationAssertion,
  type E2eFrameLocator,
  type E2eLocator,
  type E2eObservableSignals,
  type E2ePage,
} from "./e2e.js";

class FakeLocator implements E2eLocator {
  constructor(
    private readonly countValue: number | (() => number),
    private readonly text = "",
    private readonly handlers: {
      click?: () => void;
      fill?: (value: string) => void;
      press?: (key: string) => void;
    } = {},
  ) {}

  async count(): Promise<number> {
    return typeof this.countValue === "function" ? this.countValue() : this.countValue;
  }

  async click(): Promise<void> {
    this.handlers.click?.();
  }

  async fill(value: string): Promise<void> {
    this.handlers.fill?.(value);
  }

  async press(key: string): Promise<void> {
    this.handlers.press?.(key);
  }

  async textContent(): Promise<string> {
    return this.text;
  }

  first(): E2eLocator {
    return this;
  }
}

class FakePage implements E2ePage {
  constructor(
    private readonly counts: Record<string, number>,
    private readonly bodyText = "",
    private readonly frameCounts: Record<string, number> = {},
  ) {}

  async goto(): Promise<void> {}

  locator(selector: string): E2eLocator {
    if (selector === "body") return new FakeLocator(1, this.bodyText);
    if (selector.includes(".fl-toast")) return new FakeLocator(this.counts[".fl-toast"] ?? 0, this.bodyText);
    const key = Object.keys(this.counts).find((candidate) => selector.includes(candidate));
    return new FakeLocator(key ? this.counts[key] ?? 0 : 0);
  }

  getByRole(role: string): E2eLocator {
    return new FakeLocator(this.counts[`role:${role}`] ?? 0);
  }

  getByLabel(): E2eLocator {
    return new FakeLocator(this.counts.label ?? 0);
  }

  getByTestId(testId: string): E2eLocator {
    return new FakeLocator(this.counts[`testid:${testId}`] ?? 0);
  }

  frameLocator(): E2eFrameLocator {
    return {
      locator: (selector: string) => new FakeLocator(this.frameCounts[selector] ?? 0),
      getByRole: (role: string) => new FakeLocator(this.frameCounts[`role:${role}`] ?? 0),
      getByTestId: (testId: string) => new FakeLocator(this.frameCounts[`testid:${testId}`] ?? 0),
    };
  }
}

function signals(partial: Partial<E2eObservableSignals>): E2eObservableSignals {
  return {
    toolCalls: [],
    views: [],
    approvals: [],
    errorToasts: [],
    ...partial,
  };
}

describe("conversation suite parsing", () => {
  it("defines prompts, assertions, timeout, k, and threshold", () => {
    const suite = parseConversationSuite({
      version: 1,
      k: 2,
      timeoutMs: 60000,
      threshold: 0.8,
      conversations: [
        {
          id: "analytics-question",
          prompts: ["Which page had the most views?"],
          assertions: [
            { type: "tool-called", name: { regex: "stats|page" } },
            { kind: "view-rendered", role: "table" },
            { kind: "no-error-toast" },
          ],
        },
      ],
    });

    expect(suite.conversations[0]?.assertions.map((assertion) => assertion.kind)).toEqual([
      "tool-called",
      "view-rendered",
      "no-error-toast",
    ]);
  });
});

describe("evaluateAssertion", () => {
  it("matches tool-called assertions by exact and regex name matchers from fake signals", async () => {
    const observed = signals({
      toolCalls: [
        { name: "listWebsiteStats", source: "test" },
        { name: "createShareLink", source: "test" },
      ],
    });

    await expect(evaluateAssertion({ kind: "tool-called", name: "listWebsiteStats" }, observed))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "tool-called", name: { regex: "share.*link" } }, observed))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "tool-called", name: "deleteDocument" }, observed))
      .resolves.toMatchObject({ pass: false });
  });

  it("matches rendered views from fake signals and fake DOM roles/test ids", async () => {
    const observed = signals({
      views: [{ component: "Table", role: "table", testId: "ui-node", text: "Pricing" }],
    });
    const page = new FakePage({ "role:list": 1, "testid:ui-node": 1 });

    await expect(evaluateAssertion({ kind: "view-rendered", component: "Table", role: "table" }, observed))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "view-rendered", role: "list" }, signals({}), page))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "view-rendered", testId: "ui-node" }, signals({}), page))
      .resolves.toMatchObject({ pass: true });
  });

  it("matches generated view roles inside the Vendo stage iframe", async () => {
    const page = new FakePage({}, "", { "role:table": 1 });

    await expect(evaluateAssertion({ kind: "view-rendered", role: "table" }, signals({}), page))
      .resolves.toMatchObject({ pass: true });
  });

  it("evaluates approval cards and no-error-toast from fake page/signal objects", async () => {
    const approvalPage = new FakePage({ "Approval request": 1 });
    const genericAlertPage = new FakePage({ '[role="alert"]': 1 });
    const shellErrorPage = new FakePage({ ".fl-error": 1 });
    const explicitDataErrorPage = new FakePage({ '[data-error="true"]': 1 });
    const benignDataErrorPage = new FakePage({ "[data-error]": 1 });
    const stageErrorPage = new FakePage({}, "", { "[data-error]:visible, [data-error-boundary]:visible": 1 });
    const statusToastPage = new FakePage({ ".fl-toast": 1 }, "Saved successfully");
    const approvalAssertion: ConversationAssertion = { kind: "approval-card-shown" };

    await expect(evaluateAssertion(approvalAssertion, signals({}), approvalPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), approvalPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), benignDataErrorPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), genericAlertPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), statusToastPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), shellErrorPage))
      .resolves.toMatchObject({ pass: false });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), explicitDataErrorPage))
      .resolves.toMatchObject({ pass: false });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), stageErrorPage))
      .resolves.toMatchObject({ pass: false });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({ errorToasts: [{ text: "failed" }] })))
      .resolves.toMatchObject({ pass: false });
  });
});

describe("scorePassAtK", () => {
  it("scores scripts by pass@k and compares to the repo threshold", () => {
    const result = scorePassAtK([
      {
        id: "passes-on-retry",
        k: 2,
        successes: 1,
        passAtK: true,
        attempts: [],
      },
      {
        id: "fails-both",
        k: 2,
        successes: 0,
        passAtK: false,
        attempts: [],
      },
    ], 0.5);

    expect(result.passed).toBe(true);
    expect(result.score).toEqual({ passed: 1, total: 2, value: 0.5 });
    expect(result.checks).toEqual([
      { id: "conversation.passes-on-retry", pass: true, detail: "pass@2: 1/2 attempts passed" },
      { id: "conversation.fails-both", pass: false, detail: "pass@2: 0/2 attempts passed" },
    ]);
  });

  it("fails the layer score below threshold even when one script passes", () => {
    const result = scorePassAtK([
      { id: "one", k: 2, successes: 1, passAtK: true, attempts: [] },
      { id: "two", k: 2, successes: 0, passAtK: false, attempts: [] },
    ], 0.75);

    expect(result.passed).toBe(false);
    expect(result.score.value).toBe(0.5);
  });
});

describe("runE2eLayer", () => {
  it("retries opening the Vendo surface when the launcher is present before hydration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-"));
    const expectationsRoot = path.join(root, "expectations");
    const logsDir = path.join(root, "logs");
    const repoDir = path.join(root, "repo");
    await mkdir(path.join(expectationsRoot, "fixture"), { recursive: true });
    await mkdir(path.join(repoDir, ".vendo"), { recursive: true });
    await writeFile(path.join(repoDir, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
    await writeFile(
      path.join(expectationsRoot, "fixture", "conversations.json"),
      JSON.stringify({
        version: 1,
        k: 1,
        threshold: 1,
        timeoutMs: 2_000,
        conversations: [
          {
            id: "hydrating-launcher",
            prompts: ["show me a view"],
            assertions: [{ kind: "no-error-toast" }],
          },
        ],
      }),
    );

    let launcherClicks = 0;
    let promptSent = false;
    const page: E2ePage = {
      async goto() {},
      locator(selector: string) {
        if (selector === "body" || selector.includes("[role='dialog']")) return new FakeLocator(1, "dialog ready");
        return new FakeLocator(0);
      },
      getByRole(role: string) {
        if (role === "dialog") return new FakeLocator(() => launcherClicks >= 2 ? 1 : 0);
        if (role === "button") {
          return new FakeLocator(1, "", {
            click: () => {
              launcherClicks += 1;
            },
          });
        }
        return new FakeLocator(0);
      },
      getByLabel() {
        return new FakeLocator(1, "", {
          fill: () => {},
          press: () => {
            promptSent = true;
          },
        });
      },
    };

    const result = await runE2eLayer({
      repoName: "fixture",
      repoDir,
      readinessUrl: "http://127.0.0.1:3000",
      expectationsRoot,
      logsDir,
      pageFactory: async () => ({ page }),
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(result.layer.status).toBe("pass");
    expect(launcherClicks).toBeGreaterThan(1);
    expect(promptSent).toBe(true);
  });

  it("restores the per-attempt Vendo thread URL after Umami login redirects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-"));
    const expectationsRoot = path.join(root, "expectations");
    const logsDir = path.join(root, "logs");
    const repoDir = path.join(root, "repo");
    await mkdir(path.join(expectationsRoot, "umami"), { recursive: true });
    await mkdir(path.join(repoDir, ".vendo"), { recursive: true });
    await writeFile(path.join(repoDir, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
    await writeFile(
      path.join(expectationsRoot, "umami", "conversations.json"),
      JSON.stringify({
        version: 1,
        k: 1,
        threshold: 1,
        timeoutMs: 2_000,
        conversations: [
          {
            id: "umami-login",
            prompts: ["show me a view"],
            assertions: [{ kind: "no-error-toast" }],
          },
        ],
      }),
    );

    const gotoUrls: string[] = [];
    let usernameVisible = true;
    let promptSent = false;
    const page: E2ePage = {
      async goto(url: string) {
        gotoUrls.push(url);
      },
      locator(selector: string) {
        if (selector.includes("input-username") || selector.includes('input[name="username"]')) {
          return new FakeLocator(() => usernameVisible ? 1 : 0);
        }
        if (selector.includes("input-password") || selector.includes('input[name="password"]')) {
          return new FakeLocator(() => usernameVisible ? 1 : 0);
        }
        if (selector === "body" || selector.includes("[role='dialog']")) return new FakeLocator(1, "dialog ready");
        return new FakeLocator(0);
      },
      getByRole(role: string) {
        if (role === "dialog") return new FakeLocator(1);
        if (role === "button") {
          return new FakeLocator(1, "", {
            click: () => {
              usernameVisible = false;
            },
          });
        }
        return new FakeLocator(0);
      },
      getByLabel() {
        return new FakeLocator(1, "", {
          fill: () => {},
          press: () => {
            promptSent = true;
          },
        });
      },
    };

    const result = await runE2eLayer({
      repoName: "umami",
      repoDir,
      readinessUrl: "http://localhost:3000",
      expectationsRoot,
      logsDir,
      pageFactory: async () => ({ page }),
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(result.layer.status).toBe("pass");
    expect(gotoUrls).toEqual([
      "http://localhost:3000/?vendoThread=corpus-umami-login-1",
      "http://localhost:3000/?vendoThread=corpus-umami-login-1",
    ]);
    expect(promptSent).toBe(true);
  });

  it("visits Papermark's e2e login route and restores the per-attempt Vendo thread URL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-"));
    const expectationsRoot = path.join(root, "expectations");
    const logsDir = path.join(root, "logs");
    const repoDir = path.join(root, "repo");
    await mkdir(path.join(expectationsRoot, "papermark"), { recursive: true });
    await mkdir(path.join(repoDir, ".vendo"), { recursive: true });
    await writeFile(path.join(repoDir, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
    await writeFile(
      path.join(expectationsRoot, "papermark", "conversations.json"),
      JSON.stringify({
        version: 1,
        k: 1,
        threshold: 1,
        timeoutMs: 2_000,
        conversations: [
          {
            id: "papermark-login",
            prompts: ["show me documents"],
            assertions: [{ kind: "no-error-toast" }],
          },
        ],
      }),
    );

    const gotoUrls: string[] = [];
    let promptSent = false;
    const page: E2ePage = {
      async goto(url: string) {
        gotoUrls.push(url);
      },
      locator(selector: string) {
        if (selector === "body" || selector.includes("[role='dialog']")) return new FakeLocator(1, "dialog ready");
        return new FakeLocator(0);
      },
      getByRole(role: string) {
        if (role === "dialog") return new FakeLocator(1);
        return new FakeLocator(0);
      },
      getByLabel() {
        return new FakeLocator(1, "", {
          fill: () => {},
          press: () => {
            promptSent = true;
          },
        });
      },
    };

    const result = await runE2eLayer({
      repoName: "papermark",
      repoDir,
      readinessUrl: "http://127.0.0.1:3000",
      expectationsRoot,
      logsDir,
      pageFactory: async () => ({ page }),
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(result.layer.status).toBe("pass");
    expect(gotoUrls).toEqual([
      "http://127.0.0.1:3000/corpus-e2e?vendoThread=corpus-papermark-login-1",
      "http://127.0.0.1:3000/api/corpus-login",
      "http://127.0.0.1:3000/corpus-e2e?vendoThread=corpus-papermark-login-1",
    ]);
    expect(promptSent).toBe(true);
  });
});
