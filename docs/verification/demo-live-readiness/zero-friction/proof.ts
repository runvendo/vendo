/**
 * Zero-friction cold-profile proof (contract Z5 / task T4).
 *
 * Prereqs (prod builds, run from repo root; ANTHROPIC_API_KEY set like the
 * deployed demos so boot-time chip pre-generation fills the tap-to-attach
 * cache — the Supabase env stays ABSENT, which is the contract's point).
 * VENDO_BASE_URL is REQUIRED: the autologin gate is host-bound and fails
 * closed without a configured demo origin (no loopback exception), so local
 * runs must set it to the exact origin the browser will use:
 *   apps/demo-bank:      DEMO_AUTOLOGIN=1 VENDO_BASE_URL=http://127.0.0.1:4300 \
 *     AUTH_SECRET=<any> pnpm start -p 4300
 *   apps/demo-accounting: env -u SUPABASE_URL -u SUPABASE_ANON_KEY \
 *     -u SUPABASE_JWT_SECRET DEMO_AUTOLOGIN=1 \
 *     VENDO_BASE_URL=http://127.0.0.1:4301 pnpm start -p 4301
 *
 * Run: npx tsx docs/verification/demo-live-readiness/zero-friction/proof.ts
 *
 * Per host, in a FRESH browser context (cold profile, video recorded):
 *   1. first navigation to / lands signed-in — no /login in the navigation
 *      trail, no password field anywhere;
 *   2. the "Live demo — signed in as <first name>" chip is visible;
 *   3. Reset works (Maple: sidebar button; Cadence: ⌘⇧. hotkey) and the
 *      visitor is STILL signed in afterwards;
 *   4. one scripted scenario card attaches (canned turn, no model);
 *   5. the REAL /logout continuation (which targets /login) lands back in
 *      the signed-in product — no login form ever renders.
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
  /** Drive the host's REAL sign-out (it targets /login) — the continuation
   * must land signed-in without a login form. */
  logout: (page: import("playwright").Page, origin: string) => Promise<void>
}

const HOSTS: HostSpec[] = [
  {
    key: "maple",
    origin: "http://127.0.0.1:4300",
    chipText: "Live demo — signed in as Yousef",
    // The scenario card's description — unique to the card, unlike its
    // title, which the pre-generated chips also echo.
    scriptedCard: "A live breakdown of this month's spending",
    launcherLabel: "Ask Maple",
    reset: async (page) => {
      page.once("dialog", (dialog) => void dialog.accept())
      await page.getByRole("button", { name: "Reset demo" }).click()
      await page.waitForURL("**/")
    },
    logout: async (page, origin) => {
      // The account switcher's real sign-out: POST /logout, then the client
      // navigates to /login — which the flag-aware proxy turns into the
      // signed-in product.
      await page.getByRole("button", { name: /Yousef Helal/ }).click()
      await page.getByText("Sign out").click()
      await page.waitForURL(`${origin}/`, { timeout: 30_000 })
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
    logout: async (page, origin) => {
      // GET /logout clears the cookie and 303s to /login — which the
      // flag-aware proxy turns into the signed-in product.
      await page.goto(`${origin}/logout`)
      await page.waitForURL(`${origin}/`, { timeout: 30_000 })
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
  const card = page.getByText(spec.scriptedCard).first()
  await card.waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForTimeout(1_500) // let the landing's entrance animation settle
  await card.click()
  // The canned turn streams and attaches the view card (its pin affordance
  // is the attached-card signal).
  await page.getByText("Pin to dashboard").first().waitFor({ state: "visible", timeout: 60_000 })
  await page.waitForTimeout(6_000) // let the scripted stream finish for the recording
  await page.screenshot({ path: path.join(OUT, `${spec.key}-04-scripted-card-attached.png`) })

  // 4. The REAL /logout continuation: sign-out targets /login, and with the
  //    flag active that continuation lands back in the signed-in product —
  //    no login form ever renders.
  const scrim = page.locator(".fl-overlay-scrim")
  await page.keyboard.press("Escape") // close the overlay (scrim stays mounted, goes hidden)
  await scrim.waitFor({ state: "hidden", timeout: 3_000 }).catch(async () => {
    // Escape landed in the composer — the scrim itself dismisses on click.
    await scrim.click({ position: { x: 8, y: 8 } })
    await scrim.waitFor({ state: "hidden", timeout: 5_000 })
  })
  await spec.logout(page, spec.origin)
  await page.getByText(spec.chipText).first().waitFor({ state: "visible", timeout: 30_000 })
  if ((await page.locator('input[type="password"]').count()) !== 0) {
    throw new Error(`${spec.key}: the /logout continuation rendered a login form`)
  }
  await page.screenshot({ path: path.join(OUT, `${spec.key}-05-logout-continuation-signed-in.png`) })

  const video = page.video()
  await context.close()
  if (video) {
    const recorded = await video.path()
    renameSync(recorded, path.join(RECORDINGS, `${spec.key}-cold-profile.webm`))
  }
  await browser.close()
  console.log(`${spec.key}: PROVEN (${navigations.length} navigation(s): ${navigations.join(" → ")})`)
}

/** Z4 negative: a CREDENTIAL session on the same flag-enabled Maple server
 * shows no chip — the claim rides only proxy-minted tokens. The login form
 * is (by design) unreachable under the flag, so the credential session is
 * installed directly: the exact claim-less Auth.js JWE the credentials
 * provider mints, signed with the server's own AUTH_SECRET. If the proxy
 * did NOT accept it, it would auto-mint and the chip WOULD render — chip
 * absence therefore proves the credential session was honored. */
async function proveCredentialNoChip(): Promise<void> {
  const requireBank = createRequire(path.join(repoRoot, "apps/demo-bank/package.json"))
  const { encode } = requireBank("next-auth/jwt") as typeof import("next-auth/jwt")
  const credential = await encode({
    token: { sub: "vendo-demo", name: "Yousef Helal", email: "yousef@maple.com" },
    // Must match the AUTH_SECRET the Maple server was started with.
    secret: process.env.AUTH_SECRET ?? "zero-friction-proof-secret",
    salt: "authjs.session-token",
  })
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([
    { name: "authjs.session-token", value: credential, url: "http://127.0.0.1:4300/" },
  ])
  const page = await context.newPage()
  await page.goto("http://127.0.0.1:4300/", { waitUntil: "load" })
  await page.getByText("Yousef Helal").first().waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForTimeout(2_000)
  const chips = await page.getByText("Live demo — signed in as").count()
  if (chips !== 0) throw new Error(`credential session rendered ${chips} chip(s); expected none`)
  await page.screenshot({ path: path.join(OUT, "maple-06-credential-session-no-chip.png") })
  await browser.close()
  console.log("maple credential session: NO chip (as required)")
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
