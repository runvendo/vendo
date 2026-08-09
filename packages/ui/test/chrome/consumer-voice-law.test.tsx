// @vitest-environment jsdom
/**
 * spec §16 law 3 — the consumer-voice guarantees, asserted through the REAL
 * components: no developer sentence, no id, no raw error ever reaches an
 * end-user surface.
 *
 * Every case here was seen LIVE on demo-bank during the redesign wave. The law
 * is not "our copy is nice"; it is that strings authored for a MODEL or a HOST
 * DEVELOPER have a different home (the model's own context, the server log, the
 * dev-mode console) and must not arrive on a bank customer's screen.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRequest } from "@vendoai/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VendoProvider, createVendoClient, type VendoClient } from "../../src/index.js";
import {
  ActivityLedger,
  ActivityPanel,
  ApprovalCard,
  AutomationCard,
  AutomationsPanel,
  ConnectCard,
  ConnectedAccountsPanel,
  GrantSetCard,
  VendoThread,
  WaitingQueue,
  type GrantSetPermission,
} from "../../src/chrome/index.js";
import { consumerVoiceViolation } from "../../src/consumer-voice.js";
import { appEditAudit, createWireServer } from "../wire-server.js";

let wire: Awaited<ReturnType<typeof createWireServer>>;
let client: VendoClient;

beforeEach(async () => {
  wire = await createWireServer();
  client = createVendoClient({ baseUrl: wire.url });
});

afterEach(async () => {
  cleanup();
  await wire.close();
});

/** The exact string seen on `standing-01-pending.png`, from demo-bank's own
 *  `.vendo/tools.json` — a sentence written for the MODEL, rendered faithfully
 *  at a bank customer. */
const MODEL_INSTRUCTION =
  "Spending by category for the current period. Amounts are integer cents"
  + " (e.g. 285000 = $2,850.00): divide by 100 exactly once before displaying,"
  + " including any totals you compute. Do not re-divide.";

/** The wire part carries the descriptor's description and `thread/parts.tsx`
 *  casts it straight into the card's props — so the cast is how a description
 *  reaches this component in production, and the cast is what the law has to
 *  survive. */
const wirePermissions = (description: string): GrantSetPermission[] => ([
  { approvalId: "apr_1", tool: "host_getSpendingInsights", description, risk: "read" },
  { approvalId: "apr_2", tool: "host_transferMoney", description, risk: "destructive" },
] as unknown as GrantSetPermission[]);

/** Everything a person can READ or HEAR from a rendered surface: every text node,
 *  every accessible name AND every `title` tooltip, one per line so adjacent
 *  nodes cannot glue into a token neither of them contains.
 *
 *  RULING 17a — `title` used to be excluded "on purpose", to let the consent
 *  cards keep the raw argument value one hover away. That exclusion is how L37
 *  survived every audit in the wave: a tooltip IS an end-user surface, and the
 *  cards were putting raw JSON and developer literals in one. The sweep can see
 *  it now. */
function readable(root: ParentNode): string {
  const lines: string[] = [];
  const walker = (root.ownerDocument ?? (root as Document))
    .createTreeWalker(root as Node, 4 /* NodeFilter.SHOW_TEXT */);
  while (walker.nextNode()) lines.push(walker.currentNode.textContent ?? "");
  for (const node of root.querySelectorAll("[aria-label]")) lines.push(node.getAttribute("aria-label") ?? "");
  for (const node of root.querySelectorAll("[title]")) lines.push(node.getAttribute("title") ?? "");
  return lines.join("\n");
}

/** The vocabulary is `src/consumer-voice.ts` — the SAME definition the render
 *  paths gate a descriptor sentence with, so the law and the product can never
 *  drift into two opinions of what a developer string looks like. */
function auditReadable(root: ParentNode, surface: string): void {
  const violation = consumerVoiceViolation(readable(root));
  expect(violation === undefined ? "" : `${surface} rendered ${violation}`).toBe("");
}

