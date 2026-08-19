// @vitest-environment jsdom
// S2 one door — <Remixable> stopped being a second place to ask. The ✦ on an
// unremixed component OPENS THE CHAT about it; the wish is typed there, where
// the agent can answer and say so when the remix fails. On a remixed one the ✦
// is the pin chrome itself (Edit in chat · Update · Revert), not a lookalike.
// The inline wish form, its status line, and its pill states are deleted.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { Remixable, VendoOverlay } from "../../src/chrome/index.js";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";
import { createWireServer } from "../wire-server.js";

/**
 * jsdom 25 ships no `PointerEvent`, so every synthetic pointer event arrives
 * with an undefined `pointerType` and a finger cannot be told from a cursor —
 * which is the whole of the reveal's leave rule. This carries the init through
 * (the plain `extends MouseEvent` shim in kit/base-ui-bricks.test.tsx drops it),
 * so the two devices are expressible here. It stays an ENVIRONMENT stand-in: the
 * real touchscreen behaviour is proven in the browser pass.
 */
if (typeof window.PointerEvent !== "function") {
  window.PointerEvent = class extends MouseEvent {
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "";
    }
  } as unknown as typeof PointerEvent;
}

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

describe("Remixable — one door into the chat, one ✦ menu on the remix", () => {
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
  const remixDoor = () => screen.getByRole("button", { name: "Remix this view with Vendo" });
  /** The remixed component wears the PIN chrome's pill — same mark, same words. */
  const managePill = () => screen.getByRole("button", { name: "Edit this view" });
  /** The same mark WITHOUT assuming what it says — the word is the state. */
  const pill = () => wrapper().querySelector<HTMLButtonElement>(".fl-remix-pill")!;
  const revealed = () => wrapper().hasAttribute("data-vendo-revealed");
  // An instant remix carries no in-client approval, so the fork surface IS the
  // contained drop-back notice — the one venue a generated node has left.
  const forkSurface = () => screen.queryByRole("note", { name: "Not approved for this page" });
  const opens = () => wire.requests.filter(r => r.method === "GET" && /\/apps\/.+\/open/.test(r.path));

  /** The remix the CHAT minted — the wrapper no longer mints anything itself. */
  const seedRemix = () => client.apps.seedFrom({ component: SLOT, instruction: "make it a chart" });

  function mount(node = <Remixable><TopMerchants title="Top merchants" /></Remixable>) {
    return render(
      <VendoProvider client={client}>
        {node}
        <VendoOverlay launcher="none" />
      </VendoProvider>,
    );
  }

  const composerIn = (panel: HTMLElement) =>
    within(panel).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

  it("renders the host's own markup untouched, with the seed and the ✦ door over it", () => {
    mount();
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(wrapper().querySelector(".fl-remix-seed")?.textContent).toBe("✦");
    expect(remixDoor()).toBeTruthy();
    // At rest the pill is inert — nothing invisible to misclick.
    expect(revealed()).toBe(false);
  });

  it("blooms on hover and holds through the grace period on the way out", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.pointerEnter(wrapper(), { pointerType: "mouse" });
    expect(revealed()).toBe(true);
    fireEvent.pointerLeave(wrapper(), { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(150));
    expect(revealed()).toBe(true);
    act(() => void vi.advanceTimersByTime(100));
    expect(revealed()).toBe(false);
  });

  // Only a CURSOR leaves. A finger's pointerleave fires the instant it lifts,
  // so treating it as a cursor took the door away 200ms after the tap that
  // asked for it — while CSS leaves the pill non-interactive until revealed,
  // which left touch with no reliable way to reach Remix at all.
  it("keeps the door up when a TOUCH pointer lifts, and puts it away on a press outside", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.pointerEnter(wrapper(), { pointerType: "touch" });
    expect(revealed()).toBe(true);
    fireEvent.pointerLeave(wrapper(), { pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(400));
    expect(revealed()).toBe(true);

    // Touch dismisses the way every other ✦ mark does: a press outside it.
    fireEvent.pointerDown(document.body);
    expect(revealed()).toBe(false);
  });

  it("reveals on focus, so the door is keyboard-reachable", () => {
    mount();
    act(() => remixDoor().focus());
    expect(revealed()).toBe(true);
  });

  it("✦ opens the CHAT about this component — there is no second place to ask", async () => {
    mount();
    fireEvent.click(remixDoor());

    // The door lands in the conversation the page already has, prefilled and
    // unsent: the person finishes the sentence where the agent can answer it.
    const panel = await screen.findByRole("dialog", { name: "Vendo assistant" });
    await waitFor(() => expect(composerIn(panel).value).toBe("Remix this view: "));

    // The inline wish form is GONE — not hidden, not behind a flag.
    expect(screen.queryByRole("textbox", { name: `What should your ${SLOT} do?` })).toBeNull();
    expect(document.querySelector(".fl-remix-ask")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remix it" })).toBeNull();
    // And the wrapper mints nothing on its own — the ask is the chat's now.
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/apps/seed")).toHaveLength(0);
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("hands the agent the component's grounding out of sight", async () => {
    mount();
    fireEvent.click(remixDoor());
    const panel = await screen.findByRole("dialog", { name: "Vendo assistant" });
    await waitFor(() => expect(composerIn(panel).value).toBe("Remix this view: "));

    fireEvent.change(composerIn(panel), { target: { value: "Remix this view: make it a chart" } });
    fireEvent.keyDown(composerIn(panel), { key: "Enter" });

    const sent = await waitFor(() => {
      const post = wire.requests.find(r => r.method === "POST" && r.path === "/threads");
      expect(post).toBeTruthy();
      return JSON.stringify(post!.body);
    });
    // The agent is told WHICH component; the person is told nothing they did
    // not type — the grounding rides the turn, never the screen.
    expect(sent).toContain(SLOT);
    expect(sent).toContain("make it a chart");
    await waitFor(() => expect(panel.textContent).toContain("make it a chart"));
    expect(panel.textContent).not.toContain("The view being remixed");
  });

  it("warns in development when nothing is mounted for the chat to land in", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(
      <VendoProvider client={client}>
        <Remixable><TopMerchants title="Top merchants" /></Remixable>
      </VendoProvider>,
    );
    fireEvent.click(remixDoor());
    expect(warn.mock.calls.some(([first]) => String(first).includes("mount a VendoOverlay"))).toBe(true);
  });

  it("mounts the remix the chat minted IN PLACE of the wrapped child", async () => {
    await seedRemix();
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    expect(wrapper().contains(forkSurface())).toBe(true);
    await waitFor(() => expect(screen.queryByText("Blue Bottle")).toBeNull(), { timeout: 2000 });
    // The pin chrome's pill replaced the door.
    expect(managePill()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remix this view with Vendo" })).toBeNull();
  });

  it("the remixed ✦ menu IS the pin chrome: Edit in chat · Update · Revert, and nothing else", async () => {
    await seedRemix();
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    fireEvent.click(managePill());
    const menu = screen.getByRole("group", { name: "this view" });
    expect(within(menu).getAllByRole("button").map(button => button.textContent))
      .toEqual(["Edit in chat", "Update", "Revert"]);
    // No bespoke status line: what the remix is doing, and what went wrong with
    // it, belong to the conversation that asked for it.
    expect(within(menu).queryByRole("status")).toBeNull();
    // A screen reader hears the same words the pill shows — never `slot`, which
    // is a name the person can neither see nor say to a voice control.
    expect(wrapper().innerHTML).not.toContain(`aria-label="Edit ${SLOT}"`);
    expect(managePill().getAttribute("aria-label")).toBe("Edit this view");
  });

  it("“Edit in chat” opens the conversation featuring the remix — prefilled, never sent", async () => {
    const forked = await seedRemix();
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Edit in chat" }));

    const panel = await screen.findByRole("dialog", { name: "Vendo assistant" });
    await waitFor(() => expect(composerIn(panel).value).toBe("Update this view: "));
    // The prefill names the THING, never an id (spec §16 law 3) — and `slot` is
    // an id too: the React identifier sync captures under, which the person
    // sees nowhere else on their page.
    expect(panel.textContent).not.toContain(forked.id);
    expect(panel.textContent).not.toMatch(/app_[A-Za-z0-9]{4,}/);
    expect(panel.textContent).not.toContain(SLOT);
    expect(wire.requests.filter(r => r.method === "POST" && r.path === "/threads")).toHaveLength(0);
  });

  it("“Update” re-reads the remix", async () => {
    await seedRemix();
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    const before = opens().length;
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(opens().length).toBeGreaterThan(before));
  });

  // The point of the wish list: the host ships a new version, and "Update"
  // replays every wish onto it. The menu item read "Update" while doing nothing
  // but re-read the same screen, and `client.apps.reseed` had no caller at all —
  // the replay existed on the server and nothing on the page could reach it.
  it("“Update” REPLAYS the wish list when the host component has moved on", async () => {
    const forked = await seedRemix();
    wire.state.surfaces.set(forked.id, {
      ...wire.state.surfaces.get(forked.id)!,
      seedDrift: {
        component: SLOT,
        componentName: `Seed${SLOT}`,
        baseline: "sha256:fixture",
        current: "sha256:fixture-NEW",
        reason: "baseline-changed",
      },
    });
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => {
      expect(wire.requests.some(r => r.method === "POST" && r.path === `/apps/${forked.id}/reseed`)).toBe(true);
    });
  });

  it("“Revert” deletes the remix and restores the original child", async () => {
    const forked = await seedRemix();
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    fireEvent.click(managePill());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => {
      expect(wire.requests.some(r => r.method === "DELETE" && r.path === `/apps/${forked.id}`)).toBe(true);
    });
    await waitFor(() => expect(forkSurface()).toBeNull());
    await waitFor(() => expect(screen.getByText("Blue Bottle")).toBeTruthy());
    // And the door is back — the component is unremixed again.
    expect(screen.getByRole("button", { name: "Remix this view with Vendo" })).toBeTruthy();
  });

  // The founder's binding rule (2026-08-02): until a reviewer approves, the
  // ORIGINAL host component stays rendered, untouched.
  it("keeps the ORIGINAL rendered for a review-kind remix awaiting review", async () => {
    await seedRemix();
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    await waitFor(() => expect(pill()).toBeTruthy());
    await waitFor(() => expect(opens().length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(forkSurface()).toBeNull();
    // The pending state is never an in-page notice replacing the host component.
    expect(screen.queryByText(/sent for review/i)).toBeNull();
  });

  it("mounts a review-kind remix natively once the server grants the venue", async () => {
    const forked = await seedRemix();
    wire.state.surfaces.get(forked.id)!["inClient"] = {
      granted: true, versionHash: "sha256:v1", approvedBy: "host-admin", at: "2026-08-02T00:00:00.000Z",
    };
    mount(<Remixable review><TopMerchants title="Top merchants" /></Remixable>);
    await waitFor(() => expect(screen.queryByText("Blue Bottle")).toBeNull(), { timeout: 2000 });
  });

  it("a remix that never builds leaves the host's own component alone and adds NO error surface of its own", async () => {
    // The wish was typed in the chat, so the failure is the chat's to report
    // (the thread's build-failed beat). The page keeps the host's working
    // markup and says nothing — a second error surface is the thing S2 deleted.
    const forked = await seedRemix();
    wire.state.failedApps.set(forked.id, { reason: "the model ran out of quota" });
    mount();
    await waitFor(() => expect(pill()).toBeTruthy());
    await waitFor(() => expect(opens().length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    expect(forkSurface()).toBeNull();
    // The REASON is the chat's, and nothing on the page repeats it.
    expect(wrapper().textContent).not.toMatch(/ran out of quota/i);
    expect(within(wrapper()).queryByRole("alert")).toBeNull();
    // The recourse is the one door: the chat that asked for it.
    fireEvent.click(pill());
    expect(screen.getByRole("button", { name: "Edit in chat" })).toBeTruthy();
  });

  // The other half of that rule, and the half deleting the error surface took
  // with it: the ✦ must not CLAIM the screen it is offering to edit. A failed
  // remix mounts nothing, so the mark sits over the host's untouched original —
  // and it read a settled "Edit", beside a green "Did 1 thing" receipt, over a
  // remix the agent had just said failed.
  it("says the remix didn’t load rather than offering to edit a screen that isn’t there", async () => {
    const forked = await seedRemix();
    wire.state.failedApps.set(forked.id, { reason: "the model ran out of quota" });
    mount();
    await waitFor(() => expect(pill().textContent).toContain("Didn’t load"));

    // The accessible name carries the same words the mark shows, so a screen
    // reader is not told the remix is fine.
    expect(pill().getAttribute("aria-label")).toBe("This view didn’t load");
    expect(screen.queryByRole("button", { name: "Edit this view" })).toBeNull();
    // Nothing is in flight, so nothing claims to be.
    expect(pill().getAttribute("aria-busy")).toBeNull();
    // And the state is ANNOUNCED, not merely drawn — without becoming the error
    // surface S2 deleted: it says the chat has the reason, never the reason.
    fireEvent.click(pill());
    const status = within(screen.getByRole("group", { name: "this view" })).getByRole("status");
    expect(status.textContent).toMatch(/didn’t load/i);
    expect(status.textContent).not.toMatch(/ran out of quota/i);
  });

  it("says it is still working while the screen is still being built", async () => {
    const forked = await seedRemix();
    wire.state.pendingScreens.set(forked.id, 3);
    mount();

    await waitFor(() => expect(pill().textContent).toContain("Remixing…"));
    // aria-busy is the half a screen reader gets: the mark is the only thing on
    // the page that knows a build is running.
    expect(pill().getAttribute("aria-busy")).toBe("true");
    expect(pill().getAttribute("aria-label")).toBe("Remixing this view…");

    // And it settles to the ordinary mark once the screen lands.
    await waitFor(() => expect(forkSurface()).toBeTruthy(), { timeout: 30_000 });
    expect(pill().textContent).toContain("Edit");
    expect(pill().getAttribute("aria-busy")).toBeNull();
  }, 30_000);

  it("waits out a generation far longer than the load retries, and mounts the screen with no reload", async () => {
    // The real model takes 9–38s to write the remix's screen. The load's three
    // retries are spent in ~900ms, and the surface then never asked again.
    const forked = await seedRemix();
    wire.state.pendingScreens.set(forked.id, 3);
    mount();
    await waitFor(() => expect(pill()).toBeTruthy());
    expect(forkSurface()).toBeNull();
    // No remount, no reload — the same mounted wrapper picks the screen up.
    await waitFor(() => expect(forkSurface()).toBeTruthy(), { timeout: 30_000 });
  }, 30_000);

  it("discovers an existing remix on mount, so it survives a reload", async () => {
    await seedRemix();
    mount();
    await waitFor(() => expect(forkSurface()).toBeTruthy());
    expect(managePill()).toBeTruthy();
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

  it("puts the bloom behind prefers-reduced-motion, so the states snap", () => {
    const bloom = CHROME_CSS.split("@media (prefers-reduced-motion: no-preference) {")
      .find(block => block.includes(".fl-remix-seed { transition:"));
    expect(bloom).toBeTruthy();
    expect(bloom!.slice(0, bloom!.indexOf("\n}"))).toContain(".fl-remix-pill { transition:");
    expect(CHROME_CSS.match(/\.fl-remix-(?:seed|pill) \{ transition:/g)).toHaveLength(2);
    expect(CHROME_CSS).not.toMatch(/\.fl-remix-menu[^{]*\{[^}]*(?:animation|transition)/);
  });
});
