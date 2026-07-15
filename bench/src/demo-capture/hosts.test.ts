import { describe, expect, it } from "vitest";
import { demoHostCommandArgs } from "./hosts.js";

describe("demoHostCommandArgs", () => {
  it("forwards Next options without a literal pnpm separator", () => {
    expect(demoHostCommandArgs("demo-bank", 3100)).toEqual([
      "--filter", "demo-bank", "dev",
      "--hostname", "127.0.0.1",
      "--port", "3100",
    ]);
  });
});
