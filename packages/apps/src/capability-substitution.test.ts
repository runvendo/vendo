/**
 * D5 — the capability-substitution gate, tested against the REAL measured
 * cases on both surfaces.
 *
 * Anti-overfitting law: every FAIL case here is paired with the legitimate
 * call it must not be confused with. The two anchors are live:
 *   FAIL — maple, "a button that I can use to approve all requests … send to
 *          SLAC KAFTERWARDS": host_transferMoney used as a Slack channel
 *          (runs/20260726-235241-1e17/vendo.wire.txt).
 *   PASS — cadence, "let me chase every overdue invoice in one go":
 *          host_sendClientMessage over a selected client + form state
 *          (runs/_measure/baseline/20260727-001807-93e8/vendo.wire.txt).
 */
import { VENDO_TREE_FORMAT, type NormalizedCatalog, type Tree } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { modelEngine } from "./generation/engine.js";
import {
  capabilitySubstitutionIssues,
  islandSubstitutionViolations,
} from "./generation/validation/capability-substitution.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "./testing/scripted-model.js";
import type { HostToolInfo } from "./generation/engine.js";

// The two hosts' real mutating surfaces, verbatim from examples/demo-bank and
// examples/demo-accounting `.vendo/tools.json`.
const tools: HostToolInfo[] = [
  {
    name: "host_listTransactions",
    description: "Recent transactions",
    risk: "read",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "host_transferMoney",
    description: "Send money to a recipient",
    risk: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "integer", minimum: 1, description: "Amount to send in cents" },
        recipient_name: { type: "string", description: "Who the money goes to, e.g. Alex Rivera" },
        memo: { type: "string", description: "Optional note shown on the transfer" },
      },
    },
  },
  {
    name: "host_sendClientMessage",
    description: "Message a client",
    risk: "destructive",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Client id" },
        body: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", description: "Message text" },
            author: { type: "string", description: "Staff member sending the message" },
          },
        },
      },
    },
  },
  {
    name: "host_setDocumentStatus",
    description: "Advance a document request",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Client id" },
        docId: { type: "string", description: "Document request id" },
        body: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["receive", "verify", "reject"] },
            fileName: { type: "string" },
          },
        },
      },
    },
  },
];

const island = (body: string): string => `export default function Panel({ rows }) {\n${body}\n  return <Stack/>;\n}`;

const tree = (props: Record<string, unknown>): Tree => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "Stack", source: "prewired", children: ["button-1"] },
    { id: "button-1", component: "Button", source: "prewired", props: props as never },
  ],
}) as Tree;

// ---------------------------------------------------------------------------
// The measured FAIL — a payments API repurposed as a messaging channel
// ---------------------------------------------------------------------------

