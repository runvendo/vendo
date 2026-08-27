import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { doctorErrorCodes } from "../../src/cli/doctor-codes.js";

/**
 * Registry-rot gate (agent-install DX design §Error handling): every code
 * doctor can emit must have a troubleshooting page, and every troubleshooting
 * page must name a code that exists in the registry. The docs live in this
 * repo, so this is a plain test against the docs-site source — it runs in the
 * normal `pnpm test` suite.
 *
 * The Cloud restructure retired the one long `deploy/troubleshooting` page for
 * a page per code under `production/troubleshooting/`, so the contract moved
 * from anchors on one file to the directory itself: the file name is the code,
 * lowercased, and the frontmatter title is the code as doctor prints it. Both
 * halves are asserted, because a page whose name and title disagree is a page a
 * `fix_ref` cannot reach.
 */

const TROUBLESHOOTING_DIR = new URL("../../../../docs-site/production/troubleshooting/", import.meta.url);

/** `title: "E-AREA-NNN"` in a page's Mintlify frontmatter. */
const TITLE = /^title: "(E-[A-Z]+-\d{3})"$/m;

/** The pages in this directory that document something other than one doctor
 *  code, named one by one so a page whose code title merely ROTTED can never
 *  slip out of the 1:1 contract by losing its title.
 *
 *  `index.mdx` is the group's own landing page — it lists all the codes rather
 *  than documenting one. It exists because doctor's `fix_ref` puts the code in a
 *  URL FRAGMENT, which never reaches the server: every already-installed CLI
 *  links at `/agents/verify#E-WIRE-003`, so the redirect has to land on a page
 *  that lists all of them.
 *
 *  `mcp-call-timeout.mdx` is a symptom page, not a code page: a stock MCP
 *  client's own 60-second deadline is nothing doctor can see, so there is no
 *  code to mirror. docs.json keeps `/production/mcp-call-timeout` redirecting
 *  here. */
const NON_CODE_PAGES = ["index.mdx", "mcp-call-timeout.mdx"];

/** Every code page in the directory. */
const pageFiles = (): string[] =>
  readdirSync(TROUBLESHOOTING_DIR).filter(
    (file) => file.endsWith(".mdx") && !NON_CODE_PAGES.includes(file),
  );

describe("the troubleshooting pages stay 1:1 with the doctor error-code registry", () => {
  it("gives every registered code a page and every page a registered code", async () => {
    const documented: string[] = [];

    for (const file of pageFiles()) {
      const text = await readFile(new URL(file, TROUBLESHOOTING_DIR), "utf8");
      const title = TITLE.exec(text)?.[1];
      expect(title, `${file} must carry a "title: \\"E-AREA-NNN\\"" frontmatter line`).toBeDefined();
      // Doctor's fix link ends in the code, and the page's own slug is the file
      // name. A title that does not match its file name is unreachable.
      expect(file, `${file} must be named for the code it documents`).toBe(`${title!.toLowerCase()}.mdx`);
      documented.push(title!);
    }

    expect(documented.sort()).toEqual([...doctorErrorCodes].sort());
  });
});
