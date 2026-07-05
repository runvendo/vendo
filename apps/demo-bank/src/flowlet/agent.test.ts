import { describe, it, expect } from "vitest";
import type { FlowletUIMessage } from "@flowlet/core";
import { createDemoAgent } from "./agent";
import { mockRenderModel, stubComposioClient } from "./_test-helpers";

async function collectChunks(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("createDemoAgent", () => {
  it("streams a data-ui node when the model calls render_view", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      composioClient: stubComposioClient,
    });

    const messages: FlowletUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Show me a view." }] },
    ];

    const stream = agent.run({
      messages,
      tools: {},
      principal: { userId: "flowlet-demo" },
      signal: new AbortController().signal,
    });

    const chunks = (await collectChunks(stream)) as { type?: string }[];
    expect(chunks.some((c) => c.type === "data-ui")).toBe(true);
  });
});

// Migration diff test (shared-prompt-core spec, docs/superpowers/specs/
// 2026-07-04-context-engineering-design.md): anchored on the FROZEN
// pre-migration fixture, so it can never compare the new path to itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInstructions } from "./agent";

describe("chat prompt migration diff", () => {
  const fixturePath = join(__dirname, "__fixtures__", "chat-instructions.baseline.txt");

  // The ONLY fixture lines allowed to disappear: the connect section's toolkit
  // list re-wraps onto one line in the shared connectSection. Everything else
  // must survive verbatim.
  const INTENDED_REMOVALS = [
    /^"gmail", reason: "read the receipt for that charge" \}\. Use the toolkit id \(gmail,$/,
    /^slack, notion, github, googlecalendar, linear, googledrive, discord, googlesheets,$/,
    /^stripe, jira, asana, hubspot, airtable\)\. You may briefly say you're requesting access\.$/,
  ];

  it("keeps every non-superseded fixture line and adds only the approved sections", () => {
    const current = buildInstructions();
    const baseline = readFileSync(fixturePath, "utf8");
    const currentLines = new Set(current.split("\n"));

    const lost = baseline
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !currentLines.has(line))
      .filter((line) => !INTENDED_REMOVALS.some((re) => re.test(line)));
    expect(lost, `fixture lines lost without an approved removal:\n${lost.join("\n")}`).toEqual([]);

    // The approved additions (spec sections), and guardrails after ALL host
    // content (the automations block is Maple's last extra).
    for (const anchor of [
      "TALKING ABOUT WHAT YOU CAN DO",
      "APPROVALS:",
      "REGISTER — how you talk",
      "SUGGESTIONS:",
      "NON-NEGOTIABLES",
    ]) {
      expect(current).toContain(anchor);
    }
    expect(current.indexOf("NON-NEGOTIABLES")).toBeGreaterThan(
      current.indexOf("SLACK_SEND_MESSAGE"),
    );
  });
});
