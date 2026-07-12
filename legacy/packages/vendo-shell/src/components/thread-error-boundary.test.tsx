import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadErrorBoundary } from "./ThreadErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("kaboom");
}

afterEach(() => vi.restoreAllMocks());

describe("ThreadErrorBoundary", () => {
  it("catches a render-time throw and shows the inline fallback instead of crashing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ThreadErrorBoundary resetKey={0}>
        <Boom />
      </ThreadErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/couldn.t be displayed/i);
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ThreadErrorBoundary resetKey={0}>
        <div data-testid="ok">all good</div>
      </ThreadErrorBoundary>,
    );
    expect(screen.getByTestId("ok")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the error and re-renders children when resetKey changes (next turn)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ThreadErrorBoundary resetKey={0}>
        <Boom />
      </ThreadErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    // A new turn bumps resetKey; the boundary clears and renders the healthy child.
    rerender(
      <ThreadErrorBoundary resetKey={1}>
        <div data-testid="recovered">recovered</div>
      </ThreadErrorBoundary>,
    );
    expect(screen.getByTestId("recovered")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
