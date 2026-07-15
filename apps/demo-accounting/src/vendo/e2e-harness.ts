/** Shared boot harness for the ENG-260 e2e suites: spawns the real Cadence
 * app through `next dev` on a free port with an isolated dist dir, and wraps
 * fetch with the retry the dev server needs while compiling routes. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const appDir = fileURLToPath(new URL("../..", import.meta.url))
export const BOOT_MS = 240_000

export interface CadenceApp {
  baseUrl: string
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a port")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

/** Next's dev server can reset an in-flight socket while compiling a route. */
export async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await fetch(input, init)
    } catch (error) {
      lastError = error
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    }
  }
  throw lastError
}

/** Boot the real Cadence app. `distDir` keeps each suite's dev-server lock
 * away from a concurrent `pnpm dev`; `env` overlays process.env (vitest's
 * NODE_ENV="test" is always dropped so it cannot leak into next dev). */
export async function bootCadence(
  distDir: string,
  env: Record<string, string> = {},
): Promise<CadenceApp> {
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let serverOutput = ""
  const childEnv = {
    ...process.env,
    VENDO_BASE_URL: baseUrl,
    NEXT_TELEMETRY_DISABLED: "1",
    CADENCE_DIST_DIR: distDir,
    ...env,
  }
  delete (childEnv as Record<string, string | undefined>).NODE_ENV
  const child: ChildProcessWithoutNullStreams = spawn(
    join(appDir, "node_modules", ".bin", "next"),
    ["dev", "-p", String(port)],
    { cwd: appDir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
  )
  child.stdout.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000)
  })
  child.stderr.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000)
  })

  const deadline = Date.now() + BOOT_MS
  for (;;) {
    if (child.exitCode != null) throw new Error(`Cadence exited early (${child.exitCode})\n${serverOutput}`)
    try {
      const response = await fetch(`${baseUrl}/login`)
      if (response.ok) break
    } catch {
      // still compiling
    }
    if (Date.now() > deadline) throw new Error(`Cadence did not become ready\n${serverOutput}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return {
    baseUrl,
    async stop() {
      if (child.exitCode !== null) return
      child.kill("SIGTERM")
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
      if (child.exitCode === null) child.kill("SIGKILL")
    },
  }
}
