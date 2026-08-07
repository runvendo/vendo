#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import theme from "../.vendo/theme.json";
import { assert, signIn, textOf } from "./mcp-oauth.js";

const CLIENT_NAME = "Maple MCP proof client";

async function main() {
  const target = process.argv.slice(2).find((argument) => argument !== "--");
  const session = await signIn(target, CLIENT_NAME);
  const { cookie, base, resource } = session;

  // The door's own consent page wears the HOST's brand, not Vendo's. Read the
  // accent from Maple's authored theme rather than pinning a literal here —
  // the copy that used to live here had drifted to a colour Maple never used.
  assert(
    session.consentHtml.includes(`--vendo-color-accent:${theme.colors.accent}`),
    `Default consent page did not carry Maple's accent (${theme.colors.accent}).`,
  );

  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { authorization: `Bearer ${session.accessToken}` } },
  });
  const client = new Client({ name: "maple-mcp-proof", version: "1.0.0" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    assert(listed.tools.some((tool) => tool.name === "host_listAccounts"), "Maple account tool was not listed.");

    // MAPLE'S OWN DATA, THROUGH THE DOOR — and if the guard ASKS for it first,
    // a person decides in Maple's own product and the retry is the real
    // answer. Whether it asks is not this script's to predict: every host tool
    // is `ungraded` in .vendo/tools.json, the grade is merged from
    // .vendo/overrides.json, an auto-judge rules on top, and the ORG policy
    // above that is seeded locally but console-managed on the hosted store
    // (src/demo-script/console-seed.ts). Pinning one ruling would report a
    // deployment posture as a regression.
    let accounts = await client.callTool({ name: "host_listAccounts", arguments: {} });
    const approvalId = textOf(accounts).match(/apr_[0-9a-f-]+/)?.[0];
    if (accounts.isError && approvalId !== undefined) {
      const decided = await fetch(`${base}/api/vendo/approvals/decide`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          ids: [approvalId],
          decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
        }),
      });
      assert(decided.ok, `Maple's in-product approval decision failed (${decided.status}).`);
      accounts = await client.callTool({ name: "host_listAccounts", arguments: {} });
    }
    assert(!accounts.isError, `Maple account tool failed: ${textOf(accounts)}`);
    assert(textOf(accounts).includes("Maple Checking"), "Maple account tool did not return seeded account data.");

    // AND MONEY DOES NOT MOVE WITHOUT A PERSON. Ask or block is the
    // deployment's policy to choose — Maple's seeded org policy blocks this
    // one tool at the MCP venue outright ("Money never moves on behalf of an
    // external MCP client"), a console-managed org may only ask. The thing
    // that must never happen either way is a transfer nobody was asked about.
    const transfer = await client.callTool({
      name: "host_transferMoney",
      arguments: { amount: 1234, recipient_name: "MCP Proof Recipient", memo: "ENG-267 e2e" },
    });
    assert(transfer.isError, "A money transfer ran over MCP without asking anyone.");

    console.log(JSON.stringify({
      base,
      discovery: session.discovery,
      oauth: {
        dcr: true,
        pkceS256: true,
        loginBounce: true,
        mapleSession: true,
        defaultConsent: true,
        mapleThemeTokens: true,
        accessToken: true,
        refreshToken: Boolean(session.refreshToken),
      },
      mcp: {
        sdkClient: true,
        toolsListed: listed.tools.length,
        mapleDataTool: "host_listAccounts",
        // undefined when the guard ran the read outright; an id when it asked
        // and the decision was walked in Maple's own product.
        parkedApproval: approvalId ?? null,
        moneyRefusedWithoutAPerson: "host_transferMoney",
        refusal: textOf(transfer),
      },
    }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
