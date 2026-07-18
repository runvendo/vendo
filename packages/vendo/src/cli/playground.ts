import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PLAYGROUND_BUNDLE_SOURCE } from "./playground/bundle.gen.js";
import { consoleOutput, type Output } from "./shared.js";

/**
 * `vendo playground` — a local page rendering every shipped Vendo surface
 * against scripted (director-mode) data: no model key, no database, no host
 * app. install-dx design §8; the page itself ships in ./playground/.
 */

export interface PlaygroundServer {
  url: string;
  close(): Promise<void>;
}

function pageHtml(): string {
  // Cache-busting is belt and braces: no-store headers do the real work, and
  // the length-keyed ?v= keeps even a heuristically-cached HTML copy from
  // pairing with a mismatched bundle after most rebuilds.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vendo Playground</title>
</head>
<body>
<div id="root"></div>
<script src="/playground.js?v=${PLAYGROUND_BUNDLE_SOURCE.length.toString(36)}"></script>
</body>
</html>
`;
}

export async function startPlaygroundServer(options: { port?: number }): Promise<PlaygroundServer> {
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/playground.js") {
      response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(PLAYGROUND_BUNDLE_SOURCE);
      return;
    }
    if (path === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (path !== "/" && path !== "/index.html") {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(pageHtml());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      // Detach the bind-failure handler so a later runtime error is not
      // swallowed by rejecting an already-settled promise.
      server.removeListener("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface PlaygroundOptions {
  port?: number;
  /** When false (`--no-open`), print the URL without launching the browser. */
  open?: boolean;
  output?: Output;
  /** Test seams. */
  openBrowser?: (url: string) => void;
  /** When false, return right after startup instead of blocking until Ctrl+C. */
  wait?: boolean;
}

/** Windows' `start` is a cmd built-in, not an executable — execFile can only
 *  reach it through `cmd /c start "" <url>` (the empty string is the window
 *  title, so a URL is never mistaken for one). */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

function defaultOpenBrowser(url: string): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  execFile(command, args, () => undefined);
}

export async function runPlayground(options: PlaygroundOptions = {}): Promise<number> {
  const output = options.output ?? consoleOutput;

  let server: PlaygroundServer;
  try {
    server = await startPlaygroundServer({ port: options.port });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    output.error(`vendo playground: could not listen on port ${options.port ?? 0} (${detail}) — pass a different --port`);
    return 1;
  }

  output.log(`Vendo playground running at ${server.url}`);
  output.log("Every surface, scripted data, no model key. Press Ctrl+C to stop.");
  if (options.open !== false) (options.openBrowser ?? defaultOpenBrowser)(server.url);

  if (options.wait === false) {
    await server.close();
    return 0;
  }

  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  await server.close();
  return 0;
}
