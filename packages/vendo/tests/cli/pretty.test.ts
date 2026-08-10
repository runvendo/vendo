import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrettyOutput, plainSelect, usePrettyOutput, type SelectInput } from "../../src/cli/pretty.js";
import { plainSecret, plainText } from "../../src/cli/pretty.js";

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

/** Real streams posing as a TTY, so the readline-driven prompt bodies run. */
function promptStreams(): {
  input: PassThrough & { isTTY?: boolean };
  output: Writable & { isTTY?: boolean };
  echoed: () => string;
} {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  let buffer = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;
  return { input, output, echoed: () => buffer };
}

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
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("hello");
    pretty.log("again");
    expect(out.plain()).toContain("┌  vendo init");
    expect(out.plain().match(/┌ {2}vendo init/g)).toHaveLength(1);
  });

  it("names the command it was created for", () => {
    const out = sink();
    createPrettyOutput({ write: out.write, banner: false, command: "vendo sync" }).log("hello");
    expect(out.plain()).toContain("┌  vendo sync");
  });

  it("prints the settled banner and the tagline above the header, and skips both when asked", () => {
    const withBanner = sink();
    createPrettyOutput({ write: withBanner.write, env: { COLORTERM: "truecolor" } }).log("hello");
    const plain = withBanner.plain();
    expect(plain).toContain("▄▄█████▄");
    expect(plain).toContain("Customize your product with an embedded agent");
    expect(plain.indexOf("▄▄█████▄")).toBeLessThan(plain.indexOf("┌  vendo init"));
    // Truecolor terminals get the real brand ramp.
    expect(withBanner.raw()).toContain(`${ESC}[38;2;`);

    const without = sink();
    createPrettyOutput({ write: without.write, banner: false }).log("hello");
    expect(without.plain()).not.toContain("▄▄█████▄");
  });

  it("renders the wired section with colored diff markers and bar-prefixed paths", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("\nWired (3 files):");
    pretty.log("  + vendo/registry.tsx");
    pretty.log("  + app/api/vendo/[...vendo]/route.ts");
    pretty.log("  ~ package.json");
    const plain = out.plain();
    expect(plain).toContain("◆  Wired (3 files)");
    expect(plain).toContain("│  + vendo/registry.tsx");
    expect(plain).toContain("│  ~ package.json");
    // + green, ~ yellow, paths dimmed in the accent.
    expect(out.raw()).toContain(`${ESC}[32m+${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[33m~${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[95mpackage.json${ESC}[39m`);
  });

  it("renders Vendo Cloud as the emphasized section: header, ✦ bullets, → CTA", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("\nVendo Cloud (optional): not configured. A key unlocks team sharing & org governance; hosted automations; the MCP broker.");
    pretty.log("Run `vendo login` to claim a free API key; it lands in .env.local.");
    const plain = out.plain();
    expect(plain).toContain("◆  Vendo Cloud");
    expect(plain).toContain("✦ team sharing & org governance");
    expect(plain).toContain("✦ hosted automations");
    expect(plain).toContain("✦ the MCP broker");
    // The CTA line gets the arrow treatment and keeps the command visible.
    expect(plain).toContain("→ ");
    expect(plain).toContain("vendo login");
    // The header is bold + the brand accent (the most prominent block on screen).
    expect(out.raw()).toContain(`${ESC}[95mVendo Cloud${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[1m`);
  });

  it("renders a configured Vendo Cloud key under the same emphasized header", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("\nVendo Cloud: VENDO_API_KEY present and well-formed.");
    const plain = out.plain();
    expect(plain).toContain("◆  Vendo Cloud");
    expect(plain).toContain("✦ VENDO_API_KEY present and well-formed.");
  });

  it("renders the theme summary as the brand payoff block: four slots, swatch first", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("Theme: accent #7c3bed · background #ffffff · surface #f8fafc · text #0f172a"
      + " · mutedText #64748b · border #e2e8f0 · danger #dc2626");
    pretty.log("Type: Inter · headings Sora · radius 12px");
    pretty.log("Theme lives in .vendo/theme.json — edit it anytime; it is the source of truth.");
    const plain = out.plain();
    expect(plain).toContain("◆  Your brand, captured");
    for (const slot of ["#7c3bed accent", "#ffffff background", "#0f172a text", "#dc2626 danger"]) {
      expect(plain).toContain(slot);
    }
    expect(plain.indexOf("#7c3bed accent")).toBeLessThan(plain.indexOf("#dc2626 danger"));
    expect(plain).toContain("│  Type: Inter · headings Sora · radius 12px");
    // The caller still emits all seven — the block shows the four a person
    // recognises as "our brand".
    expect(plain).not.toContain("surface");
    expect(plain).not.toContain("mutedText");
    expect(plain).not.toContain("border");
    // Each shown slot is a truecolor swatch, and it is the extracted colour.
    expect(out.raw()).toContain(`${ESC}[48;2;124;59;237m  ${ESC}[49m #7c3bed accent`);
    expect(out.raw()).toContain(`${ESC}[48;2;220;38;38m  ${ESC}[49m #dc2626 danger`);
  });

  /** The regression this rule exists for: init's own swatch() wrote a
      truecolor escape whenever stdout was a TTY, which leaked under NO_COLOR.
      The escape now lives behind usePrettyOutput, so the gate is the fix. */
  it.each([
    ["NO_COLOR on a TTY", { isTTY: true }, { NO_COLOR: "1" }],
    ["CI on a TTY", { isTTY: true }, { CI: "true" }],
    ["TERM=dumb on a TTY", { isTTY: true }, { TERM: "dumb" }],
    ["piped stdout", { isTTY: false }, {}],
  ] as const)("emits no escape at all for the brand block under %s", (_name, stream, env) => {
    const out = sink();
    // The real call site's shape (init.ts): the gate picks the renderer, and
    // the plain path just writes the caller's string.
    const message = "Theme: accent #7c3bed · background #ffffff · surface #f8fafc · text #0f172a"
      + " · mutedText #64748b · border #e2e8f0 · danger #dc2626";
    if (usePrettyOutput(stream, env)) createPrettyOutput({ write: out.write, banner: false }).log(message);
    else out.write(`${message}\n`);
    expect(out.raw()).not.toContain(ESC);
    expect(out.raw()).toContain("accent #7c3bed");
  });

  it("collapses sync's five catalog lines into one ◆ Catalog block of two lines", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("tools: +2 -0 ~1");
    pretty.log("tool schemas: inputs 11/13 · outputs 11/13");
    pretty.log("pins: 3 captured, 1 drifted");
    pretty.log("catalog.json: 5 discovered, 5 registered");
    pretty.log("components: 2 captured, 1 updated");
    pretty.done(4200, true);
    const block = out.plain().split("\n").filter((entry) => entry.includes("Catalog")
      || entry.includes("tools:") || entry.includes("components:"));
    expect(block[0]).toContain("◆  Catalog");
    expect(block[1]).toBe("│  tools: +2 -0 ~1 · tool schemas: inputs 11/13 · outputs 11/13 · pins: 3 captured, 1 drifted · catalog.json: 5 discovered, 5 registered");
    expect(block[2]).toBe("│  components: 2 captured, 1 updated");
    expect(block).toHaveLength(3);
  });

  it("collapses the judgment narrative to its counts plus the line that needs the user", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("judgment (claude-code): 12 tools judged");
    pretty.log("  hardened (3): createInvoice, sendEmail, refund");
    pretty.log("  schemas inferred (4): createInvoice.input, refund.output");
    pretty.log("  2 loosenings queued — review with `vendo sync --review`");
    pretty.log("  rejected by the skeptic (1): deleteAccount");
    pretty.log("\nTheme: accent #7c3bed");
    const plain = out.plain();
    expect(plain).toContain("◆  Judgment");
    expect(plain).toContain("│  12 tools judged · hardened (3) · schemas inferred (4) · rejected by the skeptic (1)");
    expect(plain).toContain("│  2 loosenings queued — review with vendo sync --review");
    // The long name lists are gone; --json and `vendo sync` still carry them.
    expect(plain).not.toContain("createInvoice, sendEmail, refund");
    // The block settles before the next section opens.
    expect(plain.indexOf("◆  Judgment")).toBeLessThan(plain.indexOf("◆  Your brand"));
  });

  it("gives sync's impact lines their own ◇ Impact block", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false, command: "vendo sync" });
    pretty.log("impact: sendEmail breaks 2 automations, 1 app, 3 grants");
    pretty.log("impact: createInvoice no saved references");
    pretty.done(4200, true);
    const block = out.plain().split("\n").filter((entry) => entry.includes("Impact")
      || entry.includes("sendEmail") || entry.includes("createInvoice"));
    expect(block[0]).toContain("◇  Impact");
    expect(block[1]).toBe("│  sendEmail breaks 2 automations, 1 app, 3 grants");
    expect(block[2]).toBe("│  createInvoice no saved references");
    expect(block).toHaveLength(3);
    // The title replaces the prefix; every fact is still the caller's.
    expect(out.plain()).not.toContain("impact: ");
    expect(out.raw()).toContain(`${ESC}[1m2 automations, 1 app, 3 grants${ESC}[22m`);
  });

  it.each([
    ["NO_COLOR on a TTY", { isTTY: true }, { NO_COLOR: "1" }],
    ["CI on a TTY", { isTTY: true }, { CI: "true" }],
    ["TERM=dumb on a TTY", { isTTY: true }, { TERM: "dumb" }],
    ["piped stdout", { isTTY: false }, {}],
  ] as const)("leaves the impact line exactly as sync emits it under %s", (_name, stream, env) => {
    const out = sink();
    const message = "impact: sendEmail breaks 2 automations, 1 app, 3 grants";
    if (usePrettyOutput(stream, env)) createPrettyOutput({ write: out.write, banner: false }).log(message);
    else out.write(`${message}\n`);
    expect(out.raw()).toBe(`${message}\n`);
  });

  it("turns the 64-dash paste frame into a ◇ section with an indented code block", () => {
    const out = sink();
    const rule = "─".repeat(64);
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log(`\n${rule}`);
    pretty.log("ONE STEP LEFT — paste this yourself (init never edits your files)");
    pretty.log("\n  File: app/layout.tsx");
    pretty.log("    import { VendoProvider } from \"@vendoai/vendo/react\";");
    pretty.log("\n  Without it, nothing on the page can reach Vendo.");
    pretty.log("  Then confirm it landed: npx vendo doctor");
    pretty.log(rule);
    const plain = out.plain();
    expect(plain).toContain("◇  One paste left — app/layout.tsx");
    expect(plain).toContain("│    import { VendoProvider } from \"@vendoai/vendo/react\";");
    expect(plain).toContain("│  init never edits your files");
    expect(plain).not.toContain(rule);
    expect(plain).not.toContain("ONE STEP LEFT");
  });

  it("points the mount paste at the docs for the child expression it elides", () => {
    const out = sink();
    const rule = "─".repeat(64);
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log(`\n${rule}`);
    pretty.log("ONE STEP LEFT — paste this yourself (init never edits your files)");
    pretty.log("\n  File: app/layout.tsx");
    pretty.log("    import { VendoProvider } from \"@vendoai/vendo/react\";");
    pretty.log("    … then wrap: <VendoProvider baseUrl=\"/api/vendo\" theme={theme as VendoTheme}>{children}</VendoProvider>");
    pretty.log("\n  Without it, nothing on the page can reach Vendo.");
    pretty.log(rule);
    const plain = out.plain();
    expect(plain).toContain("docs.vendo.run/quickstart#the-client-mount — exact wording for layout.tsx and _app.tsx");
    // Right under the wrap line it explains, and dim.
    expect(plain.indexOf("</VendoProvider>")).toBeLessThan(plain.indexOf("docs.vendo.run/quickstart"));
    expect(out.raw()).toContain(`${ESC}[2mdocs.vendo.run/quickstart#the-client-mount`);
  });

  it("leaves a paste block with no mount snippet without the docs pointer", () => {
    const out = sink();
    const rule = "─".repeat(64);
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log(`\n${rule}`);
    pretty.log("ONE STEP LEFT — paste this yourself (init never edits your files)");
    pretty.log("\n  File: app/actions.ts");
    pretty.log("    export const runtime = \"nodejs\";");
    pretty.log(rule);
    expect(out.plain()).not.toContain("docs.vendo.run/quickstart");
  });

  it("renders warnings yellow with ⚠ and other errors red with ✖", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.error("warning: extraction skipped app/broken.ts");
    pretty.error("vendo init failed");
    const plain = out.plain();
    expect(plain).toContain("⚠ extraction skipped app/broken.ts");
    expect(plain).toContain("✖ vendo init failed");
    expect(out.raw()).toContain(`${ESC}[33m⚠ extraction skipped app/broken.ts${ESC}[39m`);
    expect(out.raw()).toContain(`${ESC}[31m✖ vendo init failed${ESC}[39m`);
  });

  // BUG 1. The `code` span closes with a foreground reset, so without the
  // re-arm every character after the first span in a warning printed white —
  // the loudest half of the most security-sensitive line in the install.
  it("keeps a warning yellow past an inline code span", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.error("warning: .env.local holds a secret — add it to `.gitignore` before you commit");
    expect(out.raw()).toContain(`${ESC}[39m${ESC}[22m${ESC}[33m before you commit`);
    // Same for a red error line.
    pretty.error("cannot read `package.json` — is this a project root?");
    expect(out.raw()).toContain(`${ESC}[39m${ESC}[22m${ESC}[31m — is this a project root?`);
  });

  // BUG 2. The rail may absorb the FIRST indent level, and only inside a
  // section; under a narrative line the indent IS the hierarchy.
  it("absorbs a section's first indent level but keeps a narrative's sub-lines indented", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("brief: drafting from 12 judged tools");
    pretty.log("  theme: filling brand slots");
    pretty.log("\nLast steps are yours:");
    pretty.log("  In app/layout.tsx:");
    pretty.log("    import { VendoRoot } from \"@vendoai/vendo/react\";");
    const plain = out.plain();
    expect(plain).toContain("│  brief: drafting from 12 judged tools");
    expect(plain).toContain("│    theme: filling brand slots");
    expect(plain).toContain("◇  Last steps are yours");
    expect(plain).toContain("│  In app/layout.tsx:");
    expect(plain).toContain("│    import { VendoRoot }");
  });

  // BUG 3. The CTA decorates the trimmed text; the kept indent goes back in
  // front, so the arrow lands on the siblings' column instead of shoving the
  // line three spaces right of them.
  it("aligns a CTA line with its siblings in the agent tail", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("\nAgent tail:");
    pretty.log("  auth: none wired");
    pretty.log("  cloud key: none — fetch https://vendo.run/auth.md and run `vendo login`, then re-run init");
    const lines = out.plain().split("\n");
    const sibling = lines.find((entry) => entry.includes("auth: none wired"))!;
    const cta = lines.find((entry) => entry.includes("cloud key: none"))!;
    expect(cta.indexOf("→")).toBe(sibling.indexOf("auth:"));
  });

  it("renders the last-steps section and closes with the done footer", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
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

  it("carries what the run achieved in the footer", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.done(12400, true, "14 tools · brand captured · 1 paste left");
    expect(out.plain()).toContain("└  Done in 12.4s — 14 tools · brand captured · 1 paste left");
  });

  // The star ask is a dim footer line now, not a question. It is pretty-only:
  // usePrettyOutput already keeps plain, piped, NO_COLOR, CI and TERM=dumb runs
  // out of this renderer entirely.
  it("closes the run with the dim star line", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.done(12400, true, "14 tools · brand captured");
    const lines = out.plain().trimEnd().split("\n");
    expect(lines.at(-2)).toContain("└  Done in 12.4s");
    expect(lines.at(-1)).toBe("   Star us: vendo.run/star · docs.vendo.run");
    expect(out.raw()).toContain(`${ESC}[2mStar us: vendo.run/star · docs.vendo.run${ESC}[22m`);
  });

  it("closes with a red failure footer when init fails", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.error("boom");
    pretty.done(900, false);
    expect(out.plain()).toContain("└  Failed after 0.9s");
    expect(out.raw()).toContain(`${ESC}[31mFailed after 0.9s${ESC}[39m`);
  });

  it("block: a pretty-only result block on the rail", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.block("Your stack", ["Next.js · App Router · TypeScript · pnpm", "Clerk auth (@clerk/nextjs)"]);
    pretty.block("Where will this deploy?", ["https://app.acme.com"], "◇");
    const plain = out.plain();
    expect(plain).toContain("◆  Your stack");
    expect(plain).toContain("│  Next.js · App Router · TypeScript · pnpm");
    expect(plain).toContain("◇  Where will this deploy?");
  });

  it("select: arrow keys move the selection, Enter accepts, list collapses to the answer", async () => {
    const out = sink();
    const keys = fakeInput();
    const pretty = createPrettyOutput({ write: out.write, input: keys.input, banner: false });
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
    const pretty = createPrettyOutput({ write: out.write, input: keys.input, banner: false });
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
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    await expect(pretty.confirm("Wire auth: authJs()?", true)).resolves.toBe(true);
    await expect(pretty.confirm("Log in to Vendo Cloud now?", false)).resolves.toBe(false);
    expect(out.plain()).not.toContain("Wire auth");
    expect(out.plain()).not.toContain("Log in");
  });

  it("text and secret return the empty skip without prompting when stdin is not a TTY", async () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    await expect(pretty.text("Where will this deploy?")).resolves.toBe("");
    await expect(pretty.secret("Paste your provider key")).resolves.toBe("");
    expect(out.plain()).not.toContain("Where will this deploy?");
    expect(out.plain()).not.toContain("Paste your provider key");
  });

  it("select: one pasted chunk containing '2\\r' picks option 2", async () => {
    const out = sink();
    const keys = fakeInput();
    const pretty = createPrettyOutput({ write: out.write, input: keys.input, banner: false });
    const choice = pretty.select("Which auth should Vendo wire?", [
      { value: "none", label: "none" },
      { value: "authJs", label: "authJs()" },
      { value: "jwt", label: "jwt" },
    ]);
    keys.press("2\r");
    expect(await choice).toBe("authJs");
  });

  it("select: several keys in one chunk are all consumed (two arrow-downs move twice)", async () => {
    const out = sink();
    const keys = fakeInput();
    const pretty = createPrettyOutput({ write: out.write, input: keys.input, banner: false });
    const choice = pretty.select("Which auth should Vendo wire?", [
      { value: "none", label: "none" },
      { value: "authJs", label: "authJs()" },
      { value: "jwt", label: "jwt" },
    ]);
    keys.press("\u001b[B\u001b[B");
    keys.press("\r");
    expect(await choice).toBe("jwt");
  });

  it("select: an escape sequence split across chunks still moves", async () => {
    const out = sink();
    const keys = fakeInput();
    const pretty = createPrettyOutput({ write: out.write, input: keys.input, banner: false });
    const choice = pretty.select("Which auth should Vendo wire?", [
      { value: "none", label: "none" },
      { value: "authJs", label: "authJs()" },
    ]);
    keys.press("\u001b");
    keys.press("[B");
    keys.press("\r");
    expect(await choice).toBe("authJs");
  });

  it("select returns the default option without prompting when stdin is not a TTY", async () => {
    const out = sink();
    const pretty = createPrettyOutput({
      write: out.write,
      banner: false,
      input: { isTTY: false, on: () => undefined, off: () => undefined },
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

  it("plainText and plainSecret answer the empty skip without prompting when not a TTY", async () => {
    expect(await plainText("Where will this deploy?")).toBe("");
    expect(await plainSecret("Paste your provider key")).toBe("");
  });

  it("confirm parses y / n / Enter-default / other text through a real readline", async () => {
    const out = sink();
    const io = promptStreams();
    const pretty = createPrettyOutput({
      write: out.write,
      input: io.input,
      promptOutput: io.output,
      banner: false,
    });

    const enterAccepts = pretty.confirm("Wire auth: authJs()?", true);
    io.input.write("\n");
    expect(await enterAccepts).toBe(true);

    const explicitNo = pretty.confirm("Wire auth: authJs()?", true);
    io.input.write("n\n");
    expect(await explicitNo).toBe(false);

    const explicitYes = pretty.confirm("Log in to Vendo Cloud now?", false);
    io.input.write("y\n");
    expect(await explicitYes).toBe(true);

    // Anything that isn't a yes is a No — even against a Yes default.
    const garbage = pretty.confirm("Wire auth: authJs()?", true);
    io.input.write("whatever\n");
    expect(await garbage).toBe(false);

    const plain = out.plain();
    expect(plain).toContain("◇  Wire auth: authJs()?");
    expect(plain).toContain("● Yes");
    expect(plain).toContain("● No");
  });

  it("text asks on the rail, echoes the answer, and calls an empty answer a skip", async () => {
    const out = sink();
    const io = promptStreams();
    const pretty = createPrettyOutput({
      write: out.write,
      input: io.input,
      promptOutput: io.output,
      banner: false,
    });

    const answered = pretty.text("Where will this deploy?", "e.g. https://app.acme.com — Enter to skip");
    io.input.write("https://app.acme.com\n");
    expect(await answered).toBe("https://app.acme.com");

    const skipped = pretty.text("Where will this deploy?");
    io.input.write("\n");
    expect(await skipped).toBe("");

    const plain = out.plain();
    expect(plain).toContain("◇  Where will this deploy?");
    expect(plain).toContain("│  e.g. https://app.acme.com — Enter to skip");
    expect(plain).toContain("● https://app.acme.com");
    expect(plain).toContain("● skipped");
  });

  it("secret echoes a masked receipt and never the value", async () => {
    const out = sink();
    const io = promptStreams();
    (io.input as PassThrough & { setRawMode?: (mode: boolean) => void }).setRawMode = () => undefined;
    const pretty = createPrettyOutput({
      write: out.write,
      input: io.input,
      promptOutput: io.output,
      banner: false,
    });

    const answered = pretty.secret("Paste your provider key", "ANTHROPIC_API_KEY");
    io.input.write("sk-ant-secret-a41c\n");
    expect(await answered).toBe("sk-ant-secret-a41c");

    const plain = out.plain();
    expect(plain).toContain("◇  Paste your provider key");
    expect(plain).toContain("● •••••••• (…a41c)");
    expect(plain).not.toContain("sk-ant-secret-a41c");
    expect(io.echoed()).not.toContain("sk-ant-secret-a41c");
  });

  it("plainSelect drives the numbered list: pick, Enter-default, out-of-range and garbage settle on the default", async () => {
    const options = [
      { value: "none", label: "none — stay anonymous, add it later" },
      { value: "clerk", label: "clerk() — Clerk", hint: "detected @clerk/nextjs" },
    ];

    const picked = promptStreams();
    const pick = plainSelect("Which auth should Vendo wire?", options, 0, picked.input, picked.output);
    picked.input.write("2\n");
    expect(await pick).toBe("clerk");
    expect(picked.echoed()).toContain("Which auth should Vendo wire?");
    expect(picked.echoed()).toContain("1. none — stay anonymous, add it later");
    expect(picked.echoed()).toContain("2. clerk() — Clerk (detected @clerk/nextjs)");
    expect(picked.echoed()).toContain("Choose [1]: ");

    const defaulted = promptStreams();
    const byEnter = plainSelect("Which auth should Vendo wire?", options, 0, defaulted.input, defaulted.output);
    defaulted.input.write("\n");
    expect(await byEnter).toBe("none");

    // Out-of-range and non-numeric answers settle on the default (no re-ask).
    const outOfRange = promptStreams();
    const nine = plainSelect("Which auth should Vendo wire?", options, 0, outOfRange.input, outOfRange.output);
    outOfRange.input.write("9\n");
    expect(await nine).toBe("none");

    const garbage = promptStreams();
    const text = plainSelect("Which auth should Vendo wire?", options, 0, garbage.input, garbage.output);
    garbage.input.write("clerk\n");
    expect(await text).toBe("none");
  });

  it("plainText and plainSecret drive a real readline, and only plainSecret hides the typing", async () => {
    const asked = promptStreams();
    const answer = plainText("Where will this deploy?", "Enter to skip", asked.input, asked.output);
    asked.input.write("https://app.acme.com\n");
    expect(await answer).toBe("https://app.acme.com");
    expect(asked.echoed()).toContain("Where will this deploy?");
    expect(asked.echoed()).toContain("  Enter to skip");

    const secret = promptStreams();
    (secret.input as PassThrough & { setRawMode?: (mode: boolean) => void }).setRawMode = () => undefined;
    const key = plainSecret("Paste your provider key", undefined, secret.input, secret.output);
    secret.input.write("sk-ant-secret-a41c\n");
    expect(await key).toBe("sk-ant-secret-a41c");
    expect(secret.echoed()).toContain("•••••••• (…a41c)");
    expect(secret.echoed()).not.toContain("sk-ant-secret-a41c");
  });

  it("spins during slow phases and clears the frame before any log line", () => {
    vi.useFakeTimers();
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
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
