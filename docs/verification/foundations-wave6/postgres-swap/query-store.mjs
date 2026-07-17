// Wave 6a demo-only script: host-side SQL over the Cadence Vendo store.
// Works against both backends the store supports:
//   PGlite (default):  node query-store.mjs pglite <dataDir>
//   Postgres:          node query-store.mjs pg <postgres-url>
// Run from apps/demo-accounting so its node_modules resolve.
const [, , kind, target] = process.argv;
if (!kind || !target) {
  console.error("usage: node query-store.mjs pglite <dataDir> | pg <url>");
  process.exit(1);
}

const q = async (db, text) => (await db.query(text)).rows;

// Open the store exactly the way a host does (02-store §1), then use the
// documented raw() escape hatch for host-side SQL. Resolve @vendoai/store from
// the calling app's dependency tree (run from apps/demo-accounting).
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const requireFromCwd = createRequire(pathToFileURL(`${process.cwd()}/package.json`));
const { createStore } = await import(pathToFileURL(requireFromCwd.resolve("@vendoai/store")));

const store = createStore(kind === "pglite" ? { dataDir: target } : { url: target });
await store.ensureSchema(); // idempotent; opens the connection so raw() is live
const db = store.raw();

const tables = await q(
  db,
  "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'vendo_%' ORDER BY table_name",
);
console.log(`vendo_* tables on ${kind} (${target}):`);
for (const { table_name } of tables) {
  const [{ n }] = await q(db, `SELECT count(*)::int AS n FROM ${table_name}`);
  console.log(`  ${table_name.padEnd(20)} ${n} rows`);
}

console.log("\nvendo_threads (subject, id, created_at):");
for (const row of await q(
  db,
  "SELECT subject, id, created_at FROM vendo_threads ORDER BY created_at DESC LIMIT 5",
)) {
  console.log(`  ${row.subject}  ${row.id}  ${row.created_at}`);
}

console.log("\nvendo_runs (id, status, started_at):");
for (const row of await q(
  db,
  "SELECT id, status, started_at FROM vendo_runs ORDER BY started_at DESC LIMIT 5",
)) {
  console.log(`  ${row.id}  ${row.status}  ${row.started_at}`);
}

await store.close();
