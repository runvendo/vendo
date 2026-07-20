import { describe, expect, it } from "vitest";
import {
  ISLAND_AMBIENT_HELPER_NAMES,
  ISLAND_AMBIENT_KIT_NAMES,
  ISLAND_AMBIENT_NAMES,
  ISLAND_AMBIENT_REACT_NAMES,
  ISLAND_STRIPPED_SPECIFIERS,
  islandNetworkViolations,
  islandToolFallbackManifest,
  isStrippedIslandSpecifier,
  resolveIslandToolName,
  scanIslandTools,
  stripIslandImports,
} from "./island-ambient.js";
import { JAIL_ALLOWED_MODULES } from "./jail-modules.js";

describe("ambient name lists", () => {
  it("compose the full ambient scope with no duplicates", () => {
    expect(ISLAND_AMBIENT_NAMES).toEqual([
      ...ISLAND_AMBIENT_REACT_NAMES,
      ...ISLAND_AMBIENT_KIT_NAMES,
      ...ISLAND_AMBIENT_HELPER_NAMES,
    ]);
    expect(new Set(ISLAND_AMBIENT_NAMES).size).toBe(ISLAND_AMBIENT_NAMES.length);
  });

  it("include the react hooks pretraining reaches for and the tools/fmt helpers", () => {
    for (const name of ["React", "useState", "useEffect", "useMemo", "useRef", "Fragment"]) {
      expect(ISLAND_AMBIENT_REACT_NAMES).toContain(name);
    }
    expect(ISLAND_AMBIENT_HELPER_NAMES).toContain("tools");
    expect(ISLAND_AMBIENT_HELPER_NAMES).toContain("fmt");
  });

  it("strippable specifiers cover every jail module plus the kit-ish names", () => {
    for (const specifier of JAIL_ALLOWED_MODULES) {
      expect(isStrippedIslandSpecifier(specifier)).toBe(true);
    }
    expect(isStrippedIslandSpecifier("@vendoai/ui/kit")).toBe(true);
    expect(isStrippedIslandSpecifier("@vendoai/ui")).toBe(true);
    expect(isStrippedIslandSpecifier("recharts")).toBe(false);
    expect(isStrippedIslandSpecifier("lodash")).toBe(false);
    expect(new Set(ISLAND_STRIPPED_SPECIFIERS).size).toBe(ISLAND_STRIPPED_SPECIFIERS.length);
  });
});

describe("stripIslandImports", () => {
  it("strips default, named, namespace, mixed, and side-effect imports of known specifiers", () => {
    const source = [
      'import React from "react";',
      'import { useState, useEffect } from "react";',
      'import * as ReactDOM from "react-dom";',
      'import React2, { useMemo } from "react";',
      'import "react";',
      'import { Stat, DataTable } from "@vendo/kit";',
      "export default function View() { return <Stat label=\"a\" value={1}/>; }",
    ].join("\n");
    const stripped = stripIslandImports(source);
    expect(stripped.source).not.toContain("import");
    expect(stripped.source).toContain("export default function View()");
    // React2 is not an ambient name — surfaced, not silently broken.
    expect(stripped.issues.some((issue) => issue.includes('"React2"'))).toBe(true);
    // ReactDOM IS an ambient name; useState/useEffect/useMemo/Stat/DataTable are ambient.
    expect(stripped.issues.some((issue) => issue.includes("useState"))).toBe(false);
  });

  it("strips multi-line named imports", () => {
    const source = 'import {\n  useState,\n  useCallback,\n} from "react";\nexport default () => null;';
    const stripped = stripIslandImports(source);
    expect(stripped.source).not.toContain("import");
    expect(stripped.issues).toEqual([]);
  });

  it("flags aliased locals that the ambient scope cannot provide", () => {
    const stripped = stripIslandImports('import { useState as useS } from "react";\nexport default () => null;');
    expect(stripped.source).not.toContain("import");
    expect(stripped.issues.some((issue) => issue.includes('"useS"'))).toBe(true);
  });

  it("leaves unknown specifiers alone for the import gate to reject", () => {
    const source = 'import { LineChart } from "recharts";\nexport default () => null;';
    const stripped = stripIslandImports(source);
    expect(stripped.source).toContain('from "recharts"');
    expect(stripped.issues).toEqual([]);
  });

  it("strips type-only imports without name checks", () => {
    const stripped = stripIslandImports('import type { FC } from "react";\nexport default () => null;');
    expect(stripped.source).not.toContain("import");
    expect(stripped.issues).toEqual([]);
  });

  it("never touches dynamic imports or requires", () => {
    const source = 'const m = import("react"); const n = require("react"); export default () => null;';
    expect(stripIslandImports(source).source).toBe(source);
  });
});

