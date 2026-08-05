// @vitest-environment jsdom
// Build contract §9.9 / design §13 — the adoption card and the window label.
// A stopped automation is a card ON THE APP (additive venue state on the open
// payload, served only to editors), and every automation says whose access it
// runs with.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { VendoProvider, createVendoClient } from "../../src/index.js";
import {
  ADOPTION_VENUE_KEY,
  AdoptionCard,
  AdoptionVenueCard as AdoptionCardHarness,
  AutomationCard,
} from "../../src/chrome/index.js";
import { TreeView } from "../../src/tree/index.js";
import type { AdoptionVenue } from "../../src/wire-types.js";

afterEach(cleanup);

const client = createVendoClient({ baseUrl: "http://127.0.0.1:9" });
const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const WAITING: AdoptionVenue = {
  appId: "app_sweep",
  triggerId: "main",
  automation: "Weekly invoice sweep",
  sponsor: "Dana",
  reason: "edit",
  needs: [
    { tool: "host_listInvoices", title: "List invoices", description: "Read the invoice list", risk: "read" },
    {
      tool: "host_updateInvoice",
      title: "Update invoice",
      description: "Update an invoice",
      risk: "write",
      args: { invoice: "inv_42" },
    },
  ],
};

/** F4 — the provider side and the renderer side must agree on ONE payload key,
 *  or the composition attaches a card nobody ever sees. The constant is the
 *  contract; this asserts the renderer honours it and that it is the key the
 *  automations engine's `adoption()` provider is documented to ride on. */
function treeWith(adoption?: AdoptionVenue): UIPayload {
  const tree: UIPayload & { [ADOPTION_VENUE_KEY]?: AdoptionVenue } = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["heading"] },
      { id: "heading", component: "Text", props: { text: "Invoices", variant: "heading" } },
    ],
  };
  if (adoption !== undefined) tree[ADOPTION_VENUE_KEY] = adoption;
  return tree;
}

const surface = (adoption?: AdoptionVenue) => (
  <VendoProvider client={client}>
    <TreeView tree={treeWith(adoption)} components={{}} onAction={ok} />
  </VendoProvider>
);

describe("AdoptionCard", () => {
  it("says what stopped, who it ran as, and one line per read and write", () => {
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} />
      </VendoProvider>,
    );

    const card = screen.getByRole("article", { name: "Take on — Weekly invoice sweep" });
    expect(card.textContent).toContain("Weekly invoice sweep");
    expect(card.textContent).toContain("Dana");
    // §12 completeness: every read and write enumerated, never one summary
    // line for a compound, with the material arguments where they exist.
    expect(card.textContent).toContain("List invoices");
    expect(card.textContent).toContain("Update invoice");
    expect(card.textContent).toContain("inv_42");
  });

  it("hands the decision to the caller and reports a failure instead of pretending", async () => {
    const onAdopt = vi.fn().mockRejectedValue(
      Object.assign(new Error("app not found: app_sweep"), { code: "not-found" }),
    );
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} onAdopt={onAdopt} />
      </VendoProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /take it on/i }));

    await waitFor(() => expect(onAdopt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/isn’t available/i));
  });

  /** Design §3, the consumer-voice law. Every sentence the wire throws is
   *  written for the HOST DEVELOPER — one names an environment variable,
   *  another carries an app id — and this card rendered `reason.message`
   *  verbatim, so all of them reached whoever was using the app. The Share
   *  dialog and the apps page were given this treatment in the same wave; the
   *  adoption card was missed. */
  it("answers a refusal in the CONSUMER's voice, never the developer's sentence", async () => {
    const refuse = (code: string, message: string) =>
      vi.fn().mockRejectedValue(Object.assign(new Error(message), { code }));

    const forbidden = refuse("forbidden", "editor access is required for app_sweep");
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} onAdopt={forbidden} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /take it on/i }));
    await waitFor(() => {
      const shown = screen.getByRole("alert").textContent ?? "";
      expect(shown).not.toContain("app_sweep");
      expect(shown).not.toMatch(/editor access is required/);
      expect(shown).toMatch(/edit this app/i);
    });
    cleanup();

    const keyless = refuse("cloud-required", "sharing needs Vendo Cloud: set VENDO_API_KEY");
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} onAdopt={keyless} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /take it on/i }));
    await waitFor(() => {
      const shown = screen.getByRole("alert").textContent ?? "";
      expect(shown).not.toMatch(/VENDO_API_KEY|Vendo Cloud/);
      expect(shown).toMatch(/isn’t turned on/i);
    });
  });

  it("shows the settled record once it is adopted, with no decision left to make", () => {
    render(
      <VendoProvider client={client}>
        <AdoptionCard card={WAITING} state="adopted" />
      </VendoProvider>,
    );
    expect(screen.queryByRole("button", { name: /take it on/i })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/running again/i);
  });
});

