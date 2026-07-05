import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("sends trimmed text on Enter and clears the input", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByPlaceholderText("Ask anything") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "show my spending" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // onSend now carries optional attachment parts (undefined when none attached).
    expect(onSend).toHaveBeenCalledWith("show my spending", undefined);
    expect(input.value).toBe("");
  });

  it("does not send empty text", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByPlaceholderText("Ask anything");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a stop button while streaming and calls onStop", () => {
    const onStop = vi.fn();
    render(<Composer onSend={() => {}} status="streaming" onStop={onStop} />);
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("shows the mic only when a voice handler is wired", () => {
    const onVoice = vi.fn();
    const { rerender } = render(<Composer onSend={() => {}} />);
    expect(screen.queryByLabelText("Start voice session")).toBeNull();
    rerender(<Composer onSend={() => {}} onVoice={onVoice} />);
    fireEvent.click(screen.getByLabelText("Start voice session"));
    expect(onVoice).toHaveBeenCalledOnce();
  });
});
