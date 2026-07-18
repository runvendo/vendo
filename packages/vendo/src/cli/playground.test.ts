import { afterEach, describe, expect, it } from "vitest";
import { runPlayground, startPlaygroundServer } from "./playground.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function output(): { logs: string[]; errors: string[]; sink: { log(message: string): void; error(message: string): void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message) => logs.push(message), error: (message) => errors.push(message) } };
}

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
    expect(page).toContain('src="/playground.js"');

    const bundle = await fetch(`${server.url}/playground.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    expect((await bundle.text()).length).toBeGreaterThan(10_000);
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

describe("runPlayground", () => {
  it("prints the URL and opens the browser by default", async () => {
    const { logs, sink } = output();
    const opened: string[] = [];

    const code = await runPlayground({
      output: sink,
      openBrowser: (url) => opened.push(url),
      wait: false,
    });

    expect(code).toBe(0);
    const printed = logs.join("\n");
    expect(printed).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(opened).toHaveLength(1);
    expect(printed).toContain(opened[0]);
  });

  it("--no-open skips the browser", async () => {
    const { sink } = output();
    const opened: string[] = [];

    const code = await runPlayground({
      output: sink,
      open: false,
      openBrowser: (url) => opened.push(url),
      wait: false,
    });

    expect(code).toBe(0);
    expect(opened).toHaveLength(0);
  });

  it("fails loudly when the requested port is already taken", async () => {
    const squatter = await startPlaygroundServer({});
    cleanup.push(() => squatter.close());
    const port = Number(new URL(squatter.url).port);

    const { errors, sink } = output();
    const code = await runPlayground({ output: sink, port, open: false, wait: false });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(String(port));
  });
});
