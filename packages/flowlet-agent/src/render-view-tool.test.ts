import { describe, it, expect, vi } from "vitest";
import { createRenderViewTool } from "./render-view-tool";

const VALID = {
  formatVersion: "flowlet-genui/v1",
  root: "r",
  nodes: [
    { id: "r", component: "Stack", source: "prewired", children: ["g"] },
    { id: "g", component: "Gauge", source: "generated", props: { value: 42 } },
  ],
  components: { Gauge: "import React from 'react'; export default function Gauge(p){ return React.createElement('div', null, p.value); }" },
};

function writerMock() {
  return { write: vi.fn() } as unknown as Parameters<typeof createRenderViewTool>[0];
}

describe("createRenderViewTool", () => {
  it("writes a kind:'generated' data-ui node for a valid payload", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const result = await tool.execute!(VALID as never, {} as never);
    expect(result).toBe("rendered");
    const written = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.type).toBe("data-ui");
    expect(written.data.kind).toBe("generated");
    expect(written.data.payload).toEqual(VALID);
  });

  it("returns the validation error (and writes nothing) for an invalid payload", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const bad = { ...VALID, components: {} }; // generated node with no definition
    const result = await tool.execute!(bad as never, {} as never);
    expect(String(result)).toMatch(/^render_view error \((version|provision)\):/);
    expect((writer.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("mints unique node ids across calls", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    await tool.execute!(VALID as never, {} as never);
    await tool.execute!(VALID as never, {} as never);
    const calls = (writer.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].data.id).not.toBe(calls[1][0].data.id);
  });
});
