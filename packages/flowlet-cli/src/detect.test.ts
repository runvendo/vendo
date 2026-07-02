import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectTarget } from "./detect.js";

async function makeApp(pkg: object, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "flowlet-detect-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

describe("detectTarget", () => {
  it("detects next + tailwind v4 css-first + no openapi", async () => {
    const dir = await makeApp(
      { dependencies: { next: "15.0.0", tailwindcss: "^4.0.0" } },
      { "src/app/globals.css": '@import "tailwindcss";\n@theme { --color-bg: #fff; }' },
    );
    const info = await detectTarget(dir);
    expect(info.framework).toBe("next");
    expect(info.tailwind).toBe("v4-css");
    expect(info.cssFiles).toHaveLength(1);
    expect(info.openapiPath).toBeNull();
  });

  it("detects vite + tailwind v3 config + openapi spec", async () => {
    const dir = await makeApp(
      { devDependencies: { vite: "5.0.0", tailwindcss: "^3.4.0" } },
      { "tailwind.config.js": "export default {}", "openapi.json": '{"openapi":"3.0.0"}' },
    );
    const info = await detectTarget(dir);
    expect(info.framework).toBe("vite");
    expect(info.tailwind).toBe("v3-config");
    expect(info.tailwindConfigPath).toMatch(/tailwind\.config\.js$/);
    expect(info.openapiPath).toMatch(/openapi\.json$/);
  });

  it("handles a bare repo", async () => {
    const dir = await makeApp({}, {});
    const info = await detectTarget(dir);
    expect(info).toMatchObject({ framework: "unknown", tailwind: "none", openapiPath: null });
  });
});