describe("LEAK 1 — the standing-access card rendered model instructions", () => {
  it("never prints a model-authored descriptor description on a grant row", () => {
    render(
      <VendoProvider client={client}>
        <GrantSetCard name="Spending watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: /Standing access/ });
    expect(card.textContent).not.toContain("integer cents");
    expect(card.textContent).not.toContain("e.g.");
    expect(card.textContent).not.toContain("divide by 100");
    expect(card.textContent).not.toContain("Do not");
  });

  it("describes each permission in OUR words instead — the verb and the thing", () => {
    render(
      <VendoProvider client={client}>
        <GrantSetCard name="Spending watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />
      </VendoProvider>,
    );
    const rows = [...document.querySelectorAll(".fl-grant")].map(row => row.textContent);
    // ⚠️ TEST EDIT (ruling 15): the second row used to read "Changes: Transfer
    // money" — a DESTRUCTIVE permission described with the word an ordinary
    // write gets. An irreversible grant now says so.
    expect(rows).toEqual(["Reads: Get spending insights", "Irreversible: Transfer money"]);
    // The cadence stays on the card's own plain-words line, said once.
    expect(document.querySelector(".fl-card-line")?.textContent)
      .toContain("Granted once, used every run");
  });

  it("keeps the HOST's own consumer sentence, which is the one authored for people", () => {
    render(
      <VendoProvider client={client} tools={{ host_getSpendingInsights: { description: "Reads your spending totals." } }}>
        <GrantSetCard name="Spending watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />
      </VendoProvider>,
    );
    const card = screen.getByRole("article", { name: /Standing access/ });
    expect(card.textContent).toContain("Reads your spending totals.");
    expect(card.textContent).not.toContain("integer cents");
  });
});

describe("LEAK 2 — the connect card printed the wire's developer sentence", () => {
  /** The real refusal from a keyless (default OSS) deployment: it names a
   *  TypeScript call and an environment variable. */
  const developerSentence =
    "connected accounts are not configured: pass a Composio connector (composioConnector)"
    + " to createVendo({ connectors }) or set VENDO_API_KEY for the Vendo Cloud broker";

  const failing = (code: string | undefined) => {
    const base = createVendoClient({ baseUrl: wire.url });
    const reason = Object.assign(new Error(developerSentence), code === undefined ? {} : { code });
    return {
      ...base,
      connections: { ...base.connections, initiate: async () => { throw reason; } },
    } as unknown as VendoClient;
  };

  const clickConnect = async (bound: VendoClient) => {
    render(
      <VendoProvider client={bound}>
        <ConnectCard connector="composio" toolkit="slack" message="Connect Slack to post." onConnected={() => undefined} />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Slack" }));
    return await waitFor(() => screen.getByRole("alert"));
  };

  it("tells the person what it means for them, never how to configure the SDK", async () => {
    const alert = await clickConnect(failing("not-implemented"));
    expect(alert.textContent).not.toContain("createVendo");
    expect(alert.textContent).not.toContain("VENDO_API_KEY");
    expect(alert.textContent).not.toContain("pass a");
    expect(alert.textContent).toMatch(/isn’t set up/i);
    expect(alert.textContent).toContain("Slack");
  });

  it("stays consumer-voiced for an uncoded failure too (OAuth failed, expired, timed out)", async () => {
    const alert = await clickConnect(failing(undefined));
    expect(alert.textContent).not.toContain("createVendo");
    expect(alert.textContent).not.toContain("composioConnector");
    expect(alert.textContent).toMatch(/couldn’t finish connecting Slack/i);
  });

  it("keeps the developer sentence for developers — the dev-mode console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      await clickConnect(failing("not-implemented"));
      await waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("createVendo"));
    } finally {
      process.env.NODE_ENV = previous;
      warn.mockRestore();
    }
  });
});

/** The set card's own refusal was the same defect: it rendered `reason.message`
 *  from whatever the caller's decide threw. */
describe("LEAK 2, the sibling — the standing-access card's own refusal", () => {
  it("shows a consumer sentence when the decision does not go through", async () => {
    render(
      <VendoProvider client={client}>
        <GrantSetCard
          name="Spending watcher"
          permissions={wirePermissions("")}
          state="parked"
          onDecide={() => { throw Object.assign(new Error("grant set gset_1 not found for app app_9"), { code: "not-found" }); }}
        />
      </VendoProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /allow both/i }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).not.toContain("gset_1");
    expect(alert.textContent).not.toContain("app_9");
    expect(alert.textContent).toMatch(/isn’t available/i);
  });
});

