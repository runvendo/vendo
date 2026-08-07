// Tests must never emit real telemetry: every CLI command now constructs a
// real telemetry client, and most suites run commands without an injected
// telemetry seam (which would fall back to process.env + the shipped PostHog
// key). An explicit `telemetry: { env }` passed by a test still wins —
// toolingTelemetry ignores process.env when options.env is provided.
process.env.VENDO_TELEMETRY_DISABLED = "1";
