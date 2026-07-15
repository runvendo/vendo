import { describe } from "vitest";
import { fetchShimLiveLane } from "../testing/fetch-shim-live.test-util.js";
import { e2bSandbox } from "./index.js";

// ENG-290 M4 — the egress fetch shim on a real E2B machine, composed with the
// real proxy over the real network. Gated on E2B_API_KEY exactly like
// e2b.live.test.ts; skipped (not run) without it.
describe.skipIf(!process.env.E2B_API_KEY)("e2b live fetch shim", () => {
  fetchShimLiveLane("real E2B", () => e2bSandbox({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 120_000,
  }));
});
