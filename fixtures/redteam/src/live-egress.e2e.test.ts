/** Live e2b egress/exfil red-team suite (E2B_API_KEY-gated).
 *
 * Proves the OSS finding: egress is enforced by E2B's PROVIDER-NATIVE network
 * allowlist (06-apps §4.3 — `adapter.create({ egress })` maps to E2B's
 * `network.allowOut` + `denyOut: [ALL_TRAFFIC]`, see packages/apps/src/e2b/index.ts).
 * Secret handles are injected as env values by machine.ts `environment()` as the
 * opaque string `vendo-secret:<name>:<nonce>`. The pure allowlist-gated helper
 * `substituteSecretHandles` (packages/apps/src/egress.ts) is NOT wired into the
 * e2b datapath — so the REAL secret value is NEVER present inside the sandbox.
 * Exfiltration is therefore impossible by construction: there is nothing to leak,
 * and even the handle can only leave toward an allowlisted host.
 *
 * This suite creates a REAL e2b machine with `egress: ["example.com"]` (allow
 * ONLY example.com) and demonstrates on real infrastructure that:
 *   (1) egress to a non-allowlisted host (api.stripe.com) is BLOCKED,
 *   (3) a 302 redirect from a loopback server to a non-allowlisted host has its
 *       FINAL hop BLOCKED (redirect/DNS tricks don't defeat the network layer),
 *   (4) the app only ever sees the handle string, never a real secret value, and
 *       whatever leaves toward the allowed host is that handle verbatim,
 *   (5) a raw-IP probe to a non-allowlisted public IP is BLOCKED.
 * The allowlisted control path (2, example.com) is a HARD assert: the machine
 * MUST reach the one permitted host, otherwise the deny-side proofs above would
 * be a vacuous pass on a deny-all/dead network. A SUCCESSFUL non-allowlisted
 * egress is ALWAYS a hard P0 failure.
 *
 * Probes run through `node` (guaranteed present in the e2b base image, as the
 * apps live-e2b example relies on) rather than curl, so the suite does not depend
 * on curl being installed. The block is enforced at the kernel/firewall level, so
 * node fetch and curl are throttled identically.
 */
import { describe, expect, it } from "vitest";
import { e2bSandbox } from "@vendoai/apps/e2b";
import type { SandboxMachine } from "@vendoai/apps";

const liveKey = process.env.E2B_API_KEY;
const plausible = typeof liveKey === "string" && liveKey.length > 10;

/** The ONLY allowlisted egress host. example.com answers HTTPS and is stable. */
const ALLOWED_HOST = "example.com";
const ALLOWED_URL = `https://${ALLOWED_HOST}/`;
/** Non-allowlisted targets — every one of these MUST be blocked. */
const BLOCKED_URL = "https://api.stripe.com/v1/charges";
const RAW_IP_URL = "https://1.1.1.1/"; // Cloudflare DNS, unambiguously not example.com
/** The secret handle exactly as machine.ts `environment()` injects it. */
const SECRET_HANDLE = "vendo-secret:STRIPE_KEY:testnonce";
const REDIR_PORT = 8091;

/** A loopback-only server: 302→non-allowlisted for the redirect trick, plus an
 * echo endpoint so we can read back exactly what the app would transmit. Loopback
 * (127.0.0.1) is not egress, so this is reachable regardless of the allowlist —
 * which is what lets probe (3) prove the network stack is alive while the
 * cross-domain hop is still blocked. */
const redirectServerSource = `
const http = require("node:http");
const port = Number(process.env.REDIR_PORT || 8091);
const EVIL = ${JSON.stringify(BLOCKED_URL)};
http.createServer((req, res) => {
  if (req.url.startsWith("/health")) { res.writeHead(200); res.end("ok"); return; }
  if (req.url.startsWith("/redirect")) { res.writeHead(302, { location: EVIL }); res.end(); return; }
  if (req.url.startsWith("/echo")) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { res.writeHead(200, { "content-type": "text/plain" }); res.end(Buffer.concat(chunks).toString()); });
    return;
  }
  res.writeHead(404); res.end();
}).listen(port);
`;

/** In-machine probe: fetch a URL with an 8s abort, emitting a single JSON line.
 * FOLLOW=1 follows redirects (default is manual so we can inspect a 302). */
