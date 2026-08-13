/**
 * The two fidelity guards — the screens this gauntlet refuses because the ANSWER
 * would otherwise depend on which toolchain ran.
 *
 * A screen is compiled by one toolchain today and could be compiled by a
 * types-only one tomorrow, so a construct the two translate differently is a
 * screen that passes here and paints something else there. Two of them exist —
 * a `namespace` block and a class `static {}` initializer — and the scan refuses
 * both rather than admitting a venue-dependent screen.
 *
 * The third test is the other half of the same promise: the engine form is
 * compiled with a `"use strict";` banner, so strict mode is SPECIFIED rather
 * than inherited from whatever the compiler happened to emit. A screen that only
 * works in sloppy mode is now refused instead of quietly working here and
 * throwing somewhere else.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { warmScreenEngine } from "../../src/contract/index.js";
import {
  checkComponentScreen,
  type ComponentScreenCheck,
} from "../../src/server/checking/component-screen.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";
import { nodeToolchain } from "../../src/server/checking/toolchain.js";

const catalog = ["Stack", "Text", "Button"];

/** The refusal, to the byte — every namespace shape names the same construct, so
 *  every one of them earns the same sentence. */
const NAMESPACE_MESSAGE = "declares a namespace block (namespace Format { … }) — a screen is compiled by a"
  + " types-only transform, which has no output form for one, so this file would compile in"
  + " one venue and not in another. A screen is ONE file and needs no inner scope: write"
  + " plain top-level consts, functions and types instead.";

const check = (source: string, hostTools: readonly HostToolInfo[] = []): Promise<ComponentScreenCheck> =>
  checkComponentScreen({ source, hostTools, catalog, runQuery: async () => ({}) });

/** One WRITE, for the question of when a tool call actually fires. */
const writeTool: readonly HostToolInfo[] = [{
  name: "archive_invoice",
  description: "Archive one invoice",
  risk: "destructive",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
}];

const NAMESPACE = `import { Text } from "@vendo/screen";

namespace Format {
  export const dash = "—";
}

export default function Screen() {
  return <Text text={Format.dash} />;
}
`;

/** The refusal, to the byte — every shape of the block names the same construct,
 *  so every one of them earns the same sentence. */
const STATIC_BLOCK_MESSAGE = "writes a class static initializer block (static { … }) — a screen is compiled by a"
  + " types-only transform, which emits the class as written, so this block reaches the screen"
  + " VM unlowered and the same file does not run the same in every venue. Do that work in the"
  + " component body, or in a plain top-level const.";

const STATIC_BLOCK = `import { Text } from "@vendo/screen";

class Labels {
  static heading: string;
  static {
    Labels.heading = "Pending";
  }
}

export default function Screen() {
  return <Text text={Labels.heading} />;
}
`;

/** An empty block is still a block, and the brace still counts on the next
 *  line — the shape a `static[ \\t]*\\{` text match could not see. */
const STATIC_BLOCK_EMPTY = `import { Text } from "@vendo/screen";

class Labels {
  static {}
}

export default function Screen() {
  return <Text text={Labels.name} />;
}
`;

const STATIC_BLOCK_SPACED = `import { Text } from "@vendo/screen";

class Labels {
  static { }
}

export default function Screen() {
  return <Text text={Labels.name} />;
}
`;

const STATIC_BLOCK_WRAPPED_BRACE = `import { Text } from "@vendo/screen";

class Labels {
  static heading: string;
  static
  {
    Labels.heading = "Pending";
  }
}

export default function Screen() {
  return <Text text={Labels.heading} />;
}
`;

/** Every shape of `static` MEMBER that is not an initializer block. A text match
 *  had to guess at these; the AST does not. */
const STATIC_MEMBERS = `import { Text } from "@vendo/screen";

class Labels {
  static heading = { title: "Pending" };
  static caption() {
    return "nothing is waiting";
  }
  static get subtitle() {
    return "up next";
  }
  static async load() {
    return "loaded";
  }
}

export default function Screen() {
  return <Text text={Labels.heading.title + Labels.caption() + Labels.subtitle} />;
}
`;

/**
 * The construct as PROSE, in the five places a raw-text match mistook for the
 * real thing. The JSX one is the wrong refusal that mattered most: the screen
 * says the word "static" to a person, and the old guard answered by telling the
 * author to move a class initializer block their file does not contain.
 */
const STATIC_AS_PROSE = `import { Stack, Text } from "@vendo/screen";

// keep it static { and simple
/* a block comment mentioning static { too */
const plain = "a string with static { inside";
const templated = \`a template with static { inside\`;

export default function Screen() {
  const v = 12;
  return (
    <Stack gap={4}>
      <Text text={plain + templated} />
      <Stack>Balance is static {v}</Stack>
    </Stack>
  );
}
`;

