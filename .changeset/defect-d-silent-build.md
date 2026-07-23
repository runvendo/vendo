---
"@vendoai/apps": patch
"@vendoai/ui": patch
---

A create_app build can no longer die silently (0.4.5 E2E cert defect D, byo-ai-sdk host). Three layers: a build whose every region was disclaimed away ("This part of the request isn't available on this host.") now fails terminally with an honest host-capability reason instead of persisting as a "successful" app that reads as a build hanging forever; a server-side build watchdog persists a terminal failed record when a build task neither completes nor throws inside its window (VENDO_APP_BUILD_WATCHDOG_MS, default 4 min), so the embed always resolves even if the build promise hangs or is severed by the host runtime; and the embed's build deadline is now an absolute client-side timer with a per-poll timeout, so a hung open() poll can no longer freeze the building beat past the deadline.
