import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESERVED_COLLECTIONS } from "./routing.js";

describe("02-store §3 — reserved-collection routing contract", () => {
  it("keeps the routed reserved-collection list identical in code and contract", () => {
    const contract = readFileSync(
      new URL("../../../docs/contracts/02-store.md", import.meta.url),
      "utf8",
    );
    const list = contract.match(
      /The reserved routing list mirrors `RESERVED_COLLECTIONS`[^\n]*:\n\n(?<items>(?:- `[^`]+`\n)+)/,
    )?.groups?.items;
    expect(list, "could not find the 02-store §3 reserved routing list").toBeDefined();
    const documented = [...(list ?? "").matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
    expect(documented).toEqual([...RESERVED_COLLECTIONS]);
  });
});
