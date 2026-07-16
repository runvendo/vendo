import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { demoConfigSchema, isExpired, parseDemoConfig, type DemoConfig } from "./demo-config"
import { loadDemoConfig } from "./demo-config-loader"

const SAMPLE_CONFIG_PATH = fileURLToPath(new URL("../../demo.config.json", import.meta.url))

const validConfig = (): DemoConfig => ({
  id: "acme-widgets",
  prospect: "Acme Widgets",
  ctaUrl: "https://cal.com/yousefhelal",
  beats: [
    { key: "generate-ui", prompt: "Show me a dashboard of my data", chip: "Dashboard of my data" },
    { key: "take-action", prompt: "Take an action with approval", chip: "Take an action" },
    { key: "save-app", prompt: "Save this as a reusable app", chip: "Save this as an app" },
  ],
  caps: { maxTurns: 20, maxSpendUsd: 5 },
  expiresAt: "2099-01-01T00:00:00Z",
})

describe("demoConfigSchema / parseDemoConfig", () => {
  it("parses a valid config", () => {
    expect(parseDemoConfig(validConfig())).toEqual(validConfig())
  })

  it("rejects a config missing a required field", () => {
    const rest: Record<string, unknown> = { ...validConfig() }
    delete rest.prospect
    expect(() => parseDemoConfig(rest)).toThrow(/prospect/i)
  })

  it("rejects unknown/extra top-level fields", () => {
    const withExtra = { ...validConfig(), theme: "dark" }
    expect(() => parseDemoConfig(withExtra)).toThrow()
  })

  it("rejects an empty beats array", () => {
    const config = { ...validConfig(), beats: [] }
    expect(() => parseDemoConfig(config)).toThrow(/beats/i)
  })

  it("rejects a malformed expiresAt", () => {
    const config = { ...validConfig(), expiresAt: "not-a-date" }
    expect(() => parseDemoConfig(config)).toThrow(/expiresAt/i)
  })

  it("rejects a non-UTC offset expiresAt (UTC-only, locked behavior)", () => {
    const config = { ...validConfig(), expiresAt: "2030-01-01T00:00:00+02:00" }
    expect(() => parseDemoConfig(config)).toThrow(/expiresAt/i)
  })

  it("rejects a non-positive maxTurns", () => {
    const config = { ...validConfig(), caps: { maxTurns: 0, maxSpendUsd: 5 } }
    expect(() => parseDemoConfig(config)).toThrow(/maxTurns/i)
  })

  it("rejects a non-positive maxSpendUsd", () => {
    const config = { ...validConfig(), caps: { maxTurns: 20, maxSpendUsd: -1 } }
    expect(() => parseDemoConfig(config)).toThrow(/maxSpendUsd/i)
  })

  it("rejects a bad id slug", () => {
    const config = { ...validConfig(), id: "Acme_Widgets!" }
    expect(() => parseDemoConfig(config)).toThrow(/id/i)
  })

  it("rejects a bad beat key slug", () => {
    const config = validConfig()
    config.beats = [{ ...config.beats[0], key: "Not A Slug" }, ...config.beats.slice(1)]
    expect(() => parseDemoConfig(config)).toThrow()
  })

  it("accepts the optional per-beat capture expectations", () => {
    const config = validConfig()
    config.beats = [
      { ...config.beats[0], expectsView: true },
      { ...config.beats[1], expectsApproval: true },
      ...config.beats.slice(2),
    ]
    expect(parseDemoConfig(config)).toEqual(config)
  })

  it("rejects a non-boolean capture expectation", () => {
    const config = validConfig()
    config.beats = [{ ...config.beats[0], expectsView: "yes" } as never, ...config.beats.slice(1)]
    expect(() => parseDemoConfig(config)).toThrow(/expectsView/i)
  })

  it("rejects unknown fields on a beat", () => {
    const config = validConfig()
    config.beats = [{ ...config.beats[0], extra: true } as never, ...config.beats.slice(1)]
    expect(() => parseDemoConfig(config)).toThrow()
  })

  it("rejects unknown fields on caps", () => {
    const config = { ...validConfig(), caps: { ...validConfig().caps, extra: true } }
    expect(() => parseDemoConfig(config)).toThrow()
  })
})

