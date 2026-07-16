// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DemoBeat } from "@/lib/demo-config"
import { SuggestionChips } from "./suggestion-chips"

const beats: DemoBeat[] = [
  { key: "generate-ui", prompt: "Show me a dashboard of my data", chip: "Dashboard" },
  { key: "take-action", prompt: "Take an action with approval", chip: "Take an action" },
  { key: "save-app", prompt: "Save this as a reusable app", chip: "Save as app" },
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("SuggestionChips", () => {
  it("renders one chip per beat, labeled with beats[].chip", () => {
    render(<SuggestionChips beats={beats} />)
    for (const beat of beats) {
      expect(screen.getByRole("button", { name: beat.chip })).toBeTruthy()
    }
    // Prompts stay hidden until a chip is opened.
    expect(screen.queryByText(beats[0].prompt)).toBeNull()
  })

  it("renders nothing for an empty beats list", () => {
    const { container } = render(<SuggestionChips beats={[]} />)
    expect(container.innerHTML).toBe("")
  })

  it("reveals the beat's prompt with a copy affordance on click, and toggles closed", () => {
    render(<SuggestionChips beats={beats} />)
    const chip = screen.getByRole("button", { name: "Take an action" })
    fireEvent.click(chip)
    expect(chip.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Take an action with approval")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeTruthy()
    fireEvent.click(chip)
    expect(chip.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("Take an action with approval")).toBeNull()
  })

  it("copies the prompt to the clipboard and confirms", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<SuggestionChips beats={beats} />)
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }))
    expect(writeText).toHaveBeenCalledWith("Show me a dashboard of my data")
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy()
  })
})
