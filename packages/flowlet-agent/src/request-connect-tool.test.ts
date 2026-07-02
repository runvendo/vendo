import { describe, it, expect, vi } from "vitest";
import { createRequestConnectTool } from "./request-connect-tool";

function writerMock() {
  return { write: vi.fn() } as unknown as Parameters<typeof createRequestConnectTool>[0];
}

describe("createRequestConnectTool", () => {
  it("writes a host component 'Connect' data-ui node carrying toolkit + reason", async () => {
    const writer = writerMock();
    const tool = createRequestConnectTool(writer);
    const result = await tool.execute!(
      { toolkit: "gmail", reason: "to read the receipt" } as never,
      {} as never,
    );
    expect(result).toBe("connect card shown");
    const written = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.type).toBe("data-ui");
    expect(written.data.kind).toBe("component");
    expect(written.data.source).toBe("host");
    expect(written.data.name).toBe("Connect");
    expect(written.data.props).toEqual({ toolkit: "gmail", reason: "to read the receipt" });
    expect(written.id).toBe(written.data.id);
  });

  it("allows an optional reason", async () => {
    const writer = writerMock();
    const tool = createRequestConnectTool(writer);
    await tool.execute!({ toolkit: "slack" } as never, {} as never);
    const written = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.data.props).toEqual({ toolkit: "slack", reason: undefined });
  });

  it("mints unique node ids across calls", async () => {
    const writer = writerMock();
    const tool = createRequestConnectTool(writer);
    await tool.execute!({ toolkit: "gmail" } as never, {} as never);
    await tool.execute!({ toolkit: "slack" } as never, {} as never);
    const calls = (writer.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.id).not.toBe(calls[1][0].data.id);
  });
});
