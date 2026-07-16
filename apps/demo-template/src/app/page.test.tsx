import { describe, expect, it } from "vitest"
import HomePage from "./page"

describe("HomePage", () => {
  it("renders the placeholder copy", () => {
    const element = HomePage()
    const text = JSON.stringify(element)
    expect(text).toMatch(/PLACEHOLDER/i)
  })
})
