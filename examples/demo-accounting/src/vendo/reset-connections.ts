/**
 * Demo-reset connection sweep (demo-hygiene): connected accounts live on the
 * broker, so they survive the store reseed AND redeploys — reset is the
 * designed cleanup point. Per-row failures are logged and skipped: a flaky
 * broker must never wedge the demo reset. Mirrors demo-bank's sweep.
 */
import type { Principal } from "@vendoai/core"
import type { ConnectionsService } from "@vendoai/vendo/server"

export async function sweepDemoConnections(
  connections: ConnectionsService,
  users: ReadonlyArray<{ subject: string }>,
): Promise<void> {
  if (connections.posture === false) return
  for (const user of users) {
    const principal: Principal = { kind: "user", subject: user.subject }
    let accounts
    try {
      accounts = await connections.list(principal)
    } catch (error) {
      console.warn(`demo reset: listing connections for ${user.subject} failed`, error)
      continue
    }
    for (const account of accounts) {
      try {
        await connections.disconnect(principal, account.connector, account.id)
      } catch (error) {
        console.warn(
          `demo reset: disconnecting ${account.connector}/${account.id} for ${user.subject} failed`,
          error,
        )
      }
    }
  }
}
