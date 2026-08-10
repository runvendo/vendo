import { describe, expect, it } from "vitest";
import { corpusHostCommandEnv } from "../src/process.js";

describe("corpusHostCommandEnv", () => {
  it("turns engine-strict off in both pnpm config dialects, over an inherited setting", () => {
    expect(corpusHostCommandEnv({
      npm_config_engine_strict: "true",
      PNPM_CONFIG_ENGINE_STRICT: "true",
    })).toMatchObject({
      npm_config_engine_strict: "false",
      PNPM_CONFIG_ENGINE_STRICT: "false",
    });
  });
});
