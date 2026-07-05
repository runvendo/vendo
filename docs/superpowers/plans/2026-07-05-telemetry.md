# Flowlet Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship anonymous, opt-out, build/dev-side-only telemetry for Flowlet: a shared `@flowlet/telemetry` client, CLI instrumentation, dev-time feature events, Scarf download attribution, and full disclosure.

**Architecture:** A new zero-dependency `@flowlet/telemetry` package owns a closed event allowlist, a consent resolver, an anonymous-id/config store at `~/.flowlet/telemetry.json`, and a fire-and-forget PostHog (EU) client. The CLI and the `@flowlet/server` dev path call it. Product events never fire in production, never in CI, and never when any opt-out signal is present.

**Tech Stack:** TypeScript (ESM, `tsc` build, `strict`), Vitest, Node built-ins only (`node:crypto`, `node:fs`, `node:os`, global `fetch`), PostHog capture API, Scarf.

**Reference spec:** `docs/superpowers/specs/2026-07-05-telemetry-design.md`

---

## Conventions (read before starting)

- Every package mirrors `packages/flowlet-core`: `package.json` with `"type": "module"`, `tsconfig.json` extending `../../tsconfig.base.json`, tests colocated as `*.test.ts`, run with `vitest run`.
- Root commands: `pnpm --filter @flowlet/telemetry test`, `pnpm --filter @flowlet/telemetry typecheck`, `pnpm --filter @flowlet/cli test`.
- After adding a new workspace package, run `pnpm install` once from the repo root so the workspace link resolves.
- **No content collection, ever.** No file paths, code, prompts, generated UI, tool I/O, keys, host names, env values. If a step would collect any of those, stop and flag it.
- Commit after every task with a `feat:`/`test:`/`docs:` message. Do not merge. Do not push unless asked.

---

## File Structure

Create `packages/flowlet-telemetry/`:

- `src/config.ts` — read/write `~/.flowlet/telemetry.json` (`{ anonymousId, optedOut, noticeShown }`); create dir + file on first read.
- `src/consent.ts` — `resolveConsent(inputs)` pure function returning `{ allowed: boolean; reason: string }`.
- `src/events.ts` — the closed allowlist: event names, allowed property keys, and the `TelemetryEvent` union type.
- `src/base-props.ts` — gather base properties (version, os platform, node version).
- `src/client.ts` — `createTelemetry(deps)` returning `{ track, flush }`; fire-and-forget POST to PostHog with a short timeout, all failures swallowed.
- `src/notice.ts` — `maybeShowNotice(config, io)` prints the first-run notice once.
- `src/index.ts` — public exports.
- `package.json`, `tsconfig.json`.

Modify:

- `packages/flowlet-cli/src/cli.ts` — add `telemetry` subcommand.
- `packages/flowlet-cli/src/telemetry-cmd.ts` (create) — `status | enable | disable`.
- `packages/flowlet-cli/src/init.ts` — emit `init_started`, `init_completed`, `init_failed`.
- `packages/flowlet-cli/package.json` — add `@flowlet/telemetry` dep + Scarf.
- `packages/flowlet-server/src/telemetry-dev.ts` (create) — dev-only feature-event helper.
- `packages/flowlet-server/` handler path — emit `agent_run` and `error_class` behind the non-prod gate.
- `packages/flowlet-next/package.json` — add Scarf.
- `TELEMETRY.md` (create, repo root), `README.md` (link it).

---

## Task 1: Scaffold the `@flowlet/telemetry` package

**Files:**
- Create: `packages/flowlet-telemetry/package.json`
- Create: `packages/flowlet-telemetry/tsconfig.json`
- Create: `packages/flowlet-telemetry/src/index.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@flowlet/telemetry",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write a placeholder `src/index.ts`**

```ts
export {};
```

- [ ] **Step 4: Install the workspace link**

Run: `pnpm install`
Expected: completes; `@flowlet/telemetry` appears in the workspace.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry
git commit -m "feat(telemetry): scaffold @flowlet/telemetry package"
```

---

## Task 2: The closed event allowlist (`events.ts`)

The allowlist is the single source of truth for what may be sent. `TELEMETRY.md` mirrors it. A later test asserts no event carries a key outside its allowlist.

