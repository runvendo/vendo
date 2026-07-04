import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { RegisteredComponent } from "@flowlet/core";
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

  it("compiles a JSX component to sandbox-ready ESM before shipping", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const jsxPayload = {
      ...VALID,
      components: {
        Gauge: "export default function Gauge(p){ return <div>{p.value}</div>; }",
      },
    };
    const result = await tool.execute!(jsxPayload as never, {} as never);
    expect(result).toBe("rendered");
    const written = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const compiled = written.data.payload.components.Gauge as string;
    expect(compiled).toContain("react/jsx-runtime");
    expect(compiled).not.toContain("<div");
    expect(compiled).not.toContain("jsxDEV");
  });

  it("returns a compile error (and writes nothing) for a JSX syntax error", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const broken = {
      ...VALID,
      components: { Gauge: "export default function Gauge(p){ return <div>{p.value</div>; }" },
    };
    const result = await tool.execute!(broken as never, {} as never);
    expect(String(result)).toMatch(/^render_view error \(compile\): component "Gauge":/);
    expect((writer.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("keeps declared queries through the input schema and ships them (ENG-183)", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const withQueries = {
      formatVersion: "flowlet-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Text", props: { text: { $path: "/tx/0" } } }],
      data: { tx: ["stale"] },
      queries: [{ path: "/tx", tool: "get_transactions", input: { limit: 40 } }],
    };
    // The zod input schema must declare `queries`, or the SDK strips it in production.
    const schema = tool.inputSchema as { parse: (v: unknown) => Record<string, unknown> };
    expect((schema.parse(withQueries) as { queries: unknown[] }).queries).toHaveLength(1);

    const result = await tool.execute!(withQueries as never, {} as never);
    expect(result).toBe("rendered");
    const written = (writer.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written.data.payload.queries).toEqual(withQueries.queries);
  });

  it("returns a correctable error for malformed queries", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const bad = { ...VALID, queries: [{ path: "no-slash", tool: "t" }] };
    const result = await tool.execute!(bad as never, {} as never);
    expect(String(result)).toMatch(/^render_view error \(provision\):/);
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

  it("mints unique node ids across tool instances (per-request counters must not collide)", async () => {
    // Each /chat request builds a fresh tool; ids key persistence (ENG-183),
    // so two sessions' first views must not both be "view-1".
    const writerA = writerMock();
    const writerB = writerMock();
    await createRenderViewTool(writerA).execute!(VALID as never, {} as never);
    await createRenderViewTool(writerB).execute!(VALID as never, {} as never);
    const idA = (writerA.write as ReturnType<typeof vi.fn>).mock.calls[0][0].data.id;
    const idB = (writerB.write as ReturnType<typeof vi.fn>).mock.calls[0][0].data.id;
    expect(idA).not.toBe(idB);
  });
});

describe("createRenderViewTool — server-side host validation (ENG-186)", () => {
  const registry: RegisteredComponent[] = [
    {
      name: "AcmeBadge",
      description: "status pill",
      propsSchema: z.object({ text: z.string() }) as unknown as RegisteredComponent["propsSchema"],
      source: "host",
    },
  ];
  const hostPayload = (props: Record<string, unknown>, component = "AcmeBadge") => ({
    formatVersion: "flowlet-genui/v1",
    root: "r",
    nodes: [
      { id: "r", component: "Stack", source: "prewired", children: ["b"] },
      { id: "b", component, source: "host", props },
    ],
  });

  it("returns a correctable (host) error for schema-invalid host props, writing nothing", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer, { components: registry });
    const result = await tool.execute!(hostPayload({ text: 42 }) as never, {} as never);
    expect(String(result)).toMatch(/^render_view error \(host\): node "b"/);
    expect(String(result)).toContain("AcmeBadge");
    expect((writer.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("returns a correctable (host) error naming the registered components for an unknown host name", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer, { components: registry });
    const result = await tool.execute!(hostPayload({ text: "hi" }, "AcmeTypo") as never, {} as never);
    expect(String(result)).toContain('unknown host component "AcmeTypo"');
    expect(String(result)).toContain("AcmeBadge");
  });

  it("ships valid host props untouched", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer, { components: registry });
    const result = await tool.execute!(hostPayload({ text: "hi" }) as never, {} as never);
    expect(result).toBe("rendered");
  });

  it("skips host validation entirely when no registry is provided (back-compat)", async () => {
    const writer = writerMock();
    const tool = createRenderViewTool(writer);
    const result = await tool.execute!(hostPayload({ text: 42 }) as never, {} as never);
    expect(result).toBe("rendered");
  });
});
