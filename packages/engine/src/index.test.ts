import { describe, expect, it } from "vitest";
import * as engine from "./index.js";

describe("index (public surface)", () => {
  it("exports the runner, job parsing, seam, and CLI entry points", () => {
    expect(typeof engine.runEngineJob).toBe("function");
    expect(typeof engine.parseJob).toBe("function");
    expect(typeof engine.readJobFromStream).toBe("function");
    expect(typeof engine.JobValidationError).toBe("function");
    expect(typeof engine.JOB_MAX_BYTES).toBe("number");
    expect(typeof engine.createSdkQuery).toBe("function");
    expect(typeof engine.runCli).toBe("function");
  });

  it("createSdkQuery returns a callable query function without loading the real SDK", () => {
    // Merely calling createSdkQuery() must not trigger the dynamic import —
    // that only happens once the returned generator is actually iterated.
    const query = engine.createSdkQuery();
    expect(typeof query).toBe("function");
  });
});