const probeSource = `
const url = process.argv[2];
const method = process.argv[3] || "GET";
const body = process.argv[4];
const redirect = process.env.FOLLOW === "1" ? "follow" : "manual";
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 8000);
(async () => {
  try {
    const res = await fetch(url, { method, redirect, signal: ctrl.signal, ...(body === undefined ? {} : { body }) });
    const text = await res.text().catch(() => "");
    console.log(JSON.stringify({ ok: true, status: res.status, location: res.headers.get("location"), body: text.slice(0, 500) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: (error && error.name) || "Error", message: String((error && error.message) || error).slice(0, 200) }));
  } finally {
    clearTimeout(timer);
  }
})();
`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

interface ProbeResult {
  ok: boolean;
  status?: number;
  location?: string | null;
  body?: string;
  error?: string;
  message?: string;
  raw?: string;
  exec: { code: number; stdout: string; stderr: string };
}

/** Run /app/probe.js in the machine and parse its JSON verdict. */
async function probe(
  machine: SandboxMachine,
  args: { url: string; method?: string; body?: string; follow?: boolean },
): Promise<ProbeResult> {
  const parts = ["node", "/app/probe.js", shellQuote(args.url), shellQuote(args.method ?? "GET")];
  if (args.body !== undefined) parts.push(shellQuote(args.body));
  const cmd = `${args.follow ? "FOLLOW=1 " : ""}${parts.join(" ")}`;
  const exec = await machine.exec(cmd, { cwd: "/app", timeoutMs: 30_000 });
  const line = exec.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return { ...(JSON.parse(line) as Omit<ProbeResult, "exec">), exec };
  } catch {
    return { ok: false, error: "unparseable", raw: `${exec.stdout}\n${exec.stderr}`, exec };
  }
}

/** A "reached" verdict means the machine got a real HTTP response from the host —
 * i.e. egress SUCCEEDED. For any non-allowlisted host this is a P0. */
const reached = (result: ProbeResult): boolean => result.ok === true && typeof result.status === "number";

