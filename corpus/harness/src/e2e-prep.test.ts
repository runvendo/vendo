import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareE2eRepo } from "./e2e-prep.js";

/** The handler `vendo init` currently scaffolds under api/vendo/[...vendo]. */
const initRouteSource = `import { model } from "@/lib/ai";
import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";

const vendo = createVendo({
  model,
  principal: async () => null,
});

export const { GET, POST, DELETE } = nextVendoHandler(vendo);
`;

/** An App Router layout after init wired VendoRoot around {children}. */
function initLayoutSource(themeImportPath: string, wrap: (inner: string) => string): string {
  return `import { VendoRoot } from "@vendoai/vendo/react";
import theme from "${themeImportPath}";
import type { VendoTheme } from "@vendoai/vendo";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    ${wrap("<VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot>")}
  )
}
`;
}

async function createSkateshopFixture(): Promise<{ appRoot: string; logsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-prep-"));
  const appRoot = path.join(root, "skateshop");
  const logsDir = path.join(root, "logs");
  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await mkdir(path.join(appRoot, "src/app/api/vendo/[...vendo]"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo/tools.json"), JSON.stringify({ format: "vendo/tools@1", tools: [] }));
  await writeFile(path.join(appRoot, "src/app/api/vendo/[...vendo]/route.ts"), initRouteSource);
  await writeFile(
    path.join(appRoot, "src/app/layout.tsx"),
    `import { ClerkProvider } from "@clerk/nextjs"
import { VendoRoot } from "@vendoai/vendo/react";
import theme from "../../.vendo/theme.json";
import type { VendoTheme } from "@vendoai/vendo";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body><VendoRoot theme={theme as VendoTheme}>{children}</VendoRoot></body>
      </html>
    </ClerkProvider>
  )
}
`,
  );
  await mkdir(path.join(appRoot, "src/db"), { recursive: true });
  await mkdir(path.join(appRoot, "src/lib/queries"), { recursive: true });
  await writeFile(
    path.join(appRoot, "src/db/seed.ts"),
    `import { revalidateItems, seedCategories, seedSubcategories } from "@/lib/actions/seed"

async function runSeed() {
  await seedCategories()
  await seedSubcategories()
  await revalidateItems()
  process.exit(0)
}
`,
  );
  await writeFile(
    path.join(appRoot, "src/lib/queries/user.ts"),
    `import { cache } from "react"
import { currentUser } from "@clerk/nextjs/server"

export const getCachedUser = cache(currentUser)

export async function getUserUsageMetrics(input: { userId: string }) {
  return { storeCount: 0, productCount: 0 }
}
`,
  );
  await writeFile(
    path.join(appRoot, "middleware.ts"),
    `import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"])

export default clerkMiddleware((auth, req) => {
  if (isProtectedRoute(req)) {
    auth().protect()
  }
})

export const config = {
  matcher: ["/((?!.*\\\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
}
`,
  );
  return { appRoot, logsDir };
}

async function createUmamiFixture(): Promise<{ appRoot: string; logsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-prep-"));
  const appRoot = path.join(root, "umami");
  const logsDir = path.join(root, "logs");
  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await mkdir(path.join(appRoot, "src/app/api/vendo/[...vendo]"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo/tools.json"), JSON.stringify({ format: "vendo/tools@1", tools: [] }));
  await writeFile(path.join(appRoot, "src/app/api/vendo/[...vendo]/route.ts"), initRouteSource);
  await writeFile(
    path.join(appRoot, "src/app/layout.tsx"),
    initLayoutSource(
      "../../.vendo/theme.json",
      (inner) => `<html lang="en"><body><Providers>${inner}</Providers></body></html>`,
    ),
  );
  return { appRoot, logsDir };
}

// Mirrors real route-scan output: host_* names and its OWN param names
// ({id} where the curated manifest says {documentId}/{linkId}), so the
// endpoint matching must normalize params the way sync's dedupKey does.
const papermarkExtractionTools = [
  { name: "host_teams_list", method: "GET", path: "/api/teams" },
  { name: "host_teams_documents_list", method: "GET", path: "/api/teams/{teamId}/documents" },
  { name: "host_teams_documents_views_count_list", method: "GET", path: "/api/teams/{teamId}/documents/{id}/views-count" },
  { name: "host_teams_viewers_list", method: "GET", path: "/api/teams/{teamId}/viewers" },
  { name: "host_teams_documents_links_list", method: "GET", path: "/api/teams/{teamId}/documents/{id}/links" },
  { name: "host_teams_datarooms_list", method: "GET", path: "/api/teams/{teamId}/datarooms" },
  { name: "host_links_create", method: "POST", path: "/api/links" },
  { name: "host_teams_documents_add_to_dataroom", method: "POST", path: "/api/teams/{teamId}/documents/{id}/add-to-dataroom" },
  { name: "host_links_update", method: "PUT", path: "/api/links/{id}" },
  // Extraction noise the curated surface must disable.
  { name: "host_account_get", method: "GET", path: "/api/account" },
] as const;

function papermarkExtractionToolsJson(): string {
  return `${JSON.stringify({
    format: "vendo/tools@1",
    tools: papermarkExtractionTools.map((tool) => ({
      name: tool.name,
      description: "",
      inputSchema: { type: "object" },
      risk: "write",
      binding: { kind: "route", method: tool.method, path: tool.path, argsIn: tool.method === "GET" ? "query" : "body" },
    })),
  }, null, 2)}\n`;
}

async function createPapermarkFixture(options: {
  routeSegment?: string | null;
  toolsJson?: string;
} = {}): Promise<{ appRoot: string; logsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-prep-"));
  const appRoot = path.join(root, "papermark");
  const logsDir = path.join(root, "logs");
  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await mkdir(path.join(appRoot, "app"), { recursive: true });
  await mkdir(path.join(appRoot, "pages/api"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo/tools.json"), options.toolsJson ?? papermarkExtractionToolsJson());
  const routeSegment = options.routeSegment === undefined ? "[...vendo]" : options.routeSegment;
  if (routeSegment !== null) {
    await mkdir(path.join(appRoot, `app/api/vendo/${routeSegment}`), { recursive: true });
    await writeFile(path.join(appRoot, `app/api/vendo/${routeSegment}/route.ts`), initRouteSource);
  }
  await writeFile(
    path.join(appRoot, "app/layout.tsx"),
    initLayoutSource(
      "../.vendo/theme.json",
      (inner) => `<html lang="en"><body>${inner}</body></html>`,
    ),
  );
  await writeFile(
    path.join(appRoot, "package.json"),
    `${JSON.stringify({ scripts: { "dev:prisma": "npx prisma generate && npx prisma migrate deploy" } }, null, 2)}\n`,
  );
  return { appRoot, logsDir };
}

describe("prepareE2eRepo", () => {
  it("keeps the permanently wired Express host as an explicit no-op", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vendo-express-prep-"));
    const appRoot = path.join(root, "express-host");
    const logsDir = path.join(root, "logs");

    await expect(prepareE2eRepo({ name: "express-host" }, appRoot, logsDir)).resolves.toEqual([]);
    await expect(readFile(path.join(logsDir, "e2e.prepare.log"), "utf8")).rejects.toThrow();
  });

  it("adds Skateshop corpus routes, curated tools, overlay chrome, and Clerk bypasses", async () => {
    const { appRoot, logsDir } = await createSkateshopFixture();
    const logs = await prepareE2eRepo({ name: "skateshop" }, appRoot, logsDir);

    const tools = JSON.parse(await readFile(path.join(appRoot, ".vendo/tools.json"), "utf8")) as {
      tools: Array<{
        name: string;
        description: string;
        risk: "read" | "write" | "destructive";
        binding: { method: string; path: string };
      }>;
    };
    const route = await readFile(path.join(appRoot, "src/app/api/vendo/[...vendo]/route.ts"), "utf8");
    const overlay = await readFile(path.join(appRoot, "src/app/vendo-corpus-e2e.tsx"), "utf8");
    const layout = await readFile(path.join(appRoot, "src/app/layout.tsx"), "utf8");
    const corpusLib = await readFile(path.join(appRoot, "src/app/api/corpus/_lib.ts"), "utf8");
    const productsRoute = await readFile(path.join(appRoot, "src/app/api/corpus/products/route.ts"), "utf8");
    const cartRoute = await readFile(path.join(appRoot, "src/app/api/corpus/cart/route.ts"), "utf8");
    const ordersRoute = await readFile(path.join(appRoot, "src/app/api/corpus/orders/route.ts"), "utf8");
    const seed = await readFile(path.join(appRoot, "src/db/seed.ts"), "utf8");
    const middleware = await readFile(path.join(appRoot, "middleware.ts"), "utf8");
    const userQuery = await readFile(path.join(appRoot, "src/lib/queries/user.ts"), "utf8");
    const log = await readFile(logs[0]!, "utf8");

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_skateshop_catalog_products",
      "search_skateshop_products",
      "add_skateshop_item_to_cart",
      "place_skateshop_order",
      "get_skateshop_checkout_defaults",
    ]);
    expect(tools.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["list_skateshop_catalog_products", "read"],
      ["search_skateshop_products", "read"],
      ["add_skateshop_item_to_cart", "write"],
      ["place_skateshop_order", "write"],
      ["get_skateshop_checkout_defaults", "read"],
    ]);
    expect(tools.tools.map((tool) => [tool.binding.method, tool.binding.path])).toEqual([
      ["GET", "/api/corpus/products"],
      ["GET", "/api/corpus/products"],
      ["POST", "/api/corpus/cart"],
      ["POST", "/api/corpus/orders"],
      ["GET", "/api/corpus/checkout-defaults"],
    ]);
    // Fixture guidance now rides in the tool descriptions (the old handler
    // instructionsExtra knob no longer exists in the composed umbrella).
    expect(tools.tools[0]!.description).toContain("Youness gradient cuts impact 8.375 skateboard deck");
    expect(tools.tools[0]!.description).toContain("Table view");
    // The init-scaffolded handler is already correct; prep must not touch it.
    expect(route).toContain("nextVendoHandler(vendo)");
    expect(overlay).toContain('"use client"');
    expect(overlay).toContain("VendoOverlay");
    expect(layout).toContain("<VendoCorpusE2e />");
    expect(layout).not.toContain("ClerkProvider");
    expect(layout).toContain("<html");
    expect(corpusLib).toContain('from "@/assets/data/products.json"');
    expect(corpusLib).toContain("ensureCorpusCatalog");
    expect(corpusLib).toContain("seededProductIds");
    expect(productsRoute).toContain("searchCorpusProducts");
    expect(productsRoute).toContain("Response.json");
    expect(cartRoute).toContain('from "@/lib/actions/cart"');
    expect(cartRoute).toContain("addToCart");
    expect(ordersRoute).toContain("db.insert(orders)");
    expect(seed).toContain("Corpus boot runs seed before the dev server is listening");
    expect(seed).toContain("revalidateItems().catch");
    expect(middleware).toContain("isCorpusE2eRequest");
    expect(middleware).toContain("NextResponse.next()");
    expect(middleware).toContain('pathname === "/"');
    expect(middleware).toContain("vendoThread");
    expect(middleware).toContain("/api/corpus");
    expect(userQuery).not.toContain("@clerk/nextjs/server");
    expect(userQuery).toContain("cache(async () => null)");
    expect(log).toContain("Skateshop Layer 3 tools manifest");
    expect(log).toContain("Skateshop corpus API routes");
    expect(log).toContain("Skateshop seed revalidation fail-open");
    expect(log).toContain("Skateshop Clerk middleware corpus bypass");
    expect(log).toContain("Skateshop Clerk provider corpus bypass");
    expect(log).toContain("Skateshop cached user query corpus bypass");
    expect(log).toContain("corpus Vendo overlay");
  });

  it("adds Umami Layer 3 tools, overlay chrome with the auth shim, and a trusted base URL", async () => {
    const { appRoot, logsDir } = await createUmamiFixture();
    const logs = await prepareE2eRepo({ name: "umami" }, appRoot, logsDir);

    const tools = JSON.parse(await readFile(path.join(appRoot, ".vendo/tools.json"), "utf8")) as {
      tools: Array<{ name: string; description: string }>;
    };
    const overlay = await readFile(path.join(appRoot, "src/app/vendo-corpus-e2e.tsx"), "utf8");
    const layout = await readFile(path.join(appRoot, "src/app/layout.tsx"), "utf8");
    const env = await readFile(path.join(appRoot, ".env"), "utf8");
    const log = await readFile(logs[0]!, "utf8");

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_umami_websites",
      "get_umami_website_metrics",
      "get_umami_pageviews",
      "get_umami_revenue_report",
      "get_umami_funnel_report",
    ]);
    // Seeded date windows moved from instructionsExtra into the descriptions.
    expect(tools.tools[1]!.description).toContain("startAt=1782691200000");
    expect(tools.tools[3]!.description).toContain("2026-07-01T00:00:00.000Z");
    expect(overlay).toContain('"use client"');
    expect(overlay).toContain("VendoOverlay");
    expect(overlay).toContain("installUmamiAuthFetch");
    expect(overlay).toContain("umami.auth");
    expect(overlay).toContain('headers.set("authorization"');
    // The Bearer shim must cover the Vendo wire so server-side route bindings
    // receive the forwarded authorization header — the old shim excluded it.
    expect(overlay).not.toContain('!url.pathname.startsWith("/api/vendo")');
    expect(layout).toContain("<VendoCorpusE2e />");
    expect(env).toContain("VENDO_BASE_URL=http://127.0.0.1:3000");
    expect(log).toContain("read-only tools manifest");
    expect(log).toContain("Umami auth fetch shim");
    expect(log).toContain("VENDO_BASE_URL");
  });

  it("fails loudly when init's layout no longer carries the VendoRoot wrapper", async () => {
    const { appRoot, logsDir } = await createUmamiFixture();
    await writeFile(
      path.join(appRoot, "src/app/layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
    );

    await expect(prepareE2eRepo({ name: "umami" }, appRoot, logsDir)).rejects.toThrow(/VendoRoot/);
  });

  it("does nothing for repos without a Layer 3 prep fixture", async () => {
    const { appRoot, logsDir } = await createUmamiFixture();

    await expect(prepareE2eRepo({ name: "taxonomy" }, appRoot, logsDir)).resolves.toEqual([]);
  });

  it("aligns Teable's generated App Router and model module with its src/pages tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vendo-teable-prep-"));
    const appRoot = path.join(root, "apps/nextjs-app");
    const backendRoot = path.join(root, "apps/nestjs-backend");
    const logsDir = path.join(root, "logs");
    await mkdir(backendRoot, { recursive: true });
    await mkdir(path.join(appRoot, "app/api/vendo/[...vendo]"), { recursive: true });
    await mkdir(path.join(appRoot, "lib"), { recursive: true });
    await mkdir(path.join(appRoot, "src/pages/auth"), { recursive: true });
    await writeFile(
      path.join(appRoot, "next-i18next.config.js"),
      "module.exports = { i18n: { defaultLocale: 'en' } };\n",
    );
    await writeFile(
      path.join(appRoot, "app/api/vendo/[...vendo]/route.ts"),
      'import { model } from "@/lib/ai";\n',
    );
    await writeFile(
      path.join(appRoot, "app/layout.tsx"),
      'import theme from "../.vendo/theme.json";\n',
    );
    await writeFile(path.join(appRoot, "lib/ai.ts"), "export const model = {};\n");
    await writeFile(path.join(appRoot, "src/pages/auth/login.tsx"), "export default function Login() {}\n");

    const firstLogs = await prepareE2eRepo({ name: "teable" }, appRoot, logsDir);
    const secondLogs = await prepareE2eRepo({ name: "teable" }, appRoot, logsDir);

    await expect(readFile(path.join(appRoot, "app/layout.tsx"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(appRoot, "lib/ai.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(appRoot, "src/app/api/vendo/[...vendo]/route.ts"), "utf8")).resolves.toContain("@/lib/ai");
    await expect(readFile(path.join(appRoot, "src/app/layout.tsx"), "utf8")).resolves.toContain('../../.vendo/theme.json');
    await expect(readFile(path.join(appRoot, "src/lib/ai.ts"), "utf8")).resolves.toContain("export const model");
    await expect(readFile(path.join(backendRoot, "next-i18next.config.js"), "utf8")).resolves.toContain("defaultLocale");
    expect(firstLogs).toEqual([path.join(logsDir, "e2e.prepare.log")]);
    expect(secondLogs).toEqual(firstLogs);
    const prepLog = await readFile(firstLogs[0]!, "utf8");
    expect(prepLog).toContain("aligned Teable Vendo App Router with src/pages");
    expect(prepLog).toContain("copied next-i18next.config.js beside the Nest backend");
  });

  it("fails Teable prep loudly when the next-i18next config is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vendo-teable-prep-"));
    const appRoot = path.join(root, "apps/nextjs-app");
    const logsDir = path.join(root, "logs");
    await mkdir(path.join(appRoot, "src/app"), { recursive: true });
    await mkdir(path.join(appRoot, "src/lib"), { recursive: true });
    await writeFile(path.join(appRoot, "src/app/layout.tsx"), 'import theme from "../../.vendo/theme.json";\n');
    await writeFile(path.join(appRoot, "src/lib/ai.ts"), "export const model = {};\n");

    await expect(prepareE2eRepo({ name: "teable" }, appRoot, logsDir)).rejects.toThrow(/next-i18next\.config\.js/);
  });

  it("adds Papermark fixtures, JWT login, curated overrides, and overlay chrome", async () => {
    const { appRoot, logsDir } = await createPapermarkFixture();
    const toolsBefore = await readFile(path.join(appRoot, ".vendo/tools.json"), "utf8");
    const logs = await prepareE2eRepo({ name: "papermark" }, appRoot, logsDir);

    // The sync-managed extraction pin must stay byte-identical: papermark's
    // npm build runs `vendo sync --strict`, and replacing the pin with a
    // curated manifest reads as breaking tool renames (exit 2).
    await expect(readFile(path.join(appRoot, ".vendo/tools.json"), "utf8")).resolves.toBe(toolsBefore);

    const overrides = JSON.parse(await readFile(path.join(appRoot, ".vendo/overrides.json"), "utf8")) as {
      format: string;
      tools: Record<string, { risk?: string; description?: string; disabled?: boolean }>;
    };
    const route = await readFile(path.join(appRoot, "app/api/vendo/[...vendo]/route.ts"), "utf8");
    const overlay = await readFile(path.join(appRoot, "app/vendo-corpus-e2e.tsx"), "utf8");
    const layout = await readFile(path.join(appRoot, "app/layout.tsx"), "utf8");
    const corpusPage = await readFile(path.join(appRoot, "app/corpus-e2e/page.tsx"), "utf8");
    const loginRoute = await readFile(path.join(appRoot, "pages/api/corpus-login.ts"), "utf8");
    const env = await readFile(path.join(appRoot, ".env"), "utf8");
    const premiumLimitShim = await readFile(path.join(appRoot, "ee/limits/can-create-premium-team.ts"), "utf8");
    const unlimitedLimitShim = await readFile(path.join(appRoot, "ee/limits/can-create-unlimited-team.ts"), "utf8");
    const apiErrorShim = await readFile(path.join(appRoot, "lib/api/errors.ts"), "utf8");
    const seedScript = await readFile(path.join(appRoot, "scripts/corpus-seed.mjs"), "utf8");
    const packageJson = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8")) as {
      scripts: { "dev:prisma": string };
    };
    const log = await readFile(logs[0]!, "utf8");

    expect(overrides.format).toBe("vendo/overrides@1");
    // Curated endpoints keep their extraction names and gain descriptions +
    // corrected risk; every other extracted tool is disabled.
    expect(overrides.tools["host_teams_list"]).toMatchObject({ risk: "read" });
    expect(overrides.tools["host_teams_list"]!.description).toContain("Corpus E2E Team");
    expect(overrides.tools["host_teams_documents_list"]).toMatchObject({ risk: "read" });
    expect(overrides.tools["host_teams_documents_list"]!.description).toContain("seeded document names");
    expect(overrides.tools["host_teams_documents_views_count_list"]).toMatchObject({ risk: "read" });
    expect(overrides.tools["host_links_create"]).toMatchObject({ risk: "write" });
    expect(overrides.tools["host_links_update"]).toMatchObject({ risk: "write" });
    expect(overrides.tools["host_teams_documents_add_to_dataroom"]).toMatchObject({ risk: "write" });
    expect(overrides.tools["host_teams_list"]!.disabled).toBeUndefined();
    expect(overrides.tools["host_account_get"]).toEqual({ disabled: true });
    // The init-scaffolded handler is already correct; prep must not rewrite it.
    expect(route).toContain("nextVendoHandler(vendo)");
    expect(overlay).toContain("VendoOverlay");
    expect(layout).toContain("<VendoCorpusE2e />");
    expect(corpusPage).toContain("Corpus Papermark E2E");
    expect(loginRoute).toContain("next-auth.session-token");
    expect(loginRoute).toContain("encode({");
    expect(loginRoute).toContain("e2e@corpus.test");
    expect(env).toContain("STRIPE_SECRET_KEY=sk_test_corpus_e2e");
    expect(env).toContain("STRIPE_SECRET_KEY_OLD=sk_test_corpus_e2e_old");
    expect(env).toContain("VENDO_BASE_URL=http://127.0.0.1:3000");
    expect(premiumLimitShim).toContain("getPremiumTeamEligibility");
    expect(unlimitedLimitShim).toContain("canCreateUnlimitedTeam");
    expect(apiErrorShim).toContain("PapermarkApiError");
    expect(seedScript).toContain("analyst@example.test");
    expect(seedScript).toContain("datarooms-unlimited");
    expect(packageJson.scripts["dev:prisma"]).toContain("node scripts/corpus-seed.mjs");
    expect(log).toContain("Papermark fixture seed");
    expect(log).toContain("Papermark e2e login route");
    expect(log).toContain("overrides.json");
  });

  it("derives the Vendo route segment instead of hardcoding init's name", async () => {
    // A repo whose route still uses another catch-all name must not gain a
    // second, conflicting [...vendo] route (Next rejects sibling catch-alls
    // with different slugs).
    const { appRoot, logsDir } = await createPapermarkFixture({ routeSegment: "[...path]" });
    await prepareE2eRepo({ name: "papermark" }, appRoot, logsDir);

    await expect(readFile(path.join(appRoot, "app/api/vendo/[...path]/route.ts"), "utf8"))
      .resolves.toContain("nextVendoHandler(vendo)");
    await expect(readFile(path.join(appRoot, "app/api/vendo/[...vendo]/route.ts"), "utf8")).rejects.toThrow();
  });

  it("creates the current init handler when the fixture has none", async () => {
    const { appRoot, logsDir } = await createPapermarkFixture({ routeSegment: null });
    await prepareE2eRepo({ name: "papermark" }, appRoot, logsDir);

    const route = await readFile(path.join(appRoot, "app/api/vendo/[...vendo]/route.ts"), "utf8");
    expect(route).toContain("createVendo({");
    expect(route).toContain("nextVendoHandler(vendo)");
  });

  it("fails Papermark prep loudly when extraction stops covering a curated endpoint", async () => {
    const { appRoot, logsDir } = await createPapermarkFixture({
      toolsJson: `${JSON.stringify({ format: "vendo/tools@1", tools: [] }, null, 2)}\n`,
    });

    await expect(prepareE2eRepo({ name: "papermark" }, appRoot, logsDir))
      .rejects.toThrow(/no tool for curated endpoint GET \/api\/teams/);
  });
});
