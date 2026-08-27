---
"@vendoai/vendo": patch
---

The build brief tells the box what "reality" is, so builds stop hunting for a browser.

A build box is told to "test what you built against reality, and fix what
fails" — and it was never told what reality it is standing in. The machine
reaches the npm registry and the inference host, and nothing else. So an agent
that took the instruction seriously went looking for the reality it knows: a
real browser to drive Playwright against, then a native canvas to render into.
Both are unreachable past the box's allowlist, and neither failure is one it can
be talked out of, so it re-architected the app and tried again.

Measured live on 2026-08-27: four escalated builds died at 15.2–15.4 minutes
against the 15-minute message budget, on asks as small as "show a QR code". Ask
weight was never the variable — every build reached the same cul-de-sac, and the
cul-de-sac costs the same whatever was asked for.

The test step now names the egress it has to live inside: Node, a pure-JS DOM,
no browser and no native binaries. The instruction to verify is unchanged — a
build that ships an untested bundle is the failure this brief already guards
against — and the allowlist is untouched, because it is the security boundary
and the honest fix is to stop lying to the agent about it.
