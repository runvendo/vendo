import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome, ToolRegistry } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps, type AppsRuntime } from "./index.js";
import { authoringAssembler, guardFixture, memoryStore, scriptedLanguageModel } from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_sampling" },
  venue: "chat",
  presence: "present",
  sessionId: "session_sampling",
};

const generated = '<App name="Sampled dashboard"><Text text="Ready"/><Disclaimer reason="Fixture app."/></App>';

const readDescriptor = (name: string, extras: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  description: `${name} fixture`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  ...extras,
});

class RecordingTools implements ToolRegistry {
  readonly executed: string[] = [];
  #outcomes = new Map<string, ToolOutcome>();

  constructor(readonly available: ToolDescriptor[]) {}

  setOutcome(tool: string, outcome: ToolOutcome): void {
    this.#outcomes.set(tool, outcome);
  }

  async descriptors(): Promise<ToolDescriptor[]> {
    return this.available;
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    this.executed.push(call.tool);
    return this.#outcomes.get(call.tool) ?? { status: "ok", output: { rows: [] } };
  }
}

/**
 * The runtime the sampler runs inside.
 *
 * `create` builds its tool context (`generationToolContext`) before it hands the
 * ask to an engine, so the probes below happen exactly as they always did — but
 * the create only COMPLETES if something can build a screen, and the ONE engine
 * is the assembler in the `screen` slot.
 */
const sampling = (
  registry: ToolRegistry,
  over: Partial<Parameters<typeof createApps>[0]> = {},
): AppsRuntime => {
  let runtime: AppsRuntime;
  runtime = createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools: registry,
    catalog: [],
    model: scriptedLanguageModel(generated),
    screen: authoringAssembler(() => runtime, generated),
    ...over,
  });
  return runtime;
};

/**
 * Re-gate 2026-07-26 finding 2 (create-time Composio probes): the shape-card
 * sampler probes every no-arg read tool once per runtime. Connector tools
 * (descriptor.toolkit set) whose toolkit is not CONNECTED for the caller must
 * never be probed at all — on the gate hosts, ~159 unconnected Slack/Gmail
 * read probes were parked at the approval gate and the probe burst tripped
 * the call-rate breaker under real creates.
 */
