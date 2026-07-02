import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createMailApi } from "../api";
import { MailStore } from "../store";
import { seedMessages, DEMO_ME } from "../seed";

let server: Server;
let base: string;
const store = new MailStore(seedMessages(), DEMO_ME);

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createMailApi(store));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => store.reset());

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json() };
};
const send = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

describe("mail API", () => {
  it("GET /api/profile returns the demo identity", async () => {
    const { status, json } = await get("/api/profile");
    expect(status).toBe(200);
    expect(json.user).toEqual(DEMO_ME);
  });

  it("GET /api/messages lists the inbox newest-first", async () => {
    const { status, json } = await get("/api/messages");
    expect(status).toBe(200);
    expect(json.messages.length).toBeGreaterThan(40);
    expect(json.messages[0].subject).toContain("Q3 planning");
    expect(json.messages.every((m: { folder: string }) => m.folder === "inbox")).toBe(true);
  });

  it("filters unread + limit and searches q", async () => {
    const unread = await get("/api/messages?unread=true");
    expect(unread.json.messages.length).toBe(7);
    const limited = await get("/api/messages?unread=true&limit=3");
    expect(limited.json.messages.length).toBe(3);
    const search = await get("/api/messages?q=ramen");
    expect(search.json.messages.map((m: { id: string }) => m.id)).toHaveLength(1);
  });

  it("rejects an unknown folder", async () => {
    expect((await get("/api/messages?folder=archiveish")).status).toBe(400);
  });

  it("GET /api/messages/:id returns one message, 404 when missing", async () => {
    const { json } = await get("/api/messages/m1");
    expect(json.message.subject).toContain("Q3 planning");
    expect((await get("/api/messages/nope")).status).toBe(404);
  });

  it("POST /api/messages/send replies to a message", async () => {
    const { status, json } = await send("POST", "/api/messages/send", {
      inReplyTo: "m5",
      body: "Session description: taking the platform apart, live.",
    });
    expect(status).toBe(200);
    expect(json.message.to[0].email).toBe("marcus@acmelabs.dev");
    expect(json.message.subject).toBe("Re: Offsite agenda — need your session by EOD");
    const sent = await get("/api/messages?folder=sent");
    expect(sent.json.messages[0].id).toBe(json.message.id);
  });

  it("POST send without body/recipient is a 400", async () => {
    expect((await send("POST", "/api/messages/send", { body: "hi" })).status).toBe(400);
    expect((await send("POST", "/api/messages/send", { to: "a@b.c", subject: "x" })).status).toBe(400);
  });

  it("DELETE /api/messages/:id moves to trash", async () => {
    const { status, json } = await send("DELETE", "/api/messages/m4");
    expect(status).toBe(200);
    expect(json.message.folder).toBe("trash");
    const inbox = await get("/api/messages");
    expect(inbox.json.messages.some((m: { id: string }) => m.id === "m4")).toBe(false);
    expect((await send("DELETE", "/api/messages/never")).status).toBe(404);
  });

  it("read + star mutations validate their booleans", async () => {
    const read = await send("POST", "/api/messages/m1/read", { read: true });
    expect(read.json.message.unread).toBe(false);
    const star = await send("POST", "/api/messages/m3/star", { starred: true });
    expect(star.json.message.starred).toBe(true);
    expect((await send("POST", "/api/messages/m1/read", { read: "yes" })).status).toBe(400);
    expect((await send("POST", "/api/messages/m1/star", {})).status).toBe(400);
  });
});
