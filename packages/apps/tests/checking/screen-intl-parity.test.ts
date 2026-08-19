/**
 * The two `Intl` surfaces, walked and compared — the whole of the claim "a green
 * typecheck means the screen runs in the box".
 *
 * The claim spans two files that share no code and live at opposite ends of this
 * package: the declarations `tsc` reads (`server/checking/screen-typings.ts`,
 * whose `COMPONENT_SCREEN_LIB` pins `lib.es2020.d.ts` and therefore decides which
 * `Intl` a screen may write) and the bridge the screen actually runs against
 * (`contract/genui/component/vm-program.ts` `INTL_SOURCE`, which has no ICU and
 * borrows the host's). A name the lib admits and the bridge omits is a screen that
 * passes every gate and dies on its first paint with `TypeError: not a function`;
 * a name the bridge carries and the lib does not is dead code nothing can reach.
 * Both are silent. Neither side can notice on its own.
 *
 * So this file reads the surface off EACH side for real — the lib's out of the
 * program the gauntlet actually builds, the bridge's out of a screen actually
 * booted in the VM — and refuses any difference in either direction. Nothing here
 * is a list somebody typed: bump the lib pin and this test moves with it, which is
 * what makes it a gate rather than a snapshot. {@link MADE} is the one hand-written
 * thing, and it is checked against the namespace too, so a constructor a newer lib
 * introduces cannot be quietly skipped.
 */
import type TS from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { bootScreen, warmScreenEngine } from "../../src/contract/genui/component/index.js";
import { screenProgram, screenTscFindings } from "../../src/server/checking/screen-tsc.js";
import {
  COMPONENT_SCREEN_LIB,
  componentScreenTypings,
  screenCatalog,
} from "../../src/server/checking/screen-typings.js";
import { CATALOG, compileScreen, textsOf } from "../contract/genui/component/screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

const typings = componentScreenTypings({ catalog: screenCatalog([]), tools: [] });

/**
 * The cheapest legal construction of each of the lib's `Intl` constructors — the
 * arguments are minimal on purpose, and the two that take a required one take it
 * because a `DisplayNames` without a `type` and a `Locale` without a tag throw in
 * a browser too.
 *
 * This is the only hand-written list in the file, and "declares the whole
 * namespace" is asserted below rather than trusted.
 */
const MADE: Record<string, string> = {
  Collator: `Intl.Collator("en-US")`,
  DateTimeFormat: `Intl.DateTimeFormat("en-US")`,
  DisplayNames: `new Intl.DisplayNames("en-US", { type: "region" })`,
  Locale: `new Intl.Locale("en-US")`,
  NumberFormat: `Intl.NumberFormat("en-US")`,
  PluralRules: `Intl.PluralRules("en-US")`,
  RelativeTimeFormat: `new Intl.RelativeTimeFormat("en-US")`,
};

/** One screen that says, for every name in {@link MADE}, which keys the bridge
 *  really installed on the constructor and on what it builds. */