**Files:**
- Create: `packages/flowlet-telemetry/src/events.ts`
- Test: `packages/flowlet-telemetry/src/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { EVENT_ALLOWLIST, isAllowedProps, type EventName } from "./events.js";

describe("event allowlist", () => {
  it("lists every event with an explicit allowed-key set", () => {
    const names: EventName[] = [
      "init_started",
      "init_completed",
      "init_failed",
      "agent_run",
      "error_class",
    ];
    for (const name of names) {
      expect(EVENT_ALLOWLIST[name]).toBeInstanceOf(Set);
    }
  });

  it("rejects a property key not in the event's allowlist", () => {
    expect(isAllowedProps("init_started", { flowletVersion: "0.0.0" })).toBe(true);
    expect(isAllowedProps("init_started", { sourceCode: "secret" })).toBe(false);
  });

  it("never allows a content-shaped key on any event", () => {
    const banned = ["sourceCode", "prompt", "filePath", "apiKey", "hostAppName", "body"];
    for (const name of Object.keys(EVENT_ALLOWLIST) as EventName[]) {
      for (const key of banned) {
        expect(EVENT_ALLOWLIST[name].has(key)).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/telemetry test`
Expected: FAIL — cannot resolve `./events.js`.

- [ ] **Step 3: Write `events.ts`**

```ts
/**
 * The closed allowlist of telemetry events and their permitted property keys.
 * TELEMETRY.md mirrors this file. Nothing outside these sets is ever sent.
 * Base properties (see base-props.ts) are permitted on every event implicitly.
 */
export const BASE_PROP_KEYS = ["flowletVersion", "osPlatform", "nodeVersion"] as const;

export const EVENT_ALLOWLIST = {
  // CLI / build
  init_started: new Set([...BASE_PROP_KEYS, "framework"]),
  init_completed: new Set([
    ...BASE_PROP_KEYS,
    "framework",
    "provider",
    "llmSkipped",
    "componentCount",
    "toolCount",
    "durationMs",
  ]),
  init_failed: new Set([...BASE_PROP_KEYS, "framework", "failedStep"]),
  // dev-time feature usage
  agent_run: new Set([...BASE_PROP_KEYS]),
  error_class: new Set([...BASE_PROP_KEYS, "errorClass"]),
} as const;

export type EventName = keyof typeof EVENT_ALLOWLIST;

export function isAllowedProps(event: EventName, props: Record<string, unknown>): boolean {
  const allowed = EVENT_ALLOWLIST[event];
  return Object.keys(props).every((k) => allowed.has(k));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/telemetry test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry/src/events.ts packages/flowlet-telemetry/src/events.test.ts
git commit -m "feat(telemetry): closed event allowlist"
```

---

## Task 3: Consent resolver (`consent.ts`)

**Files:**
- Create: `packages/flowlet-telemetry/src/consent.ts`
- Test: `packages/flowlet-telemetry/src/consent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveConsent } from "./consent.js";

const base = { env: {} as Record<string, string | undefined>, optedOut: false, runtime: false };

describe("resolveConsent", () => {
  it("allows by default on the build side", () => {
    expect(resolveConsent(base).allowed).toBe(true);
  });

  it("disables when FLOWLET_TELEMETRY_DISABLED=1", () => {
    expect(resolveConsent({ ...base, env: { FLOWLET_TELEMETRY_DISABLED: "1" } }).allowed).toBe(false);
  });

  it("disables when DO_NOT_TRACK=1", () => {
    expect(resolveConsent({ ...base, env: { DO_NOT_TRACK: "1" } }).allowed).toBe(false);
  });

  it("disables in CI", () => {
    expect(resolveConsent({ ...base, env: { CI: "true" } }).allowed).toBe(false);
  });

  it("disables when the config records opt-out", () => {
    expect(resolveConsent({ ...base, optedOut: true }).allowed).toBe(false);
  });

  it("disables runtime callers in production", () => {
    expect(resolveConsent({ ...base, runtime: true, env: { NODE_ENV: "production" } }).allowed).toBe(false);
  });

  it("allows runtime callers in development", () => {
    expect(resolveConsent({ ...base, runtime: true, env: { NODE_ENV: "development" } }).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/telemetry test consent`
Expected: FAIL — cannot resolve `./consent.js`.

- [ ] **Step 3: Write `consent.ts`**

```ts
export interface ConsentInputs {
  env: Record<string, string | undefined>;
  /** true if the config file records an explicit opt-out */
  optedOut: boolean;
  /** true for callers inside the running app (dev server); false for the CLI */
  runtime: boolean;
}

export interface ConsentResult {
  allowed: boolean;
  reason: string;
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

export function resolveConsent({ env, optedOut, runtime }: ConsentInputs): ConsentResult {
  if (truthy(env.FLOWLET_TELEMETRY_DISABLED)) return { allowed: false, reason: "env-disabled" };
  if (truthy(env.DO_NOT_TRACK)) return { allowed: false, reason: "do-not-track" };
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false")
    return { allowed: false, reason: "ci" };
  if (optedOut) return { allowed: false, reason: "config-opt-out" };
  if (runtime && env.NODE_ENV === "production") return { allowed: false, reason: "production" };
  return { allowed: true, reason: "allowed" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/telemetry test consent`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry/src/consent.ts packages/flowlet-telemetry/src/consent.test.ts
