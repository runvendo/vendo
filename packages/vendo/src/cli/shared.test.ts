import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { VERSION } from "../wire/shared.js";
import { CLI_VERSION } from "./shared.js";

// Both constants ride user-facing surfaces (--version, doctor fix_ref URLs,
// the cloud client user-agent, the wire /status body), but changesets only
// bumps package.json — these pins make a release cut that forgets a constant
// fail loudly (the 0.4.0 cut shipped both reporting 0.3.0).
describe("hand-maintained version constants", () => {
  it("CLI_VERSION and wire VERSION match the package version", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(CLI_VERSION).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });
});
