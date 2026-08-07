import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { serveFetchHandler } from "../src/server/fetch-adapter.js";

describe("Relay fetch adapter", () => {
  it("preserves every Set-Cookie value as a response-header array", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "session=rotated; Path=/; HttpOnly");
    headers.append("set-cookie", "csrf=token; Path=/; SameSite=Strict");
    const written = new Map<string, string | number | readonly string[]>();
    const req = {
      method: "GET",
      originalUrl: "/api/vendo/status",
      rawHeaders: ["host", "127.0.0.1"],
      socket: {},
    } as IncomingMessage & { originalUrl?: string };
    const res = {
      statusCode: 0,
      setHeader(name: string, value: string | number | readonly string[]) {
        written.set(name.toLowerCase(), value);
        return this;
      },
      end() {},
    } as unknown as ServerResponse;

    await serveFetchHandler(req, res, async () => new Response(null, { headers }));

    expect(written.get("set-cookie")).toEqual([
      "session=rotated; Path=/; HttpOnly",
      "csrf=token; Path=/; SameSite=Strict",
    ]);
  });
});
