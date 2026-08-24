---
"@vendoai/vendo": minor
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/ui": minor
---

Built apps: the build now says what it is doing, and a sealed bundle renders in the host's own font. `BuildRequest.onStatus` was emitted by the build lane and supplied by nobody, so a build narrated itself to no one; the door now writes the lane's latest line onto the app row (`AppDocument.buildStatus`) and the pending poll answers with it (`PendingSurface.status`), which the forming card reads in place of the generic "Building …". One label, replaced each time — no stream, no subscription, no new route — and a status write that fails never fails the build. Brand fonts now travel with the brand tokens at render: `sendFrameTheme` carries the host's `.vendo/fonts.css` faces into the frame, which installs them as its own sheet, and the bundle route's CSP gains `font-src data:` so an inlined face can load. The seal still holds nothing font-related, and the frame still makes no network request of any kind.
