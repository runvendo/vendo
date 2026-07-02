import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { UINode } from "@flowlet/core";
import type { Flowlet } from "../seams/store";
import { FlowGallery } from "./FlowGallery";
import { FlowletToast } from "./FlowletToast";

const node: UINode = { id: "n", kind: "component", source: "prewired", name: "Card", props: {} };
const flow = (id: string, name: string, extra: Partial<Flowlet> = {}): Flowlet => ({
  id, name, node, updatedAt: 1, ...extra,
});

describe("FlowGallery", () => {
  it("groups pinned before recent and opens on click", () => {
    const onOpen = vi.fn();
    render(
      <FlowGallery
        flows={[flow("a", "Recent view"), flow("b", "Pinned view", { pinned: true })]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
    fireEvent.click(screen.getByText("Pinned view"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("renames inline via Enter and cancels via Escape", () => {
    const onRename = vi.fn();
    render(<FlowGallery flows={[flow("a", "Old")]} onOpen={vi.fn()} onRename={onRename} />);
    fireEvent.click(screen.getByLabelText("Rename"));
    const input = screen.getByLabelText("Rename view") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "New name");

    fireEvent.click(screen.getByLabelText("Rename"));
    const again = screen.getByLabelText("Rename view") as HTMLInputElement;
    fireEvent.change(again, { target: { value: "Discarded" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("toggles pin and requests delete", () => {
    const onPin = vi.fn();
    const onDelete = vi.fn();
    render(<FlowGallery flows={[flow("a", "View")]} onOpen={vi.fn()} onPin={onPin} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText("Pin"));
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), true);
    fireEvent.click(screen.getByLabelText("Delete"));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });
});

describe("FlowletToast", () => {
  it("fires the action, and auto-dismisses after the duration", () => {
    vi.useFakeTimers();
    try {
      const onAction = vi.fn();
      const onDismiss = vi.fn();
      render(<FlowletToast message="Deleted" onAction={onAction} onDismiss={onDismiss} durationMs={1000} />);
      fireEvent.click(screen.getByText("Undo"));
      expect(onAction).toHaveBeenCalledOnce();
      act(() => vi.advanceTimersByTime(1100));
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
