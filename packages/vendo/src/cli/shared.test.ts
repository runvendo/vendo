import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "./shared.js";

describe("CLI_VERSION", () => {
  // The constant rides doctor fix_ref URLs and the cloud client user-agent,
  // but changesets only bumps package.json — this pin makes a release cut
  // that forgets the constant fail loudly (0.4.0 shipped reporting 0.3.0).
  it("matches the package version", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
