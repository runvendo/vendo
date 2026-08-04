#!/usr/bin/env node
/**
 * Does an EMPTY allowlist actually filter, and does the box still work?
 *
 * The round-1 proof measured a two-entry allowlist. The served-app seam's
 * fail-closed default is `[]`, which is a different provider input — an empty
 * `allowOut` could plausibly be rejected, or read as "no rules" (i.e. allow
 * everything), which would make the empty-list default a fiction.
 *
 * SCOPE, and read this before quoting the output: every check below uses an
 * ORDINARY client (curl). It shows that `[]` is accepted and that ordinary
 * clients are held. It does NOT show that the box cannot reach the network — a
 * client that omits SNI walks straight past this policy, measured in
 * `sni-bypass-probe.mjs`. See README.md in this folder for the honest claim.
 *
 *   node docs/verification/box-egress/deny-all-probe.mjs
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
const adapter = e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 5 * 60_000 });

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} · ${name}${detail === undefined ? "" : ` — ${detail}`}`);
};

let box;
try {
  // Exactly what the seam now sends when a deployment allows nothing.
  box = await adapter.create({
    ...(process.env.VENDO_BOX_TEMPLATE === undefined ? {} : { template: process.env.VENDO_BOX_TEMPLATE }),
    env: { PORT: "8080" },
    allowedDomains: [],
  });
  record("the provider ACCEPTS an empty allowlist (create did not throw)", true, `machine ${box.id}`);

  const curl = async (host) => {
    const out = await box.exec(
      `curl -sS -o /dev/null -m 12 -w '%{http_code}' https://${host}/ 2>&1 || echo BLOCKED`,
      { timeoutMs: 40_000 },
    );
    return `${out.stdout}${out.stderr}`.trim();
  };

  const anthropic = await curl("api.anthropic.com");
  record(
    "with an EMPTY allowlist an ordinary client cannot reach even the inference host (`[]` is a real policy, not 'no rules')",
    !/^[1-5]\d\d$/.test(anthropic),
    `curl api.anthropic.com → ${JSON.stringify(anthropic)}`,
  );

  const example = await curl("example.com");
  record(
    "an arbitrary host is blocked too (for this ordinary client)",
    !/^[1-5]\d\d$/.test(example),
    `curl example.com → ${JSON.stringify(example)}`,
  );

  // The point of the empty policy: the box must still FUNCTION. Adapter-private exec
  // and the provider ingress are control plane, not egress.
  const local = await box.exec(
    "node -e \"require('node:http').createServer((_,r)=>r.end('LOCAL-OK')).listen(8080,()=>console.log('up'))\" >/tmp/s.log 2>&1 & sleep 2; curl -sS -m 8 http://localhost:8080/",
    { timeoutMs: 40_000 },
  );
  record(
    "the box still runs its own app and serves it locally under an empty allowlist",
    `${local.stdout}`.includes("LOCAL-OK"),
    JSON.stringify(`${local.stdout}${local.stderr}`.slice(0, 120)),
  );
} catch (error) {
  record("probe completed without throwing", false, String(error));
} finally {
  await box?.destroy().catch(() => undefined);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[probe] ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
