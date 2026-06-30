import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "./Composer";
import { useVoiceInput } from "../use-voice-input";

describe("useVoiceInput", () => {
  it("reports unsupported by default", () => {
    const v = useVoiceInput();
    expect(v.supported).toBe(false);
    expect(v.state).toBe("disabled");
  });
});

describe("Composer", () => {
  it("sends trimmed text on Enter and clears the input", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByPlaceholderText("ask anything") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "show my spending" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("show my spending");
    expect(input.value).toBe("");
  });

  it("does not send empty text", () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const input = screen.getByPlaceholderText("ask anything");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a stop button while streaming and calls onStop", () => {
    const onStop = vi.fn();
    render(<Composer onSend={() => {}} status="streaming" onStop={onStop} />);
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