describe("scanIslandTools", () => {
  it("collects literal member-access chains", () => {
    const source = `
      export default function Lookup() {
        const [hits, setHits] = useState([]);
        const run = async (q) => setHits((await tools.clients.search({ q })).data);
        const single = async () => tools.list_invoices({ status: "overdue" });
        return <Input onChange={run}/>;
      }`;
    const scan = scanIslandTools(source);
    expect(scan.paths).toEqual([["clients", "search"], ["list_invoices"]]);
    expect(scan.violations).toEqual([]);
  });

  it("rejects computed member access", () => {
    const scan = scanIslandTools('const name = "x"; const out = tools[name](); export default () => null;');
    expect(scan.violations.some((violation) => violation.includes("computed"))).toBe(true);
  });

  it("rejects computed access after a literal chain", () => {
    const scan = scanIslandTools('const out = tools.clients["search"]({}); export default () => null;');
    expect(scan.violations.some((violation) => violation.includes("computed"))).toBe(true);
  });

  it("rejects aliasing the tools object", () => {
    for (const source of [
      "const t = tools;",
      "run(tools);",
      "const fns = [tools];",
      "callWith({ api: tools });",
    ]) {
      const scan = scanIslandTools(source);
      expect(scan.violations.length, source).toBeGreaterThan(0);
    }
  });

  it("ignores the word tools in strings, comments, and JSX text", () => {
    const source = `
      // tools are ambient in comments too
      /* tools[expr] in a block comment */
      const label = "power tools";
      const tpl = \`no tools here\`;
      export default () => <p>my favorite tools are here</p>;`;
    const scan = scanIslandTools(source);
    expect(scan.paths).toEqual([]);
    expect(scan.violations).toEqual([]);
  });

  it("still scans code inside template interpolations", () => {
    const scan = scanIslandTools("const s = `total: ${await tools.metrics.total({})}`;");
    expect(scan.paths).toEqual([["metrics", "total"]]);
  });

  it("does not match identifiers that merely end in tools", () => {
    const scan = scanIslandTools("const powertools = 1; const x = powertools.spin();");
    expect(scan.paths).toEqual([]);
    expect(scan.violations).toEqual([]);
  });
});

describe("islandNetworkViolations", () => {
  it("flags fetch/XHR/WebSocket/EventSource/sendBeacon usage", () => {
    expect(islandNetworkViolations('fetch("/api/x")')).toEqual(["fetch"]);
    expect(islandNetworkViolations("const ws = new WebSocket(url);")).toEqual(["WebSocket"]);
    expect(islandNetworkViolations("const r = new XMLHttpRequest();")).toEqual(["XMLHttpRequest"]);
    expect(islandNetworkViolations("navigator.sendBeacon(u, d);")).toEqual(["sendBeacon"]);
    expect(islandNetworkViolations("new EventSource(u);")).toEqual(["EventSource"]);
  });

  it("ignores the words in strings and comments", () => {
    expect(islandNetworkViolations('// fetch the data\nconst label = "fetch(now)";')).toEqual([]);
  });

  it("passes a clean tools-only island", () => {
    expect(islandNetworkViolations("const r = await tools.clients.search({ q });")).toEqual([]);
  });
});

describe("resolveIslandToolName", () => {
  const known = new Set(["clients_search", "list_invoices", "host_metric"]);

  it("resolves dotted chains by underscore-join and flat names directly", () => {
    expect(resolveIslandToolName(["clients", "search"], known)).toBe("clients_search");
    expect(resolveIslandToolName(["list_invoices"], known)).toBe("list_invoices");
    expect(resolveIslandToolName(["host", "metric"], known)).toBe("host_metric");
  });

  it("returns null for unknown tools", () => {
    expect(resolveIslandToolName(["made", "up"], known)).toBeNull();
  });
});

describe("islandToolFallbackManifest", () => {
  it("derives the underscore-joined manifest from literal chains", () => {
    const source = "const a = await tools.clients.search({}); const b = await tools.list_invoices({});";
    expect(islandToolFallbackManifest(source)).toEqual(["clients_search", "list_invoices"]);
  });

  it("is empty when the island never touches tools", () => {
    expect(islandToolFallbackManifest("export default () => <p>static</p>;")).toEqual([]);
  });
});
