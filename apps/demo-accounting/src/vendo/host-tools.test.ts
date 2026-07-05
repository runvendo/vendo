import { describe, it, expect } from "vitest";
import { cadenceHostToolDefs } from "./host-tools";

const byName = (name: string) => {
  const def = cadenceHostToolDefs.find((d) => d.name === name);
  if (!def) throw new Error(`missing host tool ${name}`);
  return def;
};

describe("cadenceHostToolDefs", () => {
  it("derives one tool per real API operation, named by operationId", () => {
    const names = cadenceHostToolDefs.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "getDashboard",
        "listClients",
        "getClient",
        "listClientDocuments",
        "setDocumentStatus",
        "listClientMessages",
        "sendClientMessage",
        "listDeadlines",
        "listActivity",
      ]),
    );
  });

  it("excludes the demo-control routes from the agent's toolset", () => {
    const names = cadenceHostToolDefs.map((d) => d.name);
    expect(names).not.toContain("resetDemo");
    expect(names).not.toContain("simulateClientUpload");
    expect(cadenceHostToolDefs.every((d) => !d.http.path.startsWith("/api/demo/"))).toBe(true);
  });

  it("annotates reads as read-only and writes as mutating", () => {
    expect(byName("listClients").annotations.readOnlyHint).toBe(true);
    expect(byName("sendClientMessage").annotations.readOnlyHint).toBe(false);
    expect(byName("setDocumentStatus").annotations.readOnlyHint).toBe(false);
  });

  it("carries the HTTP binding the client executor needs", () => {
    const send = byName("sendClientMessage");
    expect(send.http).toMatchObject({ method: "post", path: "/api/clients/{id}/messages", hasBody: true });
    expect(send.inputSchema["required"]).toEqual(expect.arrayContaining(["id", "body"]));
  });
});
