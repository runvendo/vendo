/**
 * Zero-friction cold-profile proof (contract Z5 / task T4).
 *
 * Prereqs (prod builds, run from repo root; ANTHROPIC_API_KEY set like the
 * deployed demos so boot-time chip pre-generation fills the tap-to-attach
 * cache — the Supabase env stays ABSENT, which is the contract's point):
 *   apps/demo-bank:      DEMO_AUTOLOGIN=1 AUTH_SECRET=<any> pnpm start -p 4300
 *   apps/demo-accounting: env -u SUPABASE_URL -u SUPABASE_ANON_KEY \
 *     -u SUPABASE_JWT_SECRET DEMO_AUTOLOGIN=1 pnpm start -p 4301
 *
 * Run: npx tsx docs/verification/demo-live-readiness/zero-friction/proof.ts
 *
 * Per host, in a FRESH browser context (cold profile, video recorded):
 *   1. first navigation to / lands signed-in — no /login in the navigation
 *      trail, no password field anywhere;
 *   2. the "Live demo — signed in as <first name>" chip is visible;
 *   3. Reset works (Maple: sidebar button; Cadence: ⌘⇧. hotkey) and the
 *      visitor is STILL signed in afterwards;
 *   4. one scripted scenario card attaches (canned turn, no model).
 */
import { createRequire } from "node:module"
import { mkdirSync, renameSync } from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(__dirname, "../../../..")
const require_ = createRequire(path.join(repoRoot, "packages/ui/package.json"))
// Playwright ships with packages/ui's browser test deps — reuse it.
const { chromium } = require_("playwright") as typeof import("playwright")

const OUT = __dirname
const RECORDINGS = path.join(OUT, "recordings")

interface HostSpec {
  key: "maple" | "cadence"
  origin: string
  chipText: string
  /** Text of the scripted/pre-generated card to tap: Maple = a scenario card
   * (canned turn engine), Cadence = a pre-generated "try this" chip
   * (instant-attach cache) — each host's deterministic demo path. */
  scriptedCard: string
  launcherLabel: string
  reset: (page: import("playwright").Page) => Promise<void>
}

const HOSTS: HostSpec[] = [
  {
    key: "maple",
    origin: "http://127.0.0.1:4300",
    chipText: "Live demo — signed in as Yousef",
    scriptedCard: "Where did my money go?",
    launcherLabel: "Ask Maple",
    reset: async (page) => {
      page.once("dialog", (dialog) => void dialog.accept())
      await page.getByRole("button", { name: "Reset demo" }).click()
      await page.waitForURL("**/")
    },
  },
  {
    key: "cadence",
    origin: "http://127.0.0.1:4301",
    chipText: "Live demo — signed in as Maya",
    scriptedCard: "What filing deadlines hit next week?",
    launcherLabel: "Ask Cadence",
    reset: async (page) => {
      // Cadence's demo chrome reset is the ⌘⇧. hotkey (VendoLayer).
      await page.keyboard.press("Meta+Shift+Period")
      await page.waitForURL("**/")
    },
  },
]

async function prove(spec: HostSpec): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: RECORDINGS, size: { width: 1440, height: 900 } },
  })
  const page = await context.newPage()

  const navigations: string[] = []
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  })

  // 1. Cold first navigation lands signed in.
  await page.goto(`${spec.origin}/`, { waitUntil: "load" })
  const chip = page.getByText(spec.chipText).first()
  await chip.waitFor({ state: "visible", timeout: 30_000 })
  if (navigations.some((url) => url.includes("/login"))) {
    throw new Error(`${spec.key}: navigation trail touched /login: ${navigations.join(" → ")}`)
  }
  if ((await page.locator('input[type="password"]').count()) !== 0) {
    throw new Error(`${spec.key}: a password field rendered in the flow`)
  }
  await page.screenshot({ path: path.join(OUT, `${spec.key}-01-cold-landing-signed-in.png`), fullPage: false })
  await chip.screenshot({ path: path.join(OUT, `${spec.key}-02-chip.png`) })

  // 2. Reset works and the visitor is still signed in afterwards.
  await spec.reset(page)
  await page.getByText(spec.chipText).first().waitFor({ state: "visible", timeout: 30_000 })
  await page.screenshot({ path: path.join(OUT, `${spec.key}-03-after-reset-still-signed-in.png`) })

  // 3. One scripted scenario card attaches (canned turn — no model, no keys).
  await page.getByRole("button", { name: spec.launcherLabel }).first().click()
  await page.getByText(spec.scriptedCard).first().click()
  // The canned turn streams and attaches the view card (its pin affordance
  // is the attached-card signal).
  await page.getByText("Pin to dashboard").first().waitFor({ state: "visible", timeout: 60_000 })
  await page.waitForTimeout(6_000) // let the scripted stream finish for the recording
  await page.screenshot({ path: path.join(OUT, `${spec.key}-04-scripted-card-attached.png`) })

  const video = page.video()
  await context.close()
  if (video) {
    const recorded = await video.path()
    renameSync(recorded, path.join(RECORDINGS, `${spec.key}-cold-profile.webm`))
  }
  await browser.close()
  console.log(`${spec.key}: PROVEN (${navigations.length} navigation(s): ${navigations.join(" → ")})`)
}

/** Z4 negative: a CREDENTIAL login on the same flag-enabled Maple server
 * shows no chip — the claim rides only proxy-minted tokens. */
async function proveCredentialNoChip(): Promise<void> {
  const browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await page.goto("http://127.0.0.1:4300/login", { waitUntil: "load" })
  await page.locator('input[type="email"]').fill("yousef@maple.com")
  await page.locator('input[type="password"]').fill(process.env.MAPLE_DEMO_PASSWORD ?? "maple-harvest-0427")
  await page.getByRole("button", { name: /sign in/i }).click()
  await page.waitForURL("http://127.0.0.1:4300/", { timeout: 30_000 })
  await page.waitForTimeout(2_000)
  const chips = await page.getByText("Live demo — signed in as").count()
  if (chips !== 0) throw new Error(`credential login rendered ${chips} chip(s); expected none`)
  await page.screenshot({ path: path.join(OUT, "maple-05-credential-login-no-chip.png") })
  await browser.close()
  console.log("maple credential login: NO chip (as required)")
}

async function main(): Promise<void> {
  mkdirSync(RECORDINGS, { recursive: true })
  for (const spec of HOSTS) await prove(spec)
  await proveCredentialNoChip()
  console.log("ALL HOSTS PROVEN")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
