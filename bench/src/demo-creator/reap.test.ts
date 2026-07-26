import { describe, expect, it, vi } from "vitest";
import { buildReapPlan, parseDemoReapArgs, runDemoReap, selectReapable, type RegistryRow } from "./reap.js";

function row(overrides: Partial<RegistryRow> & { id: string }): RegistryRow {
  return {
    url: `https://demo-${overrides.id}.up.railway.app`,
    prospect: overrides.id,
    expiresAt: "2099-01-01T00:00:00Z",
    killed: false,
    createdAt: "2026-07-01T00:00:00Z",
    hits: 0,
    ...overrides,
  };
}

describe("parseDemoReapArgs", () => {
  it("defaults to a dry run against the production router", () => {
    expect(parseDemoReapArgs([])).toEqual({
      routerUrl: "https://demos.vendo.run",
      project: "vendo-demos",
      execute: false,
    });
  });

  it("parses overrides and the execute flag (with the pnpm separator)", () => {
    expect(parseDemoReapArgs(["--", "--router-url", "https://router.example", "--project", "p2", "--execute"]))
      .toEqual({ routerUrl: "https://router.example", project: "p2", execute: true });
  });

  it("rejects unknown options", () => {
    expect(() => parseDemoReapArgs(["--nope"])).toThrow("Unknown option: --nope");
  });

  it("requires an https router URL (localhost excepted) and normalizes trailing slashes", () => {
    expect(() => parseDemoReapArgs(["--router-url", "http://router.example"])).toThrow(/--router-url must be https/);
    expect(parseDemoReapArgs(["--router-url", "http://localhost:8080"]).routerUrl).toBe("http://localhost:8080");
    expect(parseDemoReapArgs(["--router-url", "https://router.example/"]).routerUrl).toBe("https://router.example");
  });
});

describe("selectReapable", () => {
  const now = new Date("2026-07-16T00:00:00Z");

  it("selects expired and killed rows, keeps live ones", () => {
    const rows = [
      row({ id: "live" }),
      row({ id: "old", expiresAt: "2026-07-01T00:00:00Z" }),
      row({ id: "dead", killed: true }),
    ];
    expect(selectReapable(rows, now)).toEqual([
      { row: rows[1], reason: "expired" },
      { row: rows[2], reason: "killed" },
    ]);
  });

  it("kill wins as the reported reason when a row is both killed and expired", () => {
    const selected = selectReapable([row({ id: "both", killed: true, expiresAt: "2020-01-01T00:00:00Z" })], now);
    expect(selected).toEqual([expect.objectContaining({ reason: "killed" })]);
  });

  it("treats the exact expiry instant as expired (matches the router)", () => {
    expect(selectReapable([row({ id: "edge", expiresAt: "2026-07-16T00:00:00Z" })], now))
      .toEqual([expect.objectContaining({ reason: "expired" })]);
  });

  it("treats an unparseable expiresAt as reapable (fail closed, like the router)", () => {
    expect(selectReapable([row({ id: "bad", expiresAt: "not-a-date" })], now))
      .toEqual([expect.objectContaining({ reason: "invalid-expiry" })]);
  });

  it("selects nothing from an empty or all-live registry", () => {
    expect(selectReapable([], now)).toEqual([]);
    expect(selectReapable([row({ id: "live" })], now)).toEqual([]);
  });
});

describe("buildReapPlan", () => {
  it("plans a railway down (deployment removal) plus the registry DELETE", () => {
    const plan = buildReapPlan(row({ id: "old" }), "https://demos.vendo.run");
    expect(plan.railwayDown).toEqual(["railway", "down", "--service", "demo-old", "--yes"]);
    expect(plan.registryDelete).toBe("https://demos.vendo.run/admin/demos/old");
  });
});

