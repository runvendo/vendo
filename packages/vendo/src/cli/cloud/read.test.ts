import { describe, expect, it, vi } from "vitest";
import { runDeployments, runOrgs, runUsage } from "./read.js";

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

describe("cloud organization reads", () => {
  it("prints organizations", async () => {
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue({ orgs: [{ id: "org_1" }] });
    expect(await runOrgs([], { output: messages.sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/orgs", expect.objectContaining({ auth: "user" }));
    expect(JSON.parse(messages.logs[0]!)).toEqual({ orgs: [{ id: "org_1" }] });
  });

  it("uses an explicit organization for deployments", async () => {
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue({ deployments: [] });
    expect(await runDeployments(["--org", "org/a"], { output: messages.sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/orgs/org%2Fa/deployments", expect.any(Object));
  });

  it("defaults to the only organization and forwards usage days", async () => {
    const messages = output();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ orgs: [{ id: "org_only" }] })
      .mockResolvedValueOnce({ days: 7, totals: [] });
    expect(await runUsage(["--days", "7"], { output: messages.sink, fetcher })).toBe(0);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/orgs/org_only/usage?days=7");
  });

  it("returns a clear error when an organization cannot be inferred", async () => {
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue({ orgs: [{ id: "one" }, { id: "two" }] });
    expect(await runDeployments([], { output: messages.sink, fetcher })).toBe(1);
    expect(messages.errors.join("\n")).toContain("--org <id>");
  });
});
