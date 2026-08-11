/**
 * The boot block `createVendo` prints.
 *
 * Two halves, tested as two: the RENDERER is pure (a summary + a style in, text
 * out), and the DERIVATION is read off a real `createComposition` — never off a
 * hand-built composition object, which would only prove the test agrees with
 * itself about which fields exist.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@vendoai/core";
import { setLogger, vendoStyle, type VendoLogEvent, type VendoStyle } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authJs } from "../src/auth-presets/auth-js.js";
import { auth0 } from "../src/auth-presets/auth0.js";
import { clerk } from "../src/auth-presets/clerk.js";
import { jwt } from "../src/auth-presets/jwt.js";
import type { HostAuthPreset } from "../src/auth-presets/shared.js";
import { supabase } from "../src/auth-presets/supabase.js";
import {
  announceBootSummary,
  bootSummaryFor,
  renderBootSummary,
  type BootSummary,
} from "../src/boot-summary.js";
import { createComposition } from "../src/compose-context.js";
import type { CreateVendoConfig } from "../src/types.js";

const TTY = { isTTY: true };
const pretty = (env: Record<string, string | undefined> = {}): VendoStyle =>
  vendoStyle(TTY, env);
/** Escapes stripped, so a layout assertion reads as the block on screen does. */
const plainText = (text: string): string => text.replaceAll(/\u001b\[[0-9;]*m/g, "");

/** The founder's example, as data. */
const EXAMPLE: BootSummary = {
  rows: [
    { label: "sandbox", venue: "cloud", detail: "VENDO_API_KEY" },
    { label: "store", venue: "local", detail: ".vendo/data" },
    { label: "models", venue: "cloud", detail: "VENDO_API_KEY (gateway)" },
    { label: "auth", venue: "clerk", detail: "auth: clerk()" },
  ],
  warnings: [],
};

/** The warning S6 will feed in — two lines, and nothing special about it. */
const EPHEMERAL: BootSummary = {
  ...EXAMPLE,
  warnings: [{
    label: "store",
    lines: [
      ".vendo/data is under /tmp — data will not survive a redeploy.",
      'Mount a volume, or pass url: "postgres://…" to createVendo.',
    ],
  }],
};

const STRAY_KEY: BootSummary = {
  rows: [{ label: "store", venue: "local", detail: ".vendo/data" }],
  warnings: [{
    label: "sandbox",
    venue: "none",
    lines: ["found E2B_API_KEY, which no longer selects a sandbox — pass sandbox: e2bSandbox() to use it"],
  }],
};

describe("the pretty block", () => {
  it("is one rail block, venue in column 2 and what chose it in column 3", () => {
    expect(plainText(renderBootSummary(EXAMPLE, pretty()))).toBe([
      "◆  vendo ready",
      "│  ✓ sandbox   cloud    VENDO_API_KEY",
      "│  ✓ store     local    .vendo/data",
      "│  ✓ models    cloud    VENDO_API_KEY (gateway)",
      "│  ✓ auth      clerk    auth: clerk()",
    ].join("\n"));
  });

  it("colours the block: accent mark, dim rail, green ✓, bold venue, dim detail", () => {
    const style = pretty();
    const [head, first] = renderBootSummary(EXAMPLE, style).split("\n");
    expect(head).toBe(`${style.accent("◆")}  ${style.bold("vendo ready")}`);
    expect(first).toContain(style.dim("│"));
    expect(first).toContain(style.ok("✓"));
    expect(first).toContain(style.bold("cloud    "));
    expect(first).toContain(style.dim("VENDO_API_KEY"));
  });

  it("draws a warning as a ⚠ row, continuations aligned under the text", () => {
    const lines = plainText(renderBootSummary(EPHEMERAL, pretty())).split("\n");
    expect(lines.slice(-2)).toEqual([
      "│  ⚠ store     .vendo/data is under /tmp — data will not survive a redeploy.",
      '│              Mount a volume, or pass url: "postgres://…" to createVendo.',
    ]);
    // Column alignment is the point: the continuation starts where the first
    // line's text starts, not under the marker.
    const [first, second] = lines.slice(-2) as [string, string];
    expect(second.indexOf("Mount")).toBe(first.indexOf(".vendo/data"));
  });

  it("paints a warning row yellow, marker and text alike", () => {
    const style = pretty();
    const rendered = renderBootSummary(EPHEMERAL, style);
    expect(rendered).toContain(style.warn("⚠"));
    expect(rendered).toContain(style.warn(".vendo/data is under /tmp — data will not survive a redeploy."));
  });

  it("widens a column rather than breaking alignment on a long label", () => {
    const long: BootSummary = {
      rows: [
        { label: "connections", venue: "byo", detail: "createVendo({ connectors })" },
        { label: "guard", venue: "rules+judge", detail: "createVendo({ guard })" },
      ],
      warnings: [],
    };
    const [, first, second] = plainText(renderBootSummary(long, pretty())).split("\n") as [string, string, string];
    expect(first.indexOf("byo")).toBe(second.indexOf("rules+judge"));
    expect(first.indexOf("createVendo")).toBe(second.indexOf("createVendo"));
  });
});

describe("the frozen stray-key hint", () => {
  // Wording pinned by the founder. Changing this string is a product decision,
  // never a refactor's collateral.
  it("says exactly what it was frozen saying", () => {
    const text = plainText(renderBootSummary(STRAY_KEY, pretty()));
    expect(text).toContain(
      "found E2B_API_KEY, which no longer selects a sandbox"
      + " — pass sandbox: e2bSandbox() to use it",
    );
    // …carried on a ⚠ row naming the seam and the venue, in the BLOCK's columns.
    // The frozen row was written standalone, before the block it now sits in,
    // with one space fewer after `none`; padding it to the venue column is what
    // keeps it from being the only misaligned line on screen.
    expect(text.split("\n").at(-1)).toBe(
      "│  ⚠ sandbox   none     found E2B_API_KEY, which no longer selects a sandbox"
      + " — pass sandbox: e2bSandbox() to use it",
    );
  });

  it("carries the same wording into a degraded run", () => {
    expect(renderBootSummary(STRAY_KEY, vendoStyle({}, {}))).toContain(
      "[vendo] warning: sandbox — found E2B_API_KEY, which no longer selects a sandbox"
      + " — pass sandbox: e2bSandbox() to use it",
    );
  });
});

describe("degradation", () => {
  // Verbatim usePrettyOutput's law: the block is a rail block only for a real
  // terminal that has not opted out.
  const degraded: Array<[string, { isTTY?: boolean }, Record<string, string | undefined>]> = [
    ["a pipe", {}, {}],
    ["NO_COLOR", TTY, { NO_COLOR: "1" }],
    ["CI", TTY, { CI: "true" }],
    ["TERM=dumb", TTY, { TERM: "dumb" }],
    ["a pipe under CI", {}, { CI: "true" }],
  ];

  for (const [name, stream, env] of degraded) {
    it(`collapses to one plain line under ${name}`, () => {
      expect(renderBootSummary(EXAMPLE, vendoStyle(stream, env))).toBe(
        "[vendo] ready — sandbox: cloud · store: local · models: cloud · auth: clerk",
      );
    });
  }

  it("stays pretty for a TTY with an empty NO_COLOR and CI", () => {
    expect(renderBootSummary(EXAMPLE, vendoStyle(TTY, { NO_COLOR: "", CI: "" })))
      .toContain("◆");
  });

  it("adds one plain line per warning, its lines joined", () => {
    expect(renderBootSummary(EPHEMERAL, vendoStyle({}, {})).split("\n")).toEqual([
      "[vendo] ready — sandbox: cloud · store: local · models: cloud · auth: clerk",
      '[vendo] warning: store — .vendo/data is under /tmp — data will not survive a redeploy.'
      + ' Mount a volume, or pass url: "postgres://…" to createVendo.',
    ]);
  });

  it("carries no escape sequences at all", () => {
    const rendered = renderBootSummary(EPHEMERAL, vendoStyle({}, { CI: "1" }));
    expect(rendered).toBe(plainText(rendered));
  });
});

describe("announcing it", () => {
  const events: VendoLogEvent[] = [];
  afterEach(() => {
    setLogger(undefined);
    events.length = 0;
  });

  // The latch is module-scoped and there is no reset, so this is the ONE test
  // in this file that may announce — a second one would silently pass on an
  // already-latched module and prove nothing.
  it("says it once per process, through core's sink, as one event", () => {
    setLogger((event) => events.push(event));
    announceBootSummary(EPHEMERAL, vendoStyle({}, {}));
    announceBootSummary(EXAMPLE, vendoStyle({}, {}));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: "vendo.ready",
      // A block carrying a warning is a warning.
      level: "warn",
      message: renderBootSummary(EPHEMERAL, vendoStyle({}, {})),
    });
  });
});

