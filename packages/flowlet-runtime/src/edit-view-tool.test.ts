import { describe, expect, it, vi } from "vitest";
import type { VerifiedPinBase } from "@flowlet/core";
import { normalizeBaseline } from "./remix/baseline";
import { createRemixSealer, deriveSealKey, hashSources } from "./remix/envelope";
import { createEditViewTool, type EditViewToolOptions } from "./edit-view-tool";

const BASELINE_SRC = [
  "export default function DeadlineList(props) {",
  "  const items = props.anchor?.items ?? [];",
  "  return <ul>{items.map((it) => <li key={it.id}>{it.name}</li>)}</ul>;",
  "}",
].join("\n");

const baseline = normalizeBaseline(BASELINE_SRC, undefined);

function writerMock() {
  return { write: vi.fn() } as unknown as Parameters<typeof createEditViewTool>[0];
}

const sealer = createRemixSealer(deriveSealKey({ secret: "test-secret" })!);

function options(over: Partial<EditViewToolOptions> = {}): EditViewToolOptions {
  return {
    remixAnchorId: "upcoming-deadlines",
    anchorBase: {
      text: baseline.text,
      baseHash: baseline.baseHash,
      sourceHash: "captured-hash",
      componentName: "DeadlineList",
    },
    seal: { sealer, principalUserId: "user-1", now: () => "2026-07-04T12:00:00.000Z" },
    ...over,
  };
}

const editOp = (over: Record<string, unknown> = {}) => ({
  component: "DeadlineList",
  baseHash: baseline.baseHash,
  hunks: [
    {
      startLine: 3,
      oldLines: ["  return <ul>{items.map((it) => <li key={it.id}>{it.name}</li>)}</ul>;"],
      newLines: [
        "  return <ol style={{ color: 'var(--flowlet-accent)' }}>",
        "    {items.map((it) => <li key={it.id}>{it.name}</li>)}",
        "  </ol>;",
      ],
    },
  ],
  ...over,
});

const calls = (writer: ReturnType<typeof writerMock>) =>
  (writer.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

describe("createEditViewTool — anchor base", () => {
  it("applies hunks to the baseline and ships the deterministic skeleton", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    const result = await tool.execute!({ base: "anchor", ops: [editOp()] } as never, {} as never);
    expect(result).toBe("edited");
    const written = calls(writer);
    const ui = written.find((w) => w.type === "data-ui")!;
    expect(ui.data.kind).toBe("generated");
    expect(ui.data.remixAnchorId).toBe("upcoming-deadlines");
    const payload = ui.data.payload;
    expect(payload.root).toBe("root");
    expect(payload.nodes).toEqual([
      {
        id: "root",
        component: "DeadlineList",
        source: "generated",
        props: { anchor: { $path: "/anchor" } },
      },
    ]);
    // Shipped source is COMPILED (JSX gone), and carries the edit.
    expect(payload.components.DeadlineList).not.toContain("<ol");
    expect(payload.components.DeadlineList).toContain("var(--flowlet-accent)");
  });

  it("pairs a sealed envelope carrying the AUTHORED (pre-compile) state", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    await tool.execute!({ base: "anchor", ops: [editOp()] } as never, {} as never);
    const written = calls(writer);
    const ui = written.find((w) => w.type === "data-ui")!;
    const env = written.find((w) => w.type === "data-remix-envelope")!;
    expect(env.data.uiNodeId).toBe(ui.data.id);
    const verified = sealer.verify(env.data.envelope, {
      anchorId: "upcoming-deadlines",
      principalUserId: "user-1",
    })!;
    expect(verified).not.toBeNull();
    // Authored, not compiled: JSX survives in the envelope.
    expect(verified.sources.DeadlineList).toContain("<ol");
    expect(verified.baseHash).toBe(hashSources(verified.sources));
    expect(verified.sourceHash).toBe("captured-hash");
  });

  it("returns a correctable mismatch error echoing the actual lines, writes nothing", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    const bad = editOp({
      hunks: [{ startLine: 2, oldLines: ["  WRONG LINE"], newLines: ["x"] }],
    });
    const result = String(
      await tool.execute!({ base: "anchor", ops: [bad] } as never, {} as never),
    );
    expect(result).toMatch(/^edit_view error \(mismatch\)/);
    expect(result).toContain("const items = props.anchor?.items ?? [];");
    expect(result).toContain("lines 2-2");
    expect(calls(writer)).toHaveLength(0);
  });

  it("rejects a stale per-component baseHash with the current hash in the error", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    const result = String(
      await tool.execute!(
        { base: "anchor", ops: [editOp({ baseHash: "stale" })] } as never,
        {} as never,
      ),
    );
    expect(result).toMatch(/^edit_view error \(base-hash\)/);
    expect(result).toContain(baseline.baseHash);
  });

  it("rejects unknown components and duplicate ops on one component", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    const unknown = String(
      await tool.execute!(
        { base: "anchor", ops: [editOp({ component: "Nope" })] } as never,
        {} as never,
      ),
    );
    expect(unknown).toMatch(/^edit_view error \(component\)/);
    expect(unknown).toContain("DeadlineList");
    const dup = String(
      await tool.execute!({ base: "anchor", ops: [editOp(), editOp()] } as never, {} as never),
    );
    expect(dup).toMatch(/^edit_view error \(component\)/);
  });

  it("errors when no anchor baseline exists", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options({ anchorBase: undefined }));
    const result = String(
      await tool.execute!({ base: "anchor", ops: [editOp()] } as never, {} as never),
    );
    expect(result).toMatch(/^edit_view error \(base\)/);
  });

  it("surfaces compile failures as correctable errors", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    const breaks = editOp({
      hunks: [{ startLine: 4, oldLines: ["}"], newLines: ["} syntax error <<<"] }],
    });
    const result = String(
      await tool.execute!({ base: "anchor", ops: [breaks] } as never, {} as never),
    );
    expect(result).toMatch(/^edit_view error \(compile\)/);
    expect(calls(writer)).toHaveLength(0);
  });
});

