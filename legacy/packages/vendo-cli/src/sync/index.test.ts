import { describe, expect, it } from "vitest";
import { runSync } from "./index.js";
import { createUi } from "../ui.js";

describe("runSync", () => {
  it("keeps the prebuild command as a quiet successful no-op", async () => {
    const lines: string[] = [];
    const ui = createUi({ sink: (chunk) => lines.push(chunk), tty: false, colors: false });
    await expect(runSync({ targetDir: "/unused", ui })).resolves.toBe(0);
    expect(lines.join(" ")).toContain("generated artifacts up to date");
  });
});