describe("the composed facts", () => {
  const base: CreateVendoConfig = {
    // Never resolved: the summary reports the SLOT, and a real model would make
    // this test measure a provider.
    principal: async (): Promise<Principal> => ({ kind: "user", subject: "user_boot" }),
  };

  /** Compose for real, with the environment fully under the test's control —
      an ambient VENDO_API_KEY would otherwise silently move every venue. */
  const summaryFor = (
    config: CreateVendoConfig = base,
    env: Record<string, string> = {},
  ): BootSummary => {
    vi.stubEnv("VENDO_API_KEY", "");
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("VENDO_DEV_CREDENTIAL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    return bootSummaryFor(createComposition(config));
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the keyless local default: a store on disk and the host's principal", () => {
    expect(summaryFor()).toEqual({
      rows: [
        { label: "store", venue: "local", detail: ".vendo/data" },
        { label: "auth", venue: "custom", detail: "createVendo({ principal })" },
      ],
      warnings: [],
    });
  });

  it("moves every unset seam to Cloud on VENDO_API_KEY, naming the key", () => {
    const { rows } = summaryFor(base, { VENDO_API_KEY: "vk_test" });
    expect(rows).toEqual([
      { label: "sandbox", venue: "cloud", detail: "VENDO_API_KEY" },
      { label: "store", venue: "cloud", detail: "VENDO_API_KEY" },
      { label: "models", venue: "cloud", detail: "VENDO_API_KEY (gateway)" },
      { label: "connections", venue: "cloud", detail: "VENDO_API_KEY" },
      { label: "auth", venue: "custom", detail: "createVendo({ principal })" },
    ]);
  });

  it("names the provider key that won the model ladder, not the ladder", () => {
    const { rows } = summaryFor(base, { ANTHROPIC_API_KEY: "sk-ant-test", VENDO_API_KEY: "vk_test" });
    expect(rows).toContainEqual({
      label: "models",
      venue: "anthropic",
      detail: "ANTHROPIC_API_KEY",
    });
  });

  it("says only what is in charge when the E2E rung pin is set", () => {
    const { rows } = summaryFor(base, { VENDO_DEV_CREDENTIAL: "none", ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(rows).toContainEqual({
      label: "models",
      venue: "ladder",
      detail: "VENDO_DEV_CREDENTIAL",
    });
  });

  it("credits the config line, not the key, for a seam the host filled", () => {
    const { rows } = summaryFor(
      { ...base, models: { default: {} as LanguageModel } },
      { VENDO_API_KEY: "vk_test" },
    );
    expect(rows).toContainEqual({
      label: "models",
      venue: "custom",
      detail: "createVendo({ models })",
    });
  });

  it("shows the guard posture only once a policy exists", () => {
    expect(summaryFor().rows.map((row) => row.label)).not.toContain("guard");
    expect(summaryFor({ ...base, guard: { policy: { rules: [] } } }).rows).toContainEqual({
      label: "guard",
      venue: "rules",
      detail: "createVendo({ guard })",
    });
  });

  // The row's whole value is knowing WHICH auth is live, so it is read off the
  // real preset factories — not off a `name` a test wrote itself, which would
  // only prove the test agrees with the test.
  it("names the vendor for every shipped preset", () => {
    const shipped: Array<[string, HostAuthPreset]> = [
      ["clerk", clerk()],
      ["authJs", authJs({ secret: "test-secret" })],
      ["auth0", auth0({ secret: "test-secret" })],
      ["supabase", supabase({ secret: "test-secret" })],
      ["jwt", jwt({ secret: "test-secret" })],
    ];
    for (const [name, auth] of shipped) {
      expect(summaryFor({ auth }).rows).toContainEqual({
        label: "auth",
        venue: name,
        detail: `auth: ${name}()`,
      });
    }
  });

  it("claims no vendor for a preset the HOST composed itself", () => {
    // demo-bank's `mapleAuth` is exactly this: a real three-seam preset with no
    // vendor behind it. Borrowing a name here would be a lie.
    const { rows } = summaryFor({
      auth: { principal: async (): Promise<Principal> => ({ kind: "user", subject: "user_boot" }) },
    });
    expect(rows).toContainEqual({ label: "auth", venue: "preset", detail: "createVendo({ auth })" });
  });

  // The block is ONE log event, so a newline or an ANSI escape in the one
  // host-supplied string it renders would forge a row inside that event and
  // drive the operator's terminal. A name that is not an identifier is not a
  // vendor name, and the unnamed-preset row is the honest thing to say.
  it.each([
    ["a newline", "trusted\nvendo ready — forged"],
    ["an ANSI escape", "clerk\u001b[2J\u001b[H"],
    ["a carriage return", "clerk\rroot"],
    ["free text", "Acme Single Sign On"],
  ])("refuses to render a preset name carrying %s", (_label, name) => {
    const { rows } = summaryFor({
      auth: {
        name,
        principal: async (): Promise<Principal> => ({ kind: "user", subject: "user_boot" }),
      },
    });

    expect(rows).toContainEqual({ label: "auth", venue: "preset", detail: "createVendo({ auth })" });
    const authRow = rows.find((row) => row.label === "auth");
    expect(`${authRow?.venue}${authRow?.detail}`).not.toContain("\n");
    expect(`${authRow?.venue}${authRow?.detail}`).not.toContain("\u001b");
  });

  // Silence is the honest report for a seam a host chose not to fill. The stray
  // key hint next to it arms when a KEY is present and the ladder still composes
  // NOTHING — unreachable while E2B_API_KEY itself selects the e2b rung, so the
  // hint's wording and layout are pinned by the renderer tests above.
  it("says nothing about a sandbox nobody configured", () => {
    const { rows, warnings } = summaryFor();
    expect(rows.map((row) => row.label)).not.toContain("sandbox");
    expect(warnings).toEqual([]);
  });

  // The store makes this judgment at `createStore` and hangs it on its engine
  // handle; the block is the only thing that says it out loud. Composed for
  // real, so a store that stopped carrying the fact — or a block that stopped
  // reading it — is a red test, which is exactly how it shipped mute once.
  describe("the store's ephemeral-disk warning", () => {
    // A platform marker, not a path: it fires wherever the suite is checked out.
    const ONTO_EPHEMERAL_DISK = { RAILWAY_ENVIRONMENT: "production" };

    it("folds into the block as a ⚠ store row", () => {
      const summary = summaryFor(base, ONTO_EPHEMERAL_DISK);
      expect(summary.warnings).toEqual([{
        label: "store",
        lines: [
          ".vendo/data is on Railway's container filesystem — data will not survive a redeploy.",
          'Mount a volume, or pass url: "postgres://…" to createVendo.',
        ],
      }]);
      expect(plainText(renderBootSummary(summary, pretty())).split("\n").slice(-2)).toEqual([
        "│  ⚠ store     .vendo/data is on Railway's container filesystem"
        + " — data will not survive a redeploy.",
        '│              Mount a volume, or pass url: "postgres://…" to createVendo.',
      ]);
    });

    it("becomes one plain warn line in a non-TTY run", () => {
      expect(renderBootSummary(summaryFor(base, ONTO_EPHEMERAL_DISK), vendoStyle({}, {})).split("\n"))
        .toEqual([
          "[vendo] ready — store: local · auth: custom",
          "[vendo] warning: store — .vendo/data is on Railway's container filesystem"
          + ' — data will not survive a redeploy. Mount a volume, or pass url: "postgres://…" to createVendo.',
        ]);
    });

    it("names the OS temp dir case the way the founder's example does", () => {
      const summary = summaryFor({ ...base, store: createStore({ dataDir: join(tmpdir(), "maple/data") }) });
      expect(summary.warnings[0]?.lines[0])
        .toBe(`${join(tmpdir(), "maple/data")} is under /tmp — data will not survive a redeploy.`);
    });

    it("says nothing at all for a store on a real disk", () => {
      const healthy = summaryFor({ ...base, store: createStore({ dataDir: "/home/dev/maple/.vendo/data" }) });
      expect(healthy.warnings).toEqual([]);
      expect(renderBootSummary(healthy, pretty())).not.toContain("⚠");
      expect(renderBootSummary(healthy, vendoStyle({}, {}))).not.toContain("warning");
    });

    it("says nothing for the Cloud hosted store, which has no dir to lose", () => {
      expect(summaryFor(base, { ...ONTO_EPHEMERAL_DISK, VENDO_API_KEY: "vk_test" }).warnings).toEqual([]);
    });
  });

  it("never touches the filesystem", () => {
    // The portability gate: createVendo runs at module init on Workers, so a
    // stat here would break a deployment that composes fine today. Asserted
    // against the real thing, not by reading the source. The composition is
    // built BEFORE the spies — it is not what is under test here.
    const composition = createComposition({ ...base, guard: { policy: { rules: [] } } });
    const spies = (["existsSync", "statSync", "readFileSync", "readdirSync", "openSync"] as const)
      .map((name) => vi.spyOn(fs, name));
    try {
      expect(bootSummaryFor(composition).rows.length).toBeGreaterThan(0);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
