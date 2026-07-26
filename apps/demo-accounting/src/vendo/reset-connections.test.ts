import { describe, expect, it, vi } from "vitest"
import type { ConnectorAccount } from "@vendoai/actions"
import type { ConnectionsService } from "@vendoai/vendo/server"
import { sweepDemoConnections } from "./reset-connections"

const MAYA = "8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01"

function account(id: string, status: ConnectorAccount["status"]): ConnectorAccount {
  return { id, connector: "composio", toolkit: "gmail", status }
}

/** In-memory ConnectionsService: disconnect removes the row, so a post-sweep
 * list() proves the sweep emptied the account, not just that calls happened. */
function fakeConnections(rows: Map<string, ConnectorAccount[]>): ConnectionsService & {
  disconnect: ReturnType<typeof vi.fn>
} {
  const disconnect = vi.fn(async (principal, _connector, connectionId) => {
    const remaining = (rows.get(principal.subject) ?? []).filter(row => row.id !== connectionId)
    rows.set(principal.subject, remaining)
  })
  return {
    posture: "byo",
    list: async principal => rows.get(principal.subject) ?? [],
    initiate: async () => { throw new Error("unused") },
    status: async () => null,
    disconnect,
    catalog: async () => [],
  }
}

describe("sweepDemoConnections", () => {
  it("disconnects every row (active and expired) and leaves list() empty", async () => {
    const rows = new Map([[MAYA, [account("c1", "active"), account("c2", "expired")]]])
    const connections = fakeConnections(rows)

    await sweepDemoConnections(connections, [{ subject: MAYA }])

    expect(connections.disconnect).toHaveBeenCalledTimes(2)
    expect(connections.disconnect).toHaveBeenCalledWith({ kind: "user", subject: MAYA }, "composio", "c1")
    expect(connections.disconnect).toHaveBeenCalledWith({ kind: "user", subject: MAYA }, "composio", "c2")
    await expect(connections.list({ kind: "user", subject: MAYA })).resolves.toEqual([])
  })

  it("posture false: completes without error and never calls the service", async () => {
    const list = vi.fn()
    const disconnect = vi.fn()
    const connections = {
      posture: false,
      list,
      initiate: async () => { throw new Error("unused") },
      status: async () => null,
      disconnect,
      catalog: async () => [],
    } as unknown as ConnectionsService

    await expect(sweepDemoConnections(connections, [{ subject: MAYA }])).resolves.toBeUndefined()
    expect(list).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it("tolerates per-row disconnect failures and keeps sweeping", async () => {
    const rows = new Map([[MAYA, [account("c1", "active"), account("c2", "expired")]]])
    const connections = fakeConnections(rows)
    connections.disconnect.mockRejectedValueOnce(new Error("broker 502"))

    await expect(sweepDemoConnections(connections, [{ subject: MAYA }])).resolves.toBeUndefined()
    expect(connections.disconnect).toHaveBeenCalledTimes(2)
  })
})
