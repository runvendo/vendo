/**
 * KEY-GATED measurement script (NOT part of `pnpm test`). Run with:
 *   pnpm --filter @vendoai/spike-compact-tree build
 *   source /Users/yousefh/orca/workspaces/flowlet/.env
 *   pnpm --filter @vendoai/spike-compact-tree measure:tokens
 *
 * For every fixture tree it computes, for four encodings, the utf-8 byte count
 * and the Anthropic count-tokens value (authoritative for Claude), then prints a
 * per-tree and an aggregate table. Baselines:
 *   - readable-pretty : JSON.stringify(tree, null, 2) — what a human reads.
 *   - readable-min    : JSON.stringify(tree)          — the HONEST baseline (a
 *                       server would never send pretty JSON over the wire).
 * Savings are reported against readable-min.
 *
 * Tokens are counted by wrapping each string as a single user message; that adds
 * a small FIXED per-call overhead (a handful of tokens) identical across arms,
 * so it barely moves large-tree ratios and is disclosed here. Byte counts are
 * overhead-free and cross-check the token story.
 */
import { canonicalize, encodeCjtString } from "./index.js";
import { encodeVtl } from "./profile-vtl.js";
import { bytes, COUNT_MODEL, getAnthropic, loadFixtures, pct } from "./harness.js";

interface Row {
  name: string;
  nodes: number;
  prettyBytes: number;
  minBytes: number;
  cjtBytes: number;
  vtlBytes: number;
  prettyTok?: number;
  minTok?: number;
  cjtTok?: number;
  vtlTok?: number;
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    // eslint-disable-next-line no-console
    console.error("No fixtures found. Add trees under fixtures/harvested or run generate:fixtures.");
    process.exit(1);
  }

  const anthropic = await getAnthropic();
  const countTokens = async (text: string): Promise<number> => {
    const res = await anthropic.messages.countTokens({
      model: COUNT_MODEL,
      messages: [{ role: "user", content: text }],
    });
    return res.input_tokens;
  };

  const rows: Row[] = [];
  for (const { name, tree } of fixtures) {
    const canonical = canonicalize(tree);
    const pretty = JSON.stringify(canonical, null, 2);
    const min = JSON.stringify(canonical);
    const cjt = encodeCjtString(canonical);
    const vtl = encodeVtl(canonical);

    const row: Row = {
      name,
      nodes: canonical.nodes.length,
      prettyBytes: bytes(pretty),
      minBytes: bytes(min),
      cjtBytes: bytes(cjt),
      vtlBytes: bytes(vtl),
      prettyTok: await countTokens(pretty),
      minTok: await countTokens(min),
      cjtTok: await countTokens(cjt),
      vtlTok: await countTokens(vtl),
    };
    rows.push(row);
    // eslint-disable-next-line no-console
    console.log(`counted ${name} (${row.nodes} nodes)`);
  }

  // eslint-disable-next-line no-console
  console.log(`\n=== TOKENS (model ${COUNT_MODEL}) — savings vs readable-min ===`);
  const header = ["fixture", "nodes", "pretty", "min", "cjt", "vtl", "cjt%", "vtl%"];
  const lines = [header.join("\t")];
  const agg = { pretty: 0, min: 0, cjt: 0, vtl: 0, pBytes: 0, mBytes: 0, cBytes: 0, vBytes: 0 };
  for (const r of rows) {
    lines.push(
      [
        r.name,
        r.nodes,
        r.prettyTok,
        r.minTok,
        r.cjtTok,
        r.vtlTok,
        pct(r.minTok!, r.cjtTok!),
        pct(r.minTok!, r.vtlTok!),
      ].join("\t"),
    );
    agg.pretty += r.prettyTok!;
    agg.min += r.minTok!;
    agg.cjt += r.cjtTok!;
    agg.vtl += r.vtlTok!;
    agg.pBytes += r.prettyBytes;
    agg.mBytes += r.minBytes;
    agg.cBytes += r.cjtBytes;
    agg.vBytes += r.vtlBytes;
  }
  lines.push(["TOTAL", "", agg.pretty, agg.min, agg.cjt, agg.vtl, pct(agg.min, agg.cjt), pct(agg.min, agg.vtl)].join("\t"));
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));

  // eslint-disable-next-line no-console
  console.log(`\n=== BYTES — savings vs readable-min (overhead-free cross-check) ===`);
  const bl = [["fixture", "pretty", "min", "cjt", "vtl", "cjt%", "vtl%"].join("\t")];
  for (const r of rows) {
    bl.push([r.name, r.prettyBytes, r.minBytes, r.cjtBytes, r.vtlBytes, pct(r.minBytes, r.cjtBytes), pct(r.minBytes, r.vtlBytes)].join("\t"));
  }
  bl.push(["TOTAL", agg.pBytes, agg.mBytes, agg.cBytes, agg.vBytes, pct(agg.mBytes, agg.cBytes), pct(agg.mBytes, agg.vBytes)].join("\t"));
  // eslint-disable-next-line no-console
  console.log(bl.join("\n"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
