#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import theme from "../.vendo/theme.json";
import { assert, signIn, textOf } from "./mcp-oauth.js";

const CLIENT_NAME = "Maple MCP proof client";

async function main() {
  const target = process.argv.slice(2).find((argument) => argument !== "--");
  const session = await signIn(target, CLIENT_NAME);
  const { cookie, origin, resource } = session;

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
    const accounts = await client.callTool({ name: "host_listAccounts", arguments: {} });
    assert(!accounts.isError, `Maple account tool failed: ${textOf(accounts)}`);
    assert(textOf(accounts).includes("Maple Checking"), "Maple account tool did not return seeded account data.");

    const transferArgs = { amount: 1234, recipient_name: "MCP Proof Recipient", memo: "ENG-267 e2e" };
    const parked = await client.callTool({ name: "host_transferMoney", arguments: transferArgs });
    assert(parked.isError, "Destructive Maple transfer did not park for approval.");
    const approvalId = textOf(parked).match(/apr_[0-9a-f-]+/)?.[0];
    assert(approvalId, "Parked transfer did not name its approval.");

    const decided = await fetch(new URL("/api/vendo/approvals/decide", origin), {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        ids: [approvalId],
        decision: {
          approve: true,
          remember: { scope: { kind: "tool" }, duration: "standing" },
        },
      }),
    });
    assert(decided.ok, `Maple's in-product approval decision failed (${decided.status}).`);

    const retried = await client.callTool({ name: "host_transferMoney", arguments: transferArgs });
    assert(!retried.isError, `Approved transfer retry failed: ${textOf(retried)}`);
    assert(textOf(retried).includes("MCP Proof Recipient"), "Approved transfer did not return Maple's side effect.");

    console.log(JSON.stringify({
      origin: origin.toString(),
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
        destructiveTool: "host_transferMoney",
        parkedApproval: approvalId,
        resolvedInProduct: true,
        retrySucceeded: true,
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
