import { describe, expect, it } from "vitest";
import {
  evaluateAssertion,
  parseConversationSuite,
  scorePassAtK,
  type ConversationAssertion,
  type E2eLocator,
  type E2eObservableSignals,
  type E2ePage,
} from "./e2e.js";

class FakeLocator implements E2eLocator {
  constructor(private readonly countValue: number, private readonly text = "") {}

  async count(): Promise<number> {
    return this.countValue;
  }

  async textContent(): Promise<string> {
    return this.text;
  }

  first(): E2eLocator {
    return this;
  }
}

class FakePage implements E2ePage {
  constructor(private readonly counts: Record<string, number>, private readonly bodyText = "") {}

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

  it("evaluates approval cards and no-error-toast from fake page/signal objects", async () => {
    const approvalPage = new FakePage({ "Approval request": 1 });
    const errorPage = new FakePage({ '[role="alert"]': 1 });
    const statusToastPage = new FakePage({ ".fl-toast": 1 }, "Saved successfully");
    const approvalAssertion: ConversationAssertion = { kind: "approval-card-shown" };

    await expect(evaluateAssertion(approvalAssertion, signals({}), approvalPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), approvalPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), statusToastPage))
      .resolves.toMatchObject({ pass: true });
    await expect(evaluateAssertion({ kind: "no-error-toast" }, signals({}), errorPage))
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
