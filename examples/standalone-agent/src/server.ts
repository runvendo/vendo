/**
 * The same agent over HTTP: `pnpm start`.
 *
 * `handler()` is one fetch handler for the whole agent — the chat turn, the
 * thread list and transcript, and the approvals wire — so it mounts on any
 * server that can hand it a `Request`.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { support } from "./agent.js";

const handle = support.handler({
  basePath: "/api/agent",
  // Your session, read per request. This demo has no auth, so it trusts a
  // header; return `null` and the mount answers 401.
  resolveUser: async (request) => ({ subject: request.headers.get("x-user") ?? "demo-user" }),
});

const app = new Hono();
app.all("/api/agent/*", (c) => handle(c.req.raw));

serve({ fetch: app.fetch, port: 3000 });
console.log("listening on http://localhost:3000/api/agent");
