import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef, useState } from "react";
import { useFocusTrap } from "./use-focus-trap";

// Harness: has a trigger button outside the trap, a panel with two buttons inside, and a close button.
function TrapHarness({ startActive = false }: { startActive?: boolean }) {
  const [active, setActive] = useState(startActive);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(active, containerRef);
  return (
    <div>
      <button data-testid="trigger" onClick={() => setActive(true)}>
        Open
      </button>
      <div ref={containerRef} data-testid="panel" tabIndex={-1}>
        <button data-testid="first">First</button>
        <button data-testid="last">Last</button>
      </div>
      <button data-testid="close-btn" onClick={() => setActive(false)}>
        Close
      </button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("moves focus into the container when activated", () => {
    render(<TrapHarness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    fireEvent.click(trigger); // sets active=true via onClick
    const panel = screen.getByTestId("panel");
    const focused = document.activeElement;
    // focus should be on the panel itself or a descendant (first focusable button)
    expect(panel === focused || panel.contains(focused)).toBe(true);
  });

  it("restores focus to the previously focused element when deactivated", () => {
    render(<TrapHarness />);
    const trigger = screen.getByTestId("trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger); // activate: hook captures trigger, moves focus into panel
    // focus is now inside panel
    fireEvent.click(screen.getByTestId("close-btn")); // deactivate: hook restores focus
    expect(document.activeElement).toBe(trigger);
  });

  it("wraps Tab forward from last focusable to first", () => {
    render(<TrapHarness startActive />);
    screen.getByTestId("last").focus();
    expect(document.activeElement).toBe(screen.getByTestId("last"));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: false });
    expect(document.activeElement).toBe(screen.getByTestId("first"));
  });

  it("wraps Shift+Tab backward from first focusable to last", () => {
    render(<TrapHarness startActive />);
    screen.getByTestId("first").focus();
    expect(document.activeElement).toBe(screen.getByTestId("first"));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("last"));
  });
});
