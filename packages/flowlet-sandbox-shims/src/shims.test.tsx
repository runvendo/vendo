import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import Link from "./next-link";
import Image from "./next-image";
import { useRouter } from "./next-navigation";
import useSWR from "./swr";
import { NAVIGATE_ACTION } from "./dispatch";

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)["__flowletDispatch"];
  delete (globalThis as Record<string, unknown>)["__flowletAnchorData"];
});

function captureDispatch() {
  const calls: Array<{ action: string; payload?: unknown }> = [];
  (globalThis as Record<string, unknown>)["__flowletDispatch"] = (d: { action: string; payload?: unknown }) =>
    calls.push(d);
  return calls;
}

describe("Link shim", () => {
  it("renders an anchor and navigates via flowlet.navigate on click (no real navigation)", () => {
    const calls = captureDispatch();
    render(<Link href="/clients/cl_rivera">Rivera</Link>);
    const anchor = screen.getByText("Rivera") as HTMLAnchorElement;
    expect(anchor.tagName).toBe("A");
    expect(anchor.getAttribute("href")).toBe("/clients/cl_rivera");
    fireEvent.click(anchor);
    expect(calls).toEqual([{ action: NAVIGATE_ACTION, payload: { href: "/clients/cl_rivera" } }]);
  });

  it("still fires a user onClick before navigating", () => {
    captureDispatch();
    const onClick = vi.fn();
    render(<Link href="/x" onClick={onClick}>x</Link>);
    fireEvent.click(screen.getByText("x"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Image shim", () => {
  it("renders an img with the src prop surface", () => {
    render(<Image src="/logo.png" alt="Logo" width={40} height={40} />);
    const img = screen.getByAltText("Logo") as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("/logo.png");
  });
});

describe("useRouter shim", () => {
  it("push routes the host app; back throws a contained error", () => {
    const calls = captureDispatch();
    const router = useRouter();
    router.push("/settings");
    expect(calls).toEqual([{ action: NAVIGATE_ACTION, payload: { href: "/settings" } }]);
    expect(() => router.back()).toThrow(/not available/);
  });
});

describe("useSWR shim", () => {
  it("resolves from injected anchor data and NEVER calls the fetcher", () => {
    (globalThis as Record<string, unknown>)["__flowletAnchorData"] = { "/api/deadlines": [{ id: "a" }] };
    const fetcher = vi.fn();
    const result = useSWR("/api/deadlines", fetcher);
    expect(result.data).toEqual([{ id: "a" }]);
    expect(result.isLoading).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is loading (undefined) when the key has no injected data, fetcher still never runs", () => {
    const fetcher = vi.fn();
    const result = useSWR("/api/missing", fetcher);
    expect(result.data).toBeUndefined();
    expect(result.isLoading).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