/**
 * LEAK 5 (ruling 11) — the approval card's own descriptor hole. The card
 * rendered `descriptor.description` as its MANDATORY plain-words line and its
 * queue row did the identical thing, so demo-bank's model instruction reached a
 * consent card at a bank customer. Precedence: the host's own sentence → the
 * consequence synthesized from the real inputs → the descriptor's own sentence
 * ONLY IF it reads as consumer copy → the consequence class.
 */
describe("LEAK 5 — a descriptor sentence may never be the card's plain-words line", () => {
  const ask = (description: string): ApprovalRequest => ({
    id: "apr_desc",
    call: { id: "call_desc", tool: "host_getSpendingInsights", args: { period: "month" } },
    descriptor: {
      name: "host_getSpendingInsights",
      description,
      inputSchema: { type: "object", properties: { period: { type: "string" } } },
      risk: "read",
    },
    inputPreview: "host_getSpendingInsights {\"period\":\"month\"}",
    ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
    createdAt: "2026-08-03T12:00:00.000Z",
  } as unknown as ApprovalRequest);

  /** A clean sentence a HOST author would write for people. */
  const HOST_AUTHORED = "Shows what you spent by category this month.";

  const cardLine = (): string | undefined =>
    document.querySelector(".fl-card-line")?.textContent ?? undefined;

  const showCard = (description: string, onDecide: (() => void) | undefined = undefined) =>
    render(
      <VendoProvider client={client}>
        <ApprovalCard approval={ask(description)} onDecide={onDecide ?? (() => undefined)} />
      </VendoProvider>,
    );

  /** The queue row goes through the real hook, so the ask arrives the way the
   *  wire delivers it. */
  const showQueueAsk = (pending: ApprovalRequest, tools: Record<string, { description: string }> = {}) => {
    const base = createVendoClient({ baseUrl: wire.url });
    const bound = {
      ...base,
      approvals: { ...base.approvals, pending: async () => [pending] },
    } as unknown as VendoClient;
    render(
      <VendoProvider client={bound} tools={tools}>
        <WaitingQueue pollMs={0} />
      </VendoProvider>,
    );
    return waitFor(() => screen.getByRole("article", { name: /Approval for/ }));
  };

  const showQueue = (description: string) => showQueueAsk(ask(description));

  it("drops a model-instruction descriptor from the card and says what the call does instead", () => {
    showCard(MODEL_INSTRUCTION);
    const card = screen.getByRole("article", { name: /Approval for/ });
    expect(card.textContent).not.toContain("integer cents");
    expect(card.textContent).not.toContain("divide by 100");
    expect(card.textContent).not.toContain("e.g.");
    // Not truncated into nonsense either — the next tier answers in full.
    expect(cardLine()).toBe("This reads your data, as you.");
  });

  it("drops it from the QUEUE ROW too — the card and its row cannot diverge", async () => {
    const row = await showQueue(MODEL_INSTRUCTION);
    expect(row.textContent).not.toContain("integer cents");
    expect(row.textContent).not.toContain("divide by 100");
    expect(cardLine()).toBe("This reads your data, as you.");
  });

  it("drops the extraction's raw HTTP description — the demo hosts' own shape", () => {
    showCard("POST /api/demo/pin");
    expect(screen.getByRole("article", { name: /Approval for/ }).textContent).not.toContain("/api/demo/pin");
    expect(cardLine()).toBe("This reads your data, as you.");
  });

  // ⚠️ TEST EDIT (ruling 14 reverses ruling 11): this asserted that a "clean"
  // DESCRIPTOR sentence still occupied the card's plain-words line — the exact
  // behaviour ruling 14 removes. A descriptor is authored for the model or minted
  // by extraction, and whether it "reads clean" was decided by a regex set that
  // admitted raw JSON and exceptions. There is no rung for it now: the same
  // sentence in the HOST's own ToolMeta (the human-authored channel) is shown,
  // and from the wire it is dropped.
  it("drops even a CLEAN-READING descriptor sentence — the wire is not an authoring channel", async () => {
    showCard(HOST_AUTHORED);
    expect(cardLine()).toBe("This reads your data, as you.");
    cleanup();
    const row = await showQueue(HOST_AUTHORED);
    expect(row.textContent).not.toContain(HOST_AUTHORED);
    expect(cardLine()).toBe("This reads your data, as you.");
  });

  it("shows that same sentence when the HOST authored it in its own ToolMeta", async () => {
    const tools = { host_getSpendingInsights: { description: HOST_AUTHORED } };
    render(
      <VendoProvider client={client} tools={tools}>
        <ApprovalCard approval={ask("")} onDecide={() => undefined} />
      </VendoProvider>,
    );
    expect(cardLine()).toBe(HOST_AUTHORED);
    cleanup();
    const row = await showQueueAsk(ask(""), tools);
    expect(row.textContent).toContain(HOST_AUTHORED);
  });

  /** H6 + ruling 14 — ONE ladder, so the card and the row are the same sentence
   *  on the same fixture, at every rung. */
  describe("the card and its queue row read from one ladder", () => {
    /** RULING 21 — this fixture had `descriptor.name === call.tool` at every
     *  tier, so it could not see H-1: the card classified off
     *  `descriptor.name` while its queue row classified off `call.tool`, and a
     *  server-served ask where those differ printed two different sentences
     *  for ONE ask. They differ here now, the way a server that names its
     *  descriptors independently of the wire tool id serves them. */
    const money = (): ApprovalRequest => ({
      id: "apr_money",
      call: {
        id: "call_money",
        tool: "host_transferMoney",
        args: { amount_cents: 4750, recipient_name: "Acme Utilities" },
      },
      descriptor: {
        name: "payments.transfer.v2",
        title: "Send money",
        // The wire's own sentence rides along and must reach neither surface.
        description: MODEL_INSTRUCTION,
        inputSchema: {},
        risk: "write",
      },
      inputPreview: 'host_transferMoney {"amount_cents":4750}',
      ctx: { principal: { kind: "user", subject: "user_1" }, venue: "chat", presence: "present" },
      createdAt: "2026-08-03T12:00:00.000Z",
    } as unknown as ApprovalRequest);

    it("tier 2 — the same synthesized consequence, word for word", async () => {
      render(
        <VendoProvider client={client}>
          <ApprovalCard approval={money()} onDecide={() => undefined} />
        </VendoProvider>,
      );
      const onCard = cardLine();
      expect(onCard).toBe("Sends $47.50 to Acme Utilities — now, as you.");
      cleanup();
      const row = await showQueueAsk(money());
      expect(cardLine()).toBe(onCard);
      expect(row.textContent).not.toContain("integer cents");
    });

    it("tier 1 — the host's own sentence, on both", async () => {
      const tools = { host_transferMoney: { description: "Pays your water bill from checking." } };
      render(
        <VendoProvider client={client} tools={tools}>
          <ApprovalCard approval={money()} onDecide={() => undefined} />
        </VendoProvider>,
      );
      const onCard = cardLine();
      expect(onCard).toBe("Pays your water bill from checking.");
      cleanup();
      await showQueueAsk(money(), tools);
      expect(cardLine()).toBe(onCard);
    });

    it("tier 4 — the same class sentence when nothing truthful can be said", async () => {
      const bare = (): ApprovalRequest => ({
        ...money(),
        call: { id: "call_bare", tool: "host_transferMoney", args: { note: "hi" } },
      } as unknown as ApprovalRequest);
      render(
        <VendoProvider client={client}>
          <ApprovalCard approval={bare()} onDecide={() => undefined} />
        </VendoProvider>,
      );
      const onCard = cardLine();
      // Grade-driven (Yousef's D1): `money()` is graded `write`. The old
      // string came from the tool id's "transfer" token, which no longer votes.
      expect(onCard).toBe("This changes something in your account, as you.");
      cleanup();
      await showQueueAsk(bare());
      expect(cardLine()).toBe(onCard);
    });
  });

  it("tells the person what a failed decision means, never the wire's sentence", async () => {
    showCard(HOST_AUTHORED, () => {
      throw Object.assign(new Error("approval apr_desc not found for app app_9"), { code: "not-found" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).not.toContain("apr_desc");
    expect(alert.textContent).not.toContain("app_9");
    expect(alert.textContent).toMatch(/isn’t waiting on you any more/i);
  });
});

/** LEAK 3 — the composer printed the BROWSER's sentence. A failed attachment
 *  read rendered `reason.message`, which for a real FileReader failure is
 *  "NotReadableError: The requested file could not be read…" — a developer
 *  string with a code in it, on the most everyday surface there is. */
describe("LEAK 3 — a failed attachment read speaks to the person", () => {
  const BROWSER_SENTENCE = "NotReadableError: The requested file could not be read, typically due to permission problems";

  /** Every read fails, the way a revoked file handle fails in a real browser. */
  class FailingFileReader {
    error = new Error(BROWSER_SENTENCE);
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    onprogress: (() => void) | null = null;
    result: string | null = null;
    readAsDataURL(): void {
      queueMicrotask(() => this.onerror?.());
    }
  }

  afterEach(() => vi.unstubAllGlobals());

  it("says what happened and that nothing was sent — never the browser's error", async () => {
    vi.stubGlobal("FileReader", FailingFileReader);
    render(<VendoProvider client={client}><VendoThread threadId="thr_1" /></VendoProvider>);
    await screen.findByText("Existing thread");
    const form = screen.getByRole("form", { name: "Message composer" });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [file] } });
    await screen.findByText("notes.txt");

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "here you go" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).not.toContain("NotReadableError");
    expect(alert.textContent).toMatch(/nothing was sent/i);
    // And the message itself is still there to send again.
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("here you go");
  });
});

