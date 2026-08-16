// @vitest-environment jsdom
/**
 * The screen-initiated approval modal.
 *
 * THE DEFECT it exists for: a money-moving button on a generated screen that
 * parked on the guard had no UI anywhere — only a badge count on another
 * surface — so the person who pressed it waited forever. These cases pin the
 * behaviors that make the modal an answer rather than a second dead end:
 * it says the ask in the product's own words for ANY tool, it shows the wait
 * honestly while the approved action actually runs, and it never spends a
 * decision the person did not make.
 */
import type { AppDocument, ApprovalId, ApprovalRequest, JsonSchema, UIPayload } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVALS_DECIDED_EVENT, VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import { ApprovalModal, useApprovalModal } from "../../src/chrome/approval-modal.js";
import { Remixable, VendoAppEmbed, VendoOverlay, type VendoThreadProps } from "../../src/chrome/index.js";
import { useSplitView } from "../../src/chrome/split-view.js";
import { ThreadPart } from "../../src/chrome/thread/parts.js";
import type { ApprovalResolution } from "../../src/wire-types.js";
import { createWireServer } from "../wire-server.js";

let wire: Awaited<ReturnType<typeof createWireServer>>;
let base: VendoClient;

beforeEach(async () => {
  wire = await createWireServer();
  base = createVendoClient({ baseUrl: wire.url });
});

afterEach(async () => {
  cleanup();
  await wire.close();
});

const CENTS_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    amount: { type: "integer", description: "Amount in integer cents" },
    recipient_name: { type: "string", description: "Who is being paid" },
    memo: { type: "string" },
  },
};

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "apr_1" as ApprovalId,
    call: { id: "call_1", tool: "host_transferMoney", args: { amount: 4750, recipient_name: "Acme Utilities", memo: "July water bill" } },
    descriptor: {
      name: "host_transferMoney",
      title: "Send money",
      inputSchema: CENTS_SCHEMA,
      risk: "destructive",
    },
    inputPreview: "host_transferMoney …",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "app", presence: "present" },
    createdAt: "2026-08-12T12:00:00.000Z",
    ...over,
  } as ApprovalRequest;
}

/** A client whose approval routes this test drives directly. */
function clientWith(over: {
  get?(id: ApprovalId): Promise<ApprovalResolution>;
  decide?(...args: Parameters<VendoClient["approvals"]["decide"]>): Promise<void>;
  apps?: Partial<VendoClient["apps"]>;
}): VendoClient {
  return {
    ...base,
    apps: { ...base.apps, ...over.apps },
    approvals: {
      ...base.approvals,
      ...(over.get === undefined ? {} : { get: over.get }),
      ...(over.decide === undefined ? {} : { decide: over.decide }),
    },
  };
}

function mount(client: VendoClient, onClose = () => undefined) {
  return render(
    <VendoProvider client={client}>
      <ApprovalModal approvalId={"apr_1" as ApprovalId} onClose={onClose} />
    </VendoProvider>,
  );
}

const pending = (over?: Partial<ApprovalRequest>) =>
  async (): Promise<ApprovalResolution> => ({ state: "pending", request: request(over) });

const ask = () => screen.getByRole("dialog").querySelector(".fl-apmodal-ask")!.textContent;
const notes = () => Array.from(screen.getByRole("dialog").querySelectorAll(".fl-apmodal-notes li")).map(li => li.textContent);
const rows = () => Array.from(screen.getByRole("dialog").querySelectorAll(".fl-card-field"))
  .map(row => `${row.querySelector("dt")!.textContent}: ${row.querySelector("dd")!.textContent}`);

