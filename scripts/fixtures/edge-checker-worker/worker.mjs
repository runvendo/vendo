/** Portability-gate fixture: the screen toolchain of `@vendoai/apps/edge`, wired
 *  the way the production checker Worker wires it — the QuickJS WebAssembly
 *  arrives as a module the DEPLOYMENT imported (workerd compiles no bytes at
 *  runtime), and the toolchain is built at MODULE SCOPE, where Workers forbids
 *  I/O and timers.
 *
 *  The handler runs all three machines over one screen: compile it, type-check
 *  it, RUN it. Anything the edge leg reaches that workerd does not have shows up
 *  here and nowhere in a Node test. */
import { edgeToolchain } from "@vendoai/apps/edge";
import wasmModule from "./quickjs.wasm";

const toolchain = edgeToolchain({ wasmModule });

const SCREEN = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function Rows() {
  const listed = useQuery("list_rows");

  return (
    <Stack gap={8}>
      {listed.rows.map((row) => <Text key={row.id} text={row.label} />)}
    </Stack>
  );
}
`;

/** The shape `componentScreenTypings` prints, by hand and cut to this screen:
 *  the fixture stands alone, as the sibling portability-worker's store does. */
const TYPINGS = `declare namespace JSX {
  interface Element {}
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: string | number }
  interface IntrinsicElements {}
}
declare module "@vendo/screen" {
  export const Stack: (props: { gap?: number; children?: any }) => JSX.Element;
  export const Text: (props: { text: string | number; children?: any }) => JSX.Element;
  export function useQuery(tool: "list_rows"): { rows: Array<{ id: string; label: string }> };
}
`;

const CATALOG = ["Stack", "Text"];
const QUERIES = { list_rows: { rows: [{ id: "r_1", label: "One" }, { id: "r_2", label: "Two" }] } };

export default {
  async fetch() {
    const forms = await toolchain.transform(SCREEN);

    const typed = await toolchain.typecheck({
      source: SCREEN,
      typings: TYPINGS,
      lib: ["lib.es2020.d.ts"],
      components: CATALOG,
    });

    const painted = await toolchain.paint({
      compiledSource: forms.engine,
      queries: QUERIES,
      catalog: CATALOG,
      now: 0,
    });

    // The texts, not the node count: a paint that returned an empty tree would
    // otherwise read as a working engine.
    const texts = painted.ok
      ? Object.values(painted.tree.nodes)
        .filter((node) => node.component === "Text")
        .map((node) => node.props.text)
      : [];

    return Response.json({
      transform: { engine: forms.engine.startsWith('"use strict";'), scan: forms.scan.includes("@vendo/screen") },
      typecheck: typed.ok ? { ok: true, issues: typed.issues.map(({ code }) => code) } : typed,
      paint: painted.ok ? { ok: true, texts } : painted,
    });
  },
};
