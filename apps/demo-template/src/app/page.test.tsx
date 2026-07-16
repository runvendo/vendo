import { describe, expect, it } from "vitest"
import HomePage from "./page"

// This is a smoke test for the placeholder page only — it gets rewritten
// alongside page.tsx by the demo creator. Once the real page uses hooks,
// switch to @testing-library/react's render()/screen instead of inspecting
// the raw element tree.
describe("HomePage", () => {
  it("renders the placeholder copy", () => {
    const element = HomePage()
    const text = JSON.stringify(element)
    expect(text).toContain("PLACEHOLDER — the demo creator")
  })
})
