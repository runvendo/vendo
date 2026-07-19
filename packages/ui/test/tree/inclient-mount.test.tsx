// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT_V2, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView, evaluateApprovedComponent } from "../../src/tree/index.js";
import type { InClientVenue } from "../../src/tree/renderer.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const WIDGET_SOURCE = `
export default function Widget({ label, onRun }) {
  return <button type="button" onClick={() => onRun()}>In-client {label}</button>;
}
`;

const GRANTED: InClientVenue = {
  granted: true,
  versionHash: "sha256:approved",
  approvedBy: "host-console",
  at: "2026-07-15T09:00:00.000Z",
};

function venueTree(inClient?: InClientVenue, source = WIDGET_SOURCE): UIPayload {
  const tree: UIPayload & { inClient?: InClientVenue } = {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["gen"] },
      {
        id: "gen",
        component: "Widget",
        source: "generated",
        props: { label: "ready", onRun: { $action: "fn:run", payload: { id: 7 } } },
      },
    ],
    components: { Widget: source },
  };
  if (inClient !== undefined) tree.inClient = inClient;
  return tree;
}

describe("in-client venue enforcement (06-apps §9)", () => {
  it("keeps generated components in the iframe jail by default (no inClient field)", () => {
    render(<TreeView tree={venueTree()} components={{}} onAction={ok} />);
    expect(document.querySelector('iframe[title="Generated component: Widget"]')).not.toBeNull();
    expect(document.querySelector("[data-vendo-inclient-mount]")).toBeNull();
    expect(screen.queryByRole("note", { name: /in-client/i })).toBeNull();
  });

  it("mounts the approved component in the host page when the verdict granted the venue", async () => {
    const onAction = vi.fn(async (): Promise<ToolOutcome> => ({ status: "ok", output: null }));
    render(<TreeView tree={venueTree(GRANTED)} components={{}} onAction={onAction} />);

    // Host-page DOM, not an iframe.
    const button = await screen.findByRole("button", { name: "In-client ready" });
    expect(document.querySelector('iframe[title="Generated component: Widget"]')).toBeNull();
    expect(document.querySelector('[data-vendo-inclient-mount="Widget"]')).not.toBeNull();

    // $action props bind to REAL functions dispatching through onAction.
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith({ nodeId: "gen", action: "fn:run", payload: { id: 7 } });
  });

  it("renders captured sampleProps for a prop-less approved node — venue parity with the jail (ENG-288 M6)", async () => {
    // A forked pin commonly has no live tree props; the jail rehearses it with
    // the baseline's sampleProps. Promotion is hash-pinned, so the approved
    // mount must see the same props instead of crashing on undefined.
    const tree = venueTree(GRANTED, "export default function Widget({ label }) { return <p>Sampled {label}</p>; }") as UIPayload & {
      furnishings?: Record<string, { sampleProps?: Record<string, unknown> }>;
    };
    delete (tree.nodes[1] as { props?: unknown }).props;
    tree.furnishings = { Widget: { sampleProps: { label: "rehearsal" } } };
    render(<TreeView tree={tree} components={{}} onAction={ok} />);

    expect((await screen.findByText("Sampled rehearsal")).textContent).toBe("Sampled rehearsal");
    expect(document.querySelector('[data-vendo-inclient-mount="Widget"]')).not.toBeNull();
    expect(screen.queryByRole("note", { name: "In-client mount failed" })).toBeNull();
  });

  it("ignores a forged granted flag of the wrong shape", () => {
    render(
      <TreeView
        tree={venueTree({ granted: "true" } as unknown as InClientVenue)}
        components={{}}
        onAction={ok}
      />,
    );
    expect(document.querySelector('iframe[title="Generated component: Widget"]')).not.toBeNull();
    expect(document.querySelector("[data-vendo-inclient-mount]")).toBeNull();
  });

  it("drops back to the jail loudly when the approval no longer matches the version", () => {
    render(
      <TreeView
        tree={venueTree({ granted: false, versionHash: "sha256:new", reason: "version-changed" })}
        components={{}}
        onAction={ok}
      />,
    );
    expect(document.querySelector('iframe[title="Generated component: Widget"]')).not.toBeNull();
    expect(document.querySelector("[data-vendo-inclient-mount]")).toBeNull();
    const notice = screen.getByRole("note", { name: "In-client approval invalidated" });
    expect(notice.textContent).toContain("re-approved");
  });

  it("drops an erroring approved component back to the sandboxed iframe, loudly", () => {
    render(
      <TreeView
        tree={venueTree(GRANTED, "export default function Widget() { throw new Error('kaboom'); }")}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.getByRole("note", { name: "In-client mount failed" }).textContent).toContain("kaboom");
    expect(document.querySelector('iframe[title="Generated component: Widget"]')).not.toBeNull();
  });

  it("drops a non-compiling approved component back to the sandboxed iframe", () => {
    render(
      <TreeView
        tree={venueTree(GRANTED, "export default not even syntax {{{")}
        components={{}}
        onAction={ok}
      />,
    );
    expect(screen.getByRole("note", { name: "In-client mount failed" })).toBeTruthy();
    expect(document.querySelector('iframe[title="Generated component: Widget"]')).not.toBeNull();
  });
});

describe("evaluateApprovedComponent", () => {
  it("resolves captured sub-sources through their import tables", () => {
    const Component = evaluateApprovedComponent(
      `import { Badge } from "./Badge";
export default function Fork() { return <div>fork <Badge /></div>; }`,
      {
        sourceImports: { "./Badge": "src/Badge.tsx" },
        subSources: {
          "src/Badge.tsx": { source: "export function Badge() { return <b>badge</b>; }", imports: {} },
        },
      },
    );
    render(<Component />);
    expect(screen.getByText("badge")).toBeTruthy();
  });

  it("refuses modules outside React and the captured import table", () => {
    expect(() => evaluateApprovedComponent(
      'import fs from "node:fs";\nexport default function Fork() { return <b>{fs.readFileSync("/etc/passwd", "utf8")}</b>; }',
    )).toThrow(/not available/);
  });

  it("requires a React default export", () => {
    expect(() => evaluateApprovedComponent("export const nope = 1;")).toThrow(/default export/);
  });
});
