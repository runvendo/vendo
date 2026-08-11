import { describe, expect, it, vi } from "vitest";
import { runOrgs, runUsage } from "../../../src/cli/cloud/read.js";

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

  it("uses an explicit project for usage and forwards days", async () => {
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue({ days: [] });
    expect(await runUsage(["--project", "proj/a", "--days", "7"], { output: messages.sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/projects/proj%2Fa/usage?days=7",
      expect.objectContaining({ auth: "user" }),
    );
  });

  it("defaults to the only project of the only organization", async () => {
    const messages = output();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ orgs: [{ id: "org_only" }] })
      .mockResolvedValueOnce({ projects: [{ id: "proj_only" }] })
      .mockResolvedValueOnce({ days: [] });
    expect(await runUsage([], { output: messages.sink, fetcher })).toBe(0);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/orgs");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/orgs/org_only/projects");
    expect(fetcher.mock.calls[2]?.[0]).toBe("/api/v1/projects/proj_only/usage?days=30");
  });

  // Pins the dollar fields the usage route now returns. runUsage hands the
  // response straight to printJson, so nothing here transforms them — this
  // test exists so a future refactor cannot silently drop them.
  it("prints the dollar figures the usage route returns", async () => {
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue({
      days: [{ day: "2026-08-04", requests: 2, usd: 4 }],
      totalUsd: 4,
    });
    expect(await runUsage(["--project", "p1"], { output: messages.sink, fetcher })).toBe(0);
    expect(messages.logs.join("\n")).toContain('"usd": 4');
    expect(messages.logs.join("\n")).toContain('"totalUsd": 4');
  });

  it("returns a clear error when a project cannot be inferred", async () => {
    const messages = output();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ orgs: [{ id: "org_only" }] })
      .mockResolvedValueOnce({ projects: [{ id: "one" }, { id: "two" }] });
    expect(await runUsage([], { output: messages.sink, fetcher })).toBe(1);
    expect(messages.errors.join("\n")).toContain("--project <id>");
  });
});
