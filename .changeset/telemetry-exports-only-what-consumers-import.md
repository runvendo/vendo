---
"@vendoai/telemetry": minor
---

The package now exports only what its consumers actually import. Seven names left the public surface — `createTelemetry`, `DEFAULT_POSTHOG_KEY`, `CLOUD_PROP_KEYS`, `resolveConsent`, `saveConfig`, `configPath`, and `maybeShowNotice` — none of which was imported by the CLI, the console, or any example. `EVENT_ALLOWLIST` stays: the integration fixture's telemetry-wire seam test consumes it. `initTelemetry` remains the one way to build a client, and the first-run notice it shows moved with it into the entry module (the standalone `notice.ts` is gone). The edge build sheds the same names (`resolveConsent` and its no-op `saveConfig`), keeping the two entries' surfaces aligned.