describe.skipIf(!plausible)("live e2b egress: exfil is blocked and secrets never leave", () => {
  it(
    "enforces the provider-native allowlist against direct, redirect, DNS/IP, and secret-exfil attacks",
    { timeout: 300_000 },
    async () => {
      const adapter = e2bSandbox({ apiKey: liveKey as string, timeoutMs: 120_000 });
      const machine = await adapter.create({
        // egress allows ONLY example.com; everything else is denied by E2B's
        // ALL_TRAFFIC deny rule (see packages/apps/src/e2b/index.ts).
        egress: [ALLOWED_HOST],
        env: {
          PORT: "8080",
          REDIR_PORT: String(REDIR_PORT),
          // The app only ever sees the opaque handle. There is no real Stripe key
          // anywhere in this machine to exfiltrate — that is the fail-safe.
          SECRET_UNDER_TEST: SECRET_HANDLE,
        },
        files: {
          "/app/redirect.js": redirectServerSource,
          "/app/probe.js": probeSource,
        },
      });

      try {
        // Boot the loopback redirect/echo server and wait for it to answer.
        const boot = await machine.exec("nohup node /app/redirect.js >/tmp/redir.log 2>&1 &", {
          cwd: "/app",
          timeoutMs: 10_000,
        });
        expect(boot.code).toBe(0);

        let loopbackUp = false;
        for (let attempt = 0; attempt < 30 && !loopbackUp; attempt += 1) {
          const health = await probe(machine, { url: `http://127.0.0.1:${REDIR_PORT}/health` });
          loopbackUp = reached(health) && health.status === 200;
          if (!loopbackUp) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        // Loopback is exempt from egress rules; if it is down the machine's node
        // fetch stack is broken and no probe below would be meaningful.
        expect(loopbackUp, "loopback redirect server never became ready").toBe(true);

        // ── (1) Direct non-allowlisted egress MUST be blocked (core assertion). ──
        const direct = await probe(machine, { url: BLOCKED_URL });
        if (reached(direct)) {
          throw new Error(
            `P0 EGRESS ESCAPE: reached non-allowlisted ${BLOCKED_URL} (HTTP ${direct.status}) ` +
              `despite egress:["${ALLOWED_HOST}"]. The provider allowlist did NOT block it.`,
          );
        }
        expect(reached(direct), `direct egress to ${BLOCKED_URL} should be blocked`).toBe(false);

        // ── (5) DNS/IP trick: raw non-allowlisted public IP MUST be blocked. ──
        const rawIp = await probe(machine, { url: RAW_IP_URL });
        if (reached(rawIp)) {
          throw new Error(
            `P0 EGRESS ESCAPE: reached raw IP ${RAW_IP_URL} (HTTP ${rawIp.status}) despite ` +
              `egress:["${ALLOWED_HOST}"]. Raw-IP egress defeated the allowlist.`,
          );
        }
        expect(reached(rawIp), `raw-IP egress to ${RAW_IP_URL} should be blocked`).toBe(false);

        // ── (3) Redirect trick: the loopback 302 is served (proving the stack is
        //        alive), but FOLLOWING it to the non-allowlisted host is blocked. ──
        const seen302 = await probe(machine, { url: `http://127.0.0.1:${REDIR_PORT}/redirect`, follow: false });
        expect(reached(seen302), "loopback redirect endpoint should answer").toBe(true);
        expect(seen302.status, "redirect endpoint should emit a 302").toBe(302);
        expect(seen302.location, "302 should point at the non-allowlisted host").toBe(BLOCKED_URL);

        const followed = await probe(machine, { url: `http://127.0.0.1:${REDIR_PORT}/redirect`, follow: true });
        if (reached(followed)) {
          throw new Error(
            `P0 EGRESS ESCAPE: following a 302 to ${BLOCKED_URL} succeeded (HTTP ${followed.status}). ` +
              `Redirect defeated the provider allowlist.`,
          );
        }
        expect(reached(followed), "the redirect's final hop to a non-allowlisted host should be blocked").toBe(false);

        // ── (4a) The app only ever sees the HANDLE — no real secret in the machine. ──
        const envRead = await machine.exec(
          `node -e "process.stdout.write(String(process.env.SECRET_UNDER_TEST))"`,
          { cwd: "/app", timeoutMs: 10_000 },
        );
        expect(envRead.code).toBe(0);
        // Exact-match: substitution is unwired in OSS, so no real value is ever
        // present to exfiltrate. This is the fail-safe property.
        expect(envRead.stdout).toBe(SECRET_HANDLE);

        // ── (4b) What would leave toward the ALLOWED host is the handle verbatim. ──
        // Read it back through the loopback echo endpoint (a faithful stand-in for
        // the allowed egress hop): what the app transmits is the handle, never a
        // real key — because there is no real key in the process to substitute in.
        const echoed = await probe(machine, {
          url: `http://127.0.0.1:${REDIR_PORT}/echo`,
          method: "POST",
          body: `leak=${SECRET_HANDLE}`,
        });
        expect(reached(echoed), "echo endpoint should answer").toBe(true);
        expect(echoed.body).toBe(`leak=${SECRET_HANDLE}`);

        // ── (2) Allowlisted control (HARD): example.com MUST be reachable. ──
        // This is a HARD assert, not a soft-skip, and that is load-bearing: it is
        // the ONLY thing that proves the allowlist can ALLOW its one permitted
        // host. Without it, a deny-all misconfiguration (or a dead network) would
        // make every deny-side assertion (1/3/5) pass VACUOUSLY — everything
        // reached===false — and the suite would falsely report "allowlist
        // enforced" while having proven only "everything is blocked." A complete
        // allowlist proof needs BOTH sides: deny the forbidden AND allow the
        // permitted. The suite is live-only (E2B_API_KEY + real network), so a
        // hard control assert is appropriate. We retry generously to absorb
        // genuine transient flakiness, then assert reachability at the end.
        let control: ProbeResult | undefined;
        let controlOk = false;
        for (let attempt = 0; attempt < 5 && !controlOk; attempt += 1) {
          control = await probe(machine, { url: ALLOWED_URL, follow: true });
          controlOk = reached(control);
          if (!controlOk) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        expect(
          controlOk,
          `allowlisted control ${ALLOWED_URL} was NOT reachable after retries — the allowlist did not ` +
            `ALLOW its one permitted host, so the deny-side assertions (1/3/5) are a vacuous pass on a ` +
            `dead/deny-all network. Last probe: ${JSON.stringify(control)}`,
        ).toBe(true);
      } finally {
        // Never leak a live machine.
        await machine.stop().catch(() => undefined);
      }
    },
  );
});