const ENUMERATING_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Surface() {
  return (
    <Stack gap={0}>
      <Text text={"Intl|" + Object.keys(Intl).sort().join(",")} />
${Object.entries(MADE).map(([name, made]) => `      <Text text={"${name}.statics|" + Object.keys(Intl.${name}).sort().join(",")} />
      <Text text={"${name}.instance|" + Object.keys(${made}).sort().join(",")} />`).join("\n")}
    </Stack>
  );
}
`;

/** `name|a,b,c` per painted line, as a map — the bridge's own answer about
 *  itself, read off a real paint. */
const bridgeSurface = (): Record<string, string[]> => {
  const screen = bootScreen({
    compiledSource: compileScreen(ENUMERATING_SCREEN),
    queries: {},
    catalog: CATALOG,
  });
  try {
    return Object.fromEntries(textsOf(screen.tree()).map((line) => {
      const [key = "", keys = ""] = line.split("|");
      return [key, keys === "" ? [] : keys.split(",")];
    }));
  } finally {
    screen.dispose();
  }
};

/** The `Intl` identifier in a compiled screen, which is the handle the checker
 *  answers every question about the pinned lib through. */
const intlAt = (program: { ts: typeof TS; file: TS.SourceFile }): TS.Identifier => {
  let found: TS.Identifier | undefined;
  const visit = (node: TS.Node): void => {
    if (found === undefined && program.ts.isIdentifier(node) && node.text === "Intl") found = node;
    program.ts.forEachChild(node, visit);
  };
  program.ts.forEachChild(program.file, visit);
  if (found === undefined) throw new Error("the probe screen does not name Intl");
  return found;
};

/** Every value-side member of `Intl` the PINNED lib declares, and the keys it
 *  gives each constructor — the statics on the constructor itself, and the
 *  methods and fields on what it builds.
 *
 *  `prototype` is dropped because it is not something a screen calls: it is
 *  non-enumerable on every function in JavaScript, so the bridge's own
 *  constructors do not list it either, in the box or out of it. */
const declaredSurface = (): { members: string[]; statics: Record<string, string[]>; instance: Record<string, string[]> } => {
  const program = screenProgram({ screen: `const probe = Intl;\nexport {};\n`, typings, lib: COMPONENT_SCREEN_LIB });
  if (!program.ok) throw new Error(program.why);
  const { checker } = program;
  const node = intlAt(program);
  const names = (type: TS.Type): string[] =>
    checker.getPropertiesOfType(type).map((symbol) => symbol.getName()).filter((name) => name !== "prototype").sort();

  const surface = { members: names(checker.getTypeAtLocation(node)), statics: {}, instance: {} } as {
    members: string[];
    statics: Record<string, string[]>;
    instance: Record<string, string[]>;
  };
  for (const member of checker.getPropertiesOfType(checker.getTypeAtLocation(node))) {
    const type = checker.getTypeOfSymbolAtLocation(member, node);
    const construct = type.getConstructSignatures()[0];
    // A member with no `new` is a plain function (`getCanonicalLocales`), which
    // builds nothing and carries no statics of its own.
    if (construct === undefined) continue;
    surface.statics[member.getName()] = names(type);
    surface.instance[member.getName()] = names(construct.getReturnType());
  }
  return surface;
};

describe("the bridge and the pinned lib", () => {
  it("installs exactly the Intl the typings admit — every name, on both sides", () => {
    const declared = declaredSurface();
    const installed = bridgeSurface();

    // The namespace itself. Written out because this list is the whole finding:
    // four of these eight were missing, and the compiler admitted all eight.
    expect(declared.members).toEqual([
      "Collator", "DateTimeFormat", "DisplayNames", "Locale",
      "NumberFormat", "PluralRules", "RelativeTimeFormat", "getCanonicalLocales",
    ]);
    expect(installed.Intl).toEqual(declared.members);
    // The table below covers every constructor the lib declares, so a newer lib's
    // `ListFormat` fails HERE rather than going unwalked.
    expect(Object.keys(MADE).sort()).toEqual(Object.keys(declared.statics).sort());

    for (const name of Object.keys(MADE)) {
      expect({ [name]: installed[`${name}.statics`] }).toEqual({ [name]: declared.statics[name] });
      expect({ [name]: installed[`${name}.instance`] }).toEqual({ [name]: declared.instance[name] });
    }
  });

  it("type-checks the very screen that read the bridge", () => {
    // Otherwise the walk proves nothing: a surface read by a screen the compiler
    // would have refused is not the surface a screen may write.
    expect(screenTscFindings({ screen: ENUMERATING_SCREEN, typings, lib: COMPONENT_SCREEN_LIB })).toEqual([]);
  });

  it("refuses the names the pinned lib does not declare, instead of bridging them", () => {
    // The other direction of the same rule. `ListFormat`, `Segmenter` and the
    // `formatRange` family are es2021 and later, so the box does not carry them
    // and MUST NOT: a screen that writes one is stopped by the type check, with a
    // sentence, rather than booting and dying. Bridging them means moving
    // COMPONENT_SCREEN_LIB first — and then the walk above demands them.
    for (const call of [
      `new Intl.ListFormat("en-US").format(["a", "b"])`,
      `new Intl.Segmenter("en-US").segment("ab")`,
      `new Intl.NumberFormat("en-US").formatRange(1, 2)`,
      `new Intl.DateTimeFormat("en-US").formatRange(new Date(0), new Date(1))`,
      `Intl.supportedValuesOf("currency")`,
    ]) {
      const findings = screenTscFindings({
        screen: `import { Text } from "@vendo/screen";\n\nexport default function S() {\n  return <Text text={String(${call})} />;\n}\n`,
        typings,
        lib: COMPONENT_SCREEN_LIB,
      });
      expect(findings.length, call).toBeGreaterThan(0);
    }
  });
});
