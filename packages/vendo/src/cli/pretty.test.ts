import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrettyOutput, plainSelect, usePrettyOutput, type SelectInput } from "./pretty.js";

const ESC = "\u001b";

/** Drop SGR/erase sequences so structure asserts stay legible. */
function stripAnsi(text: string): string {
  return text.split(ESC).map((chunk, index) => {
    if (index === 0) return chunk;
    return chunk.replace(/^\[[0-9;]*[A-Za-z]/, "");
  }).join("").replace(/\r/g, "");
}

function sink(): { write: (chunk: string) => void; raw: () => string; plain: () => string } {
  let buffer = "";
  return {
    write: (chunk) => { buffer += chunk; },
    raw: () => buffer,
    plain: () => stripAnsi(buffer),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/** A PTY-free keypress source for the select loop. */
function fakeInput(): { input: SelectInput; press: (text: string) => void } {
  const listeners = new Set<(chunk: Buffer | string) => void>();
  return {
    input: {
      isTTY: true,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (_event, listener) => listeners.add(listener),
      off: (_event, listener) => listeners.delete(listener),
    },
    press: (text) => {
      for (const listener of [...listeners]) listener(text);
    },
  };
}

describe("usePrettyOutput (selection)", () => {
  it("selects pretty only on a TTY with no opt-outs", () => {
    expect(usePrettyOutput({ isTTY: true }, {})).toBe(true);
  });

  it.each([
    ["non-TTY stdout", { isTTY: false }, {}],
    ["missing isTTY (pipes, tests)", {}, {}],
    ["NO_COLOR set", { isTTY: true }, { NO_COLOR: "1" }],
    ["CI set", { isTTY: true }, { CI: "true" }],
    ["TERM=dumb", { isTTY: true }, { TERM: "dumb" }],
  ] as const)("degrades to plain on %s", (_name, stream, env) => {
    expect(usePrettyOutput(stream, env)).toBe(false);
  });

  it("treats empty NO_COLOR / CI as unset (no-color.org semantics)", () => {
    expect(usePrettyOutput({ isTTY: true }, { NO_COLOR: "", CI: "" })).toBe(true);
  });
});

describe("createPrettyOutput (visual system)", () => {
  it("opens with the vendo init header exactly once", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.log("hello");
    pretty.log("again");
    expect(out.plain()).toContain("┌  vendo init");
    expect(out.plain().match(/┌ {2}vendo init/g)).toHaveLength(1);
  });

  it("renders the wired section with colored diff markers and bar-prefixed paths", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.log("\nWired (3 files):");
    pretty.log("  + vendo/registry.tsx");
    pretty.log("  + app/api/vendo/[...vendo]/route.ts");
    pretty.log("  ~ package.json");
    const plain = out.plain();
    expect(plain).toContain("◆  Wired (3 files)");
    expect(plain).toContain("│  + vendo/registry.tsx");
    expect(plain).toContain("│  ~ package.json");
    // + green, ~ yellow, paths dimmed-cyan.
    expect(out.raw()).toContain(`${ESC}[32m+${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[33m~${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[36mpackage.json${ESC}[39m`);
  });

  it("renders Vendo Cloud as the emphasized section: header, ✦ bullets, → CTA", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.log("\nVendo Cloud (optional): not configured. A key unlocks team sharing & org governance; hosted automations; the MCP broker.");
    pretty.log("Run `vendo cloud login` to grab a free dev-mode starter key; the wizard writes it to .env.local on your next `vendo init`.");
    const plain = out.plain();
    expect(plain).toContain("◆  Vendo Cloud");
    expect(plain).toContain("✦ team sharing & org governance");
    expect(plain).toContain("✦ hosted automations");
    expect(plain).toContain("✦ the MCP broker");
    // The CTA line gets the arrow treatment and keeps the command visible.
    expect(plain).toContain("→ ");
    expect(plain).toContain("vendo cloud login");
    // The header is bold + brand blue (the most prominent block on screen).
    expect(out.raw()).toContain(`${ESC}[34mVendo Cloud${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[1m`);
  });

  it("renders a configured Vendo Cloud key under the same emphasized header", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.log("\nVendo Cloud: VENDO_API_KEY present and well-formed.");
    const plain = out.plain();
    expect(plain).toContain("◆  Vendo Cloud");
    expect(plain).toContain("✦ VENDO_API_KEY present and well-formed.");
  });

  it("renders the theme summary as a captured section", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.log("Theme: accent #2b7fff · background #fafafa");
    pretty.log("Type: Inter · radius 8px");
    pretty.log("Theme lives in .vendo/theme.json — edit it anytime; it is the source of truth.");
    const plain = out.plain();
    expect(plain).toContain("◇  Theme captured");
    expect(plain).toContain("│  accent #2b7fff · background #fafafa");
    expect(plain).toContain("│  Type: Inter · radius 8px");
  });

  it("renders warnings yellow with ⚠ and other errors red with ✖", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.error("warning: extraction skipped app/broken.ts");
    pretty.error("vendo init failed");
    const plain = out.plain();
    expect(plain).toContain("⚠ extraction skipped app/broken.ts");
    expect(plain).toContain("✖ vendo init failed");
    expect(out.raw()).toContain(`${ESC}[33m⚠ extraction skipped app/broken.ts${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[31m✖ vendo init failed${ESC}[39m`);
  });

  it("renders the last-steps section and closes with the done footer", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.log("\nLast steps are yours:");
    pretty.log("  In app/layout.tsx:");
    pretty.log("    import { VendoRoot } from \"@vendoai/vendo/react\";");
    pretty.log("\nThen start your dev server — the agent is live in your app.");
    pretty.log("Verify everything: `npx vendo doctor` (it can start the server and run a live turn).");
    pretty.done(4230, true);
    const plain = out.plain();
    expect(plain).toContain("◇  Last steps are yours");
    expect(plain).toContain("│  In app/layout.tsx:");
    expect(plain).toContain("│    import { VendoRoot }");
    expect(plain).toContain("npx vendo doctor");
    expect(plain).toContain("└  Done in 4.2s");
  });

  it("closes with a red failure footer when init fails", () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.error("boom");
    pretty.done(900, false);
    expect(out.plain()).toContain("└  Failed after 0.9s");
    expect(out.raw()).toContain(`${ESC}[31mFailed after 0.9s${ESC}[39m`);
  });

  it("select: arrow keys move the selection, Enter accepts, list collapses to the answer", async () => {
    const out = sink();
    const keys = fakeInput();
    const pretty = createPrettyOutput(out.write, keys.input);
    const choice = pretty.select("Which auth should Vendo wire?", [
      { value: "none", label: "none — stay anonymous, add it later" },
      { value: "clerk", label: "clerk() — Clerk", hint: "detected @clerk/nextjs" },
      { value: "jwt", label: "jwt — my own JWT scheme" },
    ]);
    keys.press("\u001b[B");
    keys.press("\r");
    expect(await choice).toBe("clerk");
    const plain = out.plain();
    expect(plain).toContain("◇  Which auth should Vendo wire?");
    expect(plain).toContain("○ ");
    expect(plain).toContain("(detected @clerk/nextjs)");
    // Collapsed to the chosen answer.
    expect(plain).toContain("● clerk() — Clerk");
  });

  it("select: number keys pick directly without Enter", async () => {
    const out = sink();
    const keys = fakeInput();
    const pretty = createPrettyOutput(out.write, keys.input);
    const choice = pretty.select("Which auth should Vendo wire?", [
      { value: "none", label: "none" },
      { value: "authJs", label: "authJs()" },
      { value: "jwt", label: "jwt" },
    ]);
    keys.press("3");
    expect(await choice).toBe("jwt");
    expect(out.plain()).toContain("● jwt");
  });

  it("confirm returns the default without prompting when stdin is not a TTY", async () => {
    // vitest's stdin is not a TTY: the styled confirm must never block
    // readline — the default stands (stdout-TTY selection is stdout-only).
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    await expect(pretty.confirm("Wire auth: authJs()?", true)).resolves.toBe(true);
    await expect(pretty.confirm("Log in to Vendo Cloud now?", false)).resolves.toBe(false);
    expect(out.plain()).not.toContain("Wire auth");
    expect(out.plain()).not.toContain("Log in");
  });

  it("select returns the default option without prompting when stdin is not a TTY", async () => {
    const out = sink();
    const pretty = createPrettyOutput(out.write, {
      isTTY: false,
      on: () => undefined,
      off: () => undefined,
    });
    await expect(pretty.select("Which auth should Vendo wire?", [
      { value: "none", label: "none — stay anonymous" },
      { value: "clerk", label: "clerk()" },
    ])).resolves.toBe("none");
    expect(out.plain()).not.toContain("Which auth");
  });

  it("plainSelect returns the default without prompting when not a TTY", async () => {
    expect(await plainSelect("Which auth should Vendo wire?", [
      { value: "none", label: "none — stay anonymous" },
      { value: "clerk", label: "clerk()" },
    ])).toBe("none");
  });

  it("spins during slow phases and clears the frame before any log line", () => {
    vi.useFakeTimers();
    const out = sink();
    const pretty = createPrettyOutput(out.write);
    pretty.spin("Capturing your theme");
    vi.advanceTimersByTime(300);
    expect(out.plain()).toContain("Capturing your theme");
    pretty.log("Theme: accent #2b7fff");
    // The in-flight frame is erased (carriage return + erase-line) before printing.
    expect(out.raw()).toContain(`${ESC}[2K`);
    pretty.stopSpin();
    vi.advanceTimersByTime(300);
    const settled = out.raw();
    vi.advanceTimersByTime(300);
    expect(out.raw()).toBe(settled); // no frames after stopSpin
  });
});
