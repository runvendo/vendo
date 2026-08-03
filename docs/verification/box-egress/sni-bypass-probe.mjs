#!/usr/bin/env node
/**
 * CHARACTERIZATION PROBE — what the box's egress allowlist does NOT stop.
 *
 * This is not a test and it asserts nothing. It records a PROVIDER-level gap so
 * the next person does not have to rediscover it, and so nobody reads the word
 * "deny-all" in this repo as stronger than it is.
 *
 * THE GAP. e2b's network policy filters by DOMAIN. It classifies an outbound
 * TLS connection by the server name the client asks for, which in practice
 * means the SNI extension in the ClientHello. A client that omits SNI presents
 * nothing to match against — and the policy lets it through rather than
 * refusing it. Filtering therefore holds against ordinary clients and does NOT
 * hold against a client that skips SNI.
 *
 * `openssl` is in the box image already (node:22 base), so the bypass needs no
 * upload, no install, and no egress to obtain:
 *
 *   openssl s_client -connect 1.1.1.1:443 -noservername
 *
 * Observed: a complete, certificate-validated TLS session — `Verify return
 * code: 0 (ok)` — to hosts that appear in no allowlist, under
 * `allowedDomains: []`, which is the strictest policy the seam can express.
 *
 * What this repo CAN say: outbound traffic from the box is filtered at the
 * provider's domain layer; ordinary clients (curl, python ssl, fetch) are held
 * to the allowlist. What it CANNOT say: that the box cannot reach the network.
 * Closing this needs an IP/CIDR-level egress control from the sandbox provider;
 * it is not reachable from Vendo's side of the seam.
 *
 *   node docs/verification/box-egress/sni-bypass-probe.mjs
 *
 * Needs E2B_API_KEY. VENDO_BOX_TEMPLATE optional.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import process from "node:process";

const fromUmbrella = createRequire(new URL("../../../packages/vendo/package.json", import.meta.url));
const load = async (specifier) => import(pathToFileURL(fromUmbrella.resolve(specifier)).href);

if (!process.env.E2B_API_KEY) {
  console.error("[probe] missing E2B_API_KEY");
  process.exit(2);
}

const { e2bSandbox } = await load("@vendoai/apps/e2b");
const adapter = e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 6 * 60_000 });

/** Arbitrary hosts that appear in NO allowlist this repo ever builds. */
const OFF_LIST_IPS = ["1.1.1.1", "8.8.8.8", "8.8.4.4", "151.101.1.140"];

const observed = [];
const note = (what, detail) => {
  observed.push({ what, detail });
  console.log(`· ${what} — ${detail}`);
};

let box;
try {
  // The strictest policy the seam can express.
  box = await adapter.create({
    ...(process.env.VENDO_BOX_TEMPLATE === undefined ? {} : { template: process.env.VENDO_BOX_TEMPLATE }),
    env: { PORT: "8080" },
    allowedDomains: [],
  });
  console.log(`[probe] box ${box.id} created with allowedDomains: []\n`);

  // ── the CONTROL: ordinary clients are genuinely held ───────────────────────
  console.log("--- ordinary clients (expected: blocked) ---");
  const curled = await box.exec(
    "curl -sS -o /dev/null -m 10 -w '%{http_code}' https://1.1.1.1/ 2>&1 || true",
    { timeoutMs: 40_000 },
  );
  note("curl → 1.1.1.1", JSON.stringify(`${curled.stdout}${curled.stderr}`.trim().slice(0, 160)));

  // `check_hostname=False` is deliberate and is the POINT: it is how this client
  // omits the server name, which is the condition under test. It runs inside a
  // throwaway sandbox against IPs, verifies nothing, and carries no data — this
  // is a diagnostic, never a pattern to copy into product code.
  const pythoned = await box.exec(
    "python3 -c \"import socket,ssl;c=ssl.create_default_context();c.check_hostname=False;"
    + "s=c.wrap_socket(socket.create_connection(('1.1.1.1',443),timeout=10));print('TLS-OK',s.version())\" 2>&1 || true",
    { timeoutMs: 40_000 },
  );
  note("python ssl (no SNI) → 1.1.1.1", JSON.stringify(`${pythoned.stdout}${pythoned.stderr}`.trim().slice(0, 160)));

  // ── the GAP: openssl's minimal, SNI-less ClientHello ───────────────────────
  console.log("\n--- openssl s_client -noservername (the gap) ---");
  for (const ip of OFF_LIST_IPS) {
    const out = await box.exec(
      `echo Q | timeout 20 openssl s_client -connect ${ip}:443 -noservername 2>&1 | grep -E 'Verify return code|Protocol *:|Cipher *:' | head -3`,
      { timeoutMs: 45_000 },
    );
    const text = `${out.stdout}${out.stderr}`.trim().replace(/\s+/g, " ");
    note(`openssl -noservername → ${ip}`, text === "" ? "(no TLS session)" : text);
  }
} catch (error) {
  note("probe threw", String(error));
} finally {
  await box?.destroy().catch(() => undefined);
  console.log(
    "\n[probe] Recorded, not asserted. If e2b ever filters SNI-less ClientHellos,"
    + "\n[probe] these lines change and the egress notes in this folder should be updated.",
  );
}