/** A screen that only works in SLOPPY mode: the write to a frozen object is
 *  silently dropped there and a TypeError here. */
const SLOPPY = `import { Text } from "@vendo/screen";

const settings: { label: string } = { label: "before" };
Object.freeze(settings);

export default function Screen() {
  settings.label = "after";
  return <Text text={settings.label} />;
}
`;

/** The brace on the next line, and the block not at the start of one: the two
 *  shapes a line-anchored, space-only match let through. A guard that misses
 *  admits exactly the screen it exists to catch. */
const NAMESPACE_WRAPPED_BRACE = `import { Text } from "@vendo/screen";

namespace Format
{
  export const dash = "—";
}

export default function Screen() {
  return <Text text={Format.dash} />;
}
`;

const NAMESPACE_MID_LINE = `import { Text } from "@vendo/screen";

const gap = 4; namespace Format { export const dash = "—"; }

export default function Screen() {
  return <Text text={Format.dash} gap={gap} />;
}
`;

/**
 * WHEN a class field initializer runs, which is the thing raising the scan form
 * to es2022 made visible. The body runs on `new`, so the tool call belongs to
 * whoever constructs the class — here, the click handler. This screen does
 * exactly what the tool-at-render refusal tells authors to do, so refusing it
 * would be the gate contradicting its own instructions.
 */
const FIELD_CONSTRUCTED_IN_HANDLER = `import { Button, Stack, tools } from "@vendo/screen";

class Archive {
  result = tools.archive_invoice({ id: "inv_1" });
}

export default function Screen() {
  return (
    <Stack gap={4}>
      <Button label="Archive" onClick={() => { const run = new Archive(); void run.result; }} />
    </Stack>
  );
}
`;

/** A STATIC field is the other case, and it inverts: its initializer runs when
 *  the class DEFINITION is evaluated, which is the render — nobody has to
 *  construct anything. So this one really does fire with nobody clicking. */
const STATIC_FIELD_CALLS_TOOL = `import { Button, Stack, tools } from "@vendo/screen";

class Archive {
  static result = tools.archive_invoice({ id: "inv_1" });
}

export default function Screen() {
  return (
    <Stack gap={4}>
      <Button label="Archive" onClick={() => void Archive.result} />
    </Stack>
  );
}
`;

/** The same class, constructed while the component renders — so the write DOES
 *  fire with nobody clicking. The engine is what catches this, and its sentence
 *  is the one this screen has always earned. */
const FIELD_CONSTRUCTED_AT_RENDER = `import { Button, Stack, tools } from "@vendo/screen";

class Archive {
  result = tools.archive_invoice({ id: "inv_1" });
}

export default function Screen() {
  const run = new Archive();
  return (
    <Stack gap={4}>
      <Button label="Archive" onClick={() => void run.result} />
    </Stack>
  );
}
`;

/** The namespace guard reads raw text, so it answers on prose too. Pinned on
 *  purpose — see the note below the assertions. */
const NAMESPACE_IN_COMMENT = `import { Text } from "@vendo/screen";

// namespace Format { — how NOT to write a screen
export default function Screen() {
  return <Text text="hi" />;
}
`;

const NAMESPACE_IN_STRING = `import { Text } from "@vendo/screen";

const advice = "namespace Format { is not allowed here";

export default function Screen() {
  return <Text text={advice} />;
}
`;

/** REAL namespaces, split by a block comment the guard's `\\s` cannot cross —
 *  before the name, and before the brace. */
const NAMESPACE_SPLIT_BY_COMMENT = `import { Text } from "@vendo/screen";

namespace /* still a namespace */ Format {
  export const dash = "—";
}

export default function Screen() {
  return <Text text={Format.dash} />;
}
`;

const NAMESPACE_COMMENT_BEFORE_BRACE = `import { Text } from "@vendo/screen";

namespace Format /* still a namespace */ {
  export const dash = "—";
}

export default function Screen() {
  return <Text text={Format.dash} />;
}
`;

beforeAll(async () => {
  await warmScreenEngine();
});

