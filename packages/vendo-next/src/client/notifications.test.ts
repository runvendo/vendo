import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerNotifications } from "./notifications";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const body = handler(url, init);
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

describe("createServerNotifications", () => {
  it("polls /deliveries and flattens automation payloads into notices", async () => {
    const calls = stubFetch(() => ({
      deliveries: [
        {
          cursor: 3,
          message: {
            channel: "in-app",
            principal: { tenantId: "t", subject: "u" },
            text: 'Automation "Chase" finished.',
            automation: { kind: "completed", runId: "r1", summary: "Chase: finished" },
          },
        },
        {
          // No automation payload → not toastable, skipped.
          cursor: 4,
          message: { channel: "in-app", principal: { tenantId: "t", subject: "u" }, text: "hi" },
        },
      ],
    }));
    const client = createServerNotifications("/api/vendo");
    const notices = await client.listSince(2);
    expect(calls[0]!.url).toBe("/api/vendo/deliveries?since=2");
    expect(notices).toEqual([
      {
        cursor: 3,
        kind: "completed",
        runId: "r1",
        summary: "Chase: finished",
        text: 'Automation "Chase" finished.',
      },
    ]);
  });

  it("posts approvals to /resume and maps stale answers", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/resume") ? { stale: true } : { deliveries: [] },
    );
    const client = createServerNotifications("/api/vendo");
    expect(await client.resume("r9", true)).toBe("stale");
    expect(calls[0]!.url).toBe("/api/vendo/resume");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ runId: "r9", approved: true });
  });

  it("maps a resumed run answer to 'resumed' and rejects on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/resume")
          ? new Response(JSON.stringify({ run: { id: "r9", status: "succeeded" } }), { status: 200 })
          : new Response("{}", { status: 500 }),
      ),
    );
    const client = createServerNotifications("/api/vendo");
    expect(await client.resume("r9", true)).toBe("resumed");
    await expect(client.listSince(0)).rejects.toThrow(/deliveries/);
  });
});
