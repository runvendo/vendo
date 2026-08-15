/**
 * The screen toolchain's conformance table — one fixture set, driven once per
 * implementation.
 *
 * A toolchain is an ADAPTER SLOT: the Node one compiles with esbuild, checks
 * with the `typescript` package and paints in QuickJS, and a non-Node venue will
 * do all three differently. What must NOT differ is what a screen author reads
 * back, so the contract is asserted where the author meets it — through the
 * whole gauntlet (`checkComponentScreen`), on the verdict and the issue codes
 * and the sentence each class is written in.
 *
 * Driven through the gauntlet rather than against the three methods directly
 * because two of these fixtures never reach the toolchain's second or third
 * call: the import surface and the literal-query rule are the SCAN's, and a
 * toolchain that compiled to a different module form would break them without
 * ever answering a question wrong itself.
 *
 * A second driver calls this with its own factory and adds nothing else.
 */
import { expect, it } from "vitest";
import {
  checkComponentScreen,
  type ComponentScreenCheck,
} from "../../src/server/checking/component-screen.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";
import type { ScreenToolchain } from "../../src/server/checking/toolchain.js";

const tools: readonly HostToolInfo[] = [
  {
    name: "list_rows",
    description: "The rows this screen paints",
    risk: "read",
    inputSchema: { type: "object", properties: { status: { type: "string" } }, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
      },
      required: ["rows"],
      additionalProperties: false,
    },
  },
];

const catalog = ["Stack", "Text"];

/** The rows `list_rows` really answers with, for every fixture but the one that
 *  is about a tool answering with less than its shape promised. */
const ROWS = { rows: [{ id: "r_1", label: "One" }, { id: "r_2", label: "Two" }] };

const LISTING = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function Rows() {
  const listed = useQuery("list_rows");

  return (
    <Stack gap={8}>
      {listed.rows.map((row) => <Text key={row.id} text={row.label} />)}
    </Stack>
  );
}
`;

interface Fixture {
  readonly name: string;
  readonly source: string;
  /** What `list_rows` answers with here. */
  readonly answer: unknown;
  /** The refusal's codes, in order. Empty means the screen passes. */
  readonly codes: readonly string[];
  /** A fragment of the sentence the author reads — the part that must be
   *  identical whatever compiled, checked and painted the screen. */
  readonly says?: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "paints a screen that compiles, type-checks and renders",
    source: LISTING,
    answer: ROWS,
    codes: [],
  },
  {
    name: "refuses a screen that does not type-check",
    source: `import { Text } from "@vendo/screen";

export default function Rows() {
  return <img><Text text="hi" /></img>;
}
`,
    answer: ROWS,
    codes: ["types"],
    says: "writes the HTML element <img>, which a screen does not have",
  },
  {
    name: "refuses a screen that throws on the data its query really returned",
    // The listing screen, against a tool that answered with less than its shape
    // promised: nothing static can catch this, so only a real paint does.
    source: LISTING,
    answer: {},
    codes: ["run"],
    says: "the screen threw while rendering against the data its queries really returned",
  },
  {
    name: "refuses a screen that imports a module it may not",
    source: `import { Text } from "@vendo/screen";
import { titleCase } from "change-case";

export default function Rows() {
  return <Text text={titleCase("hello")} />;
}
`,
    answer: ROWS,
    codes: ["import"],
    says: 'imports "change-case" — a screen may import only "react"',
  },
  {
    name: "refuses a screen whose query names its tool through a variable",
    source: `import { Stack, Text, useQuery } from "@vendo/screen";

const TOOL = "list_rows";

export default function Rows() {
  const listed = useQuery(TOOL);

  return (
    <Stack gap={8}>
      {listed.rows.map((row) => <Text key={row.id} text={row.label} />)}
    </Stack>
  );
}
`,
    answer: ROWS,
    codes: ["query-name"],
    says: "calls useQuery(…) with a computed tool name",
  },
];

const check = (
  toolchain: ScreenToolchain,
  fixture: Fixture,
): Promise<ComponentScreenCheck> => checkComponentScreen({
  source: fixture.source,
  hostTools: tools,
  catalog,
  runQuery: async () => fixture.answer,
  toolchain,
});

/** Drive the table with one implementation. Call it inside a `describe`. */
export function runToolchainConformance(makeToolchain: () => ScreenToolchain): void {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const result = await check(makeToolchain(), fixture);

      expect(result.issues.map(({ code }) => code)).toEqual(fixture.codes);
      expect(result.ok).toBe(fixture.codes.length === 0);
      if (fixture.says !== undefined) {
        expect(result.issues.map(({ message }) => message).join("\n")).toContain(fixture.says);
      }
      if (fixture.codes.length > 0) return;
      // A passing verdict is only worth what it hands back: the compiled screen
      // the renderer re-boots, the answers it boots on, and the paint itself.
      expect(result.compiled).toContain("react/jsx-runtime");
      expect(result.queries).toEqual({ list_rows: fixture.answer });
      expect(Object.values(result.initialTree?.nodes ?? {}).map(({ component }) => component))
        .toContain("Text");
    });
  }
}
