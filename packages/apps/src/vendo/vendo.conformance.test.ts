import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll } from "vitest";
import { sandboxAdapterConformance } from "../adapter-conformance.js";
import {
  fakeSandbox,
  type FakeSandboxAdapter,
  type FakeSandboxMachine,
} from "../testing/fake-sandbox.js";
import { vendoSandbox } from "./index.js";

const apiKey = `vnd_${"0".repeat(40)}`;
const decoder = new TextDecoder();

let broker: Server;
let harnessUrl = "";

const readBody = async (request: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const readJson = async <T>(request: IncomingMessage): Promise<T> =>
  JSON.parse(decoder.decode(await readBody(request))) as T;

const sendJson = (response: import("node:http").ServerResponse, body: unknown, status = 200): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const sendBytes = (response: import("node:http").ServerResponse, bytes: Uint8Array): void => {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  response.end(bytes);
};

const sendError = (
  response: import("node:http").ServerResponse,
  status: number,
  code: string,
  message: string,
): void => sendJson(response, { error: { code, message } }, status);

beforeAll(async () => {
  const backing: FakeSandboxAdapter = fakeSandbox();
  const snapshots = new Map<string, string>();
  let nextSnapshot = 1;

  broker = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        sendError(response, 401, "unauthorized", "invalid Vendo API key");
        return;
      }

      const url = new URL(request.url ?? "/", "http://broker.test");
      const method = request.method ?? "GET";
      if (url.pathname === "/api/v1/sandboxes" && method === "POST") {
        const body = await readJson<{
          env: Record<string, string>;
          files?: Record<string, string>;
          egress?: string[];
        }>(request);
        const files = body.files === undefined
          ? undefined
          : Object.fromEntries(Object.entries(body.files).map(([path, value]) => [
            path,
            new Uint8Array(Buffer.from(value, "base64")),
          ]));
        const machine = await backing.create({
          env: body.env,
          ...(files === undefined ? {} : { files }),
          ...(body.egress === undefined ? {} : { egress: body.egress }),
        });
        sendJson(response, { id: machine.id, url: `${harnessUrl}/machines/${machine.id}` });
        return;
      }

      if (url.pathname === "/api/v1/sandboxes/resume" && method === "POST") {
        const { ref } = await readJson<{ ref: string }>(request);
        const fakeRef = snapshots.get(ref);
        if (fakeRef === undefined) {
          sendError(response, 404, "not-found", `snapshot not found: ${ref}`);
          return;
        }
        const machine = await backing.resume(fakeRef);
        sendJson(response, { id: machine.id, url: `${harnessUrl}/machines/${machine.id}` });
        return;
      }

      const match = /^\/api\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const machineId = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
      const action = match?.[2] ?? "";
      const machine: FakeSandboxMachine | undefined = machineId === undefined
        ? undefined
        : backing.machines.get(machineId);
      if (machine === undefined) {
        sendError(response, 404, "not-found", `sandbox not found: ${machineId ?? "unknown"}`);
        return;
      }

      if (action === "/exec" && method === "POST") {
        const body = await readJson<{ cmd: string; cwd?: string; timeout_ms?: number }>(request);
        sendJson(response, await machine.exec(body.cmd, {
          ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
          ...(body.timeout_ms === undefined ? {} : { timeoutMs: body.timeout_ms }),
        }));
        return;
      }

      if (action === "/files" && method === "GET") {
        sendBytes(response, await machine.files.read(url.searchParams.get("path") ?? ""));
        return;
      }

      if (action === "/files" && method === "PUT") {
        await machine.files.write(url.searchParams.get("path") ?? "", await readBody(request));
        sendJson(response, { ok: true });
        return;
      }

      if (action === "/files/list" && method === "GET") {
        sendJson(response, { entries: await machine.files.list(url.searchParams.get("dir") ?? "") });
        return;
      }

      if (action === "/request" && method === "POST") {
        const body = await readJson<{
          method: string;
          path: string;
          headers?: Record<string, string>;
          body_b64?: string;
        }>(request);
        const result = await machine.request({
          method: body.method,
          path: body.path,
          ...(body.headers === undefined ? {} : { headers: body.headers }),
          ...(body.body_b64 === undefined
            ? {}
            : { body: new Uint8Array(Buffer.from(body.body_b64, "base64")) }),
        });
        sendJson(response, {
          status: result.status,
          headers: result.headers,
          body_b64: Buffer.from(result.body).toString("base64"),
        });
        return;
      }

      if (action === "/snapshot" && method === "POST") {
        const ref = `vendo:snap_${nextSnapshot++}`;
        snapshots.set(ref, await machine.snapshot());
        sendJson(response, { ref });
        return;
      }

      if (action === "/screenshot" && method === "GET") {
        sendBytes(response, await machine.screenshot());
        return;
      }

      if (action === "" && method === "DELETE") {
        await machine.stop();
        sendJson(response, { ok: true });
        return;
      }

      sendError(response, 404, "not-found", `${method} ${url.pathname} is not implemented`);
    } catch (error) {
      sendError(response, 503, "unavailable", error instanceof Error ? error.message : "fake broker failure");
    }
  });
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const address = broker.address() as AddressInfo;
  harnessUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  broker.close();
  await once(broker, "close");
});

sandboxAdapterConformance("vendo", () => vendoSandbox({
  apiKey: "vnd_" + "0".repeat(40),
  baseUrl: harnessUrl,
}));
