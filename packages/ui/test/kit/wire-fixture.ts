/**
 * A real HTTP door, shaped like the route the shim actually talks to.
 *
 * Mirrors `packages/vendo/src/wire/apps.ts` (the `POST /apps/:appId/call`
 * branch) and the CSRF json-mutation gate in `packages/vendo/src/server.ts`:
 *
 *   - the path is `<base>/apps/:appId/call`;
 *   - a mutation MUST arrive as `application/json` or it is refused, exactly as
 *     the wire refuses it (`jsonMutationRequired`);
 *   - the body is `{ ref, args }`, and a non-string `ref` is a validation
 *     error, exactly as `string(body["ref"], "ref")` makes it;
 *   - every answer is a REAL `ToolOutcome`, parsed by core's own
 *     `toolOutcomeSchema` before it is served — the fixture cannot invent a
 *     shape the contract forbids;
 *   - a thrown `VendoError` becomes the wire's `{ error: { code, message } }`
 *     envelope with a non-2xx status.
 *
 * The shim may not depend on `@vendoai/vendo` (layering — it ships into a
 * browser bundle), so the real handler cannot be imported here. What is NOT
 * stubbed: the fetch, the HTTP round trip, the JSON, and the outcome contract.
 */

import { toolOutcomeSchema, type Json, type ToolOutcome } from "@vendoai/core";
import { createServer, type Server } from "node:http";

export interface DoorCall {
  appId: string;
  ref: string;
  args: Json;
  method: string;
  contentType: string | undefined;
  path: string;
}

export interface Door {
  baseUrl: string;
  /** Every call the door received, in order. */
  calls: DoorCall[];
  /** What the next call answers. Throw to exercise the error envelope. */
  answer: (call: DoorCall) => ToolOutcome;
  close: () => Promise<void>;
}

const BASE = "/api/vendo";

export async function startDoor(answer: Door["answer"]): Promise<Door> {
  const door: Door = {
    baseUrl: "",
    calls: [],
    answer,
    close: async () => undefined,
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const segments = url.pathname.slice(BASE.length).split("/").filter((part) => part !== "");
      const fail = (status: number, code: string, message: string): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code, message } }));
      };
      if (!url.pathname.startsWith(`${BASE}/`) || segments[0] !== "apps" || segments[2] !== "call") {
        fail(404, "not-found", "unknown Vendo route");
        return;
      }
      const contentType = request.headers["content-type"];
      // server.ts's CSRF json-mutation gate, verbatim in spirit.
      if (contentType === undefined || !contentType.includes("application/json")) {
        fail(400, "validation", "content-type must be application/json");
        return;
      }
      let body: Record<string, Json>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, Json>;
      } catch {
        fail(400, "validation", "body must be JSON");
        return;
      }
      if (typeof body["ref"] !== "string") {
        fail(400, "validation", "ref must be a string");
        return;
      }
      const call: DoorCall = {
        appId: decodeURIComponent(segments[1] ?? ""),
        ref: body["ref"],
        args: body["args"] as Json,
        method: request.method ?? "",
        contentType,
        path: url.pathname,
      };
      door.calls.push(call);
      let outcome: ToolOutcome;
      try {
        outcome = door.answer(call);
      } catch (error) {
        fail(500, "validation", error instanceof Error ? error.message : String(error));
        return;
      }
      // The contract, enforced on the way out: the fixture serves what the real
      // route's return type allows and nothing else.
      const parsed = toolOutcomeSchema.safeParse(outcome);
      if (!parsed.success) {
        fail(500, "validation", `fixture served a non-ToolOutcome: ${parsed.error.message}`);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(parsed.data));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("door did not bind a port");
  door.baseUrl = `http://127.0.0.1:${address.port}${BASE}`;
  door.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return door;
}