describe("the screen-initiated approval modal", () => {
  describe("the ask it renders", () => {
    it("states the real money and counterparty as the hero, with the rest of the inputs under it", async () => {
      mount(clientWith({ get: pending() }));
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      // The honesty law: what the question did not name is on the surface,
      // never behind a fold — and the raw 4750 never reaches a person.
      expect(rows()).toEqual(["Memo: July water bill"]);
      expect(notes()).toEqual(["Sends now, as you", "Can’t be undone"]);
      expect(screen.getByRole("dialog").textContent).not.toContain("4750");
    });

    it("asks for a tool that moves no money at all — nothing here is wired to transfers", async () => {
      mount(clientWith({
        get: pending({
          call: { id: "call_2", tool: "host_archiveProject", args: { project: "Orion", notify_team: true } },
          descriptor: { name: "host_archiveProject", title: "Archive project", description: "", inputSchema: {}, risk: "destructive" },
        }),
      }));
      await waitFor(() => expect(ask()).toBe("Archive project?"));
      expect(rows()).toEqual(["Project: Orion", "Notify team: Yes"]);
      expect(notes()).toEqual(["This makes a change you can’t undo, as you."]);
    });

    it("lands focus on the dialog, never on Approve — the press that opened it must not spend the decision", async () => {
      mount(clientWith({ get: pending() }));
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    });
  });

  describe("deciding", () => {
    it("holds a designed in-flight state until the approved action has actually run", async () => {
      let release = () => undefined as void;
      const running = new Promise<void>(resolve => { release = () => resolve(); });
      const onClose = vi.fn();
      mount(clientWith({ get: pending(), decide: () => running }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));

      // The POST does not return until the action has run (~25s in production),
      // so the modal says so: both buttons locked, the wait stated plainly.
      const approve = await screen.findByRole("button", { name: "Approving…" });
      expect(approve).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Deny" })).toHaveProperty("disabled", true);
      expect(screen.getByText("Running now — this can take a few seconds.")).toBeDefined();
      expect(screen.getByRole("dialog").getAttribute("data-deciding")).toBe("approve");
      expect(onClose).not.toHaveBeenCalled();

      release();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("refuses to close mid-decision: the action is already running on the server", async () => {
      const onClose = vi.fn();
      mount(clientWith({ get: pending(), decide: () => new Promise<void>(() => undefined) }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await screen.findByRole("button", { name: "Approving…" });

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      fireEvent.click(document.querySelector(".fl-apmodal-scrim")!);

      await new Promise(resolve => setTimeout(resolve, 250));
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeDefined();
    });

    it("denies through the same wire call and closes", async () => {
      const decide = vi.fn(async () => undefined);
      const onClose = vi.fn();
      mount(clientWith({ get: pending(), decide }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(decide).toHaveBeenCalledWith(["apr_1"], { approve: false });
    });

    it("says what a refused decision means for the person, and re-arms the buttons", async () => {
      const onClose = vi.fn();
      mount(clientWith({
        get: pending(),
        decide: () => Promise.reject(Object.assign(new Error("approval apr_1 not found"), { code: "not-found" })),
      }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));

      // The consumer's half of a refusal (§16 law 3) — never the wire's own
      // sentence, which carries the approval id.
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("This request isn’t waiting on you any more — it may have expired.");
      expect(screen.getByRole("button", { name: "Approve" })).toHaveProperty("disabled", false);
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("dismissing", () => {
    it("Escape CLOSES without deciding — the approval stays pending", async () => {
      const decide = vi.fn(async () => undefined);
      const onClose = vi.fn();
      mount(clientWith({ get: pending(), decide }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      // The one thing a consent surface may never do is spend a decision on a
      // keystroke: nothing was approved and nothing was denied.
      expect(decide).not.toHaveBeenCalled();
    });

    it("the scrim closes without deciding too", async () => {
      const decide = vi.fn(async () => undefined);
      const onClose = vi.fn();
      mount(clientWith({ get: pending(), decide }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      fireEvent.click(document.querySelector(".fl-apmodal-scrim")!);
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(decide).not.toHaveBeenCalled();
    });

    it("leaves when the same approval is decided on another surface", async () => {
      const onClose = vi.fn();
      mount(clientWith({ get: pending() }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      window.dispatchEvent(new CustomEvent(APPROVALS_DECIDED_EVENT, { detail: { ids: ["apr_1"], approved: true } }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("stays put when a DIFFERENT approval is decided elsewhere", async () => {
      const onClose = vi.fn();
      mount(clientWith({ get: pending() }), onClose);
      await waitFor(() => expect(ask()).toBe("Send $47.50 to Acme Utilities?"));
      window.dispatchEvent(new CustomEvent(APPROVALS_DECIDED_EVENT, { detail: { ids: ["apr_other"], approved: true } }));
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("an ask that is no longer waiting on this person", () => {
    it.each([
      ["expired", "This request expired — try the action again."],
      ["declined", "This was already declined."],
      ["executed", "This already went through."],
    ])("says so rather than closing silently (%s)", async (state, copy) => {
      mount(clientWith({ get: async () => ({ state }) as ApprovalResolution }));
      expect(await screen.findByText(copy)).toBeDefined();
      // Nothing left to decide — and no dead end either.
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
      expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
    });

    it("says the request could not be loaded at all", async () => {
      mount(clientWith({ get: () => Promise.reject(new Error("offline")) }));
      expect(await screen.findByText("We couldn’t load this request.")).toBeDefined();
    });
  });

  /**
   * Presses arrive in BURSTS — Send on two payee rows, back to back. Two
   * modals over one screen is not a question anybody can answer, so the asks
   * queue: exactly one on screen, the next when that one leaves.
   */
  describe("useApprovalModal, queueing a burst of presses", () => {
    /** Each ask is its own sentence, so "which one is on screen" is readable. */
    const byId = async (id: ApprovalId): Promise<ApprovalResolution> => ({
      state: "pending",
      request: request({
        id,
        call: { id: `call_${id}`, tool: "host_transferMoney", args: { amount: 4750, recipient_name: id === "apr_1" ? "Acme Utilities" : "Northline Internet" } },
      }),
    });
    const asks = { first: "Send $47.50 to Acme Utilities?", second: "Send $47.50 to Northline Internet?" };

    function Harness({ client }: { client: VendoClient }) {
      const approval = useApprovalModal();
      return (
        <VendoProvider client={client}>
          <button type="button" onClick={() => approval.onParked({ nodeId: "pay-1", approvalId: "apr_1" as ApprovalId })}>park one</button>
          <button type="button" onClick={() => approval.onParked({ nodeId: "pay-2", approvalId: "apr_2" as ApprovalId })}>park two</button>
          {approval.modal}
        </VendoProvider>
      );
    }

    const burst = (client: VendoClient) => {
      render(<Harness client={client} />);
      fireEvent.click(screen.getByRole("button", { name: "park one" }));
      fireEvent.click(screen.getByRole("button", { name: "park two" }));
    };

    it("shows exactly ONE modal for two parked presses — never a second scrim", async () => {
      burst(clientWith({ get: byId }));
      await waitFor(() => expect(ask()).toBe(asks.first));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(document.querySelectorAll(".fl-apmodal-scrim")).toHaveLength(1);
    });

    it("presents the next ask once the first is decided", async () => {
      burst(clientWith({ get: byId, decide: async () => undefined }));
      await waitFor(() => expect(ask()).toBe(asks.first));
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(ask()).toBe(asks.second));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });

    it("Escape moves on to the next ask WITHOUT deciding, and loses neither", async () => {
      const decide = vi.fn(async () => undefined);
      burst(clientWith({ get: byId, decide }));
      await waitFor(() => expect(ask()).toBe(asks.first));

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      // The dismissed ask was never decided — it is still pending on the
      // server, and reachable again by pressing that row. The one queued
      // behind it gets its turn now rather than being dropped with it.
      await waitFor(() => expect(ask()).toBe(asks.second));
      expect(decide).not.toHaveBeenCalled();
    });

    it("empties out rather than re-presenting a dismissed ask forever", async () => {
      burst(clientWith({ get: byId }));
      await waitFor(() => expect(ask()).toBe(asks.first));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(ask()).toBe(asks.second));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("never queues the same approval twice, however often its button is pressed", async () => {
      const get = vi.fn(byId);
      render(<Harness client={clientWith({ get })} />);
      fireEvent.click(screen.getByRole("button", { name: "park one" }));
      fireEvent.click(screen.getByRole("button", { name: "park one" }));
      await waitFor(() => expect(ask()).toBe(asks.first));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("drops a queued ask that was answered on another surface, instead of showing a modal to say so", async () => {
      burst(clientWith({ get: byId, decide: async () => undefined }));
      await waitFor(() => expect(ask()).toBe(asks.first));

      // The chat card settles BOTH presses while the first modal is up.
      window.dispatchEvent(new CustomEvent(APPROVALS_DECIDED_EVENT, { detail: { ids: ["apr_1", "apr_2"], approved: true } }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // …and the second never gets a turn just to announce it was handled.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  /**
   * EVERY surface a generated screen can live on, not just the dashboard slot.
   * The modal shipped wired into `VendoSlot` alone, so the same money-moving
   * press made from the conversation — the surface people actually build views
   * in — parked in silence: no ask anywhere, and the screen sat on "Sending…".
   *
   * Each case presses a real action-bound button inside the real surface, over
   * a host pipe that parks it, and asks for the ask. Nothing about the modal
   * itself is exercised here; that is every case above.
   */
  describe("the surfaces a parked press asks from", () => {
    const PAYEES: UIPayload = {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [{
        id: "root",
        component: "Button",
        props: { label: "Send $47.50", onClick: { $action: "host_transferMoney" } },
      }],
    } as unknown as UIPayload;

    /** The host pipe parks the press, and the wire answers for the ask it
     *  parked on — the two halves any surface needs to raise this modal. */
    const parking = (over: Partial<VendoClient["apps"]> = {}) => clientWith({
      get: pending(),
      apps: { call: async () => ({ status: "pending-approval", approvalId: "apr_1" as ApprovalId }), ...over },
    });

    /** The overlay is itself a dialog, so the ask is named, never positional. */
    const askedFor = async () => (await screen.findByRole("dialog", { name: /^Approval for/u }))
      .querySelector(".fl-apmodal-ask")!.textContent;

    const press = async () => fireEvent.click(await screen.findByRole("button", { name: "Send $47.50" }));

    it("the conversation's in-thread card", async () => {
      render(
        <VendoProvider client={parking()}>
          <ThreadPart
            part={{ type: "data-vendo-view", data: { appId: "app_1", payload: PAYEES } } as unknown as Parameters<typeof ThreadPart>[0]["part"]}
            partKey="p0"
            role="assistant"
            restored={false}
            risks={new Map()}
          />
        </VendoProvider>,
      );
      await press();
      expect(await askedFor()).toBe("Send $47.50 to Acme Utilities?");
    });

    it("the workspace stage the same card expands onto", async () => {
      // The stage renders its OWN copy of the view (the rail card keeps its
      // preview), so the press made there is answered there.
      const Probe = () => {
        const split = useSplitView();
        useEffect(() => {
          split?.registerEmbed("app_1", PAYEES);
          split?.expandTo("app_1");
        }, [split]);
        return null;
      };
      render(
        <VendoProvider client={parking()}>
          <VendoOverlay defaultOpen thread={Probe as unknown as (props: VendoThreadProps) => React.JSX.Element} />
        </VendoProvider>,
      );
      await press();
      expect(await askedFor()).toBe("Send $47.50 to Acme Utilities?");
    });

    it("the BYO chat surface's app embed", async () => {
      render(
        <VendoProvider client={parking({ open: async () => ({ kind: "tree", payload: PAYEES }) })}>
          <VendoAppEmbed refValue={{ kind: "vendo/app-ref@1", appId: "app_1", title: "Payees", status: "building" }} />
        </VendoProvider>,
      );
      await press();
      expect(await askedFor()).toBe("Send $47.50 to Acme Utilities?");
    });

    it("the remixed host component", async () => {
      function TopMerchants() {
        return <table><tbody><tr><td>Blue Bottle</td></tr></tbody></table>;
      }
      const fork = { id: "app_fork", name: "Top merchants", seed: { component: "TopMerchants" } } as unknown as AppDocument;
      render(
        <VendoProvider client={parking({
          list: async () => [fork],
          get: async () => fork,
          open: async () => ({ kind: "tree", payload: PAYEES }),
        })}>
          <Remixable><TopMerchants /></Remixable>
        </VendoProvider>,
      );
      await press();
      expect(await askedFor()).toBe("Send $47.50 to Acme Utilities?");
    });
  });
});