git commit -m "feat(telemetry): consent resolver with opt-out + prod gate"
```

---

## Task 4: Config store + anonymous id (`config.ts`)

**Files:**
- Create: `packages/flowlet-telemetry/src/config.ts`
- Test: `packages/flowlet-telemetry/src/config.test.ts`

- [ ] **Step 1: Write the failing test** (uses a temp HOME so no real file is touched)

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, configPath } from "./config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flowlet-tele-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("config store", () => {
  it("creates a random anonymous id on first load", () => {
    const c = loadConfig(home);
    expect(c.anonymousId).toMatch(/[0-9a-f-]{36}/);
    expect(c.optedOut).toBe(false);
    expect(c.noticeShown).toBe(false);
    expect(existsSync(configPath(home))).toBe(true);
  });

  it("returns the same id on subsequent loads", () => {
    const a = loadConfig(home);
    const b = loadConfig(home);
    expect(b.anonymousId).toBe(a.anonymousId);
  });

  it("persists updates", () => {
    const c = loadConfig(home);
    saveConfig(home, { ...c, optedOut: true, noticeShown: true });
    const reread = loadConfig(home);
    expect(reread.optedOut).toBe(true);
    expect(reread.noticeShown).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/telemetry test config`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 3: Write `config.ts`**

```ts
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface TelemetryConfig {
  anonymousId: string;
  optedOut: boolean;
  noticeShown: boolean;
}

export function configDir(home = homedir()): string {
  return join(home, ".flowlet");
}

export function configPath(home = homedir()): string {
  return join(configDir(home), "telemetry.json");
}

export function loadConfig(home = homedir()): TelemetryConfig {
  const path = configPath(home);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryConfig>;
      if (typeof raw.anonymousId === "string" && raw.anonymousId.length > 0) {
        return {
          anonymousId: raw.anonymousId,
          optedOut: raw.optedOut === true,
          noticeShown: raw.noticeShown === true,
        };
      }
    } catch {
      // fall through to regenerate on unreadable/corrupt file
    }
  }
  const fresh: TelemetryConfig = { anonymousId: randomUUID(), optedOut: false, noticeShown: false };
  saveConfig(home, fresh);
  return fresh;
}

export function saveConfig(home: string, config: TelemetryConfig): void {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n", "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/telemetry test config`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry/src/config.ts packages/flowlet-telemetry/src/config.test.ts
git commit -m "feat(telemetry): config store with random anonymous id"
```

---

## Task 5: Base properties (`base-props.ts`)

**Files:**
- Create: `packages/flowlet-telemetry/src/base-props.ts`
- Test: `packages/flowlet-telemetry/src/base-props.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { baseProps } from "./base-props.js";

