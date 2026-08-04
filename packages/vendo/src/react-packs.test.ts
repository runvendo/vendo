/**
 * A pack's components really mount through the client root (F7).
 *
 * Design §5: the same `packs` array goes to `createVendo({ packs })` and to the
 * client root. This asserts the client half end to end — the pack's component
 * reaches the provider's context, which is what the renderer looks it up in — by
 * rendering the real `VendoRoot` around a probe that reads that context.
 *
 * `createElement` rather than JSX because this package's tsconfig preserves JSX
 * for its bundler; the test needs no transform of its own.
 */
import { useVendoContext } from "@vendoai/ui";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { definePack } from "./packs/define.js";
import { VendoRoot } from "./react.js";

const Badge = (): ReactNode => createElement("b", null, "badge");
const HostBadge = (): ReactNode => createElement("b", null, "host badge");

const compliancePack = definePack({
  name: "compliance-reports",
  components: { RetentionBadge: { component: Badge, description: "Retention." } },
});

/** Reads the components the provider actually mounted — the same map the
 *  renderer resolves a host component name against. */
const Probe = (): ReactNode => {
  const { components } = useVendoContext();
  return createElement("span", null, Object.keys(components).sort().join(","));
};

const mountedNames = (props: Record<string, unknown>): string[] => {
  const markup = renderToStaticMarkup(
    createElement(VendoRoot, props as never, createElement(Probe)),
  );
  const names = /<span>([^<]*)<\/span>/.exec(markup)?.[1] ?? "";
  return names === "" ? [] : names.split(",");
};

describe("VendoRoot mounts pack components (F7)", () => {
  it("mounts the component a pack contributed", () => {
    expect(mountedNames({ packs: [compliancePack] })).toEqual(["RetentionBadge"]);
  });

  it("mounts pack components alongside the host's own", () => {
    expect(mountedNames({
      packs: [compliancePack],
      components: { HostThing: HostBadge },
    })).toEqual(["HostThing", "RetentionBadge"]);
  });

  it("lets the host's own registration win a repeated name, as the server does", () => {
    const markup = renderToStaticMarkup(createElement(
      VendoRoot,
      { packs: [compliancePack], components: { RetentionBadge: HostBadge } } as never,
      createElement(Probe),
    ));
    expect(markup).toContain("RetentionBadge");
    // One entry, not two.
    expect(mountedNames({ packs: [compliancePack], components: { RetentionBadge: HostBadge } }))
      .toEqual(["RetentionBadge"]);
  });

  it("mounts nothing extra when no packs are passed", () => {
    expect(mountedNames({})).toEqual([]);
  });

  it("still honours a plain components map when packs is absent", () => {
    expect(mountedNames({ components: { HostThing: HostBadge } })).toEqual(["HostThing"]);
  });

  it("accepts a pack authored as a function of the boot context", () => {
    expect(mountedNames({ packs: [() => compliancePack] })).toEqual(["RetentionBadge"]);
  });
});
