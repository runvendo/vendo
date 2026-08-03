# Box egress — what is guaranteed, and what is not

The precise statement. Every comment in the code that talks about box egress
should agree with this file, and nothing should claim more than it.

## What IS true

Outbound traffic from a Vendo sandbox box is **filtered at the provider's domain
layer**. Both box kinds now name a policy on every provider call:

- the conversational `claudeCode()` box — `boxEgress()` in
  `packages/harnesses/src/claude-code/index.ts` (inference host + MCP door
  origin + any `claudeCode({ egress })` the host added);
- the served-app machine — `boxAllowlist()` via `machine-lifecycle.ts`
  (approved declarations + implicit skin domains).

Neither can be constructed without a policy: `allowedDomains` is a **required**
parameter on both seams, because the sandbox contract reads an *absent*
`allowedDomains` as unrestricted internet (`SandboxAdapter.create` →
`allowInternetAccess: true`). An empty list is the strictest expressible policy.

Measured on real e2b (`live-egress-proof.log`, `deny-all-probe.log`):

- ordinary clients are held to the allowlist — `curl`, `fetch`, and python's
  `ssl` to a non-allowlisted host fail at connect;
- the box still functions under a policy: inference, the MCP door, tool calls
  through the guard, and app builds all work;
- under `allowedDomains: []` even the inference host is unreachable, and the box
  still runs and serves its own app locally.

## What is NOT true

**This is not a network jail, and "deny-all" is not absolute.**

e2b classifies an outbound TLS connection by the server name the client asks
for — in practice the SNI extension in the ClientHello. A client that **omits
SNI** presents nothing to match, and the policy lets the connection through
rather than refusing it. It fails *open* on traffic it cannot classify.

`openssl` ships in the box image (node:22 base), so the bypass needs no upload,
no install, and no egress to obtain:

```
openssl s_client -connect 1.1.1.1:443 -noservername
```

Measured under `allowedDomains: []` — the strictest policy the seam can express
— against four hosts in no allowlist (`sni-bypass-probe.log`):

```
· curl → 1.1.1.1                    curl: (35) SSL_ERROR_SYSCALL ... 000
· python ssl (no SNI) → 1.1.1.1     ssl.py wrap_socket → traceback
· openssl -noservername → 1.1.1.1          Verify return code: 0 (ok)
· openssl -noservername → 8.8.8.8          Verify return code: 0 (ok)
· openssl -noservername → 8.8.4.4          Verify return code: 0 (ok)
· openssl -noservername → 151.101.1.140    Verify return code: 0 (ok)
```

Full, certificate-validated TLS sessions to arbitrary addresses. Reproduced by
an independent reviewer (3× in one box, again in a second box) and again by this
lane's own `sni-bypass-probe.mjs`.

**So:** a determined agent inside the box — or prompt-injected content steering
one — can still exfiltrate over a raw TLS socket. The allowlist raises the cost
and stops every ordinary client; it does not contain a hostile one.

## Why this repo does not close it

The gap is in the provider's enforcement, below Vendo's seam. Closing it needs
IP/CIDR-level egress control (or SNI-less-ClientHello rejection) from the
sandbox provider. Nothing in `SandboxAdapter` can express that today, and
nothing host-side can observe the box's raw sockets. Removing `openssl` from the
image would not fix it either — the bypass is a property of the network policy,
not of one binary, and any statically-linked client could do the same.

**Open item for Yousef / the provider:** ask e2b for IP-level egress rules, or
for the policy to fail *closed* on unclassifiable ClientHellos. Until then the
honest posture is "filtered, not jailed", and any security claim that depends on
the box being unable to reach the network is unsupported.

## Files here

| File | What it is |
| --- | --- |
| `live-egress-proof.mjs` / `.log` / `.json` | End-to-end proof the conversational box works WITH a policy on: inference from inside the box, a tool call through the MCP door with its audit row, an app build landing in the store, plus a curl-level negative probe. 9/9. |
| `deny-all-probe.mjs` / `.log` | `allowedDomains: []` is accepted by the provider, blocks ordinary clients including the inference host, and the box still serves locally. 4/4. |
| `sni-bypass-probe.mjs` / `.log` | This document's evidence. Characterization only — it asserts nothing and is not part of the test suite. |

The `.json` and `.log` files are dated records of runs that happened; they are
not regenerated to match later edits of the scripts.

**Gotcha:** `live-egress-proof.mjs` writes `live-egress-proof.json` next to
itself, so re-running it OVERWRITES the committed record and dirties the working
tree. That is expected, not tampering — check the `at` timestamp to see whose run
you are looking at. The currently committed record is the independent security
reviewer's re-run (`2026-08-03T00:19:51Z`, 9/9), which superseded this lane's own
(`2026-08-02T23:25:42Z`, also 9/9). The other two probes only print; they write
nothing.
