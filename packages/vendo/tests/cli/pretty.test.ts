import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrettyOutput, displayWidth, plainSelect, usePrettyOutput, type SelectInput } from "../../src/cli/pretty.js";
import { plainSecret, plainText } from "../../src/cli/pretty.js";
import { BANNER_COMPACT, BANNER_CONCEPT, BANNER_TAGLINE, bannerFrames } from "../../src/cli/banner.js";

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

  it("prints the banner and the tagline above the header, and skips both when asked", async () => {
    vi.useFakeTimers();
    const withBanner = sink();
    const frames = bannerFrames(BANNER_COMPACT, "truecolor", BANNER_CONCEPT);
    const pretty = createPrettyOutput({ write: withBanner.write, env: { COLORTERM: "truecolor" } });
    pretty.log("hello");
    const plain = withBanner.plain();
    // The art is on screen first and everything else lands under it — the
    // tagline, then the header.
    expect(plain.indexOf(stripAnsi(frames[0]!))).toBe(0);
    expect(plain).toContain("Customize your product with an embedded agent");
    expect(plain.indexOf("Customize your product")).toBeLessThan(plain.indexOf("┌  vendo init"));
    // Truecolor terminals get the real brand ramp.
    expect(withBanner.raw()).toContain(`${ESC}[38;2;`);
    // …and the mark the wave settles on is the whole one.
    await vi.advanceTimersByTimeAsync(90 * frames.length);
    await pretty.arrived;
    expect(withBanner.plain()).toContain("▄▄█████▄");
    expect(withBanner.plain()).toContain(BANNER_COMPACT.join("\n"));

    const without = sink();
    createPrettyOutput({ write: without.write, banner: false }).log("hello");
    expect(without.plain()).not.toContain("▄▄█████▄");
  });

  it("the banner ARRIVES: the flow plays in place, once, and settles into the mark", async () => {
    vi.useFakeTimers();
    const out = sink();
    const frames = bannerFrames(BANNER_COMPACT, "truecolor", BANNER_CONCEPT);
    const pretty = createPrettyOutput({ write: out.write, env: { COLORTERM: "truecolor" } });
    // Construction starts it, so the arrival plays over the stack detection the
    // run does before its first line. Frame one is NOT the mark yet.
    expect(out.raw()).toBe(`${frames[0]!}\n`);
    expect(out.plain()).not.toContain(BANNER_COMPACT.join("\n"));

    await vi.advanceTimersByTimeAsync(90 * frames.length);
    // One cursor-up redraw per frame after the first — in place, no alternate
    // screen buffer, and it ends on the settled frame.
    expect(out.raw().split(`${ESC}[${BANNER_COMPACT.length}A`)).toHaveLength(frames.length);
    expect(out.raw()).not.toContain("?1049h");
    expect(out.plain()).toContain(BANNER_COMPACT.join("\n"));

    // Played once: the frames stop, and the header lands under the settled mark.
    await pretty.arrived;
    const settled = out.raw();
    await vi.advanceTimersByTimeAsync(500);
    expect(out.raw()).toBe(settled);
    pretty.log("hello");
    const plain = out.plain();
    expect(plain).toContain("Customize your product with an embedded agent");
    expect(plain.lastIndexOf(BANNER_COMPACT.join("\n"))).toBeLessThan(plain.indexOf("┌  vendo init"));
  });

  // The header used to CUT the arrival. It does not any more: it prints below
  // the art and the frames keep repainting above it, which is the whole point
  // of the composited arrival.
  it("a line printed mid-arrival lands below the art and never cuts the wave", async () => {
    vi.useFakeTimers();
    const out = sink();
    const frames = bannerFrames(BANNER_COMPACT, "truecolor", BANNER_CONCEPT);
    const pretty = createPrettyOutput({ write: out.write, env: { COLORTERM: "truecolor" } });
    // Not one frame has had time to tick; the run wants the screen anyway.
    expect(out.raw()).toBe(`${frames[0]!}\n`);
    pretty.log("hello");
    // Frame one still stands: nothing settled the mark, and the header is under
    // it. The wave was not aborted, it was composited over.
    expect(out.plain()).not.toContain(BANNER_COMPACT.join("\n"));
    expect(out.plain().indexOf("Customize your product")).toBeLessThan(out.plain().indexOf("┌  vendo init"));

    // The next frame rewinds over the art AND the six rows the header cost
    // (blank, tagline, blank, `┌`, `│`, the line itself).
    await vi.advanceTimersByTimeAsync(90);
    expect(out.raw()).toContain(`${ESC}7${ESC}[${BANNER_COMPACT.length + 6}A`);

    await vi.advanceTimersByTimeAsync(90 * frames.length);
    await expect(pretty.arrived).resolves.toBeUndefined();
    expect(out.plain()).toContain(BANNER_COMPACT.join("\n"));
  });

  it("banner: false starts no arrival — no frames, no cursor games, and nothing to await", async () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log("hello");
    expect(out.raw()).not.toContain(`${ESC}[${BANNER_COMPACT.length}A`);
    await expect(pretty.arrived).resolves.toBeUndefined();
  });

  // `arrived` is what init awaits before its first block. It must settle on a
  // run that talked all the way through the wave, or the wait becomes a hang.
  it("arrived settles on a run that printed all through the arrival", async () => {
    vi.useFakeTimers();
    const out = sink();
    const frames = bannerFrames(BANNER_COMPACT, "truecolor", BANNER_CONCEPT);
    const pretty = createPrettyOutput({ write: out.write, env: { COLORTERM: "truecolor" } });
    const waited = pretty.arrived;
    for (let at = 0; at < frames.length; at += 1) {
      pretty.log(`line ${at}`);
      await vi.advanceTimersByTimeAsync(90);
    }
    await expect(waited).resolves.toBeUndefined();
  });

  it.each([
    ["non-TTY stdout", { isTTY: false }, {}],
    ["NO_COLOR set", { isTTY: true }, { NO_COLOR: "1" }],
    ["CI set", { isTTY: true }, { CI: "true" }],
    ["TERM=dumb", { isTTY: true }, { TERM: "dumb" }],
  ] as const)("never animates under %s — today's exact plain line, byte for byte", (_name, stream, env) => {
    const out = sink();
    const message = "Wired (1 file):";
    if (usePrettyOutput(stream, env)) createPrettyOutput({ write: out.write, env }).log(message);
    else out.write(`${message}\n`);
    expect(out.raw()).toBe(`${message}\n`);
  });

  it("renders the wired section with colored diff markers and bar-prefixed paths", () => {
    const out = sink();
    // env pinned: the accent follows the terminal's colour depth now, so a bare
    // process.env would make this assert whatever the machine happens to be.
    const pretty = createPrettyOutput({ write: out.write, banner: false, env: {} });
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
    const pretty = createPrettyOutput({ write: out.write, banner: false, env: {} });
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

  // The rail's accent shipped as ANSI magenta on every terminal while the mark
  // right above it drew the real ramp, so the two were a shade apart (#1166).
  it("takes the brand's truecolor accent where the terminal can show it, ANSI magenta where it cannot", () => {
    const lines = (env: Record<string, string | undefined>): string => {
      const out = sink();
      const pretty = createPrettyOutput({ write: out.write, banner: false, env });
      pretty.log("\nWired (1 file):");
      pretty.log("  ~ package.json");
      pretty.log("\nVendo Cloud: keyed");
      return out.raw();
    };
    // #a78bfa — the colour the banner's ramp ends on, not a second purple.
    const truecolor = lines({ COLORTERM: "truecolor" });
    expect(truecolor).toContain(`${ESC}[38;2;167;139;250m◆`);
    expect(truecolor).toContain(`${ESC}[38;2;167;139;250mkeyed${ESC}[39m`);
    expect(truecolor).not.toContain(`${ESC}[95m`);

    const ansi = lines({ TERM: "xterm-256color" });
    expect(ansi).toContain(`${ESC}[95m◆`);
    expect(ansi).not.toContain("38;2;167;139;250");
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
    pretty.log("  hardened fields (3): createInvoice.risk, sendEmail.audience, refund.confirmEach");
    pretty.log("  schemas inferred (4): createInvoice.input, refund.output");
    pretty.log("  2 loosenings queued — review with `vendo sync --review`");
    pretty.log("  rejected by the skeptic (1): deleteAccount");
    pretty.log("\nTheme: accent #7c3bed");
    const plain = out.plain();
    expect(plain).toContain("◆  Judgment");
    expect(plain).toContain("│  12 tools judged · hardened fields (3) · schemas inferred (4) · rejected by the skeptic (1)");
    expect(plain).toContain("│  2 loosenings queued — review with vendo sync --review");
    // The long name lists are gone; --json and `vendo sync` still carry them.
    expect(plain).not.toContain("createInvoice.risk, sendEmail.audience, refund.confirmEach");
    // The block settles before the next section opens.
    expect(plain.indexOf("◆  Judgment")).toBeLessThan(plain.indexOf("◆  Your brand"));
  });

  it("keeps the model's prose out of the judgment summary, blanks and all", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false, command: "vendo sync" });
    // A real run: four tools, tallies counted per FIELD, and the model's
    // multi-sentence narrative emitted at the same indent as the tallies —
    // blank separator lines and internal `: ` included.
    pretty.log("judgment (claude-code): 4 tools judged");
    pretty.log("  hardened fields (18): createInvoice.risk, createInvoice.description, listInvoices.title");
    pretty.log("  schemas inferred (6): createInvoice.inputSchema, listInvoices.outputSchema");
    pretty.log("  loosenings approved (1)");
    pretty.log("  rejected by the skeptic (1): deleteInvoice");
    pretty.log("  Two handler files back all four tools");
    pretty.log("  ");
    pretty.log("  The store is a module-level literal, const invoices = [...]. POST is the only handler that touches it — invoices.push(created) — so it is the only genuine write in the product. It is a write, not destructive");
    pretty.log("  ");
    pretty.log("  DELETE and PATCH are stubs. DELETE's entire body is `const { id } = await params; return NextResponse.json({ deleted: true })`");
    pretty.log("  On semantics: the response fields are named, not described");
    // Prose wearing a tally's SHAPE — `<words> (N): <words>`. Only the label
    // allowlist can tell this from a real tally; a shape test lifts
    // "The proposal adds (2)" into the summary and eats ": examples".
    pretty.log("  The proposal adds (2): examples");
    pretty.done(4200, true);
    const body = out.plain().split("\n").filter((entry) => entry.startsWith("│  "));
    const summary = body.find((entry) => entry.includes("4 tools judged"))!;

    // Counts only — every segment is a tally, and the prose is nowhere in it.
    expect(summary).toBe("│  4 tools judged · hardened fields (18) · schemas inferred (6) · loosenings approved (1) · rejected by the skeptic (1)");
    expect(summary).not.toContain("·  ·");
    expect(summary).not.toContain("handler files");
    expect(summary).not.toContain("On semantics");
    // The mid-token cut the ": " split used to make.
    expect(summary).not.toContain("NextResponse.json({ deleted");
    // Prose that imitates a tally contributes nothing and keeps its tail.
    expect(summary).not.toContain("The proposal adds");
    for (const segment of summary.slice("│  ".length).split(" · ")) {
      expect(segment.trim()).not.toBe("");
    }

    // The prose is still shown — whole, below the summary, one line each.
    expect(body).toContain("│  Two handler files back all four tools");
    expect(body).toContain("│  On semantics: the response fields are named, not described");
    expect(body).toContain("│  The proposal adds (2): examples");
    expect(out.plain()).toContain("return NextResponse.json({ deleted: true })");
    // The blank separator lines never became empty body rows either.
    expect(body.some((entry) => entry.trim() === "│")).toBe(false);
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

  it("prints the mount paste as real JSX, with a dim … for the app tree already there", () => {
    const out = sink();
    const rule = "─".repeat(64);
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log(`\n${rule}`);
    pretty.log("ONE STEP LEFT — paste this yourself (init never edits your files)");
    pretty.log("\n  File: app/layout.tsx");
    pretty.log("    import { VendoProvider } from \"@vendoai/vendo/react\";");
    pretty.log("    import theme from \"../.vendo/theme.json\";");
    pretty.log("    import type { VendoTheme } from \"@vendoai/vendo\";");
    pretty.log("    … then wrap: <VendoProvider baseUrl=\"/api/vendo\" theme={theme as VendoTheme}>{children}</VendoProvider>");
    pretty.log(rule);
    const plain = out.plain();
    // The prose instruction is gone; what is left reads as the code it is.
    expect(plain).not.toContain("… then wrap:");
    expect(plain).not.toContain("{children}");
    expect(plain).toContain("│    <VendoProvider baseUrl=\"/api/vendo\" theme={theme as VendoTheme}>");
    expect(plain).toContain("│      …");
    expect(plain).toContain("│    </VendoProvider>");
    // A blank rail line sets the wrap apart from the imports above it.
    expect(plain).toContain("│    import type { VendoTheme } from \"@vendoai/vendo\";\n│\n│    <VendoProvider");
    // The app tree is a dim PLACEHOLDER, not code to paste…
    expect(out.raw()).toContain(`${ESC}[2m…${ESC}[22m`);
    // …which is exactly what the docs pointer under it exists to resolve.
    expect(plain.indexOf("│    </VendoProvider>")).toBeLessThan(plain.indexOf("docs.vendo.run/quickstart"));
  });

  it("keeps the real JSX when the host is a pages `_app` — the child expression differs, the shape does not", () => {
    const out = sink();
    const rule = "─".repeat(64);
    const pretty = createPrettyOutput({ write: out.write, banner: false });
    pretty.log(`\n${rule}`);
    pretty.log("ONE STEP LEFT — paste this yourself (init never edits your files)");
    pretty.log("\n  File: pages/_app.tsx");
    pretty.log("    … then wrap: <VendoProvider baseUrl=\"/api/vendo\"><Component {...pageProps} /></VendoProvider>");
    pretty.log(rule);
    const plain = out.plain();
    expect(plain).toContain("│    <VendoProvider baseUrl=\"/api/vendo\">");
    expect(plain).toContain("│      …");
    expect(plain).not.toContain("pageProps");
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
    // A default does NOT leak past the guard: "" still means nobody was asked,
    // so a piped run can never be handed an answer it never gave.
    expect(await plainText("Where does this app run in dev?", undefined, "http://localhost:3000")).toBe("");
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

  /** A prefilled question has no skip: Enter IS the answer, and the receipt has
      to say so — echoing "skipped" over a value that was just written is how a
      transcript starts lying about what the run did. */
  it("text takes a default on Enter and echoes the value, not a skip", async () => {
    const out = sink();
    const io = promptStreams();
    const pretty = createPrettyOutput({
      write: out.write,
      input: io.input,
      promptOutput: io.output,
      banner: false,
    });

    const accepted = pretty.text("Where does this app run in dev?", "Enter to accept http://localhost:4000", "http://localhost:4000");
    io.input.write("\n");
    expect(await accepted).toBe("http://localhost:4000");

    const typed = pretty.text("Where does this app run in dev?", undefined, "http://localhost:4000");
    io.input.write("http://localhost:8080\n");
    expect(await typed).toBe("http://localhost:8080");

    const plain = out.plain();
    expect(plain).toContain("● http://localhost:4000");
    expect(plain).toContain("● http://localhost:8080");
    expect(plain).not.toContain("● skipped");
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
    const answer = plainText("Where will this deploy?", "Enter to skip", undefined, asked.input, asked.output);
    asked.input.write("https://app.acme.com\n");
    expect(await answer).toBe("https://app.acme.com");
    expect(asked.echoed()).toContain("Where will this deploy?");
    expect(asked.echoed()).toContain("  Enter to skip");

    // Enter on a prefilled question answers with the default — the NO_COLOR
    // path the dev-URL question rides in a plain terminal.
    const defaulted = promptStreams();
    const byEnter = plainText("Where does this app run in dev?", undefined, "http://localhost:4000", defaulted.input, defaulted.output);
    defaulted.input.write("\n");
    expect(await byEnter).toBe("http://localhost:4000");

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

/** The terminal's OWN arithmetic, deliberately independent of the renderer's:
    a screen model that measured with the function under test could never
    disagree with it, and would pass whatever the renderer believed. Two cells
    for the wide blocks these tests use, none for a combining mark, one else. */
const cells = (text: string): number => {
  const grapheme = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let width = 0;
  for (const { segment } of grapheme.segment(text.replace(/\u001b\[[0-9;]*m/g, ""))) {
    // One cluster is one glyph: emoji presentation is always two cells.
    if (/[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/u.test(segment)) { width += 2; continue; }
    const char = String.fromCodePoint(segment.codePointAt(0) ?? 0);
    if (/^[\p{Mn}\p{Me}\p{Cf}]$/u.test(char)) continue;
    if (/^\p{Emoji_Presentation}$/u.test(char)) { width += 2; continue; }
    const point = char.codePointAt(0) ?? 0;
    const wide = (point >= 0x1100 && point <= 0x115f)
      || (point >= 0x2e80 && point <= 0xa4cf)
      || (point >= 0xac00 && point <= 0xd7a3)
      || (point >= 0xf900 && point <= 0xfaff)
      || (point >= 0xff00 && point <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
};

/** The bytes a terminal is SENT are not what a person sees: the select rewinds
    the cursor and redraws over itself, and the terminal wraps anything wider
    than the window onto a second ROW of its own. This applies both — the moves
    the renderer uses (newline, carriage return, cursor-up, erase-line,
    erase-to-end-of-screen) and the wrap — to a row buffer, so the assertions
    below are about the settled SCREEN, which is where these bugs were visible.
    Writes only ever land at the end of a row or at column 0 after an erase,
    which is why the model can treat column 0 as "replace the row". */
function screen(columns: number): {
  write: (chunk: string) => void;
  rows: () => string[];
  /** Which row the cursor sits on — what the art's repaint has to rewind to. */
  cursor: () => number;
} {
  const rows: string[] = [""];
  let at = 0;
  let col = 0;
  let saved = { at: 0, col: 0 };
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const put = (text: string): void => {
    // A terminal places GLYPHS, so the model does too: a cluster never splits
    // across the wrap.
    for (const { segment: char } of graphemes.segment(text)) {
      const cell = cells(char);
      if (col + cell > columns) {
        at += 1;
        col = 0;
        if (rows[at] === undefined) rows[at] = "";
      }
      if (col === 0) rows[at] = "";
      rows[at] = (rows[at] ?? "") + char;
      col += cell;
    }
  };
  return {
    write: (chunk) => {
      for (const token of chunk.match(/\u001b[78]|\u001b\[[0-9;?]*[A-Za-z]|\n|\r|[^\u001b\n\r]+/g) ?? []) {
        if (token === "\n") {
          at += 1;
          col = 0;
          if (rows[at] === undefined) rows[at] = "";
          continue;
        }
        if (token === "\r") { col = 0; continue; }
        if (token.startsWith(ESC)) {
          // Save/restore (ESC 7 / ESC 8) is how the art repaints above the
          // content without moving the cursor the run prints at.
          if (token === `${ESC}7`) { saved = { at, col }; continue; }
          if (token === `${ESC}8`) { ({ at, col } = saved); continue; }
          const up = /^\u001b\[(\d*)A$/.exec(token);
          if (up !== null) { at = Math.max(0, at - (up[1] === "" ? 1 : Number(up[1]))); continue; }
          if (token === `${ESC}[2K`) { rows[at] = ""; continue; }
          if (token === `${ESC}[0J` || token === `${ESC}[J`) {
            rows[at] = (rows[at] ?? "").slice(0, col);
            rows.length = at + 1;
            continue;
          }
          continue; // SGR and cursor visibility change no cell
        }
        put(token);
      }
    },
    rows: () => rows,
    cursor: () => at,
  };
}

/** The run's first question, verbatim from init's USE_CASE_OPTIONS — the list
    that duplicated itself at 80 columns. */
const USE_CASE_OPTIONS = [
  { value: "embedded", label: "Embedded in my app — chat + generated UI", hint: "recommended" },
  { value: "agent-loop", label: "Through my own agent loop (AI SDK / Mastra)" },
  { value: "mcp", label: "From outside agents over MCP — Claude, ChatGPT, Cursor, or any MCP agent (experimental)" },
] as const;

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("createPrettyOutput (80 columns — the width most people run)", () => {
  it("select: the answered block prints each option once, with exactly one ● bullet", async () => {
    const term = screen(80);
    const keys = fakeInput();
    const pretty = createPrettyOutput({
      write: term.write, input: keys.input, banner: false, columns: 80,
    });
    const choice = pretty.select("How will people use your agent?", [...USE_CASE_OPTIONS]);

    // Live: one row per option, one ● — even though option 3 wraps.
    keys.press("\u001b[B");
    const live = term.rows().join("\n");
    expect(occurrences(live, "●")).toBe(1);
    for (const option of USE_CASE_OPTIONS) {
      expect(occurrences(live, option.label.slice(0, 24))).toBe(1);
    }

    keys.press("3");
    expect(await choice).toBe("mcp");
    const settled = term.rows().join("\n");
    // Settled: only the chosen option survives, and it survives once.
    expect(occurrences(settled, "●")).toBe(1);
    expect(occurrences(settled, "From outside agents over MCP")).toBe(1);
    expect(settled).not.toContain("Embedded in my app");
    expect(settled).not.toContain("Through my own agent loop");
    expect(settled).not.toContain("○");
  });

  it("select: the settled long answer stays on the rail and still reads whole", async () => {
    const term = screen(80);
    const keys = fakeInput();
    const pretty = createPrettyOutput({
      write: term.write, input: keys.input, banner: false, columns: 80,
    });
    const choice = pretty.select("How will people use your agent?", [...USE_CASE_OPTIONS]);
    keys.press("3");
    expect(await choice).toBe("mcp");

    const rows = term.rows().filter((row) => row !== "");
    const answer = rows.slice(rows.findIndex((row) => row.includes("●")));
    // It needed two rows at this width, and both ride the rail.
    expect(answer).toHaveLength(2);
    for (const row of answer) expect(row.startsWith("│  ")).toBe(true);
    expect(answer.map((row) => row.slice(3)).join(" ")).toBe(`● ${USE_CASE_OPTIONS[2].label}`);
  });

  it("wraps every long line onto the rail — no continuation starts at column 0", () => {
    const out = sink();
    const pretty = createPrettyOutput({ write: out.write, banner: false, columns: 80 });
    pretty.log("catalog.json: 5 discovered, 5 registered");
    pretty.log("components: 12 captured, 3 updated, 1 removed because the source component is gone");
    pretty.log("\nVendo Cloud (optional): not configured. A key unlocks team sharing & org governance"
      + " across your whole company; hosted automations that keep running while you sleep.");
    pretty.log("Run `vendo login` to claim a free API key; it lands in .env.local and nothing else changes.");
    pretty.error("warning: .env.local holds a secret — add it to `.gitignore` before you commit it anywhere");
    pretty.done(12400, true, "14 tools · brand captured · 1 paste left");

    const rows = out.plain().split("\n").slice(0, -1);
    // The header opens the rail; every row after it is a rail row, and nothing
    // is wider than the terminal.
    expect(rows[0]).toBe("┌  vendo init");
    for (const row of rows.slice(1, -1)) {
      expect(row).toMatch(/^[│◇◆└]/);
      expect(row.length).toBeLessThanOrEqual(80);
    }
    // The wrapped body of a long line is a rail line too, not a naked tail.
    const wrapped = rows.filter((row) => row.startsWith("│  ") && row.includes("while you sleep"));
    expect(wrapped).toHaveLength(1);
  });

  it("closes the rail with a cancel line when Ctrl-C interrupts a question", () => {
    const term = screen(80);
    const keys = fakeInput();
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${String(code)}`);
    });
    try {
      const pretty = createPrettyOutput({
        write: term.write, input: keys.input, banner: false, columns: 80,
      });
      void pretty.select("How will people use your agent?", [...USE_CASE_OPTIONS]).catch(() => undefined);
      expect(() => keys.press("\u0003")).toThrow("exit:130");
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      exit.mockRestore();
    }
    const rows = term.rows().filter((row) => row !== "");
    expect(rows.at(-1)).toBe("└  Cancelled");
    // The rail is closed, not left hanging under a half-drawn question.
    expect(rows.at(-2)).toBe("│");
    expect(rows.join("\n")).not.toContain("○");
  });

  it.each([
    ["NO_COLOR on a TTY", { isTTY: true }, { NO_COLOR: "1" }],
    ["CI on a TTY", { isTTY: true }, { CI: "true" }],
    ["TERM=dumb on a TTY", { isTTY: true }, { TERM: "dumb" }],
    ["piped stdout", { isTTY: false }, {}],
  ] as const)("never wraps, restyles or re-rails a long line under %s", (_name, stream, env) => {
    const out = sink();
    const message = "components: 12 captured, 3 updated, 1 removed because the source component"
      + " is gone — a 140-column line that a pipe must receive exactly as sync emits it";
    if (usePrettyOutput(stream, env)) {
      createPrettyOutput({ write: out.write, banner: false, columns: 80 }).log(message);
    } else out.write(`${message}\n`);
    expect(out.raw()).toBe(`${message}\n`);
  });
});

/** A terminal measures CELLS, not code units. `.length` gets both directions
    wrong — and because the select's rewind now counts the ROWS it emitted, a
    miscount does not merely wrap badly: it puts the cursor-up on the wrong row
    and brings back the duplicate answered block this suite exists to catch.
    User content (tool names, product names, judgment prose) flows straight
    through the renderer, so this is not a hypothetical width. */
/** Six graphemes, decomposed: "e" plus a combining acute — twelve code units. */
const ACCENTED = "e\u0301".repeat(6);

describe("createPrettyOutput (display width — wide glyphs and combining marks)", () => {
  it("counts an East Asian glyph as two cells and a combining mark as none", () => {
    expect(displayWidth("界界界界")).toBe(8);
    expect(displayWidth(ACCENTED)).toBe(6);
    expect(ACCENTED.length).toBe(12); // twelve code units, six cells
    // A surrogate pair is one code point, and this one is wide.
    expect(displayWidth("\u{1F680}")).toBe(2);
    expect(displayWidth(`${ESC}[2m界${ESC}[22m`)).toBe(2);
  });

  it("wraps a wide-glyph run that overflows the window", () => {
    const out = sink();
    createPrettyOutput({ write: out.write, banner: false, columns: 10 }).log("界界界界");
    // `│  ` is 3 cells, so 8 more cells cannot share the row.
    const rows = out.plain().split("\n").filter((row) => row.includes("界"));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(10);
    expect(rows.join("").replace(/│ {2}/g, "")).toBe("界界界界");
  });

  it("keeps combining marks on one row — they cost no cells", () => {
    const out = sink();
    createPrettyOutput({ write: out.write, banner: false, columns: 10 }).log(ACCENTED);
    const rows = out.plain().split("\n").filter((row) => row.includes("\u0301"));
    // Six graphemes are six cells: `│  ` + 6 fits in 10 and must not wrap.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(`│  ${ACCENTED}`);
  });

  it("measures a composed emoji as the ONE glyph a terminal draws", () => {
    // Code-point accounting over-counts these two...
    expect(displayWidth("\u{1F44D}\u{1F3FD}")).toBe(2);                      // thumb + skin tone
    expect(displayWidth("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}")).toBe(2); // ZWJ family
    // ...and UNDER-counts this one, which is the direction that overflows a
    // row: a one-cell base the variation selector promotes to emoji width.
    expect(displayWidth("\u2714\uFE0F")).toBe(2);
    expect(displayWidth("\u2714")).toBe(1);
    // Emoji width is the Emoji_Presentation PROPERTY, not a hand-kept range
    // table: a block Unicode added recently is two cells the day it lands...
    expect(displayWidth("\u{1FA70}")).toBe(2);  // U+1FA70, Extended-A
    expect(displayWidth("\u{1FAF6}")).toBe(2);  // U+1FAF6, added later still
    // ...and a pictograph a terminal draws as TEXT stays one.
    expect(displayWidth("\u2122")).toBe(1);     // ™
    expect(displayWidth("\u2600")).toBe(1);     // ☀
  });

  it("select: an emoji option that a code-point count would under-measure still prints once", async () => {
    const term = screen(24);
    const keys = fakeInput();
    const pretty = createPrettyOutput({
      write: term.write, input: keys.input, banner: false, columns: 24,
    });
    // `│  ● ` is 5 cells and each ✔️ is 2, so twelve of them is 29 cells — wider
    // than the window. A code-point count sees 12 and thinks the row fits.
    const options = [
      { value: "text", label: "\u2714\uFE0F".repeat(12) },
      { value: "emoji", label: "\u{1F680}\uFE0F".repeat(12) },
    ];
    const choice = pretty.select("Pick", options);
    keys.press("2");
    expect(await choice).toBe("emoji");
    const rows = term.rows().filter((row) => row !== "");
    expect(occurrences(rows.join("\n"), "●")).toBe(1);
    for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(24);
  });

  it("select: an answered block of wide-glyph options still prints each option once", async () => {
    const term = screen(40);
    const keys = fakeInput();
    const pretty = createPrettyOutput({
      write: term.write, input: keys.input, banner: false, columns: 40,
    });
    const options = [
      { value: "embedded", label: "嵌入我的应用程序中的聊天与生成式界面" },
      { value: "mcp", label: "通过外部代理接入例如任何支持代理的客户端" },
    ];
    // Short in code units (a `.length` renderer thinks both fit), but 18 and 20
    // East Asian glyphs are 36 and 40 CELLS — wider than the window with the
    // rail in front, so the terminal wraps what the renderer thought was one row.
    expect(options.every((option) => option.label.length < 40)).toBe(true);
    const choice = pretty.select("用户将如何使用你的助手？", options);

    keys.press("2");
    expect(await choice).toBe("mcp");
    const rows = term.rows().filter((row) => row !== "");
    const settled = rows.join("\n");
    expect(occurrences(settled, "●")).toBe(1);
    expect(settled).not.toContain("嵌入我的应用程序");
    // Every row the terminal shows fits the window, so no row silently became
    // two and the rewind landed where it was drawn.
    for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(40);
    const answer = rows.slice(rows.findIndex((row) => row.includes("●")));
    // Whitespace-insensitive: the break may land on a space or, in an unspaced
    // CJK run, between two glyphs.
    const strip = (text: string): string => text.replace(/\s+/g, "");
    expect(strip(answer.map((row) => row.slice(3)).join(""))).toBe(strip(`● ${options[1]!.label}`));
  });
});

/** THE COMPOSITED ARRIVAL. The wave plays while the run keeps printing under
    it, and the art repaints itself by rewinding a ROW COUNT — so every
    assertion here is really about that count. They are made against the screen
    model above, which measures the terminal's own way, and never against the
    renderer's belief about its own output: a model that asked the renderer how
    wide its lines were could not disagree with it.

    72 columns is the width the art fits EXACTLY, so the only thing that wraps
    is a content line — which is the desync a newline count cannot see. */
describe("createPrettyOutput (the composited arrival)", () => {
  /** A host with three auth dependencies. 73 cells + the rail is 76: two
      screen rows at 72 columns, one newline either way. */
  const LONG_FACT = "Clerk / Auth.js / Supabase auth (@clerk/nextjs, next-auth, @supabase/ssr)";
  const STACK_FACT = "Next.js · App Router · TypeScript · pnpm";
  const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

  const artRows = (term: { rows: () => string[] }): string[] =>
    term.rows().slice(0, BANNER_COMPACT.length);

  /** init's own reveal, verbatim in shape: a leading beat, then one labelled
      beat per fact. Returns the settled screen, plus — for every frame the art
      painted — the rows it rewound by and the row the cursor was really on. */
  async function reveal(columns: number): Promise<{
    term: ReturnType<typeof screen>;
    paints: { rewound: number; cursorWas: number }[];
  }> {
    const term = screen(columns);
    const paints: { rewound: number; cursorWas: number }[] = [];
    const startsPaint = new RegExp(`^${ESC}7${ESC}\\[(\\d+)A$`);
    const pretty = createPrettyOutput({
      write: (chunk) => {
        const paint = startsPaint.exec(chunk);
        if (paint !== null) paints.push({ rewound: Number(paint[1]), cursorWas: term.cursor() });
        term.write(chunk);
      },
      columns,
      env: { COLORTERM: "truecolor" },
    });
    // The wrapping fact resolves FIRST, so it lands while the wave is still
    // playing — which is where a mis-counted row shows up. (A narrow window
    // does this to every fact; here one long one is enough.)
    const revealed = pretty.revealBlock("Your stack", [
      { beat: "Checking auth…", text: LONG_FACT },
      { beat: "Detecting your framework…", text: STACK_FACT },
    ], { beat: "Reading your app…" });
    await vi.advanceTimersByTimeAsync(5000);
    await revealed;
    return { term, paints };
  }

  it("keeps the mark whole above a scan whose fact WRAPS — the row count, not the newline count", async () => {
    vi.useFakeTimers();
    const { term, paints } = await reveal(72);

    // The arithmetic first, because everything else follows from it: the art
    // starts at row zero, so the rows a frame rewinds by must equal the row the
    // cursor was really on. A newline count is short from the wrapping line on.
    expect(paints.length).toBeGreaterThan(8);
    expect(paints.map((paint) => paint.rewound)).toEqual(paints.map((paint) => paint.cursorWas));

    // The art is untouched and exactly where it started.
    expect(artRows(term)).toEqual([...BANNER_COMPACT]);
    const below = term.rows().slice(BANNER_COMPACT.length);
    const settled = below.join("\n");
    expect(settled).toContain(BANNER_TAGLINE.trim());
    expect(settled).toContain("┌  vendo init");
    expect(settled).toContain("◆  Your stack");
    expect(settled).toContain(`│  ✓ ${STACK_FACT}`);

    // The wrapping fact is one rail body line over two screen rows, and every
    // row the terminal shows fits the window.
    const at = below.findIndex((row) => row.includes("✓ Clerk"));
    expect(below[at + 1]!.startsWith("│  ")).toBe(true);
    // Whitespace-insensitive: the row break lands ON the space it broke at.
    const strip = (text: string): string => text.replace(/\s+/g, "");
    expect(strip(below.slice(at, at + 2).map((row) => row.slice(3)).join("")))
      .toBe(strip(`✓ ${LONG_FACT}`));
    for (const row of term.rows()) expect(cells(row)).toBeLessThanOrEqual(72);

  });

  it("resolves every beat into a ✓ fact and leaves no spinner behind", async () => {
    vi.useFakeTimers();
    const { term } = await reveal(100);
    const settled = term.rows().slice(BANNER_COMPACT.length).join("\n");
    // The scan narrated, then answered: the labels are rewritten in place, so
    // the settled transcript is facts only.
    expect(settled).toContain(`✓ ${STACK_FACT}`);
    expect(settled).toContain(`✓ ${LONG_FACT}`);
    expect(settled).not.toContain("Reading your app");
    expect(settled).not.toContain("Detecting your framework");
    expect(settled).not.toContain("Checking auth");
    expect(settled).not.toMatch(SPINNER);
    // …in the order they were handed over, under the section title.
    expect(settled.indexOf("◆  Your stack")).toBeLessThan(settled.indexOf("✓ Clerk"));
    expect(settled.indexOf("✓ Clerk")).toBeLessThan(settled.indexOf(STACK_FACT));
    expect(artRows(term)).toEqual([...BANNER_COMPACT]);
  });

  it("Ctrl-C mid-wave settles the mark and closes the rail under it", () => {
    const term = screen(72);
    const keys = fakeInput();
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${String(code)}`);
    });
    try {
      const pretty = createPrettyOutput({
        write: term.write, input: keys.input, columns: 72, env: { COLORTERM: "truecolor" },
      });
      // Not one frame has ticked: the mark on screen is the first frame.
      expect(artRows(term)).not.toEqual([...BANNER_COMPACT]);
      void pretty.select("How will people use your agent?", [...USE_CASE_OPTIONS]).catch(() => undefined);
      expect(() => keys.press("\u0003")).toThrow("exit:130");
    } finally {
      exit.mockRestore();
    }
    // The interrupt is the one path that still cuts the wave, and it leaves the
    // FINISHED mark behind — with the rail closed under it, not over it.
    expect(artRows(term)).toEqual([...BANNER_COMPACT]);
    const rows = term.rows().filter((row) => row !== "");
    expect(rows.at(-1)).toBe("└  Cancelled");
    expect(rows.join("\n")).not.toContain("○");
  });
});
