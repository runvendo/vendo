import { describe, expect, it } from "vitest";
import { prepareBaseline } from "./prepare";

describe("prepareBaseline", () => {
  it("strips the @vendoai/shell import and unwraps a single-child wrapper, byte-preserving everything else", () => {
    const src = `"use client"

import Link from "next/link"
import { VendoRemix } from "@vendoai/shell"
import { cn } from "@/lib/cn"

export function DeadlineList({ className }: { className?: string }) {
  const x = 1 // keep me exactly: weird  spacing
  return (
    <VendoRemix
      id="upcoming-deadlines"
      label="Upcoming deadlines"
      context={{ clients: [] }}
      className={className}
    >
    <div className={cn("card", className)}>
      <Link href="/calendar">View calendar</Link>
    </div>
    </VendoRemix>
  )
}
`;
    const out = prepareBaseline(src)!;
    expect(out).not.toContain("@vendoai/shell");
    expect(out).not.toContain("VendoRemix");
    // Children and unrelated code survive byte-for-byte.
    expect(out).toContain('const x = 1 // keep me exactly: weird  spacing');
    expect(out).toContain('<div className={cn("card", className)}>');
    expect(out).toContain('<Link href="/calendar">View calendar</Link>');
    expect(out).toContain('import { cn } from "@/lib/cn"');
  });

  it("wraps multiple children in a fragment", () => {
    const src = `import { VendoRemix } from "@vendoai/shell"
export function W() {
  return <VendoRemix id="w"><h1>a</h1><p>b</p></VendoRemix>
}
`;
    const out = prepareBaseline(src)!;
    expect(out).toContain("<><h1>a</h1><p>b</p></>");
    expect(out).not.toContain("VendoRemix");
  });

  it("handles multiple wrappers in one file", () => {
    const src = `import { VendoRemix } from "@vendoai/shell"
export function A() { return <VendoRemix id="a"><i>1</i></VendoRemix> }
export function B() { return <VendoRemix id="b"><b>2</b></VendoRemix> }
`;
    const out = prepareBaseline(src)!;
    expect(out).not.toContain("VendoRemix");
    expect(out).toContain("<i>1</i>");
    expect(out).toContain("<b>2</b>");
  });

  it("returns undefined when there is nothing to prepare (no wrapper, no shell import)", () => {
    expect(prepareBaseline(`export default function W(){ return <div/> }`)).toBeUndefined();
  });

  it("strips only the shell import when the wrapper element lives elsewhere", () => {
    const src = `import { VendoRemix } from "@vendoai/shell"
export const passthrough = VendoRemix
`;
    // A non-JSX use of VendoRemix can't be unwrapped mechanically — refuse
    // (undefined) rather than produce code with a dangling identifier.
    expect(prepareBaseline(src)).toBeUndefined();
  });
});
