import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VENDO_TOOLS_FORMAT, type ExtractedTool } from "@vendoai/actions";
import type { ExtractionHarness } from "../../../src/cli/extract/harness.js";
import { runJudgmentPass, type JudgmentPassOptions } from "../../../src/cli/judge/pass.js";

/**
 * The judgment receipt used to name only its tallies, and three separate auditors
 * read "hardened fields (2)" next to an unchanged `tools.json` full of
 * `risk: "ungraded"` and concluded the pass had done nothing. Grades are a
 * SEPARATE layer by design — tools.json is the raw scan, judgments.json is what a
 * model proposed and a skeptic kept, and the runtime merges them — so the receipt
 * has to name both files or the split reads as a bug.
 *
 * The restart hint rides with it: a running dev server read the judgments once,
 * at boot, so grades written by `vendo sync --ai` do not reach the process the
 * developer is looking at until it restarts.
 */

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const tool = (name: string): ExtractedTool => ({
  name,
  description: `Use this to call ${name}.`,
  inputSchema: { type: "object", properties: {} },
  risk: "ungraded",
  binding: { kind: "route", method: "GET", path: `/api/${name}`, argsIn: "query" },
  srcHash: `sha256:${name}`,
});

const reply = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function scripted(responses: string[]): ExtractionHarness {
  return {
    id: "scripted",
    availability: async () => "scripted engine",
    async run() {
      const next = responses.shift();
      if (next === undefined) throw new Error("scripted harness exhausted");
      return next;
    },
  };
}

async function judgeOne(): Promise<{ logs: string[]; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "vendo-judge-receipt-"));
  temporary.push(root);
  const out = join(root, ".vendo");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "tools.json"),
    `${JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools: [tool("host_customers_list")] }, null, 2)}\n`,
    "utf8",
  );
  const logs: string[] = [];
  const options: JudgmentPassOptions = {
    root,
    out,
    mode: "full",
    loosenings: "queue",
    env: {},
    output: { log: (message) => logs.push(message), error: () => {} },
    harness: scripted([
      reply({
        tools: [{ name: "host_customers_list", risk: "read", evidence: "select().from(customers)" }],
        narrative: "one read",
      }),
      reply({ verdicts: [{ name: "host_customers_list", field: "risk", verdict: "uphold" }] }),
    ]),
  };
  const result = await runJudgmentPass(options);
  expect(result.status).toBe("judged");
  return { logs, root };
}

describe("the judgment receipt", () => {
  it("names the file the grades landed in, and the merge that makes tools.json still say ungraded", async () => {
    const { logs, root } = await judgeOne();
    const said = logs.join("\n");
    expect(said).toContain(`grades written to ${join(".vendo", "judgments.json")}`);
    expect(said).toContain("tools.json keeps the raw scan; the runtime merges both");

    // Both halves of the claim are literally true on disk: the grade is in
    // judgments.json, and tools.json is untouched by it.
    const judgments = JSON.parse(await readFile(join(root, ".vendo", "judgments.json"), "utf8")) as {
      tools: Record<string, { fields?: { risk?: string } }>;
    };
    expect(judgments.tools["host_customers_list"]?.fields?.risk).toBe("read");
    const tools = JSON.parse(await readFile(join(root, ".vendo", "tools.json"), "utf8")) as {
      tools: Array<{ risk: string }>;
    };
    expect(tools.tools[0]?.risk).toBe("ungraded");
  });

  it("tells the developer to restart the dev server, which is the only way a running one sees them", async () => {
    const { logs } = await judgeOne();
    expect(logs.join("\n")).toContain("restart your dev server to pick up the new grades");
  });
});
