// Criterion 25 evidence: assert VIA THE STORE that each curated chip prompt
// produced a real pipeline-generated app (not a fixture). Run from the host
// app dir AFTER stopping its dev server (PGlite single-writer):
//   node assert-chips-store.mjs .vendo/data <collection> <subject>
import { createStore } from "@vendoai/store";

const [dataDir, collection, subject] = process.argv.slice(2);
const store = createStore({ dataDir });

const manifestRow = await store.records(collection).get(`chips_${subject}`);
if (!manifestRow) {
  console.error(`FAIL: no chip manifest row chips_${subject} in ${collection}`);
  process.exit(1);
}
const entries = manifestRow.data.entries ?? [];
console.log(`manifest entries: ${entries.length}`);
let failures = 0;
for (const entry of entries) {
  const appRow = await store.records("vendo_apps").get(entry.appId);
  if (!appRow) {
    console.error(`FAIL: ${entry.key} -> ${entry.appId} missing from vendo_apps`);
    failures += 1;
    continue;
  }
  const doc = appRow.data.doc ?? {};
  const tree = doc.tree ?? {};
  const nodeCount = Object.keys(tree.nodes ?? {}).length;
  const queryCount = Object.keys(tree.queries ?? {}).length;
  const fixture = String(entry.appId).startsWith("app_demo_");
  console.log(
    `${entry.key}: appId=${entry.appId} subject=${appRow.data.subject} name=${JSON.stringify(doc.name)} ` +
    `ui=${doc.ui} treeNodes=${nodeCount} treeQueries=${queryCount} fixture=${fixture}`,
  );
  if (fixture || appRow.data.subject !== subject || nodeCount === 0) failures += 1;
}
if (failures > 0) {
  console.error(`FAIL: ${failures} entries not real pipeline output`);
  process.exit(1);
}
console.log(`PASS: all ${entries.length} chip apps are real pipeline-generated store rows`);
process.exit(0);
