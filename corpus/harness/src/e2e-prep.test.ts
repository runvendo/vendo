import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prepareE2eRepo } from "./e2e-prep.js";


async function createSkateshopFixture(): Promise<{ appRoot: string; logsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-prep-"));
  const appRoot = path.join(root, "skateshop");
  const logsDir = path.join(root, "logs");
  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await mkdir(path.join(appRoot, "src/app/api/vendo/[...path]"), { recursive: true });
  await mkdir(path.join(appRoot, "src/app"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
  await writeFile(
    path.join(appRoot, "src/app/api/vendo/[...path]/route.ts"),
    `import { createVendoHandler } from "vendoai/server";
export const { GET, POST } = createVendoHandler();
`,
  );
  await writeFile(
    path.join(appRoot, "src/app/vendo-root.tsx"),
    `"use client";
import { VendoRoot } from "vendoai/react";
import type { ReactNode } from "react";
import theme from "../../.vendo/theme.json";
import tools from "../../.vendo/tools.json";

export function AppVendoRoot({ children }: { children: ReactNode }) {
  return (
    <VendoRoot theme={theme} tools={tools} productName="Skateshop">
      {children}
    </VendoRoot>
  );
}
`,
  );
  await writeFile(
    path.join(appRoot, "src/app/layout.tsx"),
    `import { ClerkProvider } from "@clerk/nextjs"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
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
  await mkdir(path.join(appRoot, "src/app/api/vendo/[...path]"), { recursive: true });
  await mkdir(path.join(appRoot, "src/app"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
  await writeFile(
    path.join(appRoot, "src/app/api/vendo/[...path]/route.ts"),
    `import { createVendoHandler } from "vendoai/server";
export const { GET, POST } = createVendoHandler();
`,
  );
  await writeFile(
    path.join(appRoot, "src/app/vendo-root.tsx"),
    `"use client";
import { VendoRoot } from "vendoai/react";
import type { ReactNode } from "react";
import theme from "../../.vendo/theme.json";
import tools from "../../.vendo/tools.json";

export function AppVendoRoot({ children }: { children: ReactNode }) {
  return (
    <VendoRoot theme={theme} tools={tools} productName="Umami">
      {children}
    </VendoRoot>
  );
}
`,
  );
  return { appRoot, logsDir };
}

async function createPapermarkFixture(): Promise<{ appRoot: string; logsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vendo-e2e-prep-"));
  const appRoot = path.join(root, "papermark");
  const logsDir = path.join(root, "logs");
  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await mkdir(path.join(appRoot, "app/api/vendo/[...path]"), { recursive: true });
  await mkdir(path.join(appRoot, "app"), { recursive: true });
  await mkdir(path.join(appRoot, "pages/api"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo/tools.json"), JSON.stringify({ version: 1, tools: [], events: [] }));
  await writeFile(
    path.join(appRoot, "app/api/vendo/[...path]/route.ts"),
    `import { createVendoHandler } from "vendoai/server";
export const { GET, POST } = createVendoHandler();
`,
  );
  await writeFile(
    path.join(appRoot, "app/vendo-root.tsx"),
    `"use client";
import { VendoRoot } from "vendoai/react";
import type { ReactNode } from "react";
import theme from "../.vendo/theme.json";
import tools from "../.vendo/tools.json";

export function AppVendoRoot({ children }: { children: ReactNode }) {
  return (
    <VendoRoot theme={theme} tools={tools} productName="Papermark">
      {children}
    </VendoRoot>
  );
}
`,
  );
  await writeFile(
    path.join(appRoot, "app/layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  );
  await writeFile(
    path.join(appRoot, "package.json"),
    `${JSON.stringify({ scripts: { "dev:prisma": "npx prisma generate && npx prisma migrate deploy" } }, null, 2)}\n`,
  );
  return { appRoot, logsDir };
}

describe("prepareE2eRepo", () => {
  it("adds Skateshop corpus routes, reviewed tools, handler guidance, and per-attempt thread ids", async () => {
    const { appRoot, logsDir } = await createSkateshopFixture();
    const logs = await prepareE2eRepo({ name: "skateshop" }, appRoot, logsDir);

    const tools = JSON.parse(await readFile(path.join(appRoot, ".vendo/tools.json"), "utf8")) as {
      tools: Array<{
        name: string;
        annotations: { mutating: boolean; dangerous: boolean; idempotent?: boolean };
        binding: { method: string; path: string };
      }>;
    };
    const route = await readFile(path.join(appRoot, "src/app/api/vendo/[...path]/route.ts"), "utf8");
    const root = await readFile(path.join(appRoot, "src/app/vendo-root.tsx"), "utf8");
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
    expect(tools.tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ["list_skateshop_catalog_products", { mutating: false, dangerous: false, idempotent: true }],
      ["search_skateshop_products", { mutating: false, dangerous: false, idempotent: true }],
      ["add_skateshop_item_to_cart", { mutating: true, dangerous: false }],
      ["place_skateshop_order", { mutating: true, dangerous: false }],
      ["get_skateshop_checkout_defaults", { mutating: false, dangerous: false, idempotent: true }],
    ]);
    expect(tools.tools.map((tool) => [tool.binding.method, tool.binding.path])).toEqual([
      ["GET", "/api/corpus/products"],
      ["GET", "/api/corpus/products"],
      ["POST", "/api/corpus/cart"],
      ["POST", "/api/corpus/orders"],
      ["GET", "/api/corpus/checkout-defaults"],
    ]);
    expect(route).toContain("storage: false");
    expect(route).toContain("instructionsExtra");
    expect(route).toContain("Youness gradient cuts impact 8.375 skateboard deck");
    expect(route).toContain("render a Table view");
    expect(root).toContain("threadId={threadId}");
    expect(root).toContain("vendoThread");
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
  });
  it("adds Umami Layer 3 tools, handler guidance, auth fetch, and per-attempt thread ids", async () => {
    const { appRoot, logsDir } = await createUmamiFixture();
    const logs = await prepareE2eRepo({ name: "umami" }, appRoot, logsDir);

    const tools = JSON.parse(await readFile(path.join(appRoot, ".vendo/tools.json"), "utf8")) as {
      tools: Array<{ name: string }>;
    };
    const route = await readFile(path.join(appRoot, "src/app/api/vendo/[...path]/route.ts"), "utf8");
    const root = await readFile(path.join(appRoot, "src/app/vendo-root.tsx"), "utf8");
    const log = await readFile(logs[0]!, "utf8");

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_umami_websites",
      "get_umami_website_metrics",
      "get_umami_pageviews",
      "get_umami_revenue_report",
      "get_umami_funnel_report",
    ]);
    expect(route).toContain("storage: false");
    expect(route).toContain("instructionsExtra");
    expect(route).toContain("visible answer must include labels and numeric values");
    expect(route).toContain("If you render a view");
    expect(root).toContain("threadId={threadId}");
    expect(root).toContain("vendoThread");
    expect(root).toContain("installUmamiAuthFetch");
    expect(root).toContain("umami.auth");
    expect(root).toContain('headers.set("authorization"');
    expect(log).toContain("read-only tools manifest");
    expect(log).toContain("Umami auth headers");
  });

  it("does nothing for repos without a Layer 3 prep fixture", async () => {
    const { appRoot, logsDir } = await createUmamiFixture();

    await expect(prepareE2eRepo({ name: "taxonomy" }, appRoot, logsDir)).resolves.toEqual([]);
  });

  it("adds Papermark fixtures, JWT login, curated tools, handler guidance, and per-attempt thread ids", async () => {
    const { appRoot, logsDir } = await createPapermarkFixture();
    const logs = await prepareE2eRepo({ name: "papermark" }, appRoot, logsDir);

    const tools = JSON.parse(await readFile(path.join(appRoot, ".vendo/tools.json"), "utf8")) as {
      tools: Array<{ name: string; annotations: { mutating: boolean }; binding: { method: string; path: string } }>;
    };
    const route = await readFile(path.join(appRoot, "app/api/vendo/[...path]/route.ts"), "utf8");
    const root = await readFile(path.join(appRoot, "app/vendo-root.tsx"), "utf8");
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

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "getTeams",
      "listTeamDocuments",
      "getDocumentStats",
      "getDocumentViews",
      "listDocumentLinks",
      "listDatarooms",
      "createShareLink",
      "addDocumentToDataroom",
      "updateLinkSettings",
    ]);
    expect(tools.tools.filter((tool) => tool.annotations.mutating).map((tool) => tool.name)).toEqual([
      "createShareLink",
      "addDocumentToDataroom",
      "updateLinkSettings",
    ]);
    expect(tools.tools.find((tool) => tool.name === "listTeamDocuments")?.binding).toEqual({
      type: "http",
      method: "GET",
      path: "/api/teams/{teamId}/documents",
    });
    expect(route).toContain("storage: false");
    expect(route).toContain("instructionsExtra");
    expect(route).toContain("Corpus Q3 Board Packet.pdf");
    expect(root).toContain("threadId={threadId}");
    expect(root).toContain("vendoThread");
    expect(layout).toContain("<AppVendoRoot>{children}</AppVendoRoot>");
    expect(corpusPage).toContain("Corpus Papermark E2E");
    expect(loginRoute).toContain("next-auth.session-token");
    expect(loginRoute).toContain("encode({");
    expect(loginRoute).toContain("e2e@corpus.test");
    expect(env).toContain("STRIPE_SECRET_KEY=sk_test_corpus_e2e");
    expect(env).toContain("STRIPE_SECRET_KEY_OLD=sk_test_corpus_e2e_old");
    expect(premiumLimitShim).toContain("getPremiumTeamEligibility");
    expect(unlimitedLimitShim).toContain("canCreateUnlimitedTeam");
    expect(apiErrorShim).toContain("PapermarkApiError");
    expect(seedScript).toContain("analyst@example.test");
    expect(seedScript).toContain("datarooms-unlimited");
    expect(packageJson.scripts["dev:prisma"]).toContain("node scripts/corpus-seed.mjs");
    expect(log).toContain("Papermark fixture seed");
    expect(log).toContain("Papermark e2e login route");
  });
});
