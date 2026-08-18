import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/wire/shared.js";
import { browserOpenCommand, CLI_VERSION, invokedByPackageScript } from "../../src/cli/shared.js";

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

describe("browserOpenCommand", () => {
  it("goes through cmd /c on Windows — start is a shell built-in, not an executable", () => {
    expect(browserOpenCommand("win32", "http://127.0.0.1:4123")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://127.0.0.1:4123"],
    });
  });

  it("uses open on macOS and xdg-open elsewhere", () => {
    expect(browserOpenCommand("darwin", "u")).toEqual({ command: "open", args: ["u"] });
    expect(browserOpenCommand("linux", "u")).toEqual({ command: "xdg-open", args: ["u"] });
  });
});

describe("invokedByPackageScript", () => {
  it("counts a real lifecycle hook, and nothing at all outside npm", () => {
    expect(invokedByPackageScript({ npm_lifecycle_event: "predev" })).toBe(true);
    expect(invokedByPackageScript({ npm_lifecycle_event: "postinstall" })).toBe(true);
    expect(invokedByPackageScript({})).toBe(false);
    expect(invokedByPackageScript({ npm_lifecycle_event: "" })).toBe(false);
    expect(invokedByPackageScript({ npm_lifecycle_event: "  " })).toBe(false);
  });

  // `npx vendo init` — the docs' own command — is a human at a keyboard, but
  // npm exec runs its target as a synthetic script named `npx`, so treating
  // the event as proof of a hook ran the whole quickstart mute.
  it("does not count npm exec's synthetic `npx` event", () => {
    expect(invokedByPackageScript({ npm_lifecycle_event: "npx" })).toBe(false);
  });
});
