// @vitest-environment jsdom
// Keystone graduates B7 — <Remixable>: the seed that blooms into the ✦ Remix
// pill, and the surface it attaches to the next message.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { Remixable, VendoOverlay, VendoThread, openVendoConversation } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { createWireServer } from "../wire-server.js";

const RentRoll = () => <table><tbody><tr><td>Unit 4B</td></tr></tbody></table>;

/** The text of the last turn the wire received. */
function sentText(wire: Awaited<ReturnType<typeof createWireServer>>): string {
  const post = wire.requests.filter(r => r.method === "POST" && r.path === "/threads").at(-1);
  const message = (post?.body as { message?: { parts?: { type: string; text?: string }[] } } | undefined)?.message;
  return (message?.parts ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("");
}

describe("Remixable", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await wire.close();
  });

  const dialog = () => screen.getByRole("dialog", { name: "Vendo assistant" });
  const wrapper = () => document.querySelector<HTMLElement>('[data-vendo-remixable="Rent Roll"]')!;
  const pill = () => screen.getByRole("button", { name: "Remix Rent Roll with Vendo" });
  const revealed = () => wrapper().hasAttribute("data-vendo-revealed");

  function mount(node = <Remixable name="Rent Roll"><RentRoll /></Remixable>) {
    return render(
      <VendoProvider client={client}>
        {node}
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
  }

  it("renders the host's own markup untouched, with the seed and the pill over it", () => {
    mount();
    expect(screen.getByText("Unit 4B")).toBeTruthy();
    expect(wrapper().querySelector(".fl-remix-seed")?.textContent).toBe("✦");
    expect(pill()).toBeTruthy();
    // At rest the pill is inert — nothing invisible to misclick.
    expect(revealed()).toBe(false);
  });

  it("blooms on hover and holds through the grace period on the way out", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.pointerEnter(wrapper());
    expect(revealed()).toBe(true);

    // Leaving starts the grace, it does NOT hide immediately: this is the
    // cursor's travel to the pill, and a CSS-only reveal would kill it here.
    fireEvent.pointerLeave(wrapper());
    act(() => void vi.advanceTimersByTime(150));
    expect(revealed()).toBe(true);
    act(() => void vi.advanceTimersByTime(100));
    expect(revealed()).toBe(false);
  });

  it("cancels a pending release when the pointer comes back", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.pointerEnter(wrapper());
    fireEvent.pointerLeave(wrapper());
    act(() => void vi.advanceTimersByTime(150));
    fireEvent.pointerEnter(wrapper());
    act(() => void vi.advanceTimersByTime(400));
    expect(revealed()).toBe(true);
  });

  it("reveals on focus, so the pill is keyboard-reachable", () => {
    mount();
    act(() => pill().focus());
    expect(revealed()).toBe(true);
    expect(document.activeElement).toBe(pill());
  });

  it("opens the conversation EMPTY with the surface attached", async () => {
    mount();
    fireEvent.click(pill());
    const panel = dialog();
    const composer = within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    // Empty composer — the gesture attaches, it does not type for you.
    expect(composer.value).toBe("");
    const chip = await within(panel).findByRole("status", { name: "Remixing: Rent Roll" });
    expect(chip.textContent).toContain("Rent Roll");
    // Nothing can fire a turn: opening a composer is not sending a message.
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("rides with the next message and clears on send", async () => {
    mount(<Remixable name="Rent Roll" context="24 units, Building A."><RentRoll /></Remixable>);
    fireEvent.click(pill());
    const panel = dialog();
    const composer = within(panel).getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "group it by building" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(sentText(wire)).toBe(
      'group it by building\n\nRemixing the "Rent Roll" component on this page. 24 units, Building A.',
    ));
    // Spent by the message it rode on.
    await waitFor(() => expect(within(panel).queryByRole("status", { name: "Remixing: Rent Roll" })).toBeNull());
  });

  it("never sends a turn on its own with an empty draft", () => {
    mount();
    fireEvent.click(pill());
    const composer = within(dialog()).getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("drops the attachment when the chip is dismissed, without sending", async () => {
    mount();
    fireEvent.click(pill());
    const panel = dialog();
    fireEvent.click(await within(panel).findByRole("button", { name: "Stop remixing Rent Roll" }));
    expect(within(panel).queryByRole("status", { name: "Remixing: Rent Roll" })).toBeNull();

    const composer = within(panel).getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "just a question" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(sentText(wire)).toBe("just a question"));
  });

  it("puts the attachment back when a failed file read cancels the send", async () => {
    // Every FileReader errors, so the send's attachment conversion rejects and
    // the composer restores the message instead of losing it (greptile P1).
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      queueMicrotask(() => this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>));
    });
    mount();
    fireEvent.click(pill());
    const panel = dialog();
    const composer = within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const input = panel.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["x"], "chart.csv", { type: "text/csv" })] } });
    fireEvent.change(composer, { target: { value: "group these" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await within(panel).findByRole("alert");
    // The typed text comes back UNCOMPOSED, and the surface is armed again.
    expect(composer.value).toBe("group these");
    expect(within(panel).getByRole("status", { name: "Remixing: Rent Roll" })).toBeTruthy();
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("does not wipe a draft already in the composer", async () => {
    mount();
    const panel = render(<VendoProvider client={client}><VendoThread /></VendoProvider>);
    panel.unmount();
    fireEvent.click(pill());
    const composer = within(dialog()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "half a thought" } });
    // A second gesture re-arms without touching what is typed.
    fireEvent.click(pill());
    await waitFor(() => expect(composer.value).toBe("half a thought"));
  });

  it("warns in development when no conversation surface is mounted", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<VendoProvider client={client}><Remixable name="Rent Roll"><RentRoll /></Remixable></VendoProvider>);
    fireEvent.click(pill());
    expect(warn.mock.calls[0]?.[0]).toContain('Remixable "Rent Roll"');
    vi.unstubAllEnvs();
  });

  it("exposes the same attachment programmatically", async () => {
    render(<VendoProvider client={client}><VendoOverlay launcher="none" /></VendoProvider>);
    act(() => { expect(openVendoConversation({ remix: { name: "Rent Roll" } })).toBe(true); });
    expect(await within(dialog()).findByRole("status", { name: "Remixing: Rent Roll" })).toBeTruthy();
  });

  it("puts the bloom behind prefers-reduced-motion, so the states snap", () => {
    // The reveal is a data attribute; only the travel is animated, and every
    // transition on the two marks lives inside the no-preference guard.
    const bloom = CHROME_CSS.split("@media (prefers-reduced-motion: no-preference) {")
      .find(block => block.includes(".fl-remix-seed { transition:"));
    expect(bloom).toBeTruthy();
    expect(bloom!.slice(0, bloom!.indexOf("\n}"))).toContain(".fl-remix-pill { transition:");
    // And nowhere unguarded.
    expect(CHROME_CSS.match(/\.fl-remix-(?:seed|pill) \{ transition:/g)).toHaveLength(2);
  });
});
