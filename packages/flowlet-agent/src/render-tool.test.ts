import { describe, it, expect, vi } from "vitest";
import type { UIMessageStreamWriter } from "ai";
import type { FlowletUIMessage } from "@flowlet/core";
import type { ComponentNode } from "@flowlet/core";
import { createRenderTool } from "./render-tool";

type FlowletWriter = UIMessageStreamWriter<FlowletUIMessage>;

/** Minimal fake writer that captures write() calls. */
function fakeWriter(): { write: ReturnType<typeof vi.fn>; writer: FlowletWriter } {
  const write = vi.fn();
  const writer = { write, merge: vi.fn(), onError: vi.fn() } as unknown as FlowletWriter;
  return { write, writer };
}

/** Cast to any so we can call execute without the full SDK options shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callExecute(tool: ReturnType<typeof createRenderTool>, input: unknown): Promise<unknown> {
  const fn = tool.execute as (input: unknown, options: unknown) => Promise<unknown>;
  return fn(input, { toolCallId: "test-call", messages: [] });
}

describe("createRenderTool", () => {
  it("writes a data-ui part and returns 'rendered'", async () => {
    const { write, writer } = fakeWriter();
    const renderTool = createRenderTool(writer);

    const result = await callExecute(renderTool, { name: "DemoCard", props: { title: "Hi" } });

    expect(result).toBe("rendered");
    expect(write).toHaveBeenCalledOnce();

    const part = write.mock.calls[0][0] as { type: string; id: string; data: ComponentNode };
    expect(part.type).toBe("data-ui");
    expect(part.data.kind).toBe("component");
    expect(part.data.name).toBe("DemoCard");
    expect(part.data.props).toEqual({ title: "Hi" });
    expect((part.data as ComponentNode).source).toBe("prewired");
    expect(part.id).toBe(part.data.id);
    expect(typeof part.id).toBe("string");
  });

  it("uses the explicit id when provided", async () => {
    const { write, writer } = fakeWriter();
    const renderTool = createRenderTool(writer);

    await callExecute(renderTool, { name: "Card", props: {}, id: "my-id" });

    const part = write.mock.calls[0][0] as { type: string; id: string; data: ComponentNode };
    expect(part.id).toBe("my-id");
    expect(part.data.id).toBe("my-id");
  });

  it("uses the explicit source when provided", async () => {
    const { write, writer } = fakeWriter();
    const renderTool = createRenderTool(writer);

    await callExecute(renderTool, { name: "Card", props: {}, source: "host" });

    const part = write.mock.calls[0][0] as { type: string; id: string; data: ComponentNode };
    expect((part.data as ComponentNode).source).toBe("host");
  });

  it("defaults props to {} when not provided", async () => {
    const { write, writer } = fakeWriter();
    const renderTool = createRenderTool(writer);

    await callExecute(renderTool, { name: "EmptyCard" });

    const part = write.mock.calls[0][0] as { type: string; id: string; data: ComponentNode };
    expect(part.data.props).toEqual({});
  });

  it("two calls without an id produce distinct ids", async () => {
    const { write, writer } = fakeWriter();
    const renderTool = createRenderTool(writer);

    await callExecute(renderTool, { name: "CardA" });
    await callExecute(renderTool, { name: "CardB" });

    const part1 = write.mock.calls[0][0] as { id: string };
    const part2 = write.mock.calls[1][0] as { id: string };
    expect(part1.id).not.toBe(part2.id);
  });
});
