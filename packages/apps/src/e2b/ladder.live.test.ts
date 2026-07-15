import { describe } from "vitest";
import { ladderLiveLanes } from "../testing/ladder-live.test-util.js";
import { e2bSandbox } from "./index.js";

// ENG-290 — rungs 2–4 through the REAL runtime on real E2B machines. Gated on
// E2B_API_KEY exactly like e2b.live.test.ts; skipped (not run) without it.
describe.skipIf(!process.env.E2B_API_KEY)("e2b live lanes", () => {
  ladderLiveLanes("real E2B", () => e2bSandbox({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 120_000,
  }), { serverRefPattern: /^e2b:v1:/ });
});
