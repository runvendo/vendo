---
"@vendoai/ui": patch
---

The connect dock's status poll now backs off exponentially on failures (1.5s floor, 15s cap, with jitter) instead of retrying on the healthy cadence until the 120s deadline, and a rate-limited answer (the wire `unavailable` code) jumps straight to the cap. A failing poll no longer sustains the very rate limit that is failing it. Before giving up at the deadline, the dock checks status one last time, so a connection that went active during the final backoff wait is reported as connected instead of timed out.
