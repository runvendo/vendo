// @vitest-environment jsdom
/**
 * §3.4 — the beat / status channel, CLIENT half.
 *
 * The producer has shipped for a while (`writeStatus` →
 * `data-vendo-status`, transient) and had NO receiver, so the whole channel
 * was dead on arrival. These tests read it back through the real client: a
 * real HTTP wire server writes the exact chunks the harness writes, and the
 * real ai-SDK transport + the real `useVendoThread` deliver them. Nothing on
 * either side is stubbed — a beat test that mocked the stream would have
 * passed against the dead channel too.
 *
 * The law being pinned, in order: a beat with `phase`/`appId` lands, a bare
 * label lands, beats accumulate newest-active, the transcript-tail working
 * beat speaks the latest one, a settled turn leaves NOTHING behind (ephemeral by
 * construction — no `data-vendo-status` ever reaches `messages`), and a
 * malformed chunk is simply not a beat.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { VendoOverlay, VendoThread } from "../../src/chrome/index.js";
import { useVendoThread } from "../../src/hooks/use-vendo-thread.js";
import { resetRunActivity } from "../../src/chrome/run-activity.js";
import { createWireServer } from "../wire-server.js";

describe("the status channel reaches the screen", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;
  let release = () => undefined;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
  });

  afterEach(async () => {
    cleanup();
    resetRunActivity();
    await wire.close();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <VendoProvider client={client}>{children}</VendoProvider>
  );

  // The hook is where the chunks arrive, so it is where the shape law is read
  // back: the SDK hands a transient data chunk to `onData` and never pushes it
  // into `message.parts`, which is exactly what "ephemeral by construction"
  // means here.
  it("accumulates phase-carrying and bare beats in arrival order, and drops junk", { timeout: 20_000 }, async () => {
    const { result } = renderHook(() => useVendoThread("thr_1"), { wrapper });
    await waitFor(() => expect(result.current.messages[0]?.id).toBe("msg_existing"));
    expect(result.current.beats).toEqual([]);

    void act(() => { void result.current.sendMessage({ text: "[beats] build it" }); });
    // Mid-turn: the gate is still held, so this is the LIVE frame.
    await waitFor(() => expect(result.current.beats).toHaveLength(4));
    expect(result.current.beats).toEqual([
      { label: "Reading what you asked for", phase: "understanding", appId: "app_1" },
      { label: "Laying out the matching table", phase: "assembling" },
      { label: "Wiring up your transactions" },
      // "polishing" is not one of the six phases and 42 is not an app id: the
      // label is real, so the beat is real, and the two unusable fields are
      // absent rather than guessed at.
      { label: "Adding drag and drop" },
    ]);
    // Four valid labels out of eight chunks — an empty label, a whitespace
    // label, a numeric label and a null payload are not beats.
    await act(async () => release());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("leaves no beat behind when the turn settles, and never persists one as a message part", { timeout: 20_000 }, async () => {
    const { result } = renderHook(() => useVendoThread("thr_1"), { wrapper });
    await waitFor(() => expect(result.current.messages[0]?.id).toBe("msg_existing"));

    const seenPartTypes = new Set<string>();
    void act(() => { void result.current.sendMessage({ text: "[beats] build it" }); });
    await waitFor(() => expect(result.current.beats.length).toBeGreaterThan(0));
    for (const message of result.current.messages) {
      for (const part of message.parts) seenPartTypes.add(part.type);
    }

    await act(async () => release());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    // §3.4 — ephemeral by construction. A beat that landed in `parts` would be
    // persisted history, which is the one thing the channel forbids.
    expect(result.current.beats).toEqual([]);
    for (const message of result.current.messages) {
      for (const part of message.parts) seenPartTypes.add(part.type);
    }
    expect([...seenPartTypes]).not.toContain("data-vendo-status");
    expect(result.current.messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "All done." }),
    );
  });

  // HOME A — the between-steps gap indicator. It has always taken a `label`
  // and nobody ever passed one, so every busy gap said "Working". Since the
  // 2026-08-06 polish it is a working BEAT at the transcript tail (the direct
  // `.fl-msglist` child; a tool's own beat is nested in its turn's article),
  // debounced by 800ms.
  it("the working beat speaks the latest harness beat instead of the generic label", { timeout: 20_000 }, async () => {
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    expect(await screen.findByText("Existing thread")).toBeTruthy();

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[beats] build it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(await screen.findByText(/Here is the plan/)).toBeTruthy();
    await waitFor(() => {
      const working = document.querySelector(".fl-msglist > .fl-beat-working");
      expect(working).toBeTruthy();
      // The LAST valid beat, not the last chunk (the stream's final chunk is
      // deliberately malformed) and not "Working".
      expect(working?.textContent).toContain("Adding drag and drop");
    }, { timeout: 5_000 });
    expect(document.querySelector(".fl-msglist > .fl-beat-working")?.textContent).not.toContain("Working");

    await act(async () => release());
    expect(await screen.findByText("All done.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".fl-msglist > .fl-beat-working")).toBeNull());
  });

  // HOME B — the accumulating rail on the EXISTING split-view stage (no new
  // panel, no second preview surface).
  it("the workspace stage accumulates the beats: newest active, earlier ones ticked", { timeout: 20_000 }, async () => {
    render(<VendoProvider client={client}><VendoOverlay defaultOpen /></VendoProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Expand workspace" }));

    const composer = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "[beats] build it" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    const rail = () => document.querySelector(".fl-beatrail");
    await waitFor(() => expect(rail()?.querySelectorAll(".fl-beat")).toHaveLength(4));
    const lines = [...rail()!.querySelectorAll<HTMLElement>(".fl-beat")];
    expect(lines.map(line => line.querySelector(".fl-beat-label")?.textContent)).toEqual([
      "Reading what you asked for",
      "Laying out the matching table",
      "Wiring up your transactions",
      "Adding drag and drop",
    ]);
    // The newest is the working one; every earlier line is settled with a tick.
    expect(lines.at(-1)!.classList.contains("fl-beat-working")).toBe(true);
    expect(lines.at(-1)!.querySelector(".fl-beat-tick")).toBeNull();
    for (const settled of lines.slice(0, -1)) {
      expect(settled.classList.contains("fl-beat-done")).toBe(true);
      expect(settled.querySelector(".fl-beat-tick")).toBeTruthy();
    }
    // The optional fields ride as machine affordances only — a phase slug is
    // never words on a screen (the `data-vendo-*` convention the beat and
    // ribbon already use for the raw tool name).
    expect(lines[0]!.getAttribute("data-vendo-phase")).toBe("understanding");
    expect(lines[0]!.getAttribute("data-vendo-app")).toBe("app_1");
    expect(lines[2]!.hasAttribute("data-vendo-phase")).toBe(false);
    expect(lines[3]!.hasAttribute("data-vendo-phase")).toBe(false);
    expect(rail()?.textContent).toContain("You can close this and keep working");

    await act(async () => release());
    expect(await screen.findByText("All done.")).toBeTruthy();
    // Ephemeral on screen too: the settled turn leaves the stage clean.
    await waitFor(() => expect(rail()).toBeNull());
  });

  /**
   * P1 (bot review on #796) — SCOPE. The run store narrates whichever surface is
   * RUNNING, globally (`recompute`: `find(surface => surface.running)`), so a
   * stage that reads it unscoped narrates a conversation it is not showing.
   *
   * This is not hypothetical: the shipped `/concurrent` harness scenario mounts
   * an embedded `VendoThread` beside this very overlay, so ONE running turn plus
   * one expanded workspace is enough. It is also the third instance of this
   * codebase's singleton-vs-scoped mistake — `PrefillScopeContext` exists because
   * prompts went "to whichever composer registered last", and `publishThreadRun`
   * carries a comment about one settle being announced twice.
   */
  it("a stage narrates its OWN conversation, never whichever surface happens to be running", { timeout: 30_000 }, async () => {
    render(
      <VendoProvider client={client}>
        <VendoThread threadId="thr_1" />
        <VendoOverlay defaultOpen />
      </VendoProvider>,
    );
    expect(await screen.findByText("Existing thread")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Expand workspace" }));
    const panel = screen.getByRole("dialog", { name: "Vendo assistant" });
    const composerIn = (inside: boolean) => screen.getAllByRole("textbox", { name: "Message" })
      .find(box => panel.contains(box) === inside)!;

    // The EMBEDDED thread runs the build. The overlay's workspace is open on a
    // different, brand-new, never-run conversation.
    const outside = composerIn(false);
    fireEvent.change(outside, { target: { value: "[beats] build it" } });
    fireEvent.keyDown(outside, { key: "Enter" });

    // Positive anchor FIRST: the beats really are live on the running surface
    // (its transcript-tail working beat says the latest one), so the absence
    // asserted next cannot pass vacuously.
    await waitFor(() => expect(document.querySelector(".fl-msglist > .fl-beat-working")?.textContent)
      .toContain("Adding drag and drop"), { timeout: 5_000 });
    // …and they do not leak onto a stage that is showing someone else.
    expect(panel.querySelector(".fl-beatrail")).toBeNull();

    await act(async () => release());
    await waitFor(() => expect(document.querySelector(".fl-msglist > .fl-beat-working")).toBeNull());

    // The same stage DOES narrate its own conversation — the scope is a filter,
    // not a mute.
    wire.state.threadReplyGate = new Promise<void>(resolve => { release = resolve; });
    const inside = composerIn(true);
    fireEvent.change(inside, { target: { value: "[beats] build mine" } });
    fireEvent.keyDown(inside, { key: "Enter" });

    await waitFor(() => expect(panel.querySelectorAll(".fl-beatrail .fl-beat")).toHaveLength(4));
    expect(panel.querySelector(".fl-beatrail")?.textContent).toContain("Adding drag and drop");
    await act(async () => release());
    await waitFor(() => expect(panel.querySelector(".fl-beatrail")).toBeNull());
  });
});
