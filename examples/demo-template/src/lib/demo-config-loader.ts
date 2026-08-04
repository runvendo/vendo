import { readFileSync } from "node:fs"
import path from "node:path"
import { safeErrorMessage } from "@vendoai/core"
import { parseDemoConfig, type DemoConfig } from "./demo-config"

/**
 * Reads and validates a demo.config.json file. Defaults to the app root
 * (process.cwd()/demo.config.json). This module imports `node:fs`/`node:path`
 * and is server/bench-only — safe from route handlers and the bench capture
 * harness, but never from a client component (unlike `./demo-config`, which
 * stays fs-free for exactly that reason).
 */
export function loadDemoConfig(
  configPath: string = path.join(process.cwd(), "demo.config.json"),
): DemoConfig {
  let raw: string
  try {
    raw = readFileSync(configPath, "utf8")
  } catch (error) {
    throw new Error(`could not read demo config at "${configPath}": ${safeErrorMessage(error)}`)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(`demo config at "${configPath}" is not valid JSON: ${safeErrorMessage(error)}`)
  }

  return parseDemoConfig(json, `demo config at "${configPath}"`)
}
