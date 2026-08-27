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

Two more of the same shape were measured once that one was gone: the image's
baked `@vendoai/ui` predates the frame protocol, so a build that used it lost
the time to find that out; and `callHost` was named as the way to reach host
data, which sent an agent hunting the box's disk for a tool list that is
deliberately absent.

The brief now names the egress it has to live inside — Node, a pure-JS DOM, no
browser, no native binaries — says to install `@vendoai/ui` from npm rather than
the stale baked copy, and places `startFrameProtocol`/`callHost` on the runtime
side of the line: they speak to the embedding page, so they answer for the
shipped app and never inside the box.

Nothing is withdrawn. The instruction to verify stands, `callHost` stays (it is
a postMessage to the host page, and dropping it would take the capability with
it), the allowlist is untouched because it is the security boundary, and
`MESSAGE_BUDGET_MS` is unchanged because a timeout is a hang-detector, not a
speed limit.

A build now completes: 836.6s end to end against a real Vendo Cloud box, sealing
a 257 KB `dist/app.js` from a "show a QR code" ask.
