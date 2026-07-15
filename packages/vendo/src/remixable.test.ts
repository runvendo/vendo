import { afterEach, describe, expect, it, vi } from "vitest";
import { remixable } from "./remixable.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("remixable helper", () => {
  it("marks the registration remixable without changing its shape", () => {
    const component = (): null => null;
    const marked = remixable({
      name: "InvoiceCard",
      description: "one invoice",
      component,
      exportable: true,
    }, "file:///host/src/vendo/components.ts");
    expect(marked).toEqual({
      name: "InvoiceCard",
      description: "one invoice",
      component,
      exportable: true,
      remixable: true,
    });
  });

  it("reports the module source to the wire in a development browser", async () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    remixable(
      { name: "InvoiceCard", component: () => null, exportable: true },
      "file:///host/src/vendo/components.ts",
    );
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/vendo/dev/remixable-source");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({
      slot: "InvoiceCard",
      source: "file:///host/src/vendo/components.ts",
      exportable: true,
    });
  });

  it("honors a custom base URL and strips its trailing slash", async () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    remixable({ name: "Card", component: () => null }, "file:///m.ts", { baseUrl: "/custom/vendo/" });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith("/custom/vendo/dev/remixable-source", expect.anything());
  });

  it("reports in a Vite-style dev browser with no NODE_ENV via import.meta.env", async () => {
    vi.stubGlobal("window", {});
    // No process-shim NODE_ENV: the helper falls back to import.meta.env,
    // where vitest (like Vite dev) sets DEV=true.
    vi.stubEnv("NODE_ENV", undefined);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    remixable({ name: "Card", component: () => null }, "http://localhost:5173/src/card.tsx");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledWith("/api/vendo/dev/remixable-source", expect.anything());
  });

  it("stays inert outside development", async () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    remixable({ name: "Card", component: () => null }, "file:///m.ts");
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays inert on the server where no window exists", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    remixable({ name: "Card", component: () => null }, "file:///m.ts");
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when the capture endpoint rejects the report", async () => {
    vi.stubGlobal("window", {});
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    remixable({ name: "Card", component: () => null }, "file:///m.ts");
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not runtime-capture remixable slot Card"),
      expect.any(Error),
    );
  });
});
