// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { effectiveAppBuildUiDeadlineMs } from "@vendoai/apps/contract";
import type { VendoAppRef, VendoApprovalRef } from "@vendoai/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VendoAppEmbed,
  VendoApprovalEmbed,
  VendoProvider,
  VendoToolResult,
  createVendoClient,
  defaultVendoTheme,
  useVendoProvider,
  type OpenSurface,
  type PendingSurface,
  type VendoClient,
} from "../src/index.js";
import { createWireServer } from "./wire-server.js";

// Existing-agents Lane B — the three embeds a BYO chat surface renders from
// `vendo_*` tool outputs, inside the same VendoProvider the headless hooks
// use. The wire owns approval state; the embed renders it in place with the
// existing failed/expired vocabulary — never a silent blank.

const appRef: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_1", title: "Invoices", status: "building" };
const approvalRef: VendoApprovalRef = {
  kind: "vendo/approval-ref@1",
  approvalId: "apr_1",
  summary: "Send the report to a client",
};

describe("existing-agents embeds", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let client: VendoClient;

  beforeEach(async () => {
    wire = await createWireServer();
    client = createVendoClient({ baseUrl: wire.url });
  });

  afterEach(async () => {
    // Unmount BEFORE closing the wire. Testing-library's automatic cleanup
    // runs in its own, later hook — so without this, a still-mounted
    // VendoAppEmbed whose app never became servable keeps polling open()
    // into the closing server every APP_POLL_MS, the socket never goes
    // idle, and server.close() livelocks until the hook timeout (the CI
    // "Hook timed out" flake; local runs won the race by luck).
    cleanup();
    await wire.close();
  });

  function mount(children: ReactNode) {
    return render(<VendoProvider client={client}>{children}</VendoProvider>);
  }

  describe("VendoToolResult", () => {
    it("renders nothing for plain data — the action executed cleanly", () => {
      const { container } = mount(<VendoToolResult output={{ delivered: true }} />);
      expect(container.querySelector("[data-vendo-embed]")).toBeNull();
    });

    it("renders nothing for a malformed envelope rather than half-rendering it", () => {
      const { container } = mount(
        <VendoToolResult output={{ kind: "vendo/app-ref@1", appId: 42 }} />,
      );
      expect(container.querySelector("[data-vendo-embed]")).toBeNull();
    });

    it("dispatches an app-ref envelope to the app embed", async () => {
      const { container } = mount(<VendoToolResult output={appRef} />);
      expect(container.querySelector('[data-vendo-embed="app"]')).not.toBeNull();
      await waitFor(() => expect(screen.getByText("Invoices app surface")).toBeDefined());
    });

    it("dispatches an approval-ref envelope to the approval embed", async () => {
      const { container } = mount(<VendoToolResult output={approvalRef} />);
      expect(container.querySelector('[data-vendo-embed="approval"]')).not.toBeNull();
      await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDefined());
    });
  });

  describe("VendoApprovalEmbed", () => {
    it("renders the consent card with real inputs while pending, then resolves in place to the executed outcome on approve", async () => {
      mount(<VendoApprovalEmbed refValue={approvalRef} />);

      // The pending request feeds the existing ApprovalCard machinery.
      // ⚠️ TEST EDIT (M1 · Sentence): the recipient used to be a field-table dd
      // of its own. It is now one of the labelled notes on the card's quiet
      // line — still displayed, still verbatim.
      const approve = await screen.findByRole("button", { name: "Approve" });
      expect(document.querySelector(".fl-approval-sub")!.textContent).toContain("To: a@example.com");

      fireEvent.click(approve);

      // The wire executes the parked call; the embed resolves in place — a
      // succeeded receipt wears no error register (its failed twin does).
      await waitFor(() => expect(screen.getByText("Approved — ran")).toBeDefined());
      expect(document.querySelector(".fl-approval-sub--failed")).toBeNull();
      expect(wire.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: "/approvals/decide",
          body: { ids: ["apr_1"], decision: { approve: true } },
        }),
      );
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("resolves to declined on deny and never renders the outcome", async () => {
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
      await waitFor(() => expect(screen.getByText(/declined/i)).toBeDefined());
    });

    it("renders the executed outcome's failure with the failed vocabulary, not a blank", async () => {
      // ⚠️ TEST EDIT (M36): this required the WIRE's own sentence ("downstream
      // exploded") on the card. That is the tool's/provider's text on a host's
      // own page — §16 law 3's exact class. The failed vocabulary and a
      // consumer line stay; the wire's half is dev-mode only (asserted below).
      wire.state.approvals = [];
      wire.state.approvalResolutions.set("apr_1", {
        state: "executed",
        outcome: { status: "error", error: { code: "error", message: "downstream exploded" } },
      });
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText(/couldn't finish/i)).toBeDefined());
      expect(screen.getByText(/Nothing changed/)).toBeDefined();
      expect(document.body.textContent).not.toContain("downstream exploded");
      // …and it LOOKS failed: the thread's danger ✕ in front of the line, in the
      // error register. Muted to the same grey as "Approved — ran", the words
      // were the only thing telling a landed call from one that didn't.
      const line = document.querySelector(".fl-approval-sub")!;
      expect(line.classList.contains("fl-approval-sub--failed")).toBe(true);
      expect(line.querySelector("svg")).not.toBeNull();
    });

    it("keeps the wire's sentence for developers — dev mode only", async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      try {
        wire.state.approvals = [];
        wire.state.approvalResolutions.set("apr_1", {
          state: "executed",
          outcome: { status: "error", error: { code: "error", message: "downstream exploded" } },
        });
        mount(<VendoApprovalEmbed refValue={approvalRef} />);
        await waitFor(() => expect(screen.getByText(/downstream exploded/)).toBeDefined());
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    /** A call parked at the MCP DOOR runs in the outside agent's own retry, not
     *  server-side, so its executed receipt carries no outcome to show. It is
     *  still a call that RAN — the one thing this card must never call it is
     *  expired (observed live 2026-08-23, on the approval the user had just
     *  granted). */
    it("renders the approved receipt for an executed answer that carries no outcome", async () => {
      wire.state.approvals = [];
      wire.state.approvalResolutions.set("apr_1", { state: "executed" });
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText("Approved — ran")).toBeDefined());
      expect(document.querySelector(".fl-approval-sub--failed")).toBeNull();
      expect(document.body.textContent).not.toMatch(/expired/i);
    });

    /** The window between the press and the outside agent's retry: the yes is
     *  in, so the ask is gone, but nothing has run. The card keeps its working
     *  beat and its poll instead of settling on any receipt at all. */
    it("keeps working, with no ask to re-answer, for a decided approval whose call has not run yet", async () => {
      wire.state.approvals = [];
      wire.state.approvalResolutions.set("apr_1", { state: "pending" });
      const { container } = mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(container.querySelector(".fl-beat-working")).not.toBeNull());
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(document.body.textContent).not.toMatch(/expired/i);
    });

    it("renders expired for a TTL-swept approval", async () => {
      wire.state.approvals = [];
      wire.state.approvalResolutions.set("apr_1", { state: "expired" });
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText(/expired/i)).toBeDefined());
    });

    it("renders expired for an approval the wire no longer knows", async () => {
      wire.state.approvals = [];
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText(/expired/i)).toBeDefined());
    });

    /** A browser bundle is the likeliest place to hold TWO copies of
     *  `@vendoai/core` (the ESM build beside the CJS one), and the second
     *  copy's VendoErrors are a different class — so `instanceof` said no and a
     *  swept approval threw past this branch into the error card. */
    it("renders expired for a not-found another realm's VendoError carried", async () => {
      client = {
        ...client,
        approvals: {
          ...client.approvals,
          get: async () => {
            throw Object.assign(new Error("apr_1 is no longer known"), {
              name: "VendoError",
              code: "not-found",
            });
          },
        },
      };
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByText(/expired/i)).toBeDefined());
    });

    it("surfaces a wire failure as one honest line plus Try again, never a silent blank", async () => {
      // ⚠️ TEST EDIT (M36 + ruling 18): this required the wire's "wire down" in
      // the alert. Ruling 18 says a non-conversational surface owes the reader an
      // honest LINE and a way to TRY AGAIN — not the transport's sentence.
      wire.state.failures.push({
        method: "GET",
        path: "/approvals/apr_1",
        code: "not-implemented",
        message: "wire down",
        status: 501,
      });
      mount(<VendoApprovalEmbed refValue={approvalRef} />);
      await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
      expect(screen.getByText(/couldn’t reach this approval/i)).toBeDefined();
      expect(screen.getByRole("alert").textContent).not.toContain("wire down");
      expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    });
  });

  describe("VendoAppEmbed", () => {
    it("renders the live app surface once the wire serves it, under the ref's title chrome", async () => {
      mount(<VendoAppEmbed refValue={appRef} />);
      await waitFor(() => expect(screen.getByText("Invoices app surface")).toBeDefined());
      expect(screen.getByText("Invoices")).toBeDefined();
    });

    it("shows the build beat while the app is not yet servable", async () => {
      const building: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_building", title: "Weather board", status: "building" };
      mount(<VendoAppEmbed refValue={building} />);
      await waitFor(() => expect(screen.getByText(/Building/)).toBeDefined());
      expect(screen.getByText("Weather board")).toBeDefined();
    });

    it("announces the build's line, so a detached build reaches a screen reader too", async () => {
      // The build's own progress lands in this one span, replaced word by word.
      // Without live-region semantics a screen-reader user is told "Building
      // Weather board…" once and then hears nothing for the whole build.
      const building: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_building", title: "Weather board", status: "building" };
      mount(<VendoAppEmbed refValue={building} />);
      await waitFor(() => expect(screen.getByText(/Building/)).toBeDefined());

      const line = screen.getByText(/Building/);
      expect(line.getAttribute("aria-live")).toBe("polite");
      expect(line.getAttribute("role")).toBe("status");
    });

    it("polls the build window under the pending flag, so a miss is a 200 envelope and never a console 404", async () => {
      const building: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_building", title: "Weather board", status: "building" };
      mount(<VendoAppEmbed refValue={building} />);
      await waitFor(() => {
        const polls = wire.requests.filter(item => item.path.startsWith("/apps/app_building/open"));
        expect(polls.length).toBeGreaterThan(0);
        for (const poll of polls) expect(poll.path).toBe("/apps/app_building/open?pending=1");
      });
      // Still honestly building — the pending envelope resolves nothing.
      expect(screen.getByText(/Building/)).toBeDefined();
    });

    it("resolves the failed vocabulary WITH the reason promptly when the build terminally fails (#492)", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_doomed", title: "Budget tracker", status: "building" };
      // The build turn threw server-side: open() now answers {kind:"failed"}
      // instead of an eternal pending, so the embed resolves on the FIRST poll
      // rather than waiting for APP_BUILD_DEADLINE_MS.
      wire.state.failedApps.set("app_doomed", { reason: "quota exhausted", retryable: false });
      mount(<VendoAppEmbed refValue={doomed} />);
      await waitFor(() => expect(screen.getByText(/— couldn't finish/)).toBeDefined());
      // The wire's classified `reason` IS the byline — the reader learns why.
      expect(screen.getByText("quota exhausted")).toBeDefined();
      // A non-retryable failure carries no retry affordance.
      expect(screen.queryByText(/Retryable/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      // Resolved terminally — no skeletons still building.
      expect(screen.queryByRole("status")).toBeNull();
    });

    // The BYO embed surface prints the reason the build gave. These are the real
    // sentences, from the wave E2E capture and from the runtime's own constants
    // (apps/runtime.ts CREATE_BLOCKED / BUILD_WATCHDOG_REASON, and
    // vendo/dev-creds' install line) — each one names the thing to change, which
    // is the half a canned first-person line used to replace.
    const buildReasons = [
      "This app wasn't created, because it didn't pass the checks that keep an app honest:"
      + " the `value` expression is a declarative string that the DataTable does not evaluate,"
      + " not JavaScript: amount / sum(spending.data.amount)",
      'query "spendingDataReduce" names unknown tool "spending.data.reduce"; the host tools are:'
      + " host_getAccounts, host_listScheduledPayments, host_listInvoices",
      "ANTHROPIC_API_KEY is set but @ai-sdk/anthropic is not installed in this app;"
      + " install it (`npm install @ai-sdk/anthropic@^3`).",
      "the build never finished — the server-side build task stalled or died without reporting a"
      + " failure. Retry the request; if this repeats, check the host server log.",
    ];

    it.each(buildReasons)(
      "prints the reason the build gave, whole, for: %s",
      async (reason) => {
        const appId = `app_voice_${buildReasons.indexOf(reason)}`;
        const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId, title: "Spending board", status: "building" };
        wire.state.failedApps.set(appId, { reason, retryable: true, prompt: "A spending board" });
        mount(<VendoAppEmbed refValue={doomed} />);
        await waitFor(() => expect(screen.getByText(reason)).toBeDefined());

        const rendered = document.querySelector<HTMLElement>('[data-vendo-embed="app"]')?.textContent ?? "";
        expect(rendered).toContain(reason);
        // The failed vocabulary and the retry affordance stay around it.
        expect(rendered).toContain("— couldn't finish");
        expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
      },
    );

    it("shows a retry BUTTON when the terminal failure is retryable — never a dead embed (speed-core, criterion 8)", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_retry", title: "Retry tracker", status: "building" };
      // The shape the build watchdog persists: terminal, retryable, with the
      // original prompt riding the record so the retry re-issues it exactly.
      wire.state.failedApps.set("app_retry", {
        reason: "the build never finished — the server-side build task stalled or died without reporting a failure.",
        retryable: true,
        prompt: "Build a subscriptions tracker with all my recurring charges and their renewal dates",
      });
      mount(<VendoAppEmbed refValue={doomed} />);
      await waitFor(() => expect(screen.getByText(/— couldn't finish/)).toBeDefined());
      // The watchdog's own sentence, beside the affordance it argues for.
      expect(screen.getByText(
        "the build never finished — the server-side build task stalled or died without reporting a failure.",
      )).toBeDefined();
      expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    });

    it("retry re-issues the create with the persisted prompt and resolves into the fresh build", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_retry2", title: "Net worth…", status: "building" };
      wire.state.failedApps.set("app_retry2", {
        reason: "the build never finished",
        retryable: true,
        prompt: "Build me a net-worth dashboard with my total balance and recent transactions",
      });
      mount(<VendoAppEmbed refValue={doomed} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      // The EXACT persisted prompt is re-issued, not the capped embed title.
      await waitFor(() => expect(wire.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: "/apps",
          body: { prompt: "Build me a net-worth dashboard with my total balance and recent transactions" },
        }),
      ));
      // The embed leaves the failed vocabulary and resolves into the new app.
      await waitFor(() => expect(screen.getByText(/app surface/)).toBeDefined(), { timeout: 5000 });
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    it("actions on the retried app target the REPLACEMENT app id, never the dead record (checker F5)", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_dead", title: "Refresh board", status: "building" };
      wire.state.failedApps.set("app_dead", {
        reason: "the build never finished",
        retryable: true,
        prompt: "Refresh board [with-button]",
      });
      mount(<VendoAppEmbed refValue={doomed} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      // The replacement build serves an action-bound button; click THROUGH it.
      const refresh = await screen.findByRole("button", { name: "Refresh data" }, { timeout: 5000 });
      fireEvent.click(refresh);
      await waitFor(() => {
        const calls = wire.requests.filter((item) => item.method === "POST" && item.path.endsWith("/call"));
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) expect(call.path).not.toContain("app_dead");
        expect(calls.at(-1)?.path).toMatch(/^\/apps\/app_\d+\/call$/);
      });
    });

    it("retry falls back to the embed title when the failed record predates the prompt field", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_retry3", title: "Budget board", status: "building" };
      wire.state.failedApps.set("app_retry3", { reason: "generation failed", retryable: true });
      mount(<VendoAppEmbed refValue={doomed} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      await waitFor(() => expect(wire.requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/apps", body: { prompt: "Budget board" } }),
      ));
    });

    it("a failed retry resolves back to the failed vocabulary with the retry button, never a blank", async () => {
      const doomed: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_retry4", title: "Alerts inbox", status: "building" };
      wire.state.failedApps.set("app_retry4", { reason: "generation failed", retryable: true, prompt: "An alerts inbox" });
      wire.state.failures.push({
        method: "POST",
        path: "/apps",
        code: "validation",
        message: "the model could not produce a valid app",
        status: 400,
      });
      mount(<VendoAppEmbed refValue={doomed} />);
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      // The retried create's own wire error becomes the byline.
      await waitFor(() => expect(screen.getByText("the model could not produce a valid app")).toBeDefined());
      expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    });

    it("resolves the build beat into the app when the build lands mid-poll", async () => {
      const late: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_late", title: "Late app", status: "building" };
      mount(<VendoAppEmbed refValue={late} />);
      await waitFor(() => expect(screen.getByText(/Building/)).toBeDefined());
      // The build lands: the app becomes servable on a later poll.
      wire.state.apps.push({ format: "vendo/app@1", id: "app_late", name: "Late app", ui: "tree" });
      wire.state.surfaces.set("app_late", {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Text", props: { text: "Late app surface" } }],
      });
      await waitFor(() => expect(screen.getByText("Late app surface")).toBeDefined(), { timeout: 5000 });
    });

    it("resolves the failed vocabulary at the deadline when the wire answers {kind:'pending'} forever (0.4.6 defect D2)", async () => {
      // The D2 masking (a wire that keeps answering pending for a terminally
      // failed app) must still terminate client-side: the deadline turns the
      // eternal pending into the failed beat at its bound.
      vi.useFakeTimers();
      try {
        const masked: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_masked", title: "Masked app", status: "building" };
        const pendingClient: VendoClient = {
          ...client,
          apps: {
            ...client.apps,
            open: ((): Promise<OpenSurface | PendingSurface> =>
              Promise.resolve({ kind: "pending" })) as VendoClient["apps"]["open"],
          },
        };
        render(
          <VendoProvider client={pendingClient}>
            <VendoAppEmbed refValue={masked} />
          </VendoProvider>,
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(effectiveAppBuildUiDeadlineMs() + 2_000);
        });
        expect(screen.getByText(/— couldn't finish/)).toBeDefined();
        // The deadline's own reason (embeds.tsx), since the wire gave none.
        expect(screen.getByText("the build never finished")).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves the failed vocabulary at the deadline even when every poll HANGS (0.4.5 defect D)", async () => {
      // The wire client has no fetch timeout, and the poll loop only checked
      // the deadline when a request settled — a hung open() left the building
      // beat spinning past any deadline (byo-ai-sdk cert: 9+ minutes). The
      // absolute deadline timer depends on nothing but the clock.
      vi.useFakeTimers();
      try {
        const hung: VendoAppRef = { kind: "vendo/app-ref@1", appId: "app_hung", title: "Hung app", status: "building" };
        const hangingClient: VendoClient = {
          ...client,
          apps: {
            ...client.apps,
            open: (() => new Promise<never>(() => undefined)) as VendoClient["apps"]["open"],
          },
        };
        render(
          <VendoProvider client={hangingClient}>
            <VendoAppEmbed refValue={hung} />
          </VendoProvider>,
        );
        expect(screen.getByText(/Building/)).toBeDefined();
        // Well past APP_BUILD_DEADLINE_MS — no poll ever settles.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(effectiveAppBuildUiDeadlineMs() + 2_000);
        });
        expect(screen.getByText(/— couldn't finish/)).toBeDefined();
        expect(screen.getByText("the build never finished")).toBeDefined();
        // Terminal — the skeleton is gone.
        expect(screen.queryByRole("status")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// The provider is settings, not a switch: every one of its props has a
// universal default, so an embed dropped on a page with no provider anywhere
// self-boots from them. A provider above still wins, for everything.
describe("embeds with no provider", () => {
  let wire: Awaited<ReturnType<typeof createWireServer>>;
  let override: Awaited<ReturnType<typeof createWireServer>> | undefined;
  let hostFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    wire = await createWireServer();
    override = undefined;
    // A browser resolves the default "/api/vendo" against the page it is on;
    // jsdom has no origin Node's fetch can resolve a relative URL against, so
    // this stands in for that one step — the same rewrite the e2e harness's
    // vite proxy performs. Neither end is stubbed: the DEFAULT client builds
    // every request and the real wire answers it.
    const upstream = globalThis.fetch;
    hostFetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      return upstream(
        target.startsWith("/api/vendo") ? `${wire.url}${target.slice("/api/vendo".length)}` : input,
        init,
      );
    });
    vi.stubGlobal("fetch", hostFetch);
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    await wire.close();
    await override?.close();
  });

  const askedFor = (path: string) => hostFetch.mock.calls.some(([input]) => String(input).startsWith(`/api/vendo${path}`));

  it("dispatches, polls the default wire, and resolves an approval in place", async () => {
    render(<VendoToolResult output={approvalRef} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("Approved — ran")).toBeDefined());
    // The wire it reached is the default mount, with nobody having named it.
    expect(askedFor("/approvals/apr_1")).toBe(true);
    expect(wire.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/approvals/decide" }),
    );
  });

  it("polls a building app to its live surface", async () => {
    render(<VendoToolResult output={appRef} />);
    await waitFor(() => expect(screen.getByText("Invoices app surface")).toBeDefined());
    expect(askedFor("/apps/app_1/open")).toBe(true);
  });

  it("paints the chrome on the default brand tokens", () => {
    render(<VendoApprovalEmbed refValue={approvalRef} />);
    const root = document.querySelector<HTMLElement>(".vendo-root")!;
    expect(root.style.getPropertyValue("--vendo-color-accent")).toBe(defaultVendoTheme.colors.accent);
  });

  /** ONE client for the whole page, stable across renders: a fresh one per
   *  embed would be a fresh wire per embed, and every poll keys its effect on
   *  client identity — so the loops would restart on every render. */
  it("shares one client across every bare surface, and keeps it across renders", () => {
    const seen: VendoClient[] = [];
    function Probe() {
      seen.push(useVendoProvider().client);
      return null;
    }
    const view = render(<><Probe /><Probe /></>);
    view.rerender(<><Probe /><Probe /></>);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]!.baseUrl).toBe("/api/vendo");
  });

  it("a surrounding provider wins: its client is used and the default wire is never touched", async () => {
    override = await createWireServer();
    render(
      <VendoProvider client={createVendoClient({ baseUrl: override.url })}>
        <VendoApprovalEmbed refValue={approvalRef} />
      </VendoProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("Approved — ran")).toBeDefined());
    expect(override.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/approvals/decide" }),
    );
    expect(wire.requests).toEqual([]);
  });

  it("a surrounding provider's theme wins over the default tokens", () => {
    render(
      <VendoProvider client={createVendoClient({ baseUrl: wire.url })} theme={{ colors: { ...defaultVendoTheme.colors, accent: "#ff00aa" } }}>
        <VendoApprovalEmbed refValue={approvalRef} />
      </VendoProvider>,
    );
    const root = document.querySelector<HTMLElement>(".vendo-root")!;
    expect(root.style.getPropertyValue("--vendo-color-accent")).toBe("#ff00aa");
  });
});
