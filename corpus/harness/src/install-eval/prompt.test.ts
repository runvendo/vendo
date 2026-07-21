import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractNorthStarPrompt, readNorthStarPrompt } from "./prompt.js";

const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

describe("extractNorthStarPrompt", () => {
  it("extracts the first ```text fence", () => {
    const source = [
      "# Install",
      "Paste this into your coding agent:",
      "```text",
      "Install Vendo in this repo. Read https://vendo.run/agents.md and follow",
      "it exactly.",
      "```",
      "```bash",
      "npm install vendoai",
      "```",
    ].join("\n");
    expect(extractNorthStarPrompt(source)).toBe(
      "Install Vendo in this repo. Read https://vendo.run/agents.md and follow\nit exactly.",
    );
  });

  it("throws when no text fence exists", () => {
    expect(() => extractNorthStarPrompt("# Install\nno fence here")).toThrow(/no longer contains/);
  });

  it("reads the real README prompt (drift guard)", async () => {
    const prompt = await readNorthStarPrompt(workspaceRoot);
    expect(prompt).toContain("https://vendo.run/agents.md");
    expect(prompt).toContain("vendo doctor --json");
    expect(prompt).toContain("Ask me before creating any account or key");
    expect(prompt).toContain("star runvendo/vendo");
    // The prompt must match the README byte-for-byte, not a copy.
    const source = await readFile(path.join(workspaceRoot, "README.md"), "utf8");
    expect(source).toContain(prompt);
  });
});