/**
 * THE WIDENED AUDIT — every chrome surface, not just the cards.
 *
 * Two halves, because each catches what the other cannot: a RENDER sweep (what
 * actually reaches the screen, with hostile data pushed through the real
 * components) and a SOURCE sweep (the shapes that let developer strings onto a
 * screen in the first place, so the class cannot come back through a file this
 * wave never looked at).
 */
describe("the widened audit — no chrome surface renders a developer string", () => {
  /** Every surface a person can reach, mounted the way a host mounts it. The
   *  wire fixture is deliberately full of our plumbing (app_auto, apr_set_1,
   *  gset_1, grt_1, tool slugs, canonical previews), so a surface that prints
   *  any of it fails here. */
  /** RULING 17a, again — the sweep waited for "any text at all", which every
   *  wire-backed panel satisfies with its own HEADER before a single row has
   *  loaded. It was therefore auditing "Loading activity…" and calling the
   *  activity rail clean: CR-2's id-shaped VALUES ("App id app_9a3f2b1c") were
   *  invisible to it. A surface whose content arrives over the wire now names
   *  the content the sweep has to see first. */
  const SETTLED: Record<string, RegExp> = {
    activity: /Invoices list/,
    "automations panel": /Invoice watcher/,
    "connected accounts": /Gmail/,
  };

  const SURFACES: Array<[string, React.ReactNode]> = [
    ["standing access", <GrantSetCard name="Invoice watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="parked" />],
    ["standing access, settled", <GrantSetCard name="Invoice watcher" permissions={wirePermissions(MODEL_INSTRUCTION)} state="approved" />],
    ["connect", <ConnectCard connector="composio" toolkit="googlecalendar" message="Connect Google Calendar to check your day." onConnected={() => undefined} />],
    ["automation", <AutomationCard name="Low balance alert" enabled description="Emails you when checking dips." />],
    // Ruling 17a — the sweep never mounted the APPROVAL CARD, the surface the
    // whole §16 law was written for. With a money ask (a formatted value, a
    // graded chip) it exercises the tooltip and chip paths the widened
    // `readable()` can now see.
    ["approval card", <ApprovalCard
      approval={{
        id: "apr_sweep",
        call: {
          id: "call_sweep",
          tool: "host_getSpendingInsights",
          args: { amount_cents: 4750, recipient_name: "Acme Utilities", permanent: true },
        },
        descriptor: {
          name: "host_getSpendingInsights",
          title: "Send money",
          description: MODEL_INSTRUCTION,
          inputSchema: {},
          risk: "destructive",
        },
        inputPreview: 'host_getSpendingInsights {"amount_cents":4750}',
        ctx: { principal: { kind: "user", subject: "user_1" }, venue: "app", presence: "present", appId: "app_7f3a2b41" },
        createdAt: "2026-08-03T12:00:00.000Z",
      } as unknown as ApprovalRequest}
      onDecide={() => undefined}
    />],
    ["waiting strip", <WaitingQueue pollMs={0} />],
    ["activity", <ActivityPanel />],
    // RULING 21 — the panel above only ever paints the wire's FIRST page, so
    // the audit shape that carries an id (`vendo_make` changing an app: an app
    // id and the person's request) could not reach the sweep through it. The
    // ledger is the shared component both activity surfaces render, so the class
    // is audited on the component, from the same fixture the wire serves.
    ["activity ledger, the vendo_make change shape", <ActivityLedger events={[appEditAudit()]} />],
    ["automations panel", <AutomationsPanel />],
    ["connected accounts", <ConnectedAccountsPanel />],
  ];

  it("sweeps every surface for ids, code, dotted paths, env vars and config instructions", async () => {
    for (const [surface, node] of SURFACES) {
      const view = render(<VendoProvider client={client}>{node}</VendoProvider>);
      // Let the wire-backed surfaces paint their real content before auditing.
      await waitFor(() => expect(view.container.textContent?.length ?? 0).toBeGreaterThan(0));
      const settled = SETTLED[surface];
      if (settled !== undefined) {
        await waitFor(() => expect(view.container.textContent ?? "").toMatch(settled));
      }
      auditReadable(view.container, surface);
      cleanup();
    }
  });

  /**
   * The SHAPES that produce the leak, across every chrome and voice source —
   * widened from the wave's ten-file card list to the whole tree, recursively.
   *
   * `KNOWN_OPEN` is not an excuse list: each entry is a live violation, with the
   * reason it is still there. Pass 3 closed the last three (approval-card,
   * thread/composer, automations-panel), leaving only the one that is a DECIDED
   * exception rather than an open defect.
   */
  // Pass 3 closed the last three (approval-card, thread/composer,
  // automations-panel); the post-check round closed the final entry, embeds.tsx
  // (M36) — the "decided exception" was the BYO-agent embed rendering the wire's
  // own sentence, and ruling 18 answers it differently: one honest line plus
  // Try again, with the wire's half dev-mode only. The table is now EMPTY, and
  // the staleness check below keeps it honest.
  const KNOWN_OPEN: Record<string, string> = {};

  const chromeSources = (): string[] => {
    const collect = (dir: string): string[] =>
      readdirSync(join("src", dir), { recursive: true, encoding: "utf8" })
        .filter(name => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
        .map(name => `${dir}/${name}`);
    return collect("chrome");
  };

  it("has no NEW raw-error render anywhere under src/chrome", () => {
    // Two shapes: the JSX render of a failure's own sentence (`{error.message}`,
    // never a `${...}` interpolation or a consumer-authored `message` prop), and
    // the state write that feeds one (`setError(reason instanceof Error ? …)`).
    const RAW_RENDER = /(?<![$`])\{[^{}\n]*\b(?:error|err|reason|failure|cause)\.message\s*\}/i;
    const RAW_STATE = /set\w*Error\w*\(\s*\w+\s+instanceof\s+Error\s*\?/;
    const offenders = chromeSources().filter(file => {
      // Comments and dev-mode console rails are the developer's own channel.
      const source = readFileSync(join("src", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ")
        .replace(/console\.\w+\([\s\S]*?\);/g, " ");
      return RAW_RENDER.test(source) || RAW_STATE.test(source);
    });
    const unexpected = offenders.filter(file => KNOWN_OPEN[file.replace(/^chrome\//, "")] === undefined);
    expect(unexpected).toEqual([]);
    // And the list stays honest: an entry that stops being a violation must be
    // deleted, so the table can never rot into a blanket exemption.
    const stale = Object.keys(KNOWN_OPEN)
      .filter(name => !offenders.some(file => file.replace(/^chrome\//, "") === name));
    expect(stale).toEqual([]);
  });

  it("has no developer configuration sentence in any chrome copy", () => {
    // The exact phrases the wire's own refusals use. A component may only ever
    // hand these to the dev-mode console, never to a rendered string, so the
    // console lines are stripped before the scan.
    const CONFIG_PHRASE = /(?:pass a |set VENDO_|createVendo\()/;
    const offenders = chromeSources().filter(file => {
      const source = readFileSync(join("src", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ")
        .replace(/console\.\w+\([\s\S]*?\);/g, " ");
      return CONFIG_PHRASE.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
