// @vitest-environment jsdom
// 2026-08-02 remix final shape (lane W1b) — <Remixable> owns the whole remix
// surface: the ✦ gesture executes the DETERMINISTIC wire seed, the seeded app
// takes the wrapped child's place, and the ✦ mark on a remixed component is
// the management handle (status / open in panel / revert). The old
// context-chip behavior is deleted, not renamed.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { Remixable, VendoOverlay } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { createWireServer } from "../wire-server.js";

/** The slot is the wrapped component's identifier — what sync captures under. */
const SLOT = "TopMerchants";

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

describe("Remixable — the wrapper fork gesture + in-place mount", () => {
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
  const forkCalls = () => wire.requests.filter(r => r.method === "POST" && r.path === "/apps/seed");
  // An instant remix carries no in-client approval, so the fork surface IS the
  // contained drop-back notice — the one venue a generated node has left.
  const forkSurface = () => screen.queryByRole("note", { name: "Not approved for this page" });

  /** The whole gesture: the pill opens the ask, and the remix is what the person
   *  wrote in it. There are no bare forks, so every fork below goes through here. */
  const remix = (instruction = "make it a chart") => {
    fireEvent.click(forkPill());
    const ask = screen.getByRole("textbox", { name: `What should your ${SLOT} do?` });
    fireEvent.change(ask, { target: { value: instruction } });
    fireEvent.click(screen.getByRole("button", { name: "Remix it" }));
  };

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

  it("✦ gesture → ONE deterministic seed call naming the component, and nothing else", async () => {
    mount(
      <Remixable>
        <TopMerchants
          title="Top merchants"
          rows={[{ merchant: "Blue Bottle", amountCents: 1250 }]}
          onSelect={() => undefined}
        />
      </Remixable>,
    );
    remix("make it a chart");
    await waitFor(() => expect(forkCalls()).toHaveLength(1));
    // A remix is an ordinary create that starts from something AND the first
    // edit on it: the call names the host component and the person's own words,
    // and carries no snapshot — call-site props are LIVE, streamed into the
    // mounted remix on every render (below), never frozen in at mint time.
    expect(forkCalls()[0]?.body).toEqual({ component: SLOT, instruction: "make it a chart" });
    // No model turn: the model lost the remix decision entirely.
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("mounts the fork IN PLACE of the wrapped child", async () => {
    mount();
    remix();
    // The fork's surface takes the spot inside the wrapper boundary, and the
    // original child yields it.
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    expect(wrapper().contains(forkSurface())).toBe(true);
    await waitFor(() => expect(screen.queryByText("Blue Bottle")).toBeNull(), { timeout: 2000 });
    // The management pill replaced the fork gesture.
    expect(managePill()).toBeTruthy();
    expect(screen.queryByRole("button", { name: `Remix ${SLOT} with Vendo` })).toBeNull();
  });

  it("revert unmounts the fork and restores the original child", async () => {
    mount();
    remix();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    const appId = wire.state.apps.at(-1)!.id;
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Revert to original" }));
    await waitFor(() => {
      expect(wire.requests.some(r => r.method === "DELETE" && r.path === `/apps/${appId}`)).toBe(true);
    });
    // The fork is gone — the host's own markup renders again.
    await waitFor(() => expect(forkSurface()).toBeNull());
    await waitFor(() => expect(screen.getByText("Blue Bottle")).toBeTruthy());
    // And the gesture is available again (the dedupe pair was freed).
    expect(screen.getByRole("button", { name: `Remix ${SLOT} with Vendo` })).toBeTruthy();
  });

  it("StrictMode double-invoke does not double-fork", async () => {
    mount(<Remixable><TopMerchants title="Top merchants" /></Remixable>, true);
    remix();
    await waitFor(() => expect(forkCalls()).toHaveLength(1));
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    // Flush any trailing effects — still exactly one fork, one minted app.
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(forkCalls()).toHaveLength(1);
    expect(wire.state.apps.filter(app => app.seed?.component === SLOT)).toHaveLength(1);
  });

  it("latches the pill while the fork is in flight (no second tap, cosmetic — the server dedupes anyway)", async () => {
    mount();
    // The ask closes on submit, so the second and third taps land on a pill that
    // is already latched and carries no instruction to send.
    remix();
    fireEvent.click(forkPill());
    fireEvent.click(forkPill());
    await waitFor(() => expect(forkCalls()).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(forkCalls()).toHaveLength(1);
  });

  it("the ✦ popover reports an instant-kind remix as sandboxed and personal", async () => {
    mount();
    remix();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    fireEvent.click(managePill());
    const menu = screen.getByRole("group", { name: `Remix of ${SLOT}` });
    expect(within(menu).getByRole("status").textContent).toBe("Sandboxed — only you see this");
  });

  // Round-2 finding 1 (the founder's binding rule): until a reviewer
  // approves, the ORIGINAL host component stays rendered, untouched — this
  // test previously asserted the fork mount for a pending review-kind
  // remix, which was the WRONG behavior.
  it("keeps the ORIGINAL rendered for a review-kind remix awaiting review — no fork mount, status in the ✦ popover only", async () => {
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    remix();
    await waitFor(() => expect(managePill()).toBeTruthy());
    // Wait past the fork surface actually arriving: STILL the original.
    await waitFor(() => expect(wire.requests.some(r => r.method === "GET" && /\/apps\/.+\/open/.test(r.path))).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(forkSurface()).toBeNull();
    // The pending state lives in the panel/popover ONLY — never as an
    // in-page notice replacing the host component.
    expect(screen.queryByText(/sent for review/i)).toBeNull();
    fireEvent.click(managePill());
    expect(screen.getByRole("status").textContent).toBe("Waiting for review");
  });

  it("keeps the ORIGINAL rendered for a REJECTED review-kind remix, with the note in the ✦ popover", async () => {
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    wire.state.surfaces.get(forked.id)!["inClient"] = {
      granted: false,
      versionHash: "sha256:v1",
      reason: "pending-review",
      review: { status: "rejected", versionHash: "sha256:v1", note: "Keep the table layout.", by: "host-admin", at: "2026-08-02T00:00:00.000Z" },
    };
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    await waitFor(() => expect(managePill()).toBeTruthy());
    fireEvent.click(managePill());
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe('Rejected — "Keep the table layout.". Edit the remix to resubmit it for review.'));
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(forkSurface()).toBeNull();
    expect(screen.queryByText(/remix rejected/i)).toBeNull();
  });

  it("reports BOTH states when an older approved version serves while the current one is pending review", async () => {
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    wire.state.surfaces.get(forked.id)!["inClient"] = {
      granted: true,
      versionHash: "sha256:v1",
      approvedBy: "host-admin",
      at: "2026-08-02T00:00:00.000Z",
      review: { status: "pending", versionHash: "sha256:v2" },
    };
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    await waitFor(() => expect(managePill()).toBeTruthy());
    fireEvent.click(managePill());
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe("Approved by host-admin — runs in the page; your latest edit is waiting for review"));
  });

  it("reports BOTH states when an older approved version serves and the current one was rejected", async () => {
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    wire.state.surfaces.get(forked.id)!["inClient"] = {
      granted: true,
      versionHash: "sha256:v1",
      approvedBy: "host-admin",
      at: "2026-08-02T00:00:00.000Z",
      review: { status: "rejected", versionHash: "sha256:v2", note: "Too wide.", by: "host-admin", at: "2026-08-02T01:00:00.000Z" },
    };
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    await waitFor(() => expect(managePill()).toBeTruthy());
    fireEvent.click(managePill());
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe('Approved by host-admin — runs in the page; your latest edit was rejected — "Too wide."'));
  });

  it("the ✦ popover surfaces a server-granted venue verdict verbatim", async () => {
    // Seed a fork whose open payload carries the SERVER-authoritative venue
    // verdict (lane W1c owns minting it; the popover only renders it).
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    wire.state.surfaces.get(forked.id)!["inClient"] = {
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
    remix();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    // The prefill NAMES THE THING and carries no id: this used to read
    // "…remix (app app_…): ", and an app id is our plumbing, not something a
    // person types (spec §16 law 3, LEAK 4).
    const appId = wire.state.apps.find(app => app.seed?.component === SLOT)!.id;
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    const panel = await screen.findByRole("dialog", { name: "Vendo assistant" });
    await waitFor(() => {
      const composer = within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      expect(composer.value).toBe(`Update my ${SLOT} remix: `);
    });
    expect(within(panel).getByRole("textbox", { name: "Message" }).textContent).not.toContain(appId);
    expect(panel.textContent).not.toMatch(/app_[A-Za-z0-9]{4,}/);
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("hands the agent its grounding out of sight — the app id reaches the turn, never the screen", async () => {
    mount();
    remix();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    const appId = wire.state.apps.find(app => app.seed?.component === SLOT)!.id;
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Open in panel" }));
    const panel = await screen.findByRole("dialog", { name: "Vendo assistant" });
    const composer = () => within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await waitFor(() => expect(composer().value).toBe(`Update my ${SLOT} remix: `));

    fireEvent.change(composer(), { target: { value: `Update my ${SLOT} remix: make it blue` } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    // It REACHES the agent: the turn's own message carries it.
    const sent = await waitFor(() => {
      const post = wire.requests.find(r => r.method === "POST" && r.path === "/threads");
      expect(post).toBeTruthy();
      return JSON.stringify(post!.body);
    });
    expect(sent).toContain(appId);
    expect(sent).toContain("make it blue");

    // And it is nowhere a person looks — not the textarea, not the transcript.
    await waitFor(() => expect(panel.textContent).toContain("make it blue"));
    expect(document.body.textContent).not.toContain(appId);
    expect(composer().value).toBe("");
  });

  it("discovers an existing fork on mount, so a remix survives a reload", async () => {
    await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    expect(screen.getByRole("button", { name: `Manage the ${SLOT} remix` })).toBeTruthy();
  });

  it("says Remixing… until the edited screen actually lands, then Remixed", async () => {
    // The seed's provenance row exists the instant the fork is minted, seconds
    // before its screen does — `open` answers "tree app has no ui payload" for
    // that whole window. The pill used to report the row, so it said "Remixed"
    // over the host's untouched original for ~4s of a ~5s remix.
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    const notYet = { method: "GET", path: `/apps/${forked.id}/open`, code: "validation", message: "tree app has no ui payload", status: 400 };
    wire.state.failures.push({ ...notYet }, { ...notYet });
    mount();
    await waitFor(() => expect(managePill()).toBeTruthy());
    // Still the host's own markup, so the pill must not claim otherwise.
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(forkSurface()).toBeNull();
    expect(managePill().textContent).toContain("Remixing…");
    expect(managePill().getAttribute("aria-busy")).toBe("true");
    // The screen lands — and only now is the work done.
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    expect(managePill().textContent).toContain("Remixed");
    expect(managePill().getAttribute("aria-busy")).toBeNull();
  });

  it("waits out a generation far longer than the load retries, and mounts the screen with no reload", async () => {
    // The real model takes 9–38s to write the remix's screen. The load's three
    // retries are spent in ~900ms, and the surface then never asked again: the
    // pill sat on "Remixing…" until the person reloaded the page. A screen that
    // is not ready is the build window's pending, and the wait rides it out.
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    wire.state.pendingScreens.set(forked.id, 3);
    mount();
    await waitFor(() => expect(managePill().textContent).toContain("Remixing…"));
    expect(forkSurface()).toBeNull();
    // No remount, no reload — the same mounted wrapper picks the screen up.
    await waitFor(() => expect(forkSurface()).toBeTruthy(), { timeout: 30_000 });
    expect(managePill().textContent).toContain("Remixed");
    expect(managePill().getAttribute("aria-busy")).toBeNull();
  }, 30_000);

  it("stops claiming work when the load gives up, and says the page is untouched", async () => {
    // The wait is bounded, so the pill must have somewhere to land: "Remixing…"
    // past the point of asking is the same lie the badge was added to end.
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    const dead = { method: "GET", path: `/apps/${forked.id}/open`, code: "validation", message: "boom", status: 400 };
    wire.state.failures.push({ ...dead }, { ...dead }, { ...dead });
    mount();
    await waitFor(() => expect(managePill().textContent).toContain("Didn’t load"));
    expect(managePill().getAttribute("aria-busy")).toBeNull();
    // The host's own markup never left, and the popover says so.
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    fireEvent.click(managePill());
    expect(screen.getByRole("status").textContent).toContain("nothing changed on the page");
  });

  it("lands the same way when the build ANSWERS that it failed, and says why", async () => {
    // The other dead end: the wire does not stop answering, it answers the
    // terminal {kind:"failed"}. That is a surface like any other to useApp, so
    // the pill said "Remixed" and the popover "Sandboxed — only you see this"
    // over a page that never got a screen.
    const forked = await client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });
    wire.state.failedApps.set(forked.id, { reason: "the model ran out of quota" });
    mount();
    await waitFor(() => expect(managePill().textContent).toContain("Didn’t load"));
    expect(managePill().getAttribute("aria-busy")).toBeNull();
    // The host's own markup is still the only thing on the page.
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(forkSurface()).toBeNull();
    fireEvent.click(managePill());
    expect(screen.getByRole("status").textContent).toBe("the model ran out of quota");
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
    wire.state.failures.push({ method: "POST", path: "/apps/seed", code: "not-found", message: "no captured baseline", status: 404 });
    mount();
    remix();
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
