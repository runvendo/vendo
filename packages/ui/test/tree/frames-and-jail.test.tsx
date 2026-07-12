// @vitest-environment jsdom
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type Tree, type ToolOutcome } from "@vendoai/core";
import { AppFrame, PinMount, TreeView } from "../../src/tree/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).__vendoHostExecuted;
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

describe("AppFrame", () => {
  it("renders the HTTP app in the contracted sandbox", () => {
    render(<AppFrame surface={{ kind: "http", url: "https://machine.invalid/app" }} />);
    const iframe = screen.getByTitle("Vendo app") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toBe("https://machine.invalid/app");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
  });

  it("renders a dimmed non-interactive resuming cover", () => {
    render(<AppFrame surface={{ kind: "resuming", cover: "data:image/png;base64,AA==" }} />);
    const frame = screen.getByLabelText("Vendo app resuming");
    expect(frame.getAttribute("aria-busy")).toBe("true");
    expect(frame.style.pointerEvents).toBe("none");
    expect(screen.getByRole("img", { name: "App loading cover" }).getAttribute("src"))
      .toBe("data:image/png;base64,AA==");
  });

  it("uses a skeleton when the resuming cover is absent", () => {
    render(<AppFrame surface={{ kind: "resuming" }} />);
    expect(document.querySelector('[data-primitive="Skeleton"]')).not.toBeNull();
  });

  it("dispatches tree surfaces through PayloadView", () => {
    render(
      <AppFrame
        surface={{
          kind: "tree",
          payload: {
            formatVersion: VENDO_TREE_FORMAT,
            root: "root",
            nodes: [{ id: "root", component: "Text", props: { text: "Instant app" } }],
          },
        }}
        onAction={ok}
      />,
    );
    expect(screen.getByText("Instant app")).toBeTruthy();
  });

  it("contains unknown surface kinds", () => {
    render(<AppFrame surface={{ kind: "spatial" } as never} />);
    expect(screen.getByRole("note", { name: /unsupported app surface/i }).textContent).toContain("spatial");
  });
});

describe("PinMount", () => {
  it("falls back to the original host component when pinned content throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Original: ComponentType = () => <p>Original host content</p>;
    const BrokenPin = () => {
      throw new Error("pin failed");
    };

    render(
      <PinMount slot="invoice-card" fallback={Original}>
        <BrokenPin />
      </PinMount>,
    );
    expect(screen.getByText("Original host content")).toBeTruthy();
  });
});

describe("generated component jail structure", () => {
  it("uses an opaque-origin iframe with CSP and never evaluates source in the host", () => {
    const evalSpy = vi.spyOn(globalThis, "eval");
    const source = [
      "globalThis.__vendoHostExecuted = true;",
      "export default function Unsafe() { return <p>inside only</p> }",
    ].join("\n");
    const generatedTree: Tree = {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [{ id: "root", component: "Unsafe", source: "generated" }],
      components: { Unsafe: source },
    };

    render(<TreeView tree={generatedTree} components={{}} onAction={ok} />);

    const iframe = screen.getByTitle("Generated component: Unsafe") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.srcdoc).toContain('http-equiv="Content-Security-Policy"');
    expect(iframe.srcdoc).toContain("default-src 'none'");
    expect(iframe.srcdoc).toContain("connect-src 'none'");
    expect((globalThis as Record<string, unknown>).__vendoHostExecuted).toBeUndefined();
    expect(document.querySelector("script")).toBeNull();
    expect(evalSpy).not.toHaveBeenCalled();
  });
});