describe("island source — capability substitution", () => {
  const slackRequest = "a button that I can use to approve all requests. it should open up a popup with my transcactions, and then send to SLAC KAFTERWARDS";

  it("the live Slack-memo transfer FAILS the gate", () => {
    const source = island(`
  async function approveAndForward() {
    const summary = rows.map(r => r.merchant).join(' | ');
    // Since there's no Slack tool, we'll use host_transferMoney with a $0.01 sentinel
    const result = await tools.host_transferMoney({
      amount: 1,
      recipient_name: 'Slack Forwarding Bot',
      memo: 'APPROVED TRANSACTIONS: ' + summary
    });
  }`);
    const violations = islandSubstitutionViolations(source, tools, slackRequest);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("host_transferMoney");
    expect(violations[0]).toContain("amount=1");
    expect(violations[0]).toContain('recipient_name="Slack Forwarding Bot"');
    // The message must route repair to the honest answer, not to a rewrite of
    // the fake call.
    expect(violations[0]).toContain("This part of the request isn't available on this host.");
  });

  it("a fabricated recipient alone FAILS (amount from user input)", () => {
    const source = island(`
  const [cents, setCents] = useState(0);
  const send = () => tools.host_transferMoney({ amount: cents, recipient_name: "Reporting Bot" });`);
    expect(islandSubstitutionViolations(source, tools, "email me a weekly report")).toHaveLength(1);
  });

  it("a fabricated amount alone FAILS (recipient from a row)", () => {
    const source = island(`
  const send = (row) => tools.host_transferMoney({ amount: 4200, recipient_name: row.name });`);
    expect(islandSubstitutionViolations(source, tools, "let me pay a saved payee")).toHaveLength(1);
  });

  it("a fabricated id inside a NESTED argument object FAILS", () => {
    const source = island(`
  const nudge = () => tools.host_setDocumentStatus({ id: "cl_rivera", docId: "doc_1", body: { action: "receive" } });`);
    const violations = islandSubstitutionViolations(source, tools, "log the missing docs somewhere");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('id="cl_rivera"');
    expect(violations[0]).toContain('docId="doc_1"');
    // The enum-constrained lifecycle action is config, never a fabricated
    // operand.
    expect(violations[0]).not.toContain("action");
  });

  // A gate that reads only plain decimals publishes its own bypass: the live
  // defect's `amount: 1` sentinel is `0x1`, `1e0`, `+1` or `(1)` in four other
  // spellings, all of them just as hand-typed.
  it.each([
    "1e0", "0x1", "1_00", "+1", "(1)", "0b1", "0o1", ".5", "1.5e2",
    // Signs and parens peel in any order, with any spacing.
    "+ 1", "- 1", "-1", "-(1)", "( + 1 )", "+0x1", "- 1_00", "((1))", "- +1",
    // Island source is TSX, so a type assertion is legal syntax around it.
    "1 as number", "1 as const", "1 satisfies number", "1 as unknown as number", "(1 as const)",
  ])(
    "a fabricated amount spelled %s FAILS like a plain decimal",
    (amount) => {
      const source = island(`
  const send = (row) => tools.host_transferMoney({ amount: ${amount}, recipient_name: row.name });`);
      expect(islandSubstitutionViolations(source, tools, "let me pay a saved payee")).toHaveLength(1);
    },
  );

  // The controls for the peeling loop: anything that is not JUST a number
  // behind wrappers must stay a reference.
  it.each([
    "(count + 1)", "count + 1", "-count", "(count)", "+row.amount", "(a) + (1)",
    "count as number", "row.amount as const",
  ])(
    "an expression spelled %s is still a reference, not a literal",
    (amount) => {
      const source = island(`
  const send = (row, count, a) => tools.host_transferMoney({ amount: ${amount}, recipient_name: row.name });`);
      expect(islandSubstitutionViolations(source, tools, "let me pay a saved payee")).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Counter-examples — every legitimate mutating call must pass
// ---------------------------------------------------------------------------

describe("island source — legitimate mutating calls PASS", () => {
  it("the measured Cadence chase-invoices case PASSES", () => {
    // Verbatim shape from the baseline run: a selected client id, form-state
    // body, and a hand-typed `author` — which is neither target nor amount.
    const source = `export default function ChaseMessagePanel({ clients }) {
  const rows = Array.isArray(clients) ? clients : [];
  const [selectedId, setSelectedId] = useState(rows[0]?.id ?? "");
  const [body, setBody] = useState("Hi, just a friendly reminder…");
  async function handleSend() {
    const result = await tools.host_sendClientMessage({ id: selectedId, body: { body, author: "Firm" } });
  }
  return <Stack/>;
}`;
    expect(islandSubstitutionViolations(source, tools, "let me chase every overdue invoice in one go")).toEqual([]);
  });

  it("a form submit with field-derived values PASSES", () => {
    const source = island(`
  const [recipient, setRecipient] = useState("");
  const [dollars, setDollars] = useState("");
  const submit = () => tools.host_transferMoney({
    amount: Math.round(parseFloat(dollars) * 100),
    recipient_name: recipient.trim(),
    memo: memo || "Transfer",
  });`);
    expect(islandSubstitutionViolations(source, tools, "let me transfer money between my accounts")).toEqual([]);
  });

  it("a row action with a bound id PASSES", () => {
    const source = island(`
  const markReceived = (row) => tools.host_setDocumentStatus({ id: row.clientId, docId: row.id, body: { action: "verify" } });`);
    expect(islandSubstitutionViolations(source, tools, "let me tick off documents as they arrive")).toEqual([]);
  });

  it("the user's OWN named recipient and amount PASS (real corpus app)", () => {
    // "one screen with a single primary button labeled Send $25 to Alex Rivera"
    // — both operands are the user's own parameters, not fabrications.
    const source = island(`
  const send = () => tools.host_transferMoney({ amount: 2500, recipient_name: "Alex Rivera", memo: "Payment to Alex Rivera" });`);
    const request = "one screen with a single primary button labeled Send $25 to Alex Rivera that calls the transfer tool when clicked";
    expect(islandSubstitutionViolations(source, tools, request)).toEqual([]);
  });

  it("a per-row Send $25 button PASSES (user's amount, row's payee)", () => {
    const source = island(`
  const quickSend = (payee) => tools.host_transferMoney({ amount: 2500, recipient_name: payee.name, memo: \`Quick send $25 to \${payee.name}\` });`);
    const request = "list my saved payees; each row has a Send $25 button that immediately transfers $25 from checking to that payee";
    expect(islandSubstitutionViolations(source, tools, request)).toEqual([]);
  });

  it("a READ tool with hand-typed args never trips the gate", () => {
    const source = island(`
  const load = () => tools.host_listTransactions({ limit: 20, accountId: "acc_checking" });`);
    expect(islandSubstitutionViolations(source, tools, "show my recent transactions")).toEqual([]);
  });

  it("operands reaching the call through a variable or a spread PASS", () => {
    const source = island(`
  const payload = buildTransfer();
  const send = () => tools.host_transferMoney(payload);
  const send2 = (base) => tools.host_transferMoney({ ...base, memo: "rent" });`);
    expect(islandSubstitutionViolations(source, tools, "pay my rent")).toEqual([]);
  });

  it("a tool-less registry stays silent (nothing to trace provenance against)", () => {
    const source = island(`  tools.host_transferMoney({ amount: 1, recipient_name: "Bot" });`);
    expect(islandSubstitutionViolations(source, undefined, "anything")).toEqual([]);
    expect(islandSubstitutionViolations(source, [], "anything")).toEqual([]);
  });

  it("prose naming a tool in a string or comment never trips the gate", () => {
    const source = island(`
  const help = "call tools.host_transferMoney({ amount: 1, recipient_name: 'Bot' }) to send";
  // tools.host_transferMoney({ amount: 1, recipient_name: 'Bot' })`);
    expect(islandSubstitutionViolations(source, tools, "explain transfers")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The declarative surface — the tree must not be a loophole
// ---------------------------------------------------------------------------

describe("tree action payloads", () => {
  it("a fabricated recipient/amount in an action payload FAILS", () => {
    const issues = capabilitySubstitutionIssues(
      tree({ label: "Send to Slack", onClick: { action: "host_transferMoney", payload: { amount: 1, recipient_name: "Slack Forwarding Bot", memo: "summary" } } }),
      tools,
      "approve all requests and forward them to Slack",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('node "button-1" prop "onClick"');
    expect(issues[0]).toContain('recipient_name="Slack Forwarding Bot"');
  });

  it("a row action whose payload BINDS the row id PASSES", () => {
    const issues = capabilitySubstitutionIssues(
      tree({ label: "Send reminder", onClick: { action: "host_sendClientMessage", payload: { id: { $path: "clients.0.id" }, body: { body: "Documents still outstanding" } } } }),
      tools,
      "let me nudge clients who owe me documents",
    );
    expect(issues).toEqual([]);
  });

  it("a form submit binding state values PASSES", () => {
    const issues = capabilitySubstitutionIssues(
      tree({ submitLabel: "Transfer", onSubmit: { action: "host_transferMoney", payload: { amount: { $state: "amountCents" }, recipient_name: { $state: "recipient" } } } }),
      tools,
      "let me transfer money between my accounts",
    );
    expect(issues).toEqual([]);
  });

  it("an enum/flag literal in a payload PASSES", () => {
    const issues = capabilitySubstitutionIssues(
      tree({ label: "Mark received", onClick: { action: "host_setDocumentStatus", payload: { id: { $path: "rows.0.clientId" }, docId: { $path: "rows.0.id" }, body: { action: "receive", fileName: "statement.pdf" } } } }),
      tools,
      "let me tick documents off as they arrive",
    );
    expect(issues).toEqual([]);
  });

  it("the user's own named recipient and amount PASS", () => {
    const issues = capabilitySubstitutionIssues(
      tree({ label: "Send $25 to Alex Rivera", onClick: { action: "host_transferMoney", payload: { amount: 2500, recipient_name: "Alex Rivera", memo: "Payment to Alex Rivera" } } }),
      tools,
      "one screen with a single primary button labeled Send $25 to Alex Rivera that calls the transfer tool",
    );
    expect(issues).toEqual([]);
  });

  it("a read-tool action with literal args never trips the gate", () => {
    const issues = capabilitySubstitutionIssues(
      tree({ label: "Refresh", onClick: { action: "host_listTransactions", payload: { limit: 20 } } }),
      tools,
      "show my transactions",
    );
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end — the recorded defect replayed through the real create loop
// ---------------------------------------------------------------------------

describe("create loop", () => {
  const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) =>
    typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")).join("\n");

  it("sends the recorded Slack-memo transfer back to repair, and ships the honest app", async () => {
    // Attempt 1 is the live defect, trimmed to the offending call.
    const substituted = `<App name="Approve & forward"><Stack><Forwarder/></Stack><Island name="Forwarder">export default function Forwarder() {
  const [rows, setRows] = useState([]);
  useEffect(() => { tools.host_listTransactions({ limit: 20 }).then((r) => setRows(r?.data ?? [])); }, []);
  async function approveAndForward() {
    const summary = rows.map((r) => r.merchant).join(' | ');
    await tools.host_transferMoney({ amount: 1, recipient_name: 'Slack Forwarding Bot', memo: 'APPROVED: ' + summary });
  }
  return <Button label="Approve all" onClick={approveAndForward}/>;
}</Island></App>`;
    // The island-scoped repair answers with the honest island: the transactions
    // still render; the part the host cannot do is disclaimed, not faked.
    const honest = `<Island name="Forwarder">export default function Forwarder() {
  const [rows, setRows] = useState([]);
  useEffect(() => { tools.host_listTransactions({ limit: 20 }).then((r) => setRows(r?.data ?? [])); }, []);
  return <Stack><DataTable rows={rows} columns={[{ key: "merchant", label: "Merchant" }]}/><Text text="Forwarding to Slack isn't available on this host — no messaging tool is connected."/></Stack>;
}</Island>`;
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? substituted : honest;
    });
    const document = await modelEngine.create(
      { prompt: "a button that I can use to approve all requests, then send to Slack afterwards" },
      {
        model,
        catalog: [] as NormalizedCatalog,
        tools,
        pipeline: { structuredRepair: false, smokeRender: false },
      } as unknown as Parameters<typeof modelEngine.create>[1],
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("REPURPOSED to fake a capability this host does not have");
    expect(prompts[1]).toContain('recipient_name="Slack Forwarding Bot"');
    expect(JSON.stringify(document)).not.toContain("host_transferMoney");
  });
});
