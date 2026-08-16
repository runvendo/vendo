import { cleanup, render, screen } from "@testing-library/react";
import type { VendoNavigation, VendoRouteMap } from "@vendoai/apps/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendoProvider } from "../../src/context.js";
import { Link } from "../../src/kit/link.js";

afterEach(cleanup);

const routes: VendoRouteMap = {
  home: { path: "/", description: "The dashboard." },
  account: { path: "/accounts/:id", description: "One account by id." },
};

const mount = (ui: React.ReactNode, onNavigate?: (nav: VendoNavigation) => void) =>
  render(<VendoProvider routes={routes} onNavigate={onNavigate}>{ui}</VendoProvider>);

const link = () => screen.getByText("Go");

describe("Link — the press the host performs", () => {
  it("hands onNavigate the resolved route, and leaves the URL to the host", () => {
    const onNavigate = vi.fn();
    mount(<Link to="account" params={{ id: "acc_1" }} label="Go" />, onNavigate);
    const anchor = link();
    expect(anchor.tagName).toBe("A");
    // No href: only the host can spell the URL (its router owns the basePath).
    expect(anchor.getAttribute("href")).toBeNull();
    expect(anchor.getAttribute("role")).toBe("link");
    expect(anchor.getAttribute("tabindex")).toBe("0");

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onNavigate).toHaveBeenCalledWith({
      to: "account",
      path: "/accounts/acc_1",
      params: { id: "acc_1" },
    });
  });

  it("renders children when no label is given", () => {
    const onNavigate = vi.fn();
    mount(<Link to="home"><span>Go</span></Link>, onNavigate);
    link().closest("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onNavigate).toHaveBeenCalledWith({ to: "home", path: "/" });
  });
});

describe("Link — an unknown route is refused, not passed through", () => {
  it("renders plain text with NO href for a name the host never registered", () => {
    const onNavigate = vi.fn();
    mount(<Link to="admin" label="Go" />, onNavigate);
    expect(link().tagName).toBe("SPAN");
    expect(screen.queryByRole("link")).toBeNull();
    link().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("never turns a model-written URL into a link at all", () => {
    mount(<Link to="javascript:alert(1)" label="Go" />, vi.fn());
    mount(<Link to="https://evil.example" label="Go" />, vi.fn());
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it("refuses a route whose :param the link left unfilled", () => {
    mount(<Link to="account" label="Go" />, vi.fn());
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("Link — a literal `:` in a path segment is not a parameter", () => {
  // A colon is legal in a path segment. Read as a parameter, `/reports/2026:Q3`
  // needed a `Q3` nobody could supply, so a perfectly good route rendered as
  // inert text — the silent breakage this brick exists to prevent.
  const literal: VendoRouteMap = {
    quarter: { path: "/reports/2026:Q3", description: "The Q3 report." },
    section: { path: "/reports/2026:Q3/:sectionId", description: "One section of it." },
  };
  const withLiteral = (ui: React.ReactNode, onNavigate: (nav: VendoNavigation) => void) =>
    render(<VendoProvider routes={literal} onNavigate={onNavigate}>{ui}</VendoProvider>);

  it("renders it as a real link and navigates to the path verbatim", () => {
    const onNavigate = vi.fn();
    withLiteral(<Link to="quarter" label="Go" />, onNavigate);
    const anchor = link();
    expect(anchor.tagName).toBe("A");
    expect(anchor.getAttribute("href")).toBeNull();
    expect(anchor.getAttribute("data-path")).toBe("/reports/2026:Q3");

    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onNavigate).toHaveBeenCalledWith({ to: "quarter", path: "/reports/2026:Q3" });
  });

  it("still substitutes the real :param beside it, and still refuses it unfilled", () => {
    const onNavigate = vi.fn();
    withLiteral(<Link to="section" params={{ sectionId: "s_1" }} label="Go" />, onNavigate);
    link().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onNavigate).toHaveBeenCalledWith({
      to: "section",
      path: "/reports/2026:Q3/s_1",
      params: { sectionId: "s_1" },
    });

    cleanup();
    withLiteral(<Link to="section" label="Go" />, vi.fn());
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("Link — provider-optional", () => {
  it("renders standalone, where there is no registry and nowhere to go", () => {
    render(<Link to="home" label="Go" />);
    expect(link().tagName).toBe("SPAN");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("stays inert inside a provider that registered routes but no onNavigate", () => {
    mount(<Link to="home" label="Go" />);
    expect(link().tagName).toBe("SPAN");
  });
});