/** F5 — taking it on is not the end of the ceremony. Adoption re-mints the
 *  automation's grants under the ADOPTER, and until they decide that set the
 *  automation is not running: claiming otherwise is a lie the card can tell in
 *  one render. */
describe("AdoptionVenueCard — what happens after Take it on", () => {
  const approval = (id: string, tool: string, risk: "read" | "write") => ({
    id,
    call: { id: `call_${id}`, tool, args: {} },
    descriptor: { name: tool, description: `${tool} description`, inputSchema: { type: "object" }, risk },
    inputPreview: `Allow the automation to use ${tool} while you're away`,
    ctx: { principal: { kind: "user" as const, subject: "user_omar" }, venue: "automation" as const, presence: "present" as const },
    createdAt: "2026-08-01T09:00:00.000Z",
  });

  const clientWith = (
    adopt: () => Promise<{ adopted: boolean; missing: unknown[]; grantSetId?: string; reason?: string }>,
    decide = vi.fn(async () => undefined),
  ) => {
    const base = createVendoClient({ baseUrl: "http://127.0.0.1:9" });
    return {
      client: {
        ...base,
        automations: { ...base.automations, adopt },
        approvals: { ...base.approvals, decide },
      } as unknown as typeof base,
      decide,
    };
  };

  it("asks the adopter for the automation's permissions before claiming anything runs", async () => {
    const missing = [approval("apr_read", "host_listInvoices", "read"), approval("apr_write", "host_updateInvoice", "write")];
    const { client: bound, decide } = clientWith(
      async () => ({ adopted: true, missing, grantSetId: "gset_1" }),
    );
    render(
      <VendoProvider client={bound}>
        <AdoptionCardHarness card={WAITING} />
      </VendoProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /take it on/i }));

    // The enable-flow set card, not a claim of success.
    const set = await screen.findByRole("article", { name: /Standing access/ });
    expect(set.textContent).toContain("2 permissions");
    expect(screen.queryByText(/running again/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /allow both/i }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(
      ["apr_read", "apr_write"],
      { approve: true },
      { grantSetId: "gset_1" },
    ));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/running again/i));
  });

  it("claims it runs only when adoption needed no new permissions", async () => {
    const { client: bound } = clientWith(async () => ({ adopted: true, missing: [] }));
    render(
      <VendoProvider client={bound}>
        <AdoptionCardHarness card={WAITING} />
      </VendoProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /take it on/i }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/running again/i));
  });

  it("tells the loser of the race the truth", async () => {
    const { client: bound } = clientWith(
      async () => ({ adopted: false, missing: [], reason: "already-adopted" }),
    );
    render(
      <VendoProvider client={bound}>
        <AdoptionCardHarness card={WAITING} />
      </VendoProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /take it on/i }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already took/i));
    expect(screen.queryByText(/running again/i)).toBeNull();
  });
});

describe("the adoption card as venue state", () => {
  it("renders above the app when one is waiting, and not otherwise", () => {
    render(surface());
    expect(screen.queryByRole("article", { name: /^Take on/ })).toBeNull();
    cleanup();

    render(surface(WAITING));
    expect(screen.getByRole("article", { name: "Take on — Weekly invoice sweep" })).toBeTruthy();
  });

  it("is the one key the constant names, so composition cannot silently miss it", () => {
    expect(ADOPTION_VENUE_KEY).toBe("adoption");
    render(surface(WAITING));
    expect(screen.getByRole("article", { name: "Take on — Weekly invoice sweep" })).toBeTruthy();
  });

  it("tolerates a malformed venue field without breaking the surface", () => {
    render(surface("nonsense" as unknown as AdoptionVenue));
    expect(screen.queryByRole("article", { name: /^Take on/ })).toBeNull();
    expect(screen.getByText("Invoices")).toBeTruthy();
  });
});

describe("the window label", () => {
  it("names whose access the automation runs with, and the wider editor set", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard
          name="Weekly invoice sweep"
          enabled
          sponsor={{ subject: "user_dana", display: "Dana" }}
          editors={3}
        />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: "Automation — Weekly invoice sweep" });
    expect(card.textContent).toContain("Runs with Dana's access");
    expect(card.textContent).toContain("3 people can edit");
  });

  it("falls back to the subject when no display name is knowable, and stays quiet with no sponsor", () => {
    render(
      <VendoProvider client={client}>
        <AutomationCard name="Solo" enabled sponsor={{ subject: "user_dana" }} />
      </VendoProvider>,
    );
    expect(screen.getByRole("article", { name: "Automation — Solo" }).textContent)
      .toContain("Runs with user_dana's access");
    cleanup();

    render(
      <VendoProvider client={client}>
        <AutomationCard name="Unsponsored" enabled />
      </VendoProvider>,
    );
    expect(screen.getByRole("article", { name: "Automation — Unsponsored" }).textContent)
      .not.toContain("Runs with");
  });
});
