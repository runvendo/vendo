import { afterEach, describe, expect, it } from "vitest";
import { browserOpenCommand, startPlaygroundServer } from "./playground.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("startPlaygroundServer", () => {
  it("serves the playground page over localhost on a free port", async () => {
    const server = await startPlaygroundServer({});
    cleanup.push(() => server.close());

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Vendo Playground");
  });

  it("serves the bundled playground app the page loads", async () => {
    const server = await startPlaygroundServer({});
    cleanup.push(() => server.close());

    const page = await (await fetch(server.url)).text();
    expect(page).toContain('src="/playground.js?v=');

    const bundle = await fetch(`${server.url}/playground.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    expect((await bundle.text()).length).toBeGreaterThan(10_000);
  });

  it("serves the CORS-open docs embed bundle at /embed.js", async () => {
    const server = await startPlaygroundServer({});
    cleanup.push(() => server.close());

    const bundle = await fetch(`${server.url}/embed.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    expect(bundle.headers.get("access-control-allow-origin")).toBe("*");
    expect(await bundle.text()).toContain("VendoDocsEmbed");
  });

  it("honors a requested port", async () => {
    // Find a currently-free port, then ask for it explicitly.
    const probe = await startPlaygroundServer({});
    const port = Number(new URL(probe.url).port);
    await probe.close();

    const server = await startPlaygroundServer({ port });
    cleanup.push(() => server.close());
    expect(new URL(server.url).port).toBe(String(port));
  });
});

describe("browserOpenCommand", () => {
  it("goes through cmd /c on Windows — start is a shell built-in, not an executable", () => {
    expect(browserOpenCommand("win32", "http://127.0.0.1:4123")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://127.0.0.1:4123"],
    });
  });

  it("uses open on macOS and xdg-open elsewhere", () => {
    expect(browserOpenCommand("darwin", "u")).toEqual({ command: "open", args: ["u"] });
    expect(browserOpenCommand("linux", "u")).toEqual({ command: "xdg-open", args: ["u"] });
  });
});