describe("baseProps", () => {
  it("returns only allowlisted base keys with primitive values", () => {
    const p = baseProps("1.2.3");
    expect(p.flowletVersion).toBe("1.2.3");
    expect(typeof p.osPlatform).toBe("string");
    expect(typeof p.nodeVersion).toBe("string");
    expect(Object.keys(p).sort()).toEqual(["flowletVersion", "nodeVersion", "osPlatform"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/telemetry test base-props`
Expected: FAIL — cannot resolve `./base-props.js`.

- [ ] **Step 3: Write `base-props.ts`**

```ts
import { platform } from "node:os";

export interface BaseProps {
  flowletVersion: string;
  osPlatform: string;
  nodeVersion: string;
}

export function baseProps(version: string): BaseProps {
  return {
    flowletVersion: version,
    osPlatform: platform(),
    nodeVersion: process.version,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/telemetry test base-props`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry/src/base-props.ts packages/flowlet-telemetry/src/base-props.test.ts
git commit -m "feat(telemetry): base properties"
```

---

## Task 6: The client (`client.ts`)

The client wires consent + allowlist + PostHog. `track` never throws, never blocks meaningfully, and drops disallowed keys defensively (allowlist test in Task 2 guarantees intent; this guarantees runtime).

**Files:**
- Create: `packages/flowlet-telemetry/src/client.ts`
- Test: `packages/flowlet-telemetry/src/client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createTelemetry } from "./client.js";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    version: "9.9.9",
    home: undefined as string | undefined, // client uses an injected config instead (below)
    config: { anonymousId: "id-1", optedOut: false, noticeShown: true },
    env: {} as Record<string, string | undefined>,
    runtime: false,
    posthogKey: "phc_test",
    fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe("createTelemetry.track", () => {
  it("posts an allowlisted event to PostHog", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = deps.fetchImpl.mock.calls[0];
    expect(String(url)).toContain("eu.i.posthog.com");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("init_started");
    expect(body.distinct_id).toBe("id-1");
    expect(body.properties.framework).toBe("next");
    expect(body.properties.flowletVersion).toBe("9.9.9");
  });

  it("does not post when consent is denied", async () => {
    const deps = makeDeps({ env: { DO_NOT_TRACK: "1" } });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not post when no PostHog key is configured", async () => {
    const deps = makeDeps({ posthogKey: undefined });
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next" });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("drops keys outside the event allowlist", async () => {
    const deps = makeDeps();
    const t = createTelemetry(deps);
    await t.track("init_started", { framework: "next", sourceCode: "secret" } as never);
    const body = JSON.parse((deps.fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body.properties.sourceCode).toBeUndefined();
    expect(body.properties.framework).toBe("next");
  });

  it("never throws when fetch rejects", async () => {
    const deps = makeDeps({ fetchImpl: vi.fn().mockRejectedValue(new Error("network")) });
    const t = createTelemetry(deps);
    await expect(t.track("agent_run", {})).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/telemetry test client`
Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 3: Write `client.ts`**

```ts
import { resolveConsent } from "./consent.js";
import { baseProps } from "./base-props.js";
import { EVENT_ALLOWLIST, type EventName } from "./events.js";
import type { TelemetryConfig } from "./config.js";

const POSTHOG_ENDPOINT = "https://eu.i.posthog.com/capture/";
const TIMEOUT_MS = 1500;

export interface TelemetryDeps {
  version: string;
  config: TelemetryConfig;
  env: Record<string, string | undefined>;
  runtime: boolean;
  posthogKey: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface Telemetry {
  track(event: EventName, props: Record<string, unknown>): Promise<void>;
}

function filterToAllowlist(event: EventName, props: Record<string, unknown>): Record<string, unknown> {
  const allowed = EVENT_ALLOWLIST[event];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) if (allowed.has(k)) out[k] = v;
  return out;
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    async track(event, props) {
      try {
        if (!deps.posthogKey) return;
        const consent = resolveConsent({
          env: deps.env,
          optedOut: deps.config.optedOut,
          runtime: deps.runtime,
        });
        if (!consent.allowed) return;

        const properties = { ...baseProps(deps.version), ...filterToAllowlist(event, props) };
        const body = JSON.stringify({
          api_key: deps.posthogKey,
          event,
          distinct_id: deps.config.anonymousId,
          properties,
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          await doFetch(POSTHOG_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Telemetry must never break a build or dev server. Intentional silent failure.
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/telemetry test client`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry/src/client.ts packages/flowlet-telemetry/src/client.test.ts
git commit -m "feat(telemetry): fire-and-forget PostHog client"
```

---

## Task 7: First-run notice (`notice.ts`)

**Files:**
- Create: `packages/flowlet-telemetry/src/notice.ts`
- Test: `packages/flowlet-telemetry/src/notice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { maybeShowNotice } from "./notice.js";

describe("maybeShowNotice", () => {
  it("prints once and marks the config", () => {
    const log = vi.fn();
    const save = vi.fn();
    const shown = maybeShowNotice(
      { anonymousId: "x", optedOut: false, noticeShown: false },
      { log, save },
    );
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("TELEMETRY.md");
    expect(save).toHaveBeenCalledOnce();
    expect(shown.noticeShown).toBe(true);
  });

  it("does nothing when already shown", () => {
    const log = vi.fn();
    const save = vi.fn();
    maybeShowNotice({ anonymousId: "x", optedOut: false, noticeShown: true }, { log, save });
    expect(log).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("does nothing when opted out", () => {
    const log = vi.fn();
    const save = vi.fn();
    maybeShowNotice({ anonymousId: "x", optedOut: true, noticeShown: false }, { log, save });
    expect(log).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/telemetry test notice`
Expected: FAIL — cannot resolve `./notice.js`.

- [ ] **Step 3: Write `notice.ts`**

```ts
import type { TelemetryConfig } from "./config.js";

const NOTICE = [
  "Flowlet collects anonymous, opt-out usage telemetry to guide development.",
  "No code, prompts, file contents, or keys are ever collected.",
  "Details and opt-out: TELEMETRY.md  ·  disable now: `flowlet telemetry disable`",
  "(also honored: FLOWLET_TELEMETRY_DISABLED=1, DO_NOT_TRACK=1, CI)",
].join("\n");

export interface NoticeIO {
  log: (msg: string) => void;
  save: (config: TelemetryConfig) => void;
}

export function maybeShowNotice(config: TelemetryConfig, io: NoticeIO): TelemetryConfig {
  if (config.optedOut || config.noticeShown) return config;
  io.log(NOTICE);
  const updated = { ...config, noticeShown: true };
  io.save(updated);
  return updated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/telemetry test notice`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry/src/notice.ts packages/flowlet-telemetry/src/notice.test.ts
git commit -m "feat(telemetry): first-run notice"
```

---

## Task 8: Public surface + a convenience factory (`index.ts`)

Bundles the pieces so callers do not re-wire consent/config/version each time.

**Files:**
- Modify: `packages/flowlet-telemetry/src/index.ts`
- Test: `packages/flowlet-telemetry/src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTelemetry } from "./index.js";

describe("initTelemetry", () => {
  it("wires config + notice + client and can track", async () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-tele-idx-"));
    try {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
      const log = vi.fn();
      const t = initTelemetry({
        version: "3.0.0",
        home,
        env: {},
        runtime: false,
        posthogKey: "phc_x",
        fetchImpl,
        log,
      });
      expect(log).toHaveBeenCalledOnce(); // first-run notice
      await t.track("init_started", { framework: "next" });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/telemetry test index`
Expected: FAIL — `initTelemetry` is not exported.

- [ ] **Step 3: Write `index.ts`**

```ts
export { resolveConsent } from "./consent.js";
export { loadConfig, saveConfig, configPath, type TelemetryConfig } from "./config.js";
export { EVENT_ALLOWLIST, isAllowedProps, type EventName } from "./events.js";
export { createTelemetry, type Telemetry } from "./client.js";
export { maybeShowNotice } from "./notice.js";

import { loadConfig, saveConfig } from "./config.js";
import { maybeShowNotice } from "./notice.js";
import { createTelemetry, type Telemetry } from "./client.js";

export interface InitTelemetryOptions {
  version: string;
  env?: Record<string, string | undefined>;
  runtime?: boolean;
  posthogKey?: string;
  home?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Load config, show the first-run notice once, and return a ready client.
 * The CLI passes runtime:false; the dev server passes runtime:true.
 */
export function initTelemetry(opts: InitTelemetryOptions): Telemetry {
  const env = opts.env ?? process.env;
  const home = opts.home;
  const config = loadConfig(home);
  const afterNotice = maybeShowNotice(config, {
    log: opts.log ?? ((m) => console.error(m)),
    save: (c) => saveConfig(home ?? require("node:os").homedir(), c),
  });
  return createTelemetry({
    version: opts.version,
    config: afterNotice,
    env,
    runtime: opts.runtime ?? false,
    posthogKey: opts.posthogKey ?? env.FLOWLET_POSTHOG_KEY,
    fetchImpl: opts.fetchImpl,
  });
}
```

Note: replace the inline `require("node:os").homedir()` with a top-level `import { homedir } from "node:os";` and call `homedir()` — the file is ESM. Wire the import at the top and use `saveConfig(home ?? homedir(), c)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowlet/telemetry test index && pnpm --filter @flowlet/telemetry typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-telemetry/src/index.ts packages/flowlet-telemetry/src/index.test.ts
git commit -m "feat(telemetry): initTelemetry convenience factory + public exports"
```

---

## Task 9: CLI `telemetry` subcommand

**Files:**
- Create: `packages/flowlet-cli/src/telemetry-cmd.ts`
- Modify: `packages/flowlet-cli/src/cli.ts`
- Modify: `packages/flowlet-cli/package.json`
- Test: `packages/flowlet-cli/src/telemetry-cmd.test.ts`

- [ ] **Step 1: Add the dependency**

In `packages/flowlet-cli/package.json` `dependencies`, add:

```json
"@flowlet/telemetry": "workspace:*",
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTelemetryCmd } from "./telemetry-cmd.js";
import { loadConfig } from "@flowlet/telemetry";

describe("runTelemetryCmd", () => {
  it("disable then status reports opted out", () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-cli-tele-"));
    try {
      const out: string[] = [];
      const log = (m: string) => out.push(m);
      expect(runTelemetryCmd("disable", { home, log })).toBe(0);
      expect(loadConfig(home).optedOut).toBe(true);
      runTelemetryCmd("status", { home, log });
      expect(out.join("\n")).toContain("disabled");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("enable clears opt-out", () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-cli-tele2-"));
    try {
      runTelemetryCmd("disable", { home, log: () => {} });
      expect(runTelemetryCmd("enable", { home, log: () => {} })).toBe(0);
      expect(loadConfig(home).optedOut).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("unknown subcommand returns non-zero", () => {
    expect(runTelemetryCmd("bogus", { home: undefined, log: () => {} })).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flowlet/cli test telemetry-cmd`
Expected: FAIL — cannot resolve `./telemetry-cmd.js`.

- [ ] **Step 4: Write `telemetry-cmd.ts`**

```ts
import { loadConfig, saveConfig, configPath } from "@flowlet/telemetry";
import { homedir } from "node:os";

export interface TelemetryCmdIO {
  home?: string;
  log: (msg: string) => void;
}

export function runTelemetryCmd(sub: string | undefined, io: TelemetryCmdIO): number {
  const home = io.home ?? homedir();
  const config = loadConfig(home);
  switch (sub) {
    case "status":
      io.log(
        `Flowlet telemetry: ${config.optedOut ? "disabled" : "enabled"}\n` +
          `anonymous id: ${config.anonymousId}\n` +
          `config: ${configPath(home)}\n` +
          `details: TELEMETRY.md`,
      );
      return 0;
    case "disable":
      saveConfig(home, { ...config, optedOut: true });
      io.log("Flowlet telemetry disabled.");
      return 0;
    case "enable":
      saveConfig(home, { ...config, optedOut: false });
      io.log("Flowlet telemetry enabled. Thank you — it is anonymous (see TELEMETRY.md).");
      return 0;
    default:
      io.log("Usage: flowlet telemetry <status|enable|disable>");
      return 1;
  }
}
```

- [ ] **Step 5: Wire into `cli.ts`**

Add the import at the top:

```ts
import { runTelemetryCmd } from "./telemetry-cmd.js";
```

Add a case inside the `switch (cmd)` (before `default`):

```ts
    case "telemetry":
      return runTelemetryCmd(rest.find((a) => !a.startsWith("--")), { log: (m) => console.log(m) });
```

Add a line to the `HELP` string under the usage block:

```
  flowlet telemetry <status|enable|disable>   View or change anonymous usage telemetry (see TELEMETRY.md)
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @flowlet/cli test telemetry-cmd && pnpm --filter @flowlet/cli typecheck`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add packages/flowlet-cli/src/telemetry-cmd.ts packages/flowlet-cli/src/telemetry-cmd.test.ts packages/flowlet-cli/src/cli.ts packages/flowlet-cli/package.json
git commit -m "feat(cli): flowlet telemetry status|enable|disable"
```

---

## Task 10: Instrument `flowlet init`

Emit `init_started` at the top and `init_completed`/`init_failed` at the end. Telemetry must never change `runInit`'s exit code or throw.

**Files:**
- Modify: `packages/flowlet-cli/src/init.ts`
- Test: `packages/flowlet-cli/src/init.telemetry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "./init.js";

describe("init telemetry", () => {
  it("emits init_started and init_completed with counts", async () => {
    const home = mkdtempSync(join(tmpdir(), "flowlet-init-tele-"));
    const target = mkdtempSync(join(tmpdir(), "flowlet-init-target-"));
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    try {
      await runInit({
        targetDir: target,
        skipLlm: true,
        force: true,
        model: null,
        telemetry: { home, posthogKey: "phc_test", env: { NODE_ENV: "test" }, fetchImpl },
      });
      const events = fetchImpl.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body).event);
      expect(events).toContain("init_started");
      expect(events).toContain("init_completed");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowlet/cli test init.telemetry`
Expected: FAIL — `telemetry` option not accepted / no events.

- [ ] **Step 3: Extend `InitOptions` and instrument `runInit`**

In `init.ts`, extend the interface:

```ts
import { initTelemetry } from "@flowlet/telemetry";
import { readFileSync } from "node:fs";
```

Add to `InitOptions`:

```ts
  /** test seam — telemetry wiring overrides; omit in production for real env/key */
  telemetry?: {
    home?: string;
    posthogKey?: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  };
```

At the very top of `runInit`, before work begins:

```ts
  const t = initTelemetry({
    version: "0.0.0",
    runtime: false,
    home: opts.telemetry?.home,
    posthogKey: opts.telemetry?.posthogKey ?? process.env.FLOWLET_POSTHOG_KEY,
    env: opts.telemetry?.env ?? process.env,
    fetchImpl: opts.telemetry?.fetchImpl,
  });
  const framework = "next"; // detectTarget result is Next-only today; refine if info exposes a name
  await t.track("init_started", { framework });
```

Then wrap the existing body so completion/failure is reported. Around the existing `try { report.theme = ... }` block, on success (just before the function returns its success code), add:

```ts
  await t.track("init_completed", {
    framework,
    provider: model === null ? "none" : "configured",
    llmSkipped: model === null,
    componentCount: report.components?.count ?? 0,
    toolCount: report.tools?.count ?? 0,
  });
```

In the failure path (the existing `catch`/error returns), before returning a non-zero code, add:

```ts
  await t.track("init_failed", { framework, failedStep });
```

Where `failedStep` is a short constant string identifying the stage (`"theme" | "tools" | "components" | "wiring"`). Track the current stage in a local `let failedStep = "theme";` updated before each extract call. Use `report.components?.count` / `report.tools?.count` if those fields exist; if the report shape differs, count array lengths from the report instead. Read the actual `InitReport` shape in `report.ts` and use the real field names — do not invent fields.

- [ ] **Step 4: Run test + full CLI suite**

Run: `pnpm --filter @flowlet/cli test && pnpm --filter @flowlet/cli typecheck`
Expected: PASS (existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/flowlet-cli/src/init.ts packages/flowlet-cli/src/init.telemetry.test.ts
git commit -m "feat(cli): emit init telemetry events"
```

---

## Task 11: Dev-time feature events in `@flowlet/server`

Emit `agent_run` on each dev-mode agent invocation and `error_class` when the handler catches an error. Hard-gated: `runtime: true` means the consent resolver blocks production automatically, but also guard the call site with the existing `NODE_ENV !== "production"` convention (see `packages/flowlet-server/src/remix-enrich.ts:78` and `guard.ts:72`) for defense in depth.

**Files:**
- Create: `packages/flowlet-server/src/telemetry-dev.ts`
- Modify: the server request handler (locate it: `grep -rn "streamText\|toUIMessageStream\|export function create" packages/flowlet-server/src`)
- Modify: `packages/flowlet-server/package.json` (add `@flowlet/telemetry` dep)
- Test: `packages/flowlet-server/src/telemetry-dev.test.ts`

- [ ] **Step 1: Add the dependency**

In `packages/flowlet-server/package.json` `dependencies` add `"@flowlet/telemetry": "workspace:*"`, then `pnpm install`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { devTelemetry } from "./telemetry-dev.js";

describe("devTelemetry", () => {
  it("emits agent_run in development", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const t = devTelemetry({ env: { NODE_ENV: "development" }, posthogKey: "phc", fetchImpl, home: undefined });
    await t.track("agent_run", {});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("never emits in production", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const t = devTelemetry({ env: { NODE_ENV: "production" }, posthogKey: "phc", fetchImpl, home: undefined });
    await t.track("agent_run", {});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flowlet/server test telemetry-dev`
Expected: FAIL — cannot resolve `./telemetry-dev.js`.

- [ ] **Step 4: Write `telemetry-dev.ts`**

```ts
import { initTelemetry, type Telemetry } from "@flowlet/telemetry";

export interface DevTelemetryOptions {
  env?: Record<string, string | undefined>;
  posthogKey?: string;
  home?: string;
  fetchImpl?: typeof fetch;
}

/** Telemetry for the running dev server. runtime:true → the resolver blocks production. */
export function devTelemetry(opts: DevTelemetryOptions = {}): Telemetry {
  const env = opts.env ?? process.env;
  return initTelemetry({
    version: "0.0.0",
    runtime: true,
    env,
    home: opts.home,
    posthogKey: opts.posthogKey ?? env.FLOWLET_POSTHOG_KEY,
    fetchImpl: opts.fetchImpl,
    log: () => {}, // the CLI owns the first-run notice; the server stays quiet
  });
}

export function errorClassName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : "Unknown";
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowlet/server test telemetry-dev`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire into the handler**

Locate the main request handler (from the grep in Files). At the point where an agent turn begins, add, behind the prod guard:

```ts
if (process.env.NODE_ENV !== "production") {
  void devTelemetry().track("agent_run", {});
}
```

In the handler's top-level `catch`, add:

```ts
if (process.env.NODE_ENV !== "production") {
  void devTelemetry().track("error_class", { errorClass: errorClassName(err) });
}
```

Use `void` so telemetry never blocks the response. Import `devTelemetry`, `errorClassName` from `./telemetry-dev.js`. If the handler is split across files, place the `agent_run` call at the single clearest entry point rather than duplicating it. If no obvious single agent-turn entry point exists within a bounded search, emit only `error_class` and record the gap in the PR description rather than guessing.

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm --filter @flowlet/server test && pnpm --filter @flowlet/server typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/flowlet-server/src/telemetry-dev.ts packages/flowlet-server/src/telemetry-dev.test.ts packages/flowlet-server/package.json
git add -u packages/flowlet-server/src
git commit -m "feat(server): dev-only agent_run + error_class telemetry"
```

---

## Task 12: Scarf download attribution

Scarf reports installs of published packages and honors `DO_NOT_TRACK`. Registering the package on scarf.sh is a separate account step (out of scope for code); this task only wires the dependency + opt-in default.

**Files:**
- Modify: `packages/flowlet-cli/package.json`
- Modify: `packages/flowlet-next/package.json`

- [ ] **Step 1: Add Scarf to both published entrypoints**

In each package's `dependencies` add:

```json
"@scarf/scarf": "^1.4.0",
```

And add a top-level `scarfSettings` block to each `package.json`:

```json
"scarfSettings": {
  "defaultOptIn": true,
  "allowTopLevel": true
}
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: resolves. (`@scarf/scarf`'s postinstall is a no-op unless the package is registered on scarf.sh and the installer has not set `DO_NOT_TRACK`.)

- [ ] **Step 3: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/flowlet-cli/package.json packages/flowlet-next/package.json pnpm-lock.yaml
git commit -m "feat(telemetry): Scarf download attribution on published packages"
```

---

## Task 13: Disclosure — `TELEMETRY.md` + README

**Files:**
- Create: `TELEMETRY.md` (repo root)
- Modify: `README.md`

- [ ] **Step 1: Write `TELEMETRY.md`**

Mirror the allowlist from `packages/flowlet-telemetry/src/events.ts` exactly. Include: what is collected (a table of every event and its properties), what is never collected (the banned list), the anonymous-id explanation, every opt-out path (`flowlet telemetry disable`, `FLOWLET_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, CI auto-off, production auto-off), where data goes (PostHog EU + Scarf), and a real example JSON payload:

```json
{
  "api_key": "phc_...",
  "event": "init_completed",
  "distinct_id": "3f2a...-random-uuid",
  "properties": {
    "flowletVersion": "0.0.0",
    "osPlatform": "darwin",
    "nodeVersion": "v22.3.0",
    "framework": "next",
    "provider": "configured",
    "llmSkipped": false,
    "componentCount": 4,
    "toolCount": 7
  }
}
```

State plainly: telemetry is build/dev-side only and never fires from a deployed production app.

- [ ] **Step 2: Link from README**

Add a short "Telemetry" section to `README.md` (or a one-line link near the top): "Flowlet collects anonymous, opt-out usage telemetry. See [TELEMETRY.md](./TELEMETRY.md)." If no root `README.md` exists, create a minimal one with just this section and a project title.

- [ ] **Step 3: Commit**

```bash
git add TELEMETRY.md README.md
git commit -m "docs: TELEMETRY.md disclosure + README link"
```

---

## Task 14: Full verification sweep

- [ ] **Step 1: Whole-repo build, test, typecheck**

Run: `pnpm build && pnpm test && pnpm typecheck`
Expected: all green. Fix any breakage before proceeding.

- [ ] **Step 2: Manual CLI smoke (no key → no network)**

Run:
```bash
node packages/flowlet-cli/dist/cli.js telemetry status
node packages/flowlet-cli/dist/cli.js telemetry disable
node packages/flowlet-cli/dist/cli.js telemetry status
node packages/flowlet-cli/dist/cli.js telemetry enable
```
Expected: status prints enabled/disabled correctly; the `~/.flowlet/telemetry.json` file reflects each change. (Build the CLI first if `dist` is stale: `pnpm --filter @flowlet/cli build`.)

- [ ] **Step 3: Confirm the safety invariants hold**

Confirm by re-reading tests: consent truth table (Task 3), allowlist enforcement (Tasks 2 + 6), prod gate (Tasks 3 + 11), random id (Task 4), silent failure (Task 6). All must be green.

- [ ] **Step 4: Open the PR (do NOT merge)**

```bash
git push -u origin yousefh409/telemetry
gh pr create --title "Telemetry: anonymous, opt-out, build/dev-side-only" --body "<summary + link to spec + note that PostHog key and Scarf registration are pending ops steps>"
```

---

## Self-Review Notes

- **Spec coverage:** distribution layer (Task 12), product events (Tasks 2/6/10/11), non-prod gate (Tasks 3/11), closed allowlist (Task 2), anonymous id (Task 4), opt-out paths + `DO_NOT_TRACK`/CI (Task 3, Task 9), first-run notice (Task 7), fire-and-forget silent failure (Task 6), `TELEMETRY.md` (Task 13), all safety invariants tested (Task 14 confirms). Covered.
- **Open items from spec** (PostHog EU project/key handling, Scarf account, config path) resolved as: config path `~/.flowlet/telemetry.json`; PostHog public key via `FLOWLET_POSTHOG_KEY`, no-op when absent; Scarf registration flagged as an ops step in the PR body.
- **Type consistency:** `EventName`, `TelemetryConfig`, `Telemetry`, `initTelemetry`, `createTelemetry`, `resolveConsent`, `runTelemetryCmd`, `devTelemetry` used consistently across tasks.
- **Known adaptation point:** Task 10 depends on the real `InitReport` field names in `report.ts` and Task 11 on the real handler entry point — both call this out explicitly and instruct reading the actual code rather than inventing shapes.
