// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.head.querySelectorAll("style[data-vendo-host-style]").forEach((style) => style.remove());
  document.body.replaceChildren();
});

describe("generated component jail furnishing runtime", () => {
  it("renders the fork through captured local modules and applies CSS in the inner document", async () => {
    class FakeResizeObserver implements ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    await import("../../src/tree/jail/runtime-entry.js");
    postMessage.mockClear();

    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: {
        vendo: true,
        kind: "render",
        source: `
          import { CardBody } from "./CardBody";
          export default function Fork({ customer }) { return <CardBody customer={customer} />; }
        `,
        props: { customer: "Ada" },
        sourceImports: { "./CardBody": "src/CardBody.tsx" },
        subSources: {
          "src/CardBody.tsx": {
            source: `
              import { Badge } from "./Badge";
              export function CardBody({ customer }) {
                return <article className="captured-card"><h2>Furnished for {customer}</h2><Badge /></article>;
              }
            `,
            imports: { "./Badge": "src/Badge.tsx" },
          },
          "src/Badge.tsx": {
            source: "export function Badge() { return <span>captured child</span>; }",
            imports: {},
          },
        },
        styles: [{ path: "src/app/globals.css", css: ".captured-card { color: rgb(12, 34, 56); }" }],
      },
    }));

    await vi.waitFor(() => expect(document.querySelector("#vendo-jail-root")?.textContent)
      .toContain("Furnished for Ada"));
    expect(document.querySelector("#vendo-jail-root")?.textContent).toContain("captured child");
    const style = document.head.querySelector<HTMLStyleElement>('style[data-vendo-host-style="src/app/globals.css"]');
    expect(style?.textContent).toBe(".captured-card { color: rgb(12, 34, 56); }");
    expect(postMessage).toHaveBeenCalledWith({ vendo: true, kind: "ready" }, "*");
  }, 15_000);

  it("strips @import statements from captured stylesheets so the CSP never refuses a fetch", async () => {
    class FakeResizeObserver implements ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error");
    await import("../../src/tree/jail/runtime-entry.js");
    postMessage.mockClear();

    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: {
        vendo: true,
        kind: "render",
        source: "export default function Fork() { return <p className=\"captured-card\">forked</p>; }",
        props: {},
        styles: [{
          path: "src/app/globals.css",
          // The quoted-semicolon URL and the string-literal decoy pin the
          // scanner behavior: a ; inside a quoted URL must not end the
          // statement, and an @import inside a string is content to keep.
          css: '@import "tailwindcss";\n@import url("https://fonts.example.test/a;b.css");\n@import url("./theme.css") layer(base);\n.captured-card { color: rgb(12, 34, 56); }\n.decoy::after { content: "@import fake;"; }',
        }],
      },
    }));

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ vendo: true, kind: "ready" }, "*"));
    const style = document.head.querySelector<HTMLStyleElement>('style[data-vendo-host-style="src/app/globals.css"]');
    // No @import statement may reach the jailed document: the CSP has no
    // style network source, so an injected @import is a guaranteed-refused
    // fetch (eval F5). The rules around the statements survive intact —
    // including one AFTER the quoted-semicolon URL — and the string-literal
    // decoy is content, not a statement.
    expect(style?.textContent).not.toMatch(/@import\s+(?:url|")/u);
    expect(style?.textContent).not.toContain("b.css");
    expect(style?.textContent).toContain(".captured-card { color: rgb(12, 34, 56); }");
    expect(style?.textContent).toContain('content: "@import fake;"');
    expect(consoleError).not.toHaveBeenCalled();
  }, 15_000);

  it("still throws for an import outside the captured map and blessed kit", async () => {
    class FakeResizeObserver implements ResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    await import("../../src/tree/jail/runtime-entry.js");
    postMessage.mockClear();

    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: {
        vendo: true,
        kind: "render",
        source: `
          import fs from "node:fs";
          export default function Escape() { return <p>{String(fs)}</p>; }
        `,
        props: {},
        sourceImports: {},
        subSources: {},
      },
    }));

    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      vendo: true,
      kind: "error",
      message: 'module "node:fs" is not available in the Vendo jail',
    }, "*"));
  }, 15_000);
});
