/**
 * Likeness hygiene: Cadence is a publicly served demo whose staff are invented
 * people (Daniel Hartwell, Maya Alvarez…). A photograph of a real person must
 * never stand in for one of them, so the persona chip renders generated
 * initials and the app ships no photographic avatar to serve.
 */
// @vitest-environment jsdom
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Topbar } from "./topbar"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

const PUBLIC_DIR = join(__dirname, "../../../public")

describe("Cadence persona chip", () => {
  it("renders generated initials, never a bitmap portrait — even if a caller supplies one", () => {
    // Extra property, not a supported prop: proves the image path is gone
    // rather than merely unused by today's callers.
    const staff = { display: "Daniel Hartwell", avatarUrl: "/avatars/daniel.jpg" }
    const { container } = render(<Topbar user={staff} />)

    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("DH")
  })

  it("serves no photographic asset from public/", () => {
    const photos = readdirSync(PUBLIC_DIR, { recursive: true, encoding: "utf8" }).filter(entry =>
      /\.(jpe?g|heic|tiff?)$/i.test(entry),
    )
    expect(photos).toEqual([])
  })
})
