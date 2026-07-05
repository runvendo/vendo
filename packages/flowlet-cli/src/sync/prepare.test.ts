import { describe, expect, it } from "vitest";
import { prepareBaseline } from "./prepare";

describe("prepareBaseline", () => {
  it("strips the @flowlet/shell import and unwraps a single-child wrapper, byte-preserving everything else", () => {
    const src = `"use client"

import Link from "next/link"
import { FlowletRemix } from "@flowlet/shell"
import { cn } from "@/lib/cn"

export function DeadlineList({ className }: { className?: string }) {
  const x = 1 // keep me exactly: weird  spacing
  return (
    <FlowletRemix
      id="upcoming-deadlines"
      label="Upcoming deadlines"
      context={{ clients: [] }}
      className={className}
    >
    <div className={cn("card", className)}>
      <Link href="/calendar">View calendar</Link>
    </div>
    </FlowletRemix>
  )
}
`;
    const out = prepareBaseline(src)!;
    expect(out).not.toContain("@flowlet/shell");
    expect(out).not.toContain("FlowletRemix");
    // Children and unrelated code survive byte-for-byte.
    expect(out).toContain('const x = 1 // keep me exactly: weird  spacing');
    expect(out).toContain('<div className={cn("card", className)}>');
    expect(out).toContain('<Link href="/calendar">View calendar</Link>');
    expect(out).toContain('import { cn } from "@/lib/cn"');
  });

  it("wraps multiple children in a fragment", () => {
    const src = `import { FlowletRemix } from "@flowlet/shell"
export function W() {
  return <FlowletRemix id="w"><h1>a</h1><p>b</p></FlowletRemix>
}
`;
    const out = prepareBaseline(src)!;
    expect(out).toContain("<><h1>a</h1><p>b</p></>");
    expect(out).not.toContain("FlowletRemix");
  });

  it("handles multiple wrappers in one file", () => {
    const src = `import { FlowletRemix } from "@flowlet/shell"
export function A() { return <FlowletRemix id="a"><i>1</i></FlowletRemix> }
export function B() { return <FlowletRemix id="b"><b>2</b></FlowletRemix> }
`;
    const out = prepareBaseline(src)!;
    expect(out).not.toContain("FlowletRemix");
    expect(out).toContain("<i>1</i>");
    expect(out).toContain("<b>2</b>");
  });

  it("returns undefined when there is nothing to prepare (no wrapper, no shell import)", () => {
    expect(prepareBaseline(`export default function W(){ return <div/> }`)).toBeUndefined();
  });

  it("strips only the shell import when the wrapper element lives elsewhere", () => {
    const src = `import { FlowletRemix } from "@flowlet/shell"
export const passthrough = FlowletRemix
`;
    // A non-JSX use of FlowletRemix can't be unwrapped mechanically — refuse
    // (undefined) rather than produce code with a dangling identifier.
    expect(prepareBaseline(src)).toBeUndefined();
  });
});