// Structural invariants over the checked-in demo.config.json. These must hold
// for ANY demo cloned from this template — do NOT delete or weaken them when
// rewriting the app for a prospect. They load the real file, so they verify
// whatever config the clone ships.
describe("demo.config.json structural invariants (keep for every demo)", () => {
  const config = () => loadDemoConfig(SAMPLE_CONFIG_PATH)

  it("parses and round-trips through the schema", () => {
    expect(demoConfigSchema.parse(config())).toEqual(config())
  })

  it("has at least the fixed 3-beat arc", () => {
    expect(config().beats.length).toBeGreaterThanOrEqual(3)
  })

  it("has positive caps (maxTurns integer, maxSpendUsd number)", () => {
    const { caps } = config()
    expect(Number.isInteger(caps.maxTurns)).toBe(true)
    expect(caps.maxTurns).toBeGreaterThan(0)
    expect(caps.maxSpendUsd).toBeGreaterThan(0)
  })

  it("is not already expired", () => {
    expect(isExpired(config(), new Date())).toBe(false)
  })

  it("has a non-empty prompt and chip on every beat", () => {
    for (const beat of config().beats) {
      expect(beat.prompt.trim().length).toBeGreaterThan(0)
      expect(beat.chip.trim().length).toBeGreaterThan(0)
    }
  })

  it("has no TODO(creator) leftovers in prompts or chips", () => {
    for (const beat of config().beats) {
      expect(beat.prompt).not.toContain("TODO(creator)")
      expect(beat.chip).not.toContain("TODO(creator)")
    }
  })
})

// DELETE OR REWRITE when creating a demo from this template — these pin the
// template's sample content only (ids, prospect name, sample prompts). A
// rewritten demo.config.json is SUPPOSED to fail them; the structural
// invariants above are the ones every demo must keep passing.
describe("template-sample content (DELETE OR REWRITE on clone)", () => {
  it("pins the sample id, prospect, and beat arc", () => {
    const config = loadDemoConfig(SAMPLE_CONFIG_PATH)
    expect(config.id).toBe("template-sample")
    expect(config.prospect).toBe("Template Sample")
    expect(config.beats).toHaveLength(3)
    expect(config.beats.map((b) => b.key)).toEqual(["generate-ui", "take-action", "save-app"])
    expect(config.beats[1].prompt).toBe("Archive the item named Bravo")
  })
})

describe("loadDemoConfig", () => {
  let tmpDir: string | undefined

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
    tmpDir = undefined
  })

  it("throws a clear error when the file does not exist", () => {
    expect(() => loadDemoConfig("/nonexistent/demo.config.json")).toThrow(/could not read demo config/)
  })

  it("throws a clear error when the file is not valid JSON", () => {
    const jsonPath = fileURLToPath(new URL("./demo-config.test.ts", import.meta.url))
    expect(() => loadDemoConfig(jsonPath)).toThrow(/not valid JSON/)
  })

  it("throws a single, non-double-wrapped message for a schema-invalid config file", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "demo-config-test-"))
    const configPath = path.join(tmpDir, "demo.config.json")
    const invalid: Record<string, unknown> = { ...validConfig() }
    delete invalid.prospect
    await writeFile(configPath, JSON.stringify(invalid), "utf8")

    let message: string | undefined
    try {
      loadDemoConfig(configPath)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/prospect/i)
    // Exactly one "invalid ... :" prefix — not double-wrapped.
    expect(message?.match(/invalid demo config/gi)).toHaveLength(1)
  })
})

describe("isExpired", () => {
  it("is false before the expiry instant", () => {
    const config = { ...validConfig(), expiresAt: "2030-01-01T00:00:00Z" }
    expect(isExpired(config, new Date("2029-12-31T23:59:59Z"))).toBe(false)
  })

  it("is true at or after the expiry instant", () => {
    const config = { ...validConfig(), expiresAt: "2030-01-01T00:00:00Z" }
    expect(isExpired(config, new Date("2030-01-01T00:00:00Z"))).toBe(true)
    expect(isExpired(config, new Date("2030-01-01T00:00:01Z"))).toBe(true)
  })
})
