import { describe, expect, it } from "vitest"
import HomePage from "./page"

// DELETE OR REWRITE when creating a demo from this template — this smoke test
// pins the placeholder page only and gets rewritten alongside page.tsx by the
// demo creator. Once the real page uses hooks, switch to
// @testing-library/react's render()/screen instead of inspecting the raw
// element tree.
describe("template-sample HomePage (DELETE OR REWRITE on clone)", () => {
  it("renders the placeholder copy", () => {
    const element = HomePage()
    const text = JSON.stringify(element)
    expect(text).toContain("PLACEHOLDER — the demo creator")
  })
})
