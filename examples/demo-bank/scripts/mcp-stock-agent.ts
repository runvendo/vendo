#!/usr/bin/env node
/**
 * THE DOORS PROOF — a stock AI SDK agent, no Vendo imports, reaching Maple
 * through the MCP door. Three third-party packages and nothing else: `ai` for
 * the loop, `@ai-sdk/anthropic` for the model, `@modelcontextprotocol/sdk` for
 * the connection. The only local import is Maple's headless sign-in, which a
 * real MCP client does in a browser instead.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-… pnpm --filter demo-bank mcp:agent \
 *     [http://localhost:3000] ["what to ask for"]
 */
import { anthropic } from "@ai-sdk/anthropic";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { signIn, textOf } from "./mcp-oauth.js";

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const target = args.find((argument) => argument.startsWith("http"));
  const ask = args.find((argument) => !argument.startsWith("http"))
    ?? "make me something I can watch this month's spending on";

  const session = await signIn(target, "stock-ai-sdk-agent");
  console.log(`door     ${session.resource}`);
  console.log(`bearer   ${session.accessToken.slice(0, 12)}…  (Maple's own OAuth: DCR, PKCE, login, consent)`);

  const client = new Client({ name: "stock-ai-sdk-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(session.resource), {
    requestInit: { headers: { authorization: `Bearer ${session.accessToken}` } },
  }));

  // Every tool the door offers, handed to the loop verbatim. The door's listing
  // IS the tool set — this script curates nothing and knows no tool by name.
  const { tools: listed } = await client.listTools();
  console.log(`listed   ${listed.length} tools, including ${
    listed.some((entry) => entry.name === "vendo_make") ? "vendo_make" : "NO vendo_make"
  }\n`);

  const receipts: string[] = [];
  const tools = Object.fromEntries(listed.map((entry) => [entry.name, tool({
    description: entry.description,
    inputSchema: jsonSchema(entry.inputSchema),
    async execute(input: unknown) {
      console.log(`→ ${entry.name}(${JSON.stringify(input).slice(0, 300)})`);
      // vendo_make routinely outruns the SDK's 60s default. `onprogress` is what
      // puts a progressToken on the request — without one the door stays silent —
      // and each of the door's heartbeats then restarts this clock.
      const result = await client.callTool({
        name: entry.name,
        arguments: input as Record<string, unknown>,
      }, undefined, { onprogress: () => {}, resetTimeoutOnProgress: true });
      const text = textOf(result);
      console.log(`← ${text.slice(0, 300)}\n`);
      if (entry.name === "vendo_make" && result.isError !== true) receipts.push(text);
      return text;
    },
  })]));

  console.log(`user     ${ask}\n`);
  const run = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system: "You are an assistant inside a banking product. When an answer would be better looked"
      + " at than read, call vendo_make with a plain-language request, then say the receipt's `say`"
      + " line. You never see the screen and must not describe one.",
    prompt: ask,
    stopWhen: stepCountIs(4),
    tools,
  });

  process.stdout.write("agent    ");
  for await (const delta of run.textStream) process.stdout.write(delta);
  console.log("\n");

  await client.close();

  // The proof, stated. `receipts` holds exactly what crossed the wire: four
  // fields of words. A tree, an island source or a machine ref in there would
  // break the receipt law (build contract §3.1), and this says so out loud.
  if (receipts.length === 0) {
    console.error("FAIL — the agent never got a receipt from vendo_make");
    process.exit(1);
  }
  const receipt = JSON.parse(receipts.at(-1)!) as Record<string, unknown>;
  console.log(`receipt  ${JSON.stringify(receipt)}`);
  const leaked = ["tree", "components", "componentTools", "machine", "snapshotRef"]
    .filter((name) => name in receipt);
  if (leaked.length > 0) {
    console.error(`FAIL — the receipt carried UI: ${leaked.join(", ")}`);
    process.exit(1);
  }
  console.log("\nPASS — words to the agent, pixels to the product.");
  console.log(`       the screen is at ${session.base}/vendo/apps  (app ${String(receipt.id)})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
