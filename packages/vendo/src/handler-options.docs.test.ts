import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CreateVendoConfig } from "./server.js";

/**
 * Docs-rot gate (same pattern as doctor-codes.docs.test.ts): the composition
 * configuration table on handler-options.mdx must list exactly the top-level
 * keys of CreateVendoConfig. The key list below is pinned to the interface at
 * compile time in both directions, so the table can neither document a key
 * that does not exist nor silently miss a new one.
 */

const CONFIG_KEYS = [
  "model",
  "paint",
  "auth",
  "principal",
  "catalog",
  "store",
  "sandbox",
  "connectors",
  "connections",
  "actAs",
  "serverActions",
  "policy",
  "judge",
  "secrets",
  "telemetry",
  "development",
  "mcp",
  "oauth",
  "agent",
  "sessions",
  "approvals",
  "apps",
] as const;

// Every listed key exists on the interface…
const _listedKeysExist: ReadonlyArray<keyof CreateVendoConfig> = CONFIG_KEYS;
void _listedKeysExist;
// …and every interface key is listed (Exclude resolves to never or this fails).
type AssertNever<T extends never> = T;
type _NoMissingKeys = AssertNever<Exclude<keyof CreateVendoConfig, (typeof CONFIG_KEYS)[number]>>;

const OPTIONS_PAGE = new URL("../../../docs-site/reference/handler-options.mdx", import.meta.url);

/** A composition-table row: `| \`key\` | ... |`. */
const OPTION_ROW = /^\|\s*`([A-Za-z]+)`\s*\|/gm;

describe("handler-options.mdx stays 1:1 with CreateVendoConfig", () => {
  it("documents every config key and no key that does not exist", async () => {
    const page = await readFile(OPTIONS_PAGE, "utf8");
    const table = page.slice(
      page.indexOf("## Composition configuration"),
      page.indexOf("##", page.indexOf("## Composition configuration") + 1),
    );

    const documented = [...table.matchAll(OPTION_ROW)].map((match) => match[1]!);
    expect(new Set(documented).size, "duplicate rows").toBe(documented.length);
    expect(documented.sort()).toEqual([...CONFIG_KEYS].sort());
  });
});
