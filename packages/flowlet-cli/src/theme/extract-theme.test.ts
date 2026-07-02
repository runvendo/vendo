import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractTheme } from "./extract-theme.js";
import { detectTarget } from "../detect.js";

describe("extractTheme", () => {
  it("writes a valid theme.json from a v4 css app", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "theme-"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { tailwindcss: "^4.0.0" } }));
    await mkdir(path.join(dir, "src/app"), { recursive: true });
    await writeFile(
      path.join(dir, "src/app/globals.css"),
      "@theme { --color-bg: #FBFBFA; --color-surface: #FFFFFF; --color-ink: #111111; --color-muted: #908C85; --radius-card: 14px; }",
    );
    const info = await detectTarget(dir);
    const summary = await extractTheme(dir, info, { force: false });
    const written = JSON.parse(await readFile(path.join(dir, ".flowlet/theme.json"), "utf8"));
    expect(written.background).toBe("#FBFBFA");
    expect(written.version).toBe(1);
    expect(summary.written).toBe(true);
    expect(summary.defaulted).toContain("accent");
  });
});
