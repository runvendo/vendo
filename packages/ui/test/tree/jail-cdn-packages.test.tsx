import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  JAIL_PACKAGE_CDN_ORIGIN,
} from "@vendoai/apps/contract";
import { JailedComponent, type JailFurnishing } from "../../src/tree/jail/JailedComponent.js";

/**
 * The venue gate, at the CSP.
 *
 * `JailFurnishing.packages` is the only thing that ever puts a network source in
 * the jail's policy. A remix fork in a customer's own page never has one, so its
 * document must come out byte-identical to the network-denied jail that has
 * always rendered there — asserted here rather than reasoned about, because the
 * policy IS the security envelope.
 */
const source = 'export default function Chart() { return <b>chart</b>; }';

function srcdocOf(furnishing?: JailFurnishing): string {
  const { container } = render(
    <JailedComponent
      name="Chart"
      source={source}
      furnishing={furnishing}
      onAction={async () => ({ status: "ok", output: null })}
      onStateSet={() => undefined}
    />,
  );
  return container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
}

const scriptSrc = (srcdoc: string): string[] => [...new Set(srcdoc.match(/script-src [^;"]+/gu) ?? [])];

describe("the preview jail's CDN package venue", () => {
  it("names no network source at all without package pins", () => {
    const directives = scriptSrc(srcdocOf({ sourceImports: {}, sampleProps: { total: 1 } }));
    expect(directives).toHaveLength(1);
    expect(directives[0]).toBe("script-src 'unsafe-inline' 'unsafe-eval'");
  });

  it("is identical with no furnishing at all and with an empty package map", () => {
    const bare = scriptSrc(srcdocOf());
    const empty = scriptSrc(srcdocOf({ packages: {} }));
    expect(bare[0]).toBe(empty[0]);
    expect(bare[0]).not.toContain(JAIL_PACKAGE_CDN_ORIGIN);
  });

  it("adds exactly the one pinned origin, to script-src only", () => {
    const srcdoc = srcdocOf({ packages: { recharts: "recharts@3.9.2" } });
    for (const directive of scriptSrc(srcdoc)) {
      expect(directive).toBe("script-src 'unsafe-inline' 'unsafe-eval' https://esm.sh data:");
    }
    // Nothing else moves.
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("img-src data:");
    expect(srcdoc).toContain('sandbox", "allow-scripts"');
    expect(srcdoc).not.toContain("allow-same-origin");
    // The origin is a script source and nothing else. Read from the policies
    // themselves — the runtime bundle in the same document also contains the
    // origin as a string constant, which is not a CSP source.
    for (const policy of srcdoc.match(/Content-Security-Policy" content="[^"]+/gu) ?? []) {
      const named = policy.split(";").filter((directive) => directive.includes(JAIL_PACKAGE_CDN_ORIGIN));
      expect(named.map((directive) => directive.trim().split(" ")[0])).toEqual(["script-src"]);
    }
  });

  it("reports a package that will not load as an honest tile, even mid-stream", async () => {
    const { container, getByRole } = render(
      <JailedComponent
        name="Chart"
        source={source}
        furnishing={{ packages: { recharts: "recharts@3.9.2" } }}
        // A preview sets this permanently, which is exactly why the note must
        // not be deferred to a "final" payload that never arrives.
        streaming
        onAction={async () => ({ status: "ok", output: null })}
        onStateSet={() => undefined}
      />,
    );
    const iframe = container.querySelector("iframe")!;
    // The jail's own report, as the runtime posts it.
    Object.defineProperty(window, "parent", { value: window, configurable: true });
    vi.spyOn(iframe, "contentWindow", "get").mockReturnValue(window as unknown as Window);
    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: { vendo: true, kind: "packages-unavailable", packages: ["recharts@3.9.2"] },
    }));

    await waitFor(() => {
      expect(getByRole("note", { name: "Preview unavailable" }).textContent)
        .toBe("Chart: could not load recharts@3.9.2");
    });
  });
});
