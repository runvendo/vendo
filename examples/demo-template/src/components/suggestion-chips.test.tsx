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

// jsdom has no navigator.clipboard; define it configurable so afterEach can
// remove the stub instead of leaking it across tests.
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, "clipboard")
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
    // The chip is linked to the revealed panel (aria-controls -> panel id).
    const panelId = chip.getAttribute("aria-controls")
    expect(panelId).toBeTruthy()
    const panel = document.getElementById(panelId!)
    expect(panel?.textContent).toContain("Take an action with approval")
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeTruthy()
    fireEvent.click(chip)
    expect(chip.getAttribute("aria-expanded")).toBe("false")
    expect(chip.getAttribute("aria-controls")).toBeNull()
    expect(screen.queryByText("Take an action with approval")).toBeNull()
  })

  it("copies the prompt to the clipboard and confirms", async () => {
    const writeText = vi.fn(async () => undefined)
    stubClipboard(writeText)
    render(<SuggestionChips beats={beats} />)
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }))
    expect(writeText).toHaveBeenCalledWith("Show me a dashboard of my data")
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy()
  })

  it("shows a visible failure state when the clipboard write is refused", async () => {
    stubClipboard(vi.fn(async () => Promise.reject(new Error("denied"))))
    render(<SuggestionChips beats={beats} />)
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }))
    expect(await screen.findByRole("button", { name: "Copy failed — select the text" })).toBeTruthy()
    // The prompt stays revealed for manual selection.
    expect(screen.getByText("Show me a dashboard of my data")).toBeTruthy()
  })
})