describe("generation tool sampling and connector connectedness", () => {
  it("skips connector tools whose toolkit is not connected, probes connected ones", async () => {
    const tools = new RecordingTools([
      readDescriptor("host_listAccounts"),
      readDescriptor("gmail_FETCH_EMAILS", { toolkit: "gmail" }),
      readDescriptor("slack_LIST_CHANNELS", { toolkit: "slack" }),
    ]);
    const runtime = sampling(tools, { connectedToolkits: async () => ["slack"] });

    await runtime.create({ prompt: "Build a dashboard" }, ctx);

    expect(tools.executed).toContain("host_listAccounts");
    expect(tools.executed).toContain("slack_LIST_CHANNELS");
    expect(tools.executed).not.toContain("gmail_FETCH_EMAILS");
  });

  it("skips ALL connector tools when no connectedToolkits seam is composed", async () => {
    const tools = new RecordingTools([
      readDescriptor("host_listAccounts"),
      readDescriptor("gmail_FETCH_EMAILS", { toolkit: "gmail" }),
    ]);
    const runtime = sampling(tools);

    await runtime.create({ prompt: "Build a dashboard" }, ctx);

    expect(tools.executed).toContain("host_listAccounts");
    expect(tools.executed).not.toContain("gmail_FETCH_EMAILS");
  });

  it("still lists skipped connector tools as descriptors (skipping is about probes, not reach)", async () => {
    const tools = new RecordingTools([
      readDescriptor("host_listAccounts"),
      readDescriptor("gmail_FETCH_EMAILS", { toolkit: "gmail" }),
    ]);
    const runtime = sampling(tools, { connectedToolkits: async () => [] });

    await runtime.create({ prompt: "Build a dashboard" }, ctx);

    expect(tools.executed).not.toContain("gmail_FETCH_EMAILS");
    // …and the unprobed connector tool is still IN the tool context the runtime
    // hands every check and every engine. The brain's create prompt is gone, so
    // the surviving surface that reads that context is `validate`, whose
    // unknown-tool finding prints the whole host inventory it measured against.
    const verdict = await runtime.validate({
      document: '<App name="Dash"><Query id="q" tool="nope_not_a_tool"/><Text text="hi"/></App>',
    }, ctx);
    const inventory = verdict.findings.map(({ message }) => message).join(" ");
    expect(inventory).toContain("gmail_FETCH_EMAILS");
    expect(inventory).toContain("host_listAccounts");
    // The probe never ran, so no shape was learned for it — listing is reach,
    // not a promise that the tool answered.
    expect(tools.executed).not.toContain("gmail_FETCH_EMAILS");
  });

  it("settles a connect-required probe outcome: never re-probed on later creates", async () => {
    const tools = new RecordingTools([
      readDescriptor("gmail_FETCH_EMAILS", { toolkit: "gmail" }),
    ]);
    tools.setOutcome("gmail_FETCH_EMAILS", {
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail", message: "Connect gmail first." },
    });
    const runtime = sampling(tools, {
      // Connected per the broker, but the account expired server-side: the
      // execute outcome is connect-required. One probe, then settled.
      connectedToolkits: async () => ["gmail"],
    });

    await runtime.create({ prompt: "Build a dashboard" }, ctx);
    await runtime.create({ prompt: "Build another dashboard" }, ctx);

    expect(tools.executed.filter((tool) => tool === "gmail_FETCH_EMAILS")).toHaveLength(1);
  });

  it("a connect-required settle is per subject: another connected subject still gets probed", async () => {
    const tools = new RecordingTools([
      readDescriptor("gmail_FETCH_EMAILS", { toolkit: "gmail" }),
    ]);
    tools.setOutcome("gmail_FETCH_EMAILS", {
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail", message: "Connect gmail first." },
    });
    const runtime = sampling(tools, { connectedToolkits: async () => ["gmail"] });

    await runtime.create({ prompt: "Build a dashboard" }, ctx);
    // A different principal with a WORKING account: the probe now succeeds
    // and must not have been suppressed by the first subject's dead probe.
    tools.setOutcome("gmail_FETCH_EMAILS", { status: "ok", output: { emails: [] } });
    await runtime.create({ prompt: "Build a dashboard" }, {
      ...ctx,
      principal: { kind: "user", subject: "user_sampling_2" },
      sessionId: "session_sampling_2",
    });

    expect(tools.executed.filter((tool) => tool === "gmail_FETCH_EMAILS")).toHaveLength(2);
  });

  it("a connect-required settle expires: a mid-boot reconnect is sampled after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    try {
      const tools = new RecordingTools([
        readDescriptor("gmail_FETCH_EMAILS", { toolkit: "gmail" }),
      ]);
      tools.setOutcome("gmail_FETCH_EMAILS", {
        status: "connect-required",
        connect: { connector: "composio", toolkit: "gmail", message: "Connect gmail first." },
      });
      const runtime = sampling(tools, { connectedToolkits: async () => ["gmail"] });

      await runtime.create({ prompt: "Build a dashboard" }, ctx);
      // Within the TTL the dead probe stays quiet.
      vi.setSystemTime(new Date("2026-07-26T00:05:00.000Z"));
      await runtime.create({ prompt: "Build a dashboard again" }, ctx);
      expect(tools.executed.filter((tool) => tool === "gmail_FETCH_EMAILS")).toHaveLength(1);
      // The user reconnects; past the TTL the probe retries and fills the shape.
      tools.setOutcome("gmail_FETCH_EMAILS", { status: "ok", output: { emails: [] } });
      vi.setSystemTime(new Date("2026-07-26T00:11:00.000Z"));
      await runtime.create({ prompt: "Build a dashboard once more" }, ctx);
      expect(tools.executed.filter((tool) => tool === "gmail_FETCH_EMAILS")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing connectedToolkits lookup degrades to host-tools-only sampling", async () => {
    const tools = new RecordingTools([
      readDescriptor("host_listAccounts"),
      readDescriptor("slack_LIST_CHANNELS", { toolkit: "slack" }),
    ]);
    const runtime = sampling(tools, {
      connectedToolkits: async () => {
        throw new Error("broker offline");
      },
    });

    await runtime.create({ prompt: "Build a dashboard" }, ctx);

    expect(tools.executed).toContain("host_listAccounts");
    expect(tools.executed).not.toContain("slack_LIST_CHANNELS");
  });
});
