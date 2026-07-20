// @vitest-environment jsdom
// W4b §1/§2 — the jail evaluation scope: React + the entire Kit + fmt are
// ambient (no imports), and the ambient `tools` API rides the postMessage
// bridge as `tool-call` requests the HOST validates.
//
// The runtime is imported ONCE for the whole file: runtime-entry registers a
// window message listener it never removes, so re-importing per test leaves
// stale instances answering renders with their own request counters.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class FakeResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

let postMessage: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  await import("../../src/tree/jail/runtime-entry.js");
});

beforeEach(() => {
  postMessage.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderSource = (source: string, props: Record<string, unknown> = {}) => {
  window.dispatchEvent(new MessageEvent("message", {
    source: window,
    data: { vendo: true, kind: "render", source, props },
  }));
};

const jailText = () => document.querySelector("#vendo-jail-root")?.textContent ?? "";

/** The single tool-call this test's render produced. */
const lastToolCall = () => postMessage.mock.calls
  .map(([message]) => message as Record<string, unknown>)
  .filter((message) => message.kind === "tool-call")
  .at(-1);

const replyToolResult = (requestId: unknown, outcome: Record<string, unknown>) => {
  window.dispatchEvent(new MessageEvent("message", {
    source: window,
    data: { vendo: true, kind: "tool-result", requestId, outcome },
  }));
};

describe("island ambient scope", () => {
  it("renders an import-free island using hooks, Kit components, and fmt", async () => {
    renderSource(`
      export default function Spending() {
        const [label] = useState("Total overdue");
        return (
          <Stack gap={8}>
            <Stat label={label} value={fmt.money(123456)}/>
            <Badge label="ambient"/>
          </Stack>
        );
      }`);
    await vi.waitFor(() => expect(jailText()).toContain("Total overdue"));
    expect(jailText()).toContain("$1,234.56");
    expect(postMessage).toHaveBeenCalledWith({ vendo: true, kind: "ready" }, "*");
  });

  it("still resolves habit imports of react and kit-ish specifiers (streaming partials)", async () => {
    renderSource(`
      import React, { useState } from "react";
      import { Stat } from "@vendoai/ui/kit";
      export default function Partial() {
        const [v] = useState(42);
        return <Stat label="Habit" value={String(v)}/>;
      }`);
    await vi.waitFor(() => expect(jailText()).toContain("Habit"));
  });

  it("lets island code shadow an ambient name with its own declaration", async () => {
    renderSource(`
      const Badge = ({ children }) => <em data-local-badge>{children}</em>;
      export default function Shadowed() {
        return <Badge>local wins</Badge>;
      }`);
    await vi.waitFor(() => expect(document.querySelector("[data-local-badge]")?.textContent)
      .toBe("local wins"));
  });

  it("keeps unknown modules unresolvable", async () => {
    renderSource('import fs from "node:fs";\nexport default () => <p>{String(fs)}</p>;');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      vendo: true,
      kind: "error",
      message: 'module "node:fs" is not available in the Vendo jail',
    }, "*"));
  });
});

describe("island ambient tools", () => {
  it("posts a tool-call for a literal chain and resolves with the ok output", async () => {
    renderSource(`
      export default function Lookup() {
        const [hits, setHits] = useState(null);
        useEffect(() => {
          (async () => setHits((await tools.clients.search({ q: "ada" })).data))();
        }, []);
        return <p data-hits>{hits === null ? "pending" : hits.join(",")}</p>;
      }`);
    await vi.waitFor(() => expect(lastToolCall()).toBeDefined());
    const call = lastToolCall();
    expect(call).toMatchObject({
      vendo: true,
      kind: "tool-call",
      path: ["clients", "search"],
      args: { q: "ada" },
    });
    replyToolResult(call?.requestId, { status: "ok", output: { data: ["Ada", "Grace"] } });
    await vi.waitFor(() => expect(document.querySelector("[data-hits]")?.textContent).toBe("Ada,Grace"));
  });

  it("surfaces a pending-approval outcome to the island as a value, not a hang", async () => {
    renderSource(`
      export default function Mutator() {
        const [state, setState] = useState("idle");
        useEffect(() => {
          (async () => {
            const outcome = await tools.send_reminders({ invoiceId: "inv_1" });
            setState(outcome && outcome.status === "pending-approval" ? "awaiting approval" : "done");
          })();
        }, []);
        return <p data-state>{state}</p>;
      }`);
    await vi.waitFor(() => expect(lastToolCall()).toBeDefined());
    const call = lastToolCall();
    expect(call?.path).toEqual(["send_reminders"]);
    replyToolResult(call?.requestId, { status: "pending-approval", approvalId: "appr_1" });
    await vi.waitFor(() => expect(document.querySelector("[data-state]")?.textContent)
      .toBe("awaiting approval"));
  });

  it("rejects the island promise on a blocked outcome", async () => {
    renderSource(`
      export default function Failing() {
        const [message, setMessage] = useState("pending");
        useEffect(() => {
          tools.blocked_tool({}).catch((error) => setMessage(error.message));
        }, []);
        return <p data-error>{message}</p>;
      }`);
    await vi.waitFor(() => expect(lastToolCall()).toBeDefined());
    const call = lastToolCall();
    replyToolResult(call?.requestId, {
      status: "blocked",
      reason: 'tool "blocked_tool" is not in this island\'s tool manifest',
    });
    await vi.waitFor(() => expect(document.querySelector("[data-error]")?.textContent)
      .toContain("not in this island's tool manifest"));
  });
});
