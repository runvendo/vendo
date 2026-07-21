import { describe, expect, it, vi } from "vitest";
import { runOrgs, runUsage } from "./read.js";

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

  it("returns a clear error when a project cannot be inferred", async () => {
    const messages = output();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ orgs: [{ id: "org_only" }] })
      .mockResolvedValueOnce({ projects: [{ id: "one" }, { id: "two" }] });
    expect(await runUsage([], { output: messages.sink, fetcher })).toBe(1);
    expect(messages.errors.join("\n")).toContain("--project <id>");
  });
});
