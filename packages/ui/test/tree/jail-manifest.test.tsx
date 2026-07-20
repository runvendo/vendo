// @vitest-environment jsdom
// W4b §2 — the HOST side of the ambient tools bridge: the runtime exposes
// ONLY the island's stamped manifest through the postMessage seam. The
// iframe's claims are never trusted — a call outside the manifest is blocked
// on the host side before it can reach the guarded pipe.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT_V2, type Json, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LOOKUP_SOURCE = `
  export default function Lookup() {
    return <p>lookup</p>;
  }`;

const treeWith = (extras: Record<string, unknown>): UIPayload => ({
  formatVersion: VENDO_TREE_FORMAT_V2,
  root: "root",
  nodes: [{ id: "root", component: "Lookup", source: "generated" }],
  components: { Lookup: LOOKUP_SOURCE },
  ...extras,
} as unknown as UIPayload);

const mountWithManifest = (extras: Record<string, unknown>, onAction: (req: {
  nodeId: string;
  action: string;
  payload?: Json;
}) => Promise<ToolOutcome>) => {
  render(<TreeView tree={treeWith(extras)} components={{}} onAction={onAction} />);
  const iframe = screen.getByTitle("Generated component: Lookup") as HTMLIFrameElement;
  const postToHost = (data: Record<string, unknown>) => {
    window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { vendo: true, ...data },
    }));
  };
  const postedToJail = vi.spyOn(iframe.contentWindow!, "postMessage");
  return { postToHost, postedToJail };
};

const flush = async () => new Promise((resolve) => setTimeout(resolve, 0));

describe("island tool manifest enforcement (host side)", () => {
  it("relays a manifest tool-call into the guarded action pipe and posts the outcome back", async () => {
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: { data: [1] } }));
    const { postToHost, postedToJail } = mountWithManifest(
      { componentTools: { Lookup: ["clients_search"] } },
      onAction,
    );
    postToHost({ kind: "tool-call", requestId: "t1", path: ["clients", "search"], args: { q: "a" } });
    await flush();
    expect(onAction).toHaveBeenCalledWith({ nodeId: "root", action: "clients_search", payload: { q: "a" } });
    expect(postedToJail).toHaveBeenCalledWith(expect.objectContaining({
      kind: "tool-result",
      requestId: "t1",
      outcome: { status: "ok", output: { data: [1] } },
    }), "*");
  });

  it("blocks a tool-call outside the stamped manifest without touching the pipe", async () => {
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const { postToHost, postedToJail } = mountWithManifest(
      { componentTools: { Lookup: ["clients_search"] } },
      onAction,
    );
    postToHost({ kind: "tool-call", requestId: "t2", path: ["delete_everything"], args: {} });
    await flush();
    expect(onAction).not.toHaveBeenCalled();
    expect(postedToJail).toHaveBeenCalledWith(expect.objectContaining({
      kind: "tool-result",
      requestId: "t2",
      outcome: expect.objectContaining({ status: "blocked" }),
    }), "*");
  });

  it("treats a stamped-era island with no manifest entry as zero tools", async () => {
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const { postToHost, postedToJail } = mountWithManifest(
      { componentTools: {} },
      onAction,
    );
    postToHost({ kind: "tool-call", requestId: "t3", path: ["clients", "search"], args: {} });
    await flush();
    expect(onAction).not.toHaveBeenCalled();
    expect(postedToJail).toHaveBeenCalledWith(expect.objectContaining({
      kind: "tool-result",
      requestId: "t3",
      outcome: expect.objectContaining({ status: "blocked" }),
    }), "*");
  });

  it("falls back to a source-derived manifest for unstamped payloads — still host-derived", async () => {
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const source = `
      export default function Lookup() {
        useEffect(() => { tools.clients.search({ q: "x" }); }, []);
        return <p>lookup</p>;
      }`;
    render(
      <TreeView
        tree={treeWith({ components: { Lookup: source } })}
        components={{}}
        onAction={onAction}
      />,
    );
    const iframe = screen.getByTitle("Generated component: Lookup") as HTMLIFrameElement;
    const postedToJail = vi.spyOn(iframe.contentWindow!, "postMessage");
    const postToHost = (data: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { vendo: true, ...data },
      }));
    };
    // The source literally names clients.search — allowed.
    postToHost({ kind: "tool-call", requestId: "t4", path: ["clients", "search"], args: {} });
    await flush();
    expect(onAction).toHaveBeenCalledWith({ nodeId: "root", action: "clients_search", payload: {} });
    // Anything else the iframe claims is blocked.
    postToHost({ kind: "tool-call", requestId: "t5", path: ["send_wire"], args: {} });
    await flush();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(postedToJail).toHaveBeenCalledWith(expect.objectContaining({
      kind: "tool-result",
      requestId: "t5",
      outcome: expect.objectContaining({ status: "blocked" }),
    }), "*");
  });

  it("rejects malformed tool-call paths and still answers (no hung island promise)", async () => {
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const { postToHost, postedToJail } = mountWithManifest(
      { componentTools: { Lookup: ["clients_search"] } },
      onAction,
    );
    postToHost({ kind: "tool-call", requestId: "t6", path: "clients_search", args: {} });
    postToHost({ kind: "tool-call", requestId: "t7", path: [{ evil: true }], args: {} });
    postToHost({ kind: "tool-call", requestId: "t8", path: ["not an identifier!"], args: {} });
    await flush();
    expect(onAction).not.toHaveBeenCalled();
    for (const requestId of ["t6", "t7", "t8"]) {
      expect(postedToJail).toHaveBeenCalledWith(expect.objectContaining({
        kind: "tool-result",
        requestId,
        outcome: expect.objectContaining({ status: "blocked" }),
      }), "*");
    }
  });

  it("gates the legacy action channel to prop-embedded actions and the manifest", async () => {
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    const tree = {
      formatVersion: VENDO_TREE_FORMAT_V2,
      root: "root",
      nodes: [{
        id: "root",
        component: "Lookup",
        source: "generated",
        props: { onPick: { $action: "pick_client", payload: { id: "c1" } } },
      }],
      components: { Lookup: LOOKUP_SOURCE },
      componentTools: { Lookup: ["clients_search"] },
    } as unknown as UIPayload;
    render(<TreeView tree={tree} components={{}} onAction={onAction} />);
    const iframe = screen.getByTitle("Generated component: Lookup") as HTMLIFrameElement;
    const postedToJail = vi.spyOn(iframe.contentWindow!, "postMessage");
    const postToHost = (data: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow,
        data: { vendo: true, ...data },
      }));
    };
    // Prop-embedded action: allowed (the host itself sent this name in).
    postToHost({ kind: "action", requestId: "a1", action: "pick_client", payload: { id: "c1" } });
    await flush();
    expect(onAction).toHaveBeenCalledWith({ nodeId: "root", action: "pick_client", payload: { id: "c1" } });
    // Manifest tool through the legacy channel: allowed.
    postToHost({ kind: "action", requestId: "a2", action: "clients_search", payload: { q: "a" } });
    await flush();
    expect(onAction).toHaveBeenCalledTimes(2);
    // A forged name outside both: blocked with an error result.
    postToHost({ kind: "action", requestId: "a3", action: "delete_everything" });
    await flush();
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(postedToJail).toHaveBeenCalledWith(expect.objectContaining({
      kind: "action-result",
      requestId: "a3",
      error: expect.stringContaining("not available"),
    }), "*");
  });
});
