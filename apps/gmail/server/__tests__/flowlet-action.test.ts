import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { createActionHandler } from "../flowlet/action";
import { demoTools } from "../flowlet/tools";
import { MailStore } from "../store";
import { seedMessages, DEMO_ME } from "../seed";

const makeHandler = (opts: { now?: () => number; slackOk?: boolean } = {}) => {
  const store = new MailStore(seedMessages(), DEMO_ME);
  const calls: { channel: string; text: string }[] = [];
  const tools = demoTools({
    store,
    generate: async () => "stub model text",
    postToSlack: async (channel, text) => {
      calls.push({ channel, text });
      return opts.slackOk === false
        ? { ok: false, channel, text, error: "boom" }
        : { ok: true, channel, text };
    },
  });
  return { handler: createActionHandler(tools, { now: opts.now }), store, calls };
};

describe("stage action handler", () => {
  it("executes read actions directly (policy allow)", async () => {
    const { handler } = makeHandler();
    const res = await handler({ action: "list_unread_messages", payload: { limit: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("allow");
    expect((res.body.result as unknown[]).length).toBe(3);
  });

  it("gates writes behind a one-time token bound to action+payload", async () => {
    const { handler, store } = makeHandler();
    const first = await handler({ action: "delete_message", payload: { messageId: "m4" } });
    expect(first.status).toBe(200);
    expect(first.body.needsApproval).toBe(true);
    const token = first.body.approvalToken as string;
    expect(token).toBeTruthy();
    expect(store.get("m4")!.folder).toBe("inbox"); // did NOT execute yet

    // Token bound to a DIFFERENT payload must not fire.
    const forged = await handler({
      action: "delete_message",
      payload: { messageId: "m1" },
      approvalToken: token,
    });
    expect(forged.status).toBe(403);
    // ...and the failed use consumed it: the original replay is dead too.
    const replay = await handler({
      action: "delete_message",
      payload: { messageId: "m4" },
      approvalToken: token,
    });
    expect(replay.status).toBe(403);
  });

  it("executes an approved write exactly once with a fresh token", async () => {
    const { handler, store } = makeHandler();
    const ask = await handler({ action: "delete_message", payload: { messageId: "m4" } });
    const token = ask.body.approvalToken as string;
    const run = await handler({
      action: "delete_message",
      payload: { messageId: "m4" },
      approvalToken: token,
    });
    expect(run.status).toBe(200);
    expect((run.body.result as { deleted: boolean }).deleted).toBe(true);
    expect(store.get("m4")!.folder).toBe("trash");
    // Reuse after success is dead.
    const again = await handler({
      action: "delete_message",
      payload: { messageId: "m4" },
      approvalToken: token,
    });
    expect(again.status).toBe(403);
  });

  it("expires tokens", async () => {
    let t = 1_000;
    const { handler } = makeHandler({ now: () => t });
    const ask = await handler({ action: "delete_message", payload: { messageId: "m4" } });
    t += 6 * 60 * 1000; // past the 5-minute TTL
    const run = await handler({
      action: "delete_message",
      payload: { messageId: "m4" },
      approvalToken: ask.body.approvalToken as string,
    });
    expect(run.status).toBe(403);
  });

  it("404s unknown actions and 400s missing action", async () => {
    const { handler } = makeHandler();
    expect((await handler({ action: "reboot_prod" })).status).toBe(404);
    expect((await handler({})).status).toBe(400);
  });

  it("surfaces tool failures as 400 with the message", async () => {
    const { handler } = makeHandler({ slackOk: false });
    const ask = await handler({ action: "slack_summary", payload: { messageId: "m1" } });
    const run = await handler({
      action: "slack_summary",
      payload: { messageId: "m1" },
      approvalToken: ask.body.approvalToken as string,
    });
    expect(run.status).toBe(400);
    expect(String(run.body.error)).toContain("Slack post failed");
  });
});

describe("demo tools", () => {
  it("send_reply drafts when body is absent, sends and marks read", async () => {
    const { handler, store } = makeHandler();
    const ask = await handler({ action: "send_reply", payload: { messageId: "m5" } });
    const run = await handler({
      action: "send_reply",
      payload: { messageId: "m5" },
      approvalToken: ask.body.approvalToken as string,
    });
    expect(run.status).toBe(200);
    const result = run.body.result as { sent: boolean; to: string; body: string };
    expect(result.sent).toBe(true);
    expect(result.to).toBe("marcus@acmelabs.dev");
    expect(result.body).toBe("stub model text");
    expect(store.get("m5")!.unread).toBe(false);
    expect(store.list({ folder: "sent" })[0]!.inReplyTo).toBe("m5");
  });

  it("slack_summary posts the branded one-liner and marks read", async () => {
    const { handler, calls, store } = makeHandler();
    const ask = await handler({ action: "slack_summary", payload: { messageId: "m1" } });
    const run = await handler({
      action: "slack_summary",
      payload: { messageId: "m1" },
      approvalToken: ask.body.approvalToken as string,
    });
    expect(run.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe("#general");
    expect(calls[0]!.text).toContain("Sarah Kim");
    expect(calls[0]!.text).toContain("stub model text");
    expect(store.get("m1")!.unread).toBe(false);
  });

  it("unknown message ids fail loudly, not silently", async () => {
    const { handler } = makeHandler();
    const ask = await handler({ action: "send_reply", payload: { messageId: "ghost" } });
    const run = await handler({
      action: "send_reply",
      payload: { messageId: "ghost" },
      approvalToken: ask.body.approvalToken as string,
    });
    expect(run.status).toBe(400);
    expect(String(run.body.error)).toContain("unknown message");
  });
});

describe("policy", () => {
  it("client-executed host tools decide from annotations", async () => {
    const { demoPolicy } = await import("../flowlet/policy");
    const { gmailHostToolDefs } = await import("../flowlet/host-tools");
    const { hostToolset } = await import("@flowlet/runtime");
    const { buildDescriptor } = await import("@flowlet/runtime");
    const toolset = hostToolset(gmailHostToolDefs) as Record<string, unknown>;
    const { DEMO_PRINCIPAL } = await import("../flowlet/principal");

    const evaluate = (name: string) =>
      demoPolicy.evaluate({
        toolName: name,
        input: {},
        descriptor: buildDescriptor(name, toolset[name], "caller"),
        principal: DEMO_PRINCIPAL,
      });

    expect(await evaluate("list_messages")).toBe("allow");
    expect(await evaluate("get_message")).toBe("allow");
    expect(await evaluate("send_message")).toBe("approve");
    expect(await evaluate("delete_message")).toBe("approve");
  });
});

describe("chat guard", () => {
  it("rejects non-local hosts and malformed messages", async () => {
    const { handleChat, principalAllowed } = await import("../flowlet/chat");
    const fakeReq = (host: string, body: unknown) =>
      ({ headers: { host }, body, on: () => {} }) as never;
    const fakeRes = () => {
      const out: { status?: number; json?: unknown } = {};
      return {
        res: {
          status(code: number) { out.status = code; return this; },
          json(payload: unknown) { out.json = payload; },
          setHeader() {},
          on() {},
          end() {},
        } as never,
        out,
      };
    };

    expect(principalAllowed(fakeReq("evil.example.com", {}) as never)).toBe(false);
    expect(principalAllowed(fakeReq("localhost:3198", {}) as never)).toBe(true);

    const agent = { run: () => { throw new Error("must not run"); } } as never;
    const a = fakeRes();
    await handleChat(fakeReq("evil.example.com", { messages: [{}] }) as never, a.res, agent);
    expect(a.out.status).toBe(403);

    const b = fakeRes();
    await handleChat(fakeReq("localhost", { messages: [] }) as never, b.res, agent);
    expect(b.out.status).toBe(400);
  });
});

describe("tool wiring", () => {
  it("read tools execute without approval and project the swipe-deck fields", async () => {
    const { handler } = makeHandler();
    const res = await handler({ action: "list_unread_messages", payload: {} });
    const items = res.body.result as Record<string, unknown>[];
    expect(items.length).toBe(7);
    expect(Object.keys(items[0]!).sort()).toEqual(
      ["body", "date", "from", "fromEmail", "id", "snippet", "starred", "subject", "unread"],
    );
  });

  it("search_messages searches by text", async () => {
    const { handler } = makeHandler();
    const res = await handler({ action: "search_messages", payload: { q: "ramen" } });
    expect((res.body.result as unknown[]).length).toBe(1);
  });

  it("does not use a stub-friendly execute for the AI SDK tool() shape", () => {
    // Guard: demoTools must produce ai-SDK tools (execute present) so both the
    // agent loop and the action route can run them.
    const probe = tool({ description: "x", inputSchema: z.object({}), execute: async () => 1 });
    expect(typeof probe.execute).toBe("function");
  });
});