describe("runDemoReap", () => {
  const env = { ROUTER_ADMIN_TOKEN: "token" };
  const listResponse = (rows: RegistryRow[]) =>
    new Response(JSON.stringify({ demos: rows }), { status: 200, headers: { "Content-Type": "application/json" } });

  it("requires ROUTER_ADMIN_TOKEN", async () => {
    await expect(runDemoReap(parseDemoReapArgs([]), { env: {}, write: () => {} }))
      .rejects.toThrow(/ROUTER_ADMIN_TOKEN/);
  });

  it("dry run (the default) reads the registry, prints the plan, and touches nothing", async () => {
    const rows = [row({ id: "live" }), row({ id: "dead", killed: true })];
    const fetchImpl = vi.fn().mockResolvedValue(listResponse(rows));
    const exec = vi.fn();
    const lines: string[] = [];
    const result = await runDemoReap(parseDemoReapArgs([]), {
      env,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (line) => lines.push(line),
      now: () => new Date("2026-07-16T00:00:00Z"),
    });
    expect(result.executed).toBe(false);
    expect(result.candidates.map((candidate) => candidate.row.id)).toEqual(["dead"]);
    expect(exec).not.toHaveBeenCalled();
    // Only the read happened.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://demos.vendo.run/admin/demos");
    expect(lines.join("\n")).toContain("railway down --service demo-dead --yes");
  });

  it("--execute removes each candidate's deployment and registry row", async () => {
    const rows = [row({ id: "old", expiresAt: "2020-01-01T00:00:00Z" }), row({ id: "live" })];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse(rows))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const result = await runDemoReap(parseDemoReapArgs(["--execute"]), {
      env,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => {},
      now: () => new Date("2026-07-16T00:00:00Z"),
    });
    expect(result.executed).toBe(true);
    expect(exec.mock.calls.map(([command]) => (command as string[]).join(" "))).toEqual([
      "railway link --project vendo-demos",
      "railway down --service demo-old --yes",
    ]);
    const deleteCall = fetchImpl.mock.calls[1];
    expect(deleteCall?.[0]).toBe("https://demos.vendo.run/admin/demos/old");
    expect(deleteCall?.[1]).toMatchObject({ method: "DELETE" });
    expect((deleteCall?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer token" });
  });

  it("treats a no-deployment-to-remove failure as already-gone and still deletes the row", async () => {
    const rows = [row({ id: "old", expiresAt: "2020-01-01T00:00:00Z" })];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse(rows))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const exec = vi.fn().mockImplementation(async (command: string[]) =>
      command[1] === "down" ? { code: 1, stdout: "", stderr: "No deployments found" } : { code: 0, stdout: "", stderr: "" });
    const result = await runDemoReap(parseDemoReapArgs(["--execute"]), {
      env,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => {},
      now: () => new Date("2026-07-16T00:00:00Z"),
    });
    expect(result.failed).toEqual([]);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://demos.vendo.run/admin/demos/old");
  });

  it("KEEPS the registry row when railway down fails transiently (no orphaned live service)", async () => {
    const rows = [
      row({ id: "flaky", expiresAt: "2020-01-01T00:00:00Z" }),
      row({ id: "old", expiresAt: "2020-01-01T00:00:00Z" }),
    ];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(listResponse(rows))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const exec = vi.fn().mockImplementation(async (command: string[]) =>
      command.join(" ") === "railway down --service demo-flaky --yes"
        ? { code: 1, stdout: "", stderr: "502 Bad Gateway" }
        : { code: 0, stdout: "", stderr: "" });
    const lines: string[] = [];
    const result = await runDemoReap(parseDemoReapArgs(["--execute"]), {
      env,
      exec,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (line) => lines.push(line),
      now: () => new Date("2026-07-16T00:00:00Z"),
    });
    expect(result.failed).toEqual(["flaky"]);
    // flaky's row was NOT deleted (a future reap must still see it); old's was.
    const deletedUrls = fetchImpl.mock.calls.slice(1).map(([url]) => url);
    expect(deletedUrls).toEqual(["https://demos.vendo.run/admin/demos/old"]);
    expect(lines.join("\n")).toMatch(/railway down failed .*keeping its registry row/i);
  });

  it("fails loudly when the registry read is unauthorized", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(runDemoReap(parseDemoReapArgs([]), {
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => {},
    })).rejects.toThrow(/401/);
  });
});
