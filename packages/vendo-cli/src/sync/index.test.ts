import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSync } from "./index.js";
import { createUi } from "../ui.js";

const NOW = () => "2026-07-06T00:00:00.000Z";

function capUi() {
  const lines: string[] = [];
  const ui = createUi({ sink: (c) => lines.push(c), tty: false, colors: false });
  return { lines, ui };
}

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "vendo-sync-"));
}

describe("runSync — silent maintenance", () => {
  it("a clean/empty run prints a short summary and never suggests new things", async () => {
    const dir = tmp();
    try {
      const { lines, ui } = capUi();
      expect(await runSync({ targetDir: dir, ui, now: NOW })).toBe(0);
      const out = lines.join("");
      // Header + one ok summary line, and nothing else.
      expect(out).toContain("vendo sync");
      expect(out).toMatch(/environment up to date \(0 widgets captured\)/);
      // It must NOT enumerate routine work or suggest wrapping / re-running.
      expect(out).not.toMatch(/wrap components/i);
      expect(out).not.toMatch(/re-run/i);
      expect(out).not.toMatch(/Next steps/i);
      expect(out).not.toMatch(/vendored|captured \S+ ←|skipped/);
      // Mechanics unchanged: it still writes the capture manifest.
      expect(JSON.parse(readFileSync(path.join(dir, ".vendo/remix-sources.json"), "utf8"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a refused capture (anchored source it maintains is broken) as a warn line", async () => {
    const dir = tmp();
    try {
      const appDir = path.join(dir, "src", "app");
      mkdirSync(appDir, { recursive: true });
      // A server-only file the threat model refuses to capture.
      writeFileSync(path.join(appDir, "widget.tsx"), '"use server";\nexport function Widget() { return null; }\n');
      writeFileSync(
        path.join(appDir, "page.tsx"),
        'import { Widget } from "./widget";\nexport default function Page() {\n  return <VendoRemix id="w"><Widget /></VendoRemix>;\n}\n',
      );
      const { lines, ui } = capUi();
      expect(await runSync({ targetDir: dir, ui, now: NOW })).toBe(0);
      const out = lines.join("");
      // The summary flips to warn and the refusal is surfaced as an indented warn line.
      expect(out).toMatch(/environment refreshed \(0 widgets captured\)/);
      expect(out).toMatch(/! .*use server/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
