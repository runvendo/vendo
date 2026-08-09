/**
 * The host's theme and design rules reach the BUILDER's brief.
 *
 * `claudeCode()` writes `app.vendo` with its own hands and thinks with
 * `turn.system` WHOLE and ALONE — it appends nothing after the host's prompt
 * seam, and `claude-code.test.ts` ("Turn.system reaches the box WHOLE and
 * ALONE") measures that against a real box door. So the only place the host's
 * `theme` and `apps.designRules` can reach it is composition's own prompt
 * closure, which is what this file drives: real `createVendo`, real HTTP
 * `Request` into `vendo.handler`, and the harness reading the `Turn` the runtime
 * built. Nothing is stubbed on either side of that seam.
 *
 * Without this, the two config keys reach the fill worker and the screen agent
 * and silently do nothing on the builder path.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, VendoTheme } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { defineHarness } from "@vendoai/harnesses";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_design" };

const theme: VendoTheme = {
  colors: {
    background: "#ffffff",
    surface: "#f7f7f5",
    text: "#101010",
    muted: "#6b6b6b",
    accent: "#0f7b4a",
    accentText: "#ffffff",
    danger: "#b3261e",
    border: "#e4e4e0",
  },
  typography: { fontFamily: "Onest", baseSize: "15px" },
  radius: { small: "6px", medium: "10px", large: "16px" },
  density: "compact",
  motion: "reduced",
};

const DESIGN_RULES = "Maple never shows a balance without its account name beside it.";

const request = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

/** One composed turn, answering with the brief the runtime handed the thinker.
 *  A scripted harness stands where `claudeCode()` stands and reads the same
 *  field it reads — `turn.system`, and nothing else. */
async function briefFor(overrides: Record<string, unknown>): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-design-brief-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  let brief: string | undefined;
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    harness: defineHarness({
      name: "scripted",
      async *run(turn) {
        brief = turn.system;
        yield { type: "text", delta: "read the brief" };
      },
    }),
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(request("/threads", {
    threadId: "thr_design",
    message: userMessage("m1", "build me a spending screen"),
  }));
  // Drained, and proven served: an unread brief and an unserved turn look the
  // same from here otherwise.
  expect(await response.text()).toContain("read the brief");
  return brief ?? "";
}

describe("the host's design configuration in the composed brief", () => {
  it("carries the theme tokens and the host's design rules", async () => {
    const brief = await briefFor({ theme, apps: { designRules: DESIGN_RULES } });
    expect(brief).toContain("THEME TOKENS:");
    // The token a builder writing an island actually needs, not a one-line
    // summary of the theme's density and font.
    expect(brief).toContain("#0f7b4a");
    expect(brief).toContain("HOST DESIGN RULES:");
    expect(brief).toContain(DESIGN_RULES);
  });

  it("says so plainly when the host set no rules, rather than leaving it unsaid", async () => {
    const brief = await briefFor({});
    expect(brief).toContain("HOST DESIGN RULES:\n(none provided)");
    expect(brief).not.toContain("THEME TOKENS:");
  });
});
