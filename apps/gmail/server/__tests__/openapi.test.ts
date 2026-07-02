import { describe, expect, it } from "vitest";
import { openApiToHostTools } from "@flowlet/core";
import spec from "../../src/openapi.json";

/**
 * The spec is the reviewable tool contract — assert the adapter derives the
 * exact tool surface and annotations the policy layer depends on.
 */
describe("openapi.json → host tools", () => {
  const tools = openApiToHostTools(spec);
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("derives the full expected tool set", () => {
    expect([...byName.keys()].sort()).toEqual([
      "delete_message",
      "get_message",
      "get_profile",
      "list_messages",
      "mark_message_read",
      "send_message",
      "star_message",
    ]);
  });

  it("reads are read-only; mutations are not", () => {
    expect(byName.get("list_messages")!.annotations.readOnlyHint).toBe(true);
    expect(byName.get("get_message")!.annotations.readOnlyHint).toBe(true);
    expect(byName.get("get_profile")!.annotations.readOnlyHint).toBe(true);
    expect(byName.get("send_message")!.annotations.readOnlyHint).toBe(false);
    expect(byName.get("mark_message_read")!.annotations.readOnlyHint).toBe(false);
    expect(byName.get("star_message")!.annotations.readOnlyHint).toBe(false);
  });

  it("delete is destructive", () => {
    expect(byName.get("delete_message")!.annotations.destructiveHint).toBe(true);
    expect(byName.get("send_message")!.annotations.destructiveHint).toBe(false);
  });

  it("send_message requires its JSON body; list_messages carries query params", () => {
    const send = byName.get("send_message")!;
    expect(send.http).toMatchObject({ method: "post", path: "/api/messages/send", hasBody: true });
    expect(send.inputSchema["required"]).toContain("body");
    const list = byName.get("list_messages")!;
    expect(list.http.params.map((p) => p.name).sort()).toEqual([
      "folder",
      "limit",
      "q",
      "starred",
      "unread",
    ]);
  });
});
