// @vitest-environment jsdom
// 2026-08-02 remix final shape (lane W1b) — <Remixable> owns the whole remix
// surface: the ✦ gesture executes the DETERMINISTIC wire fork carrying the
// wrapper's serializable live props, the fork mounts JAILED, IN PLACE of the
// wrapped child, live call-site props keep flowing into it, and the ✦ mark on
// a remixed component is the management handle (status / open in panel /
// revert). The old context-chip behavior is deleted, not renamed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vendoai/core";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { Remixable, VendoOverlay } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { createWireServer } from "../wire-server.js";

/** The slot is the wrapped component's identifier — what sync captures under. */
const SLOT = "TopMerchants";
/** The runtime's stable generated-component name for the fork's island. */
const FORK_COMPONENT = `Pinned${SLOT}${sha256Hex(SLOT).slice(0, 8)}`;

function TopMerchants(_props: {
  title?: string;
  rows?: Array<{ merchant: string; amountCents: number }>;
  onSelect?(merchant: string): void;
  icon?: unknown;
  asOf?: Date;
  ratio?: number;
}) {
  return <table><tbody><tr><td>Blue Bottle</td></tr></tbody></table>;
}

describe("Remixable — the wrapper fork gesture + in-place jailed mount", () => {
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
    vi.unstubAllEnvs();
    await wire.close();
  });

  const wrapper = () => document.querySelector<HTMLElement>(`[data-vendo-remixable="${SLOT}"]`)!;
  const forkPill = () => screen.getByRole("button", { name: `Remix ${SLOT} with Vendo` });
  const managePill = () => screen.getByRole("button", { name: `Manage the ${SLOT} remix` });
  const revealed = () => wrapper().hasAttribute("data-vendo-revealed");
  const forkCalls = () => wire.requests.filter(r => r.method === "POST" && r.path === "/apps/fork-pin");
  const forkIframe = () => screen.queryByTitle(`Generated component: ${FORK_COMPONENT}`) as HTMLIFrameElement | null;

  function mount(node = <Remixable><TopMerchants title="Top merchants" /></Remixable>, strict = false) {
    const inner = (
      <VendoProvider client={client}>
        {node}
        <VendoOverlay launcher="none" />
      </VendoProvider>
    );
    return render(strict ? <StrictMode>{inner}</StrictMode> : inner);
  }

  it("renders the host's own markup untouched, with the seed and the pill over it", () => {
    mount();
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(wrapper().querySelector(".fl-remix-seed")?.textContent).toBe("✦");
    expect(forkPill()).toBeTruthy();
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

  it("reveals on focus, so the pill is keyboard-reachable", () => {
    mount();
    act(() => forkPill().focus());
    expect(revealed()).toBe(true);
  });

  it("✦ gesture → ONE deterministic fork-pin call carrying ONLY the serializable live props", async () => {
    mount(
      <Remixable>
        <TopMerchants
          title="Top merchants"
          rows={[{ merchant: "Blue Bottle", amountCents: 1250 }]}
          onSelect={() => undefined}
          icon={<span>✦</span>}
          asOf={new Date("2026-08-01T00:00:00Z")}
          ratio={Number.NaN}
        />
      </Remixable>,
    );
    fireEvent.click(forkPill());
    await waitFor(() => expect(forkCalls()).toHaveLength(1));
    // Functions, elements, Dates, and non-finite numbers dropped SILENTLY —
    // the snapshot is exactly the JSON-serializable call-site props.
    expect(forkCalls()[0]?.body).toEqual({
      slot: SLOT,
      props: { title: "Top merchants", rows: [{ merchant: "Blue Bottle", amountCents: 1250 }] },
    });
    // No model turn: the model lost the fork decision entirely.
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("mounts the fork JAILED, IN PLACE of the wrapped child", async () => {
    mount();
    fireEvent.click(forkPill());
    // The fork's island mounts inside the wrapper boundary, in the sandboxed
    // iframe jail — and the original child yields the spot.
    await waitFor(() => expect(forkIframe()).toBeTruthy());
    expect(wrapper().contains(forkIframe())).toBe(true);
    expect(forkIframe()!.getAttribute("sandbox")).toBe("allow-scripts");
    await waitFor(() => expect(screen.queryByText("Blue Bottle")).toBeNull(), { timeout: 2000 });
    // The management pill replaced the fork gesture.
    expect(managePill()).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Remix ${SLOT} with Vendo` })).toBeNull();
  });

  it("streams live call-site props into the mounted fork on every render", async () => {
    const view = (title: string) => (
      <VendoProvider client={client}>
        <Remixable><TopMerchants title={title} /></Remixable>
      </VendoProvider>
    );
    const { rerender } = render(view("July"));
    fireEvent.click(forkPill());
    await waitFor(() => expect(forkIframe()).toBeTruthy());
    const posted = vi.spyOn(forkIframe()!.contentWindow!, "postMessage");
    rerender(view("August"));
    // The jail's render message carries the NEW call-site props merged over
    // the fork-time seed (data route 1: nothing captured, nothing stale).
    await waitFor(() => {
      expect(posted.mock.calls.some(([message]) =>
        (message as { kind?: string; props?: { title?: string } }).kind === "render"
        && (message as { props?: { title?: string } }).props?.title === "August",
      )).toBe(true);
    });
  });

  it("revert unmounts the fork and restores the original child", async () => {
    mount();
    fireEvent.click(forkPill());
    await waitFor(() => expect(forkIframe()).toBeTruthy());
    const appId = wire.state.apps.at(-1)!.id;
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Revert to original" }));
    await waitFor(() => {
      expect(wire.requests.some(r => r.method === "DELETE" && r.path === `/apps/${appId}`)).toBe(true);
    });
    // The fork is gone — the host's own markup renders again.
    await waitFor(() => expect(forkIframe()).toBeNull());
    await waitFor(() => expect(screen.getByText("Blue Bottle")).toBeTruthy());
    // And the gesture is available again (the dedupe pair was freed).
    expect(screen.getByRole("button", { name: `Remix ${SLOT} with Vendo` })).toBeTruthy();
  });

  it("StrictMode double-invoke does not double-fork", async () => {
    mount(<Remixable><TopMerchants title="Top merchants" /></Remixable>, true);
    fireEvent.click(screen.getByRole("button", { name: `Remix ${SLOT} with Vendo` }));
    await waitFor(() => expect(forkCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTitle(`Generated component: ${FORK_COMPONENT}`)).toBeTruthy());
    // Flush any trailing effects — still exactly one fork, one minted app.
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(forkCalls()).toHaveLength(1);
    expect(wire.state.apps.filter(app => app.pins?.some(pin => pin.slot === SLOT))).toHaveLength(1);
  });

  it("latches the pill while the fork is in flight (no second tap, cosmetic — the server dedupes anyway)", async () => {
    mount();
    const pill = forkPill() as HTMLButtonElement;
    fireEvent.click(pill);
    fireEvent.click(pill);
    fireEvent.click(pill);
    await waitFor(() => expect(forkCalls()).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(forkCalls()).toHaveLength(1);
  });

  it("the ✦ popover reports an instant-kind remix as sandboxed and personal", async () => {
    mount();
    fireEvent.click(forkPill());
    await waitFor(() => expect(forkIframe()).toBeTruthy());
    fireEvent.click(managePill());
    const menu = screen.getByRole("group", { name: `Remix of ${SLOT}` });
    expect(within(menu).getByRole("status").textContent).toBe("Sandboxed — only you see this");
  });

  it("the ✦ popover renders whatever venue state the open payload reports for a review-kind remix", async () => {
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    fireEvent.click(forkPill());
    await waitFor(() => expect(forkIframe()).toBeTruthy());
    // No venue on the payload → the pending state, exactly as reported.
    fireEvent.click(managePill());
    expect(screen.getByRole("status").textContent).toBe("Waiting for review");
  });

  it("the ✦ popover surfaces a server-granted venue verdict verbatim", async () => {
    // Seed a fork whose open payload carries the SERVER-authoritative venue
    // verdict (lane W1c owns minting it; the popover only renders it).
    const forked = await client.apps.forkPin({ slot: SLOT, props: {} });
    const stored = wire.state.apps.find(app => app.id === forked.app.id)!;
    (stored.tree as unknown as { inClient: unknown }).inClient = {
      granted: true, versionHash: "sha256:v1", approvedBy: "host-admin", at: "2026-08-02T00:00:00.000Z",
    };
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    await waitFor(() => expect(screen.queryByRole("button", { name: `Manage the ${SLOT} remix` })).toBeTruthy());
    fireEvent.click(managePill());
    // The open payload may still be in flight when the popover opens — the
    // status line settles on the server's verdict.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved by host-admin — runs in the page"));
  });

  it("\"Open in panel\" opens the conversation scoped to the remix — prefilled, never sent", async () => {
    mount();
    fireEvent.click(forkPill());
    await waitFor(() => expect(forkIframe()).toBeTruthy());
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    const panel = await screen.findByRole("dialog", { name: "Vendo assistant" });
    await waitFor(() => {
      const composer = within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      expect(composer.value).toBe(`Update my ${SLOT} remix: `);
    });
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("discovers an existing fork on mount, so a remix survives a reload", async () => {
    await client.apps.forkPin({ slot: SLOT, props: { title: "Persisted" } });
    mount();
    await waitFor(() => expect(forkIframe()).toBeTruthy());
    expect(screen.getByRole("button", { name: `Manage the ${SLOT} remix` })).toBeTruthy();
  });

  it("wraps only a statically importable component: inline JSX gets no affordance, and a dev warning", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(
      <VendoProvider client={client}>
        <Remixable><div>inline markup</div></Remixable>
      </VendoProvider>,
    );
    expect(screen.getByText("inline markup")).toBeTruthy();
    expect(document.querySelector("[data-vendo-remixable]")).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain("<Remixable>");
  });

  it("warns in development when the fork call fails, and unlatches", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    wire.state.failures.push({ method: "POST", path: "/apps/fork-pin", code: "not-found", message: "no captured baseline", status: 404 });
    mount();
    fireEvent.click(forkPill());
    await waitFor(() => expect(warn.mock.calls.some(([first]) => String(first).includes("no captured baseline"))).toBe(true));
    expect((forkPill() as HTMLButtonElement).disabled).toBe(false);
  });

  it("puts the bloom behind prefers-reduced-motion, so the states snap", () => {
    // The reveal is a data attribute; only the travel is animated, and every
    // transition on the two marks lives inside the no-preference guard. The
    // popover has no entry animation at all.
    const bloom = CHROME_CSS.split("@media (prefers-reduced-motion: no-preference) {")
      .find(block => block.includes(".fl-remix-seed { transition:"));
    expect(bloom).toBeTruthy();
    expect(bloom!.slice(0, bloom!.indexOf("\n}"))).toContain(".fl-remix-pill { transition:");
    expect(CHROME_CSS.match(/\.fl-remix-(?:seed|pill) \{ transition:/g)).toHaveLength(2);
    expect(CHROME_CSS).not.toMatch(/\.fl-remix-menu[^{]*\{[^}]*(?:animation|transition)/);
  });
});
