# Secrets Egress Gateway — Design Options

Date: 2026-07-15. Parent: apps-block design (2026-07-14), locked decision 5.
Status: **DECIDED 2026-07-15: Option B (egress endpoint + fetch shim), picked by Yousef.** This
document compares; it does not build.

## Problem

Secret values must never enter the sandbox (06-apps §4.3, FROZEN): app code
holds opaque handles (`vendo-secret:<name>:<nonce>`), and substitution happens
at an egress gateway **outside** the sandbox, only for hosts on the app's
declared `egress` allowlist. What ships today (ENG-259) is the explicit egress
endpoint: `POST {VENDO_PROXY_URL}/egress` (§4.5) with allowlist match → SSRF
guard on the resolved IP (re-checked per redirect) → handle substitution →
forward → response secret-stripping. The open question is the *shape of the
path from app code to that boundary*: transparent TLS interception, or an
explicit endpoint reached by a fetch shim.

## Option A — TLS-terminating egress gateway

A forward proxy the sandbox is forced through: `HTTPS_PROXY`/`HTTP_PROXY` env
plus a gateway CA injected into the machine's trust store at create/resume.
The gateway terminates TLS, applies the §4.5 pipeline (allowlist, SSRF,
substitute, redact), re-encrypts upstream.

- App code unchanged: any HTTP client in any language works, including
  third-party SDKs that never heard of Vendo (`stripe.charges.create(...)`
  with the handle in env just works).
- Requires real new infrastructure: a TLS-MITM proxy daemon reachable from
  inside every provider's sandbox, per-run client auth (the run token must
  bind CONNECT tunnels to an app/run or one app's gateway serves another's
  secrets), CA minting/rotation, and per-host leaf-cert forging.
- Weaker containment story: tools that pin certificates or read the system
  store lazily bypass or break; anything that ignores `HTTPS_PROXY` (raw
  sockets) silently skips the gateway, so the provider-level network
  allowlist must *still* be the deny wall — the gateway can only be the
  substitution point, never the enforcement point.
- Response redaction requires streaming rewrite inside the TLS splice.

### How each provider would host it

- **E2B**: no sidecar concept. The gateway must run as a Vendo-operated
  public endpoint (Cloud-ish) or as a process *inside* the sandbox — which
  defeats the boundary. OSS zero-config cannot self-host a public MITM proxy;
  a host-machine proxy is unreachable from E2B's network unless tunneled.
- **Modal**: `modal.Proxy` exists but is an egress-IP feature, not a
  programmable TLS terminator; same hosting problem as E2B — the gateway
  would be a separately deployed Modal app the OSS install must own and pay
  for.
- **Cloud (future)**: natural fit — Cloud runs a managed gateway fleet next
  to its sandboxes and mints per-run proxy credentials. But OSS would then
  have a venue Cloud secures and OSS does not, or OSS carries the fleet.

## Option B — explicit egress endpoint + in-sandbox fetch shim

Keep §4.5 as the single wired boundary. Ship a `fetch` shim in the served-app
scaffold (and the rung-2/3 boot convention) that rewrites outbound
`fetch(externalUrl)` into `POST {VENDO_PROXY_URL}/egress` with the run token,
so ordinary app code stays unchanged *within the Node fetch path*.

- Already 80% built and contract-frozen: the endpoint, allowlist reuse, SSRF
  guard, substitution, redaction, and size caps shipped in ENG-259 and are
  red-team tested; the shim is the only missing piece and is explicitly
  anticipated by the §4.3 amendment.
- Hosting is free on every venue: the "gateway" is the umbrella's proxy
  route, which already runs in the host app (Next/Express) outside the
  sandbox; `VENDO_PROXY_URL` is already injected (§4.2). Nothing new to
  deploy for OSS zero-config.
- Enforcement composes with the provider network wall: sandbox-level egress
  allowlists (E2B allow/deny rules; Modal domain+CIDR allowlists, fail-closed
  since ENG-322) keep blocking raw-socket escapes; handles that bypass the
  shim reach targets as useless opaque strings, never as secrets.
- Limitation: non-fetch clients (raw `net` sockets, non-Node runtimes,
  binaries the app spawns) do not get substitution. They *also* do not leak
  secrets — they never had values — so the failure mode is "integration does
  not authenticate," not "secret exposed."
- Deterministic and cheap to test: the live lanes and egress suites already
  exercise the full path against real E2B.

## Decision matrix

| Criterion | A: TLS-terminating gateway | B: endpoint + fetch shim |
| --- | --- | --- |
| App-code transparency | Full (any client, any language) | Node fetch path only |
| New infra for OSS zero-config | High (public MITM proxy + CA + per-run auth) | None (proxy route already mounted) |
| Provider fit today (E2B/Modal) | Poor — no per-sandbox hosting point | Native on both |
| Security surface added | TLS splice, CA key custody, CONNECT auth | None beyond §4.5 (shipped, red-teamed) |
| Failure mode when bypassed | Silent unproxied egress (if net not walled) | No auth, no leak (handle is opaque) |
| Response secret-stripping | Streaming TLS rewrite (hard) | Already implemented |
| Contract impact | New §4 surface, frozen-doc amendment | §4.3 amendment already names the shim |
| Cloud fit | Good (managed fleet) | Good (same envelope, hosted at scale) |

## Cloud alignment (standing agenda)

Whichever wins, the interface Cloud implements is the **§4.5 egress
envelope**: `POST /egress` `{ url, method?, headers?, body? }` authenticated
by the run token, returning `{ status, headers, body }` with secrets redacted
— plus the `SecretsProvider` seam for value storage. Under option A, Cloud
additionally exposes per-run proxy credentials + CA distribution to its own
sandboxes; the OSS contract surface does not change. Cloud should not build
gateway hosting until the pick lands.

## DECIDED: Option B — explicit egress endpoint + fetch shim

**Picked by Yousef, 2026-07-15** (in-session, relayed by the coordinating
agent). Rationale: the §4.5 egress path is already shipped and red-teamed
(ENG-259); the fetch shim gives app code plain-`fetch` DX with plaintext
never entering the venue; the bypass failure mode is "no auth," never
"secret leaked"; and it hosts on the umbrella's existing proxy route on
every venue with zero new OSS infra. Option A's CA/MITM surface and
provider-hosting gaps are avoided. Cloud implements the §4.5 egress
envelope + `SecretsProvider` seam, nothing gateway-shaped.

The venues child may now build the M4 implementation against this pick.

**Follow-up (decided same session): a guarded per-secret in-sandbox toggle.**
Yousef additionally wants a user-facing safety toggle — "expose this secret
inside this app's sandbox" — as a fast-follow, NOT in M4 scope. Constraints
locked with the pick: B stays the default; the toggle is per-secret × per-app,
owner-only; flipping it is a high-risk approval through the existing guard
flow; every run with an exposed secret emits an audit event; the toggle never
travels with shares or remixes (copies always revert to handles). Requires a
§4.3 amendment ("never by default; explicit per-secret owner opt-in") and its
own red-team pass before shipping. Tracked as a follow-up issue in the apps
project.
