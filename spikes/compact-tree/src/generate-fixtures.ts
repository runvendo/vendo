/**
 * KEY-GATED fixture generator (NOT part of `pnpm test`). Run with:
 *   pnpm --filter @vendoai/spike-compact-tree build
 *   source /Users/yousefh/orca/workspaces/flowlet/.env
 *   pnpm --filter @vendoai/spike-compact-tree generate:fixtures
 *
 * Prompts the real model (readable-JSON arm) with each UI_REQUEST, validates the
 * output with @vendoai/core.validateTree, and writes it to fixtures/generated/
 * with a `_provenance` note. These are the realistic trees measure:tokens uses.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateTree } from "@vendoai/core";
import { FIXTURES_DIR, GEN_MODEL, getAnthropic } from "./harness.js";
import { extractText, thinkingParam } from "./model.js";
import { systemPromptFor, UI_REQUESTS } from "./prompts.js";

async function main(): Promise<void> {
  const anthropic = await getAnthropic();
  const outDir = join(FIXTURES_DIR, "generated");
  mkdirSync(outDir, { recursive: true });

  for (const req of UI_REQUESTS) {
    const response = await anthropic.messages.create({
      model: GEN_MODEL,
      max_tokens: 8000,
      system: systemPromptFor("readable"),
      messages: [{ role: "user", content: req.prompt }],
      ...thinkingParam(GEN_MODEL),
    });
    const text = extractText(response.content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`✗ ${req.id}: model output was not valid JSON (${String(err)})`);
      continue;
    }
    const result = validateTree(parsed);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`✗ ${req.id}: invalid tree (${result.error.code}: ${result.error.message})`);
      continue;
    }
    const withProvenance = {
      _provenance: {
        origin: "generated",
        model: GEN_MODEL,
        request: req.prompt,
        note: "Fresh vendo-genui/v1 tree from the real model; validated with @vendoai/core.validateTree.",
      },
      ...result.tree,
    };
    const file = join(outDir, `${req.id}.json`);
    writeFileSync(file, `${JSON.stringify(withProvenance, null, 2)}\n`, "utf8");
    // eslint-disable-next-line no-console
    console.log(`✓ ${req.id}: ${result.tree.nodes.length} nodes -> ${file}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