describe("a construct the two toolchains would not agree on", () => {
  it("refuses a namespace block, and says what to write instead", async () => {
    const result = await check(NAMESPACE);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "namespace", message: NAMESPACE_MESSAGE }]);
  });

  it("sees a namespace whose brace is on the next line", async () => {
    const result = await check(NAMESPACE_WRAPPED_BRACE);

    expect(result.issues).toEqual([{ code: "namespace", message: NAMESPACE_MESSAGE }]);
    expect(result.ok).toBe(false);
  });

  it("sees a namespace that does not start its line", async () => {
    const result = await check(NAMESPACE_MID_LINE);

    expect(result.issues).toEqual([{ code: "namespace", message: NAMESPACE_MESSAGE }]);
    expect(result.ok).toBe(false);
  });

  it("refuses a class static initializer block, and says where that work goes", async () => {
    const result = await check(STATIC_BLOCK);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "static-block", message: STATIC_BLOCK_MESSAGE }]);
  });

  it("sees an empty static block", async () => {
    const result = await check(STATIC_BLOCK_EMPTY);

    expect(result.issues).toEqual([{ code: "static-block", message: STATIC_BLOCK_MESSAGE }]);
    expect(result.ok).toBe(false);
  });

  it("sees a static block that holds nothing but a space", async () => {
    const result = await check(STATIC_BLOCK_SPACED);

    expect(result.issues).toEqual([{ code: "static-block", message: STATIC_BLOCK_MESSAGE }]);
    expect(result.ok).toBe(false);
  });

  it("sees a static block whose brace is on the next line", async () => {
    const result = await check(STATIC_BLOCK_WRAPPED_BRACE);

    expect(result.issues).toEqual([{ code: "static-block", message: STATIC_BLOCK_MESSAGE }]);
    expect(result.ok).toBe(false);
  });

  it("admits every static MEMBER — property, method, getter, async method", async () => {
    const result = await check(STATIC_MEMBERS);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("admits `static {` written as PROSE — in a string, both comments, a template, and as JSX text", async () => {
    const result = await check(STATIC_AS_PROSE);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

/**
 * Raising the scan form to es2022 stopped esbuild lowering class fields into the
 * constructor, which made WHEN a field initializer runs a question this scan can
 * see for the first time. It must answer it the way the engine always has.
 */
describe("a tool call in a class field initializer", () => {
  it("is admitted when the class is constructed in a handler — the author did what the gate asks", async () => {
    const result = await check(FIELD_CONSTRUCTED_IN_HANDLER, writeTool);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("still earns tool-at-render when the field is STATIC — that one runs at render", async () => {
    const result = await check(STATIC_FIELD_CALLS_TOOL, writeTool);

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(["tool-at-render"]);
  });

  it("is refused by the ENGINE when the class is constructed while rendering", async () => {
    const result = await check(FIELD_CONSTRUCTED_AT_RENDER, writeTool);

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(["run"]);
    expect(result.issues[0]?.message).toContain("tools.archive_invoice() cannot run while the screen");
  });
});

/**
 * ACCEPTED RESIDUAL, pinned on purpose.
 *
 * The namespace guard matches raw text and strips nothing, so it refuses the
 * words `namespace X {` in a comment or a string as if they declared one. Both
 * assertions below are WRONG refusals, and they are correct to assert: the
 * regex was deliberately widened to close a fail-open miss (`namespace Foo\n{`
 * passed the entire gauntlet), and unlike `static {}` there is no AST route —
 * every toolchain erases a namespace before there is a tree to read.
 *
 * So this is a ratchet. Anyone "fixing" these two tests reopens that miss, and
 * these assertions are the tripwire that makes them notice.
 */
describe("the namespace guard's accepted false positives", () => {
  it("refuses the construct written in a line comment", async () => {
    const result = await check(NAMESPACE_IN_COMMENT);

    expect(result.issues).toEqual([{ code: "namespace", message: NAMESPACE_MESSAGE }]);
  });

  it("refuses the construct written inside a string", async () => {
    const result = await check(NAMESPACE_IN_STRING);

    expect(result.issues).toEqual([{ code: "namespace", message: NAMESPACE_MESSAGE }]);
  });

  /**
   * And the residual that runs the OTHER way — a KNOWN MISS, asserted so it is
   * visible rather than folklore. `\s` does not match a comment, so this real
   * declaration passes the whole gauntlet. Reading through comments means lexing
   * the file, which is exactly the comment-aware matching this guard was written
   * to avoid, and unlike `static {}` there is no tree to read instead.
   *
   * A failure here means the guard grew a lexer or an AST route: welcome news —
   * replace this assertion with a refusal.
   */
  it("admits a real namespace split by a block comment", async () => {
    const beforeName = await check(NAMESPACE_SPLIT_BY_COMMENT);
    const beforeBrace = await check(NAMESPACE_COMMENT_BEFORE_BRACE);

    expect(beforeName.issues).toEqual([]);
    expect(beforeName.ok).toBe(true);
    expect(beforeBrace.issues).toEqual([]);
    expect(beforeBrace.ok).toBe(true);
  });
});

describe("the engine form", () => {
  it("is compiled strict, so a screen that needs sloppy mode is refused rather than run", async () => {
    const result = await check(SLOPPY);

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(["run"]);
    expect(result.issues[0]?.message).toContain("'label' is read-only");
  });

  it("carries the strict-mode banner; the scan form is a module and is strict already", async () => {
    const forms = await nodeToolchain().transform(SLOPPY);

    expect(forms.engine.startsWith('"use strict";')).toBe(true);
    expect(forms.scan).not.toContain('"use strict";');
  });
});
