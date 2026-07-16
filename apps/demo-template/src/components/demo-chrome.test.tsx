// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DemoChrome, type DemoChromeRefusal } from "./demo-chrome"

const turnsRefusal: DemoChromeRefusal = {
  limit: "turns",
  message: "This demo has reached its limit — book a call to see the real thing.",
  ctaUrl: "https://cal.com/yousefhelal",
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("DemoChrome badge + CTA", () => {
  it("renders the prospect badge and the CTA link", () => {
    render(
      <DemoChrome prospect="Acme Widgets" ctaUrl="https://cal.com/yousefhelal">
        <p>surface</p>
      </DemoChrome>,
    )
    expect(screen.getByText("Acme Widgets demo").parentElement?.textContent).toContain(
      "built with Vendo · sample data",
    )
    const cta = screen.getByRole("link", { name: "Get this in your product" })
    expect(cta.getAttribute("href")).toBe("https://cal.com/yousefhelal")
    expect(screen.getByText("surface")).toBeTruthy()
  })
})

describe("DemoChrome limit card", () => {
  it("shows the limit card instead of the surface when the server says refused", () => {
    render(
      <DemoChrome prospect="Acme" ctaUrl="https://cal.com/x" initialRefusal={turnsRefusal}>
        <p>surface</p>
      </DemoChrome>,
    )
    expect(screen.getByRole("heading", { name: "This demo has reached its limit" })).toBeTruthy()
    expect(screen.getByText(turnsRefusal.message)).toBeTruthy()
    const book = screen.getByRole("link", { name: "Book a call" })
    expect(book.getAttribute("href")).toBe(turnsRefusal.ctaUrl)
    expect(screen.queryByText("surface")).toBeNull()
  })

  it("titles the card for expiry", () => {
    render(
      <DemoChrome
        prospect="Acme"
        ctaUrl="https://cal.com/x"
        initialRefusal={{ ...turnsRefusal, limit: "expired", message: "This demo has expired." }}
      >
        <p>surface</p>
      </DemoChrome>,
    )
    expect(screen.getByRole("heading", { name: "This demo has expired" })).toBeTruthy()
  })

  it("shows the limit card above the still-mounted surface when a status poll reports a refusal", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => Response.json({ vendoDemo: turnsRefusal }))
    vi.stubGlobal("fetch", fetchMock)
    render(
      <DemoChrome prospect="Acme" ctaUrl="https://cal.com/x">
        <p>surface</p>
      </DemoChrome>,
    )
    expect(screen.getByText("surface")).toBeTruthy()
    await act(() => vi.advanceTimersByTimeAsync(9000))
    expect(fetchMock).toHaveBeenCalledWith("/demo-status", { cache: "no-store" })
    expect(screen.getByRole("heading", { name: "This demo has reached its limit" })).toBeTruthy()
    // Mid-session the final allowed turn may still be streaming — keep it readable.
    expect(screen.getByText("surface")).toBeTruthy()
  })

  it("stays live while the status poll reports null", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ vendoDemo: null })))
    render(
      <DemoChrome prospect="Acme" ctaUrl="https://cal.com/x">
        <p>surface</p>
      </DemoChrome>,
    )
    await act(() => vi.advanceTimersByTimeAsync(9000))
    expect(screen.getByText("surface")).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "This demo has reached its limit" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "This demo has expired" })).toBeNull()
  })

  it("stops polling once refused — the terminal state never un-trips", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => Response.json({ vendoDemo: turnsRefusal }))
    vi.stubGlobal("fetch", fetchMock)
    render(
      <DemoChrome prospect="Acme" ctaUrl="https://cal.com/x">
        <p>surface</p>
      </DemoChrome>,
    )
    await act(() => vi.advanceTimersByTimeAsync(9000))
    expect(screen.getByRole("heading", { name: "This demo has reached its limit" })).toBeTruthy()
    const callsAtRefusal = fetchMock.mock.calls.length
    await act(() => vi.advanceTimersByTimeAsync(16000))
    expect(fetchMock.mock.calls.length).toBe(callsAtRefusal)
  })
})
