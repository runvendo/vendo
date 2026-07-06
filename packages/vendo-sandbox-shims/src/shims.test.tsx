import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import Link from "./next-link";
import Image from "./next-image";
import {
  useRouter,
  useParams,
  redirect,
  notFound,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "./next-navigation";
import useSWR, { useSWRConfig, mutate, SWRConfig, preload } from "./swr";
import { NAVIGATE_ACTION, dispatch, navigate } from "./dispatch";

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)["__vendoDispatch"];
  delete (globalThis as Record<string, unknown>)["__vendoAnchorData"];
});

function captureDispatch() {
  const calls: Array<{ action: string; payload?: unknown }> = [];
  (globalThis as Record<string, unknown>)["__vendoDispatch"] = (d: { action: string; payload?: unknown }) =>
    calls.push(d);
  return calls;
}

describe("Link shim", () => {
  it("renders an anchor and navigates via vendo.navigate on click (no real navigation)", () => {
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

describe("next/navigation extra exports", () => {
  it("useParams returns an empty object (no route channel in the sandbox)", () => {
    expect(useParams()).toEqual({});
  });

  it("redirect routes through the same navigate bridge (does not throw)", () => {
    const calls = captureDispatch();
    expect(() => redirect("/login")).not.toThrow();
    expect(calls).toEqual([{ action: NAVIGATE_ACTION, payload: { href: "/login" } }]);
  });

  it("notFound is a safe no-op (does not throw)", () => {
    expect(() => notFound()).not.toThrow();
  });

  it("useSelectedLayoutSegment(s) return null / []", () => {
    expect(useSelectedLayoutSegment()).toBeNull();
    expect(useSelectedLayoutSegments()).toEqual([]);
  });
});

describe("useSWR shim", () => {
  it("resolves from injected anchor data and NEVER calls the fetcher", () => {
    (globalThis as Record<string, unknown>)["__vendoAnchorData"] = { "/api/deadlines": [{ id: "a" }] };
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

describe("dispatch bridge-promise handling", () => {
  it("dispatch returns the bridge promise, resolving with its result on success", async () => {
    (globalThis as Record<string, unknown>)["__vendoDispatch"] = () => Promise.resolve("ok");
    await expect(dispatch("vendo.something")).resolves.toBe("ok");
  });

  it("swallows a bridge rejection (policy deny) with a warning — no unhandled rejection or dead click", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (globalThis as Record<string, unknown>)["__vendoDispatch"] = () =>
      Promise.reject(Object.assign(new Error("policy deny"), { code: "policy" }));
    await expect(navigate("/blocked")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("swr extra exports", () => {
  it("useSWRConfig returns a config object with a working mutate", async () => {
    const config = useSWRConfig();
    expect(typeof config.mutate).toBe("function");
    await expect(config.mutate("/api/x")).resolves.toBeUndefined();
  });

  it("global mutate writes into the anchor-data cache and resolves", async () => {
    (globalThis as Record<string, unknown>)["__vendoAnchorData"] = {};
    await expect(mutate("/api/deadlines", [{ id: "z" }])).resolves.toEqual([{ id: "z" }]);
    expect(useSWR("/api/deadlines").data).toEqual([{ id: "z" }]);
  });

  it("global mutate with no data is a safe resolved no-op", async () => {
    await expect(mutate("/api/x")).resolves.toBeUndefined();
  });

  it("SWRConfig renders its children (passthrough provider)", () => {
    render(<SWRConfig value={{}}>{<span>swr-child</span>}</SWRConfig>);
    expect(screen.getByText("swr-child")).toBeTruthy();
  });

  it("preload is a safe no-op returning a resolved promise (fetcher never runs)", async () => {
    const fetcher = vi.fn();
    await expect(preload("/api/x", fetcher)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
