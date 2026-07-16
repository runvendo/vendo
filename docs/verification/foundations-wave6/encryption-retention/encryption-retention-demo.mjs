// Wave 6a demo-only script: encryption + retention proof over the Cadence store
// (docs/contracts/02-store.md §4 encryption, §5 erase). Run from
// apps/demo-accounting so @vendoai/store resolves:
//   WAVE6_ENC_KEY=$(openssl rand -base64 32) node encryption-retention-demo.mjs <postgres-url>
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const url = process.argv[2];
const key = process.env.WAVE6_ENC_KEY;
if (!url || !key) {
  console.error("usage: WAVE6_ENC_KEY=<base64 32B> node encryption-retention-demo.mjs <postgres-url>");
  process.exit(1);
}

const requireFromCwd = createRequire(pathToFileURL(`${process.cwd()}/package.json`));
const { createStore, secretStore, storeSecrets, eraseStore, threadStore, grantStore } =
  await import(pathToFileURL(requireFromCwd.resolve("@vendoai/store")));

const store = createStore({ url, encryption: { key } });
await store.ensureSchema();
const db = store.raw();
const sql = async (text, params = []) => (await db.query(text, params)).rows;

console.log("=== 1. Secrets are ciphertext at rest ===");
const PLAINTEXT = "sk_live_demo_51JXaBcDeFgHiJkLmNoP";
await secretStore(store).set("STRIPE_API_KEY", PLAINTEXT);
await secretStore(store).set("QUICKBOOKS_TOKEN", "qbo-token-demo-9f8e7d6c");
const rawRows = await sql("SELECT name, ciphertext FROM vendo_secrets ORDER BY name");
for (const row of rawRows) console.log(`  ${row.name}: ${row.ciphertext}`);
const leaked = rawRows.some((row) => String(row.ciphertext).includes(PLAINTEXT));
console.log(`  plaintext visible in any ciphertext column? ${leaked ? "YES (FAIL)" : "no"}`);
const readBack = await storeSecrets(store).get("STRIPE_API_KEY");
console.log(`  decrypt with the configured key works? ${readBack === PLAINTEXT ? "yes" : "NO (FAIL)"}`);

console.log("\n=== 2. AAD tamper rejection (v2 envelope binds the secret NAME) ===");
const [{ ciphertext: qboCipher }] = await sql(
  "SELECT ciphertext FROM vendo_secrets WHERE name = 'QUICKBOOKS_TOKEN'",
);
await sql("UPDATE vendo_secrets SET ciphertext = $1 WHERE name = 'STRIPE_API_KEY'", [qboCipher]);
console.log("  swapped QUICKBOOKS_TOKEN's ciphertext into the STRIPE_API_KEY row via raw SQL");
try {
  const value = await storeSecrets(store).get("STRIPE_API_KEY");
  console.log(`  read of STRIPE_API_KEY returned a value (FAIL — swap decrypted): ${value}`);
} catch (error) {
  console.log(`  read of STRIPE_API_KEY rejected: ${error.message}`);
}
const tampered = `${String(qboCipher).slice(0, -6)}AAAAAA`;
await sql("UPDATE vendo_secrets SET ciphertext = $1 WHERE name = 'QUICKBOOKS_TOKEN'", [tampered]);
console.log("  flipped trailing ciphertext bytes on QUICKBOOKS_TOKEN via raw SQL");
try {
  const value = await storeSecrets(store).get("QUICKBOOKS_TOKEN");
  console.log(`  read returned a value (FAIL — tamper decrypted): ${value}`);
} catch (error) {
  console.log(`  read of QUICKBOOKS_TOKEN rejected: ${error.message}`);
}

console.log("\n=== 3. Erase API removes one subject's data across tables ===");
const SUBJECT = "wave6-erase-subject";
const OTHER = "wave6-keep-subject";
const principal = (subject) => ({ kind: "user", subject });
const grant = (id, subject) => ({
  id, subject,
  tool: "host_listDeadlines",
  descriptorHash: "sha256:wave6-demo",
  scope: { kind: "tool" },
  duration: "standing",
  source: "chat",
  grantedAt: new Date().toISOString(),
});
await threadStore(store).put(principal(SUBJECT), { id: "thr_wave6_erase_a", messages: [{ role: "user", text: "erase me" }] });
await threadStore(store).put(principal(SUBJECT), { id: "thr_wave6_erase_b", messages: [{ role: "user", text: "erase me too" }] });
await threadStore(store).put(principal(OTHER), { id: "thr_wave6_keep", messages: [{ role: "user", text: "keep me" }] });
await grantStore(store).create(principal(SUBJECT), grant("grt_wave6_erase", SUBJECT));
await grantStore(store).create(principal(OTHER), grant("grt_wave6_keep", OTHER));

const counts = async (label) => {
  const rows = await sql(
    `SELECT 'vendo_threads' AS t, subject, count(*)::int AS n FROM vendo_threads GROUP BY subject
     UNION ALL
     SELECT 'vendo_grants', subject, count(*)::int FROM vendo_grants GROUP BY subject
     ORDER BY t, subject`,
  );
  console.log(`  ${label}:`);
  for (const row of rows) console.log(`    ${row.t}  subject=${row.subject}  rows=${row.n}`);
};
await counts("before erase");
const report = await eraseStore(store).bySubject(SUBJECT);
const touched = Object.entries(report).filter(([, n]) => n > 0);
console.log(`  eraseStore(store).bySubject("${SUBJECT}") report: ${JSON.stringify(Object.fromEntries(touched))}`);
await counts("after erase");

await store.close();