describe("createEditViewTool — pin base", () => {
  const pinSource = [
    "export default function DeadlineList(props) {",
    "  return <div>pinned variant</div>;",
    "}",
  ].join("\n");
  const pinBase: VerifiedPinBase = {
    payload: {
      formatVersion: "flowlet-genui/v1",
      root: "root",
      nodes: [
        {
          id: "root",
          component: "DeadlineList",
          source: "generated",
          props: { anchor: { $path: "/anchor" } },
        },
      ],
      data: {},
      components: { DeadlineList: pinSource },
    },
    sources: { DeadlineList: pinSource },
    baseHash: "agg",
    sourceHash: "captured-hash",
  };

  it("patches the pin's authored sources", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options({ pinBase }));
    const op = {
      component: "DeadlineList",
      baseHash: normalizeBaseline(pinSource, undefined).baseHash,
      hunks: [
        {
          startLine: 2,
          oldLines: ["  return <div>pinned variant</div>;"],
          newLines: ["  return <div>edited pin</div>;"],
        },
      ],
    };
    const result = await tool.execute!({ base: "pin", ops: [op] } as never, {} as never);
    expect(result).toBe("edited");
    const ui = calls(writer).find((w) => w.type === "data-ui")!;
    expect(ui.data.payload.components.DeadlineList).toContain("edited pin");
  });

  it("errors when base:'pin' is requested without a verified pin base", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    const result = String(
      await tool.execute!({ base: "pin", ops: [editOp()] } as never, {} as never),
    );
    expect(result).toMatch(/^edit_view error \(base\)/);
    expect(result).toContain("anchor");
  });
});

describe("schema", () => {
  it("rejects embedded newlines in hunk lines at the schema level", async () => {
    const writer = writerMock();
    const tool = createEditViewTool(writer, options());
    const parsed = (tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(
      {
        base: "anchor",
        ops: [editOp({ hunks: [{ startLine: 1, oldLines: [], newLines: ["a\nb"] }] })],
      },
    );
    expect(parsed.success).toBe(false);
  });
});
