import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StreamingText } from "./StreamingText";

describe("StreamingText", () => {
  it("keeps dollar amounts literal — two $ figures in one paragraph are not math", () => {
    const { container } = render(
      <StreamingText text="Your Equinox membership is $285 per month, and rent is $2,850 on the 1st." />,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$285 per month");
    expect(container.textContent).toContain("$2,850");
  });

  it("still renders explicit display math via $$", () => {
    const { container } = render(<StreamingText text={"Total: $$x = 2 + 2$$"} />);
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("renders GFM tables", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |";
    const { container } = render(<StreamingText text={md} />);
    expect(container.querySelector("table")).not.toBeNull();
  });
});
