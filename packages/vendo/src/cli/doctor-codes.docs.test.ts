import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { doctorErrorCodes } from "./doctor-codes.js";

/**
 * Registry-rot gate (agent-install DX design §Error handling): every code
 * doctor can emit must have a matching anchor on the verify playbook page,
 * and every code the page documents must exist in the registry. The docs
 * live in this repo, so this is a plain test against the docs-site source —
 * it runs in the normal `pnpm test` suite.
 */

const VERIFY_PAGE = new URL("../../../../docs-site/agents/verify.mdx", import.meta.url);

/** A verify section heading: `## E-AREA-NNN {#E-AREA-NNN}` (Mintlify custom
 *  heading IDs — the {#...} id is what doctor's fix_ref fragment resolves to,
 *  case-sensitively). */
const ANCHORED_HEADING = /^#{2,4}\s+(E-[A-Z]+-\d{3})\s+\{#(E-[A-Z]+-\d{3})\}\s*$/gm;
/** Any heading that names an error code, anchored or not — catches a section
 *  someone added without the custom id (whose auto-slug would be lowercase
 *  and break the fix_ref fragment). */
const CODE_HEADING = /^#{2,4}\s+(E-[A-Z]+-\d{3})\b.*$/gm;

describe("verify.mdx stays 1:1 with the doctor error-code registry", () => {
  it("anchors every registered code and registers every anchored code", async () => {
    const page = await readFile(VERIFY_PAGE, "utf8");

    const anchored = new Map<string, string>();
    for (const match of page.matchAll(ANCHORED_HEADING)) {
      const [, heading, anchor] = match;
      expect(anchor, `heading ${heading} must anchor its own code`).toBe(heading);
      expect(anchored.has(heading!), `duplicate section for ${heading}`).toBe(false);
      anchored.set(heading!, anchor!);
    }

    // Every code heading must carry the exact {#CODE} custom id.
    const headings = [...page.matchAll(CODE_HEADING)].map((match) => match[1]!);
    for (const heading of headings) {
      expect(anchored.has(heading), `heading for ${heading} is missing its {#${heading}} anchor`).toBe(true);
    }

    // 1:1 both ways: registry → page and page → registry.
    expect([...anchored.keys()].sort()).toEqual([...doctorErrorCodes].sort());
  });
});
