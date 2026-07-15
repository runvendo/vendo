import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mountCorpusOverlay } from "./overlay-mount.js";

const skateshopTools = {
  format: "vendo/tools@1",
  tools: [
    {
      name: "list_skateshop_catalog_products",
      description: "List Skateshop catalog products/items with price, inventory, rating, category, and subcategory. Use for browse, show, deck, store, inventory, and table requests. Always call this (or search_skateshop_products) before answering any product/catalog/cart/order prompt — never answer from memory. Seeded products include Youness gradient cuts impact 8.375 skateboard deck, Max mean pets paintings impact light 8.25 skateboard deck, Nike Streakfly, Nike InfinityRN 4, Nike Air Max 2013, and Nike Pegasus 40 BTC. For list/browse/compare prompts render a Table view with columns Product, Price, Inventory, Rating, and Category, then give a one-sentence summary.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional catalog category, such as Skateboards or Shoes." },
          subcategory: { type: "string", description: "Optional catalog subcategory, such as Decks or Pros." },
          query: { type: "string", description: "Optional text search over product names and descriptions." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/corpus/products", argsIn: "query" },
    },
    {
      name: "search_skateshop_products",
      description: "Search Skateshop products/items by exact or partial product name before comparing, adding to cart, or placing an order. Returns product ids, price, inventory, rating, category, and store id. For a single-product find prompt, render a compact view that visibly includes the exact product name, price, inventory, rating, category, and subcategory.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product search text, for example Nike Streakfly or Youness gradient cuts impact." },
          names: { type: "string", description: "Optional comma-separated exact product names to compare or resolve." },
          ids: { type: "string", description: "Optional comma-separated product ids." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/corpus/products", argsIn: "query" },
    },
    {
      name: "add_skateshop_item_to_cart",
      description: "Add one Skateshop product item to the current browser cart. Use after resolving the product with search_skateshop_products; call exactly one mutating cart tool per prompt. Approval-gated, so the approval card is the expected visible outcome. Accepts productName when the exact seeded name is known.",
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              productId: { type: "string", description: "Product id from search_skateshop_products." },
              productName: { type: "string", description: "Exact product name when productId is not available." },
              quantity: { type: "integer", minimum: 1, default: 1 },
            },
            additionalProperties: false,
          },
        },
        required: ["body"],
        additionalProperties: false,
      },
      risk: "write",
      binding: { kind: "route", method: "POST", path: "/api/corpus/cart", argsIn: "body" },
    },
    {
      name: "place_skateshop_order",
      description: "Place a minimal Skateshop checkout order for one product using default corpus checkout details. Use after resolving the product with search_skateshop_products, calling get_skateshop_checkout_defaults first when the prompt mentions default checkout details; call exactly one mutating order tool per prompt. This is approval-gated, so the approval card is the expected visible outcome.",
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              productId: { type: "string", description: "Product id from search_skateshop_products." },
              productName: { type: "string", description: "Exact product name when productId is not available." },
              quantity: { type: "integer", minimum: 1, default: 1 },
              name: { type: "string", default: "Corpus Shopper" },
              email: { type: "string", default: "corpus@example.test" },
            },
            additionalProperties: false,
          },
        },
        required: ["body"],
        additionalProperties: false,
      },
      risk: "write",
      binding: { kind: "route", method: "POST", path: "/api/corpus/orders", argsIn: "body" },
    },
    {
      name: "get_skateshop_checkout_defaults",
      description:
        "Get the shopper's default checkout details (name, shipping address, payment method label). Call this before placing an order that should use the default checkout details.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/corpus/checkout-defaults", argsIn: "query" },
    },
  ],
};

const skateshopCorpusLibSource = `import { db } from "@/db"
import { categories, products, stores, subcategories } from "@/db/schema"
import catalogData from "@/assets/data/products.json"
import { and, asc, eq, ilike, inArray, or, type SQL } from "drizzle-orm"

type StoredFile = {
  id: string
  name: string
  url: string
}

type CatalogSeed = {
  id: string
  name: string
  description: string | null
  images: StoredFile[] | null
  category: string
  subcategory: string | null
  price: string
  inventory: number
  rating: number
}

export type CorpusProduct = {
  id: string
  name: string
  description: string | null
  images: StoredFile[] | null
  category: string | null
  subcategory: string | null
  price: string
  inventory: number
  rating: number
  storeId: string
  storeName: string | null
  subcategoryId: string | null
}

export type SearchCorpusProductsInput = {
  query?: string
  names?: string
  ids?: string
  category?: string
  subcategory?: string
  limit?: number
}

const catalog = catalogData as CatalogSeed[]
const seededProductIds = catalog.map((product) => product.id)
const corpusStore = {
  id: "corpus_store",
  userId: "00000000-0000-4000-8000-000000000000",
  slug: "corpus-store",
  name: "Corpus Skateshop",
  description: "Deterministic store for Vendo corpus e2e runs.",
}

const fallbackCategories = [
  {
    id: "corpus_cat_skateboards",
    name: "Skateboards",
    slug: "skateboards",
    description: "The best skateboards for all levels of skaters.",
    image: "/images/categories/skateboard-one.webp",
  },
  {
    id: "corpus_cat_shoes",
    name: "Shoes",
    slug: "shoes",
    description: "Rad shoes for long skate sessions.",
    image: "/images/categories/shoes-one.webp",
  },
]

const fallbackSubcategories = [
  {
    id: "corpus_sub_decks",
    name: "Decks",
    slug: "decks",
    description: "The board itself.",
    categoryName: "Skateboards",
  },
  {
    id: "corpus_sub_pros",
    name: "Pros",
    slug: "pros",
    description: "Performance-driven rad shoes for the pros.",
    categoryName: "Shoes",
  },
]

export async function ensureCorpusCatalog(): Promise<void> {
  await db.insert(stores).values(corpusStore).onConflictDoNothing({ target: stores.id })
  await db.insert(categories).values(fallbackCategories).onConflictDoNothing({ target: categories.name })

  const categoryRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(inArray(categories.name, fallbackCategories.map((category) => category.name)))

  const categoryIds = new Map(categoryRows.map((category) => [normalize(category.name), category.id]))
  const subcategorySeeds = fallbackSubcategories.flatMap((subcategory) => {
    const categoryId = categoryIds.get(normalize(subcategory.categoryName))
    if (!categoryId) return []
    return [{
      id: subcategory.id,
      name: subcategory.name,
      slug: subcategory.slug,
      description: subcategory.description,
      categoryId,
    }]
  })

  if (subcategorySeeds.length > 0) {
    await db.insert(subcategories).values(subcategorySeeds).onConflictDoNothing({ target: subcategories.name })
  }

  const subcategoryRows = await db
    .select({
      id: subcategories.id,
      name: subcategories.name,
      categoryName: categories.name,
    })
    .from(subcategories)
    .leftJoin(categories, eq(subcategories.categoryId, categories.id))
    .where(inArray(subcategories.name, fallbackSubcategories.map((subcategory) => subcategory.name)))

  const categoryIdsAfterSubcategories = categoryIds.size > 0
    ? categoryIds
    : new Map(categoryRows.map((category) => [normalize(category.name), category.id]))
  const subcategoryIds = new Map(subcategoryRows.map((subcategory) => [
    subcategory.categoryName
      ? normalize(subcategory.categoryName + ":" + subcategory.name)
      : normalize(subcategory.name),
    subcategory.id,
  ]))

  const values = catalog.flatMap((product) => {
    const categoryId = categoryIdsAfterSubcategories.get(normalize(product.category))
    if (!categoryId) return []
    const subcategoryKey = product.subcategory
      ? normalize(titleize(product.category) + ":" + titleize(product.subcategory))
      : ""
    return [{
      id: product.id,
      name: product.name,
      description: product.description,
      images: product.images,
      categoryId,
      subcategoryId: subcategoryKey ? subcategoryIds.get(subcategoryKey) ?? null : null,
      price: product.price,
      originalPrice: product.price,
      inventory: product.inventory,
      rating: product.rating,
      status: "active" as const,
      storeId: corpusStore.id,
    }]
  })

  if (values.length > 0) {
    await db.insert(products).values(values).onConflictDoNothing({ target: products.id })
  }
}

export async function searchCorpusProducts(input: SearchCorpusProductsInput = {}): Promise<CorpusProduct[]> {
  await ensureCorpusCatalog()

  const conditions: SQL[] = []
  const ids = splitList(input.ids)
  if (ids.length > 0) {
    conditions.push(inArray(products.id, ids))
  }

  const textTerms = [...splitList(input.names), ...splitList(input.query)]
  const textPredicates: SQL[] = []
  for (const term of textTerms) {
    const pattern = "%" + term + "%"
    const predicate = or(
      ilike(products.name, pattern),
      ilike(products.description, pattern),
      ilike(categories.name, pattern),
      ilike(subcategories.name, pattern)
    )
    if (predicate) textPredicates.push(predicate)
  }
  if (textPredicates.length > 0) {
    const predicate = or(...textPredicates)
    if (predicate) conditions.push(predicate)
  }

  const category = textValue(input.category)
  if (category) conditions.push(ilike(categories.name, "%" + category + "%"))

  const subcategory = textValue(input.subcategory)
  if (subcategory) conditions.push(ilike(subcategories.name, "%" + subcategory + "%"))

  const limit = clampLimit(input.limit)
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      images: products.images,
      category: categories.name,
      subcategory: subcategories.name,
      price: products.price,
      inventory: products.inventory,
      rating: products.rating,
      storeId: products.storeId,
      storeName: stores.name,
      subcategoryId: products.subcategoryId,
    })
    .from(products)
    .leftJoin(stores, eq(products.storeId, stores.id))
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(subcategories, eq(products.subcategoryId, subcategories.id))
    .where(conditions.length > 0 ? and(...conditions) : inArray(products.id, seededProductIds))
    .orderBy(asc(products.name))
    .limit(limit)

  return rows
}

export async function findCorpusProduct(input: {
  productId?: string
  productName?: string
}): Promise<CorpusProduct | null> {
  const productId = textValue(input.productId)
  if (productId) {
    const byId = await searchCorpusProducts({ ids: productId, limit: 1 })
    if (byId[0]) return byId[0]
  }

  const productName = textValue(input.productName)
  if (!productName) return null

  const matches = await searchCorpusProducts({ names: productName, limit: 10 })
  return matches.find((product) => normalize(product.name) === normalize(productName)) ?? matches[0] ?? null
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json().catch((): unknown => ({}))
  return isRecord(value) ? value : {}
}

export function stringValue(value: unknown): string | undefined {
  return textValue(value)
}

export function positiveQuantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1
  if (!Number.isFinite(parsed) || parsed <= 0) return 1
  return Math.max(1, Math.floor(parsed))
}

export function splitList(value: unknown): string[] {
  if (typeof value !== "string") return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 20
  if (!Number.isFinite(parsed)) return 20
  return Math.min(Math.max(Math.floor(parsed), 1), 50)
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function titleize(value: string): string {
  return value
    .split(/[\\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
}

function normalize(value: string): string {
  return titleize(value).toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
`;

const skateshopProductsRouteSource = `import { unstable_noStore as noStore } from "next/cache"

import { searchCorpusProducts } from "../_lib"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  noStore()

  const url = new URL(req.url)
  const products = await searchCorpusProducts({
    query: url.searchParams.get("query") ?? url.searchParams.get("q") ?? undefined,
    names: url.searchParams.get("names") ?? url.searchParams.get("productNames") ?? url.searchParams.get("name") ?? undefined,
    ids: url.searchParams.get("ids") ?? url.searchParams.get("productIds") ?? url.searchParams.get("productId") ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    subcategory: url.searchParams.get("subcategory") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  })

  return Response.json({
    products,
    count: products.length,
  })
}
`;

const skateshopCartRouteSource = `import { unstable_noStore as noStore } from "next/cache"
import { addToCart } from "@/lib/actions/cart"

import { findCorpusProduct, positiveQuantity, readJsonObject, stringValue } from "../_lib"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  noStore()

  const body = await readJsonObject(req)
  const product = await findCorpusProduct({
    productId: stringValue(body.productId),
    productName: stringValue(body.productName) ?? stringValue(body.name),
  })

  if (!product) {
    return Response.json({ error: "Product not found" }, { status: 404 })
  }

  const quantity = positiveQuantity(body.quantity)
  const result = await addToCart({
    productId: product.id,
    quantity,
    subcategoryId: product.subcategoryId ?? undefined,
  })

  if (result.error) {
    return Response.json({ error: result.error }, { status: 400 })
  }

  return Response.json({
    ok: true,
    product,
    quantity,
    cart: result.data,
  })
}
`;

const skateshopCheckoutDefaultsRouteSource = `export const dynamic = "force-dynamic"

// Deterministic fixture: the "default checkout details" the Layer 3 order
// conversation refers to. Read-only, so the agent can fetch it before
// proposing the approval-gated order write.
export function GET() {
  return Response.json({
    name: "Corpus Shopper",
    email: "shopper@corpus.test",
    shippingAddress: {
      line1: "1 Corpus Way",
      city: "Testville",
      state: "CA",
      postalCode: "94000",
      country: "US",
    },
    paymentMethod: "Corpus test card ending 4242",
  })
}
`

const skateshopOrdersRouteSource = `import { unstable_noStore as noStore } from "next/cache"
import { db } from "@/db"
import { addresses, orders, products } from "@/db/schema"
import { eq } from "drizzle-orm"

import { findCorpusProduct, positiveQuantity, readJsonObject, stringValue } from "../_lib"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  noStore()

  const body = await readJsonObject(req)
  const product = await findCorpusProduct({
    productId: stringValue(body.productId),
    productName: stringValue(body.productName) ?? stringValue(body.name),
  })

  if (!product) {
    return Response.json({ error: "Product not found" }, { status: 404 })
  }

  const quantity = positiveQuantity(body.quantity)
  if (product.inventory < quantity) {
    return Response.json({ error: "Product is out of stock" }, { status: 409 })
  }

  const insertedAddress = await db
    .insert(addresses)
    .values({
      line1: stringValue(body.line1) ?? "123 Corpus Lane",
      line2: stringValue(body.line2),
      city: stringValue(body.city) ?? "Corpus City",
      state: stringValue(body.state) ?? "CA",
      postalCode: stringValue(body.postalCode) ?? "94105",
      country: stringValue(body.country) ?? "US",
    })
    .returning({ insertedId: addresses.id })

  const addressId = insertedAddress[0]?.insertedId
  if (!addressId) {
    return Response.json({ error: "No address created" }, { status: 500 })
  }

  const item = {
    productId: product.id,
    quantity,
    price: Number(product.price),
  }
  const amount = (Number(product.price) * quantity).toFixed(2)
  const insertedOrder = await db.insert(orders).values({
    storeId: product.storeId,
    items: [item],
    quantity,
    amount,
    stripePaymentIntentId: "corpus_" + product.id + "_" + Date.now().toString(36),
    stripePaymentIntentStatus: "succeeded",
    name: stringValue(body.name) ?? "Corpus Shopper",
    email: stringValue(body.email) ?? "corpus@example.test",
    addressId,
  }).returning({ insertedId: orders.id })

  await db
    .update(products)
    .set({ inventory: product.inventory - quantity })
    .where(eq(products.id, product.id))

  return Response.json({
    ok: true,
    orderId: insertedOrder[0]?.insertedId,
    product,
    quantity,
    amount,
  })
}
`;

export async function prepareSkateshopE2eRepo(appRoot: string, logsDir: string): Promise<string[]> {
  await mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "e2e.prepare.log");
  const actions: string[] = [];

  await writeFile(
    path.join(appRoot, ".vendo/tools.json"),
    `${JSON.stringify(skateshopTools, null, 2)}\n`,
  );
  actions.push("wrote Skateshop Layer 3 tools manifest");

  await writeSkateshopCorpusRoutes(appRoot);
  actions.push("wrote Skateshop corpus API routes");

  await patchSkateshopSeed(appRoot);
  actions.push("patched Skateshop seed revalidation fail-open");

  await patchSkateshopMiddleware(appRoot);
  actions.push("patched Skateshop Clerk middleware corpus bypass");

  await patchSkateshopLayout(appRoot);
  actions.push("patched Skateshop Clerk provider corpus bypass");

  await patchSkateshopUserQuery(appRoot);
  actions.push("patched Skateshop cached user query corpus bypass");

  // The curated manifest is the server-side tool source (createActions reads
  // .vendo/tools.json); guidance lives in the tool descriptions since the old
  // handler-level instructionsExtra knob no longer exists, and the chat
  // surface ships as the corpus-mounted VendoOverlay (init wires the VendoRoot
  // provider only).
  await mountCorpusOverlay(appRoot, "src/app");
  actions.push("mounted the corpus Vendo overlay");

  await writeFile(logPath, `${actions.join("\n")}\n`);
  return [logPath];
}

async function writeSkateshopCorpusRoutes(appRoot: string): Promise<void> {
  const corpusDir = path.join(appRoot, "src/app/api/corpus");
  await mkdir(path.join(corpusDir, "products"), { recursive: true });
  await mkdir(path.join(corpusDir, "cart"), { recursive: true });
  await mkdir(path.join(corpusDir, "orders"), { recursive: true });

  await writeFile(path.join(corpusDir, "_lib.ts"), skateshopCorpusLibSource);
  await writeFile(path.join(corpusDir, "products/route.ts"), skateshopProductsRouteSource);
  await writeFile(path.join(corpusDir, "cart/route.ts"), skateshopCartRouteSource);
  await mkdir(path.join(corpusDir, "checkout-defaults"), { recursive: true });
  await writeFile(path.join(corpusDir, "orders/route.ts"), skateshopOrdersRouteSource);
  await writeFile(path.join(corpusDir, "checkout-defaults/route.ts"), skateshopCheckoutDefaultsRouteSource);
}

async function patchSkateshopSeed(appRoot: string): Promise<void> {
  const seedPath = path.join(appRoot, "src/db/seed.ts");
  await patchFile(seedPath, (source) => {
    if (source.includes("Corpus boot runs seed before the dev server is listening")) return source;
    return source.replace(
      "await revalidateItems()",
      `// Corpus boot runs seed before the dev server is listening.
  await revalidateItems().catch((error: unknown) => {
    console.warn(
      "Skipping corpus seed revalidation:",
      error instanceof Error ? error.message : String(error)
    )
  })`,
    );
  });
}

async function patchSkateshopMiddleware(appRoot: string): Promise<void> {
  const candidates = [
    path.join(appRoot, "middleware.ts"),
    path.join(appRoot, "src/middleware.ts"),
  ];
  const middlewarePath = await firstExisting(candidates);
  if (!middlewarePath) return;

  await patchFile(middlewarePath, (source) => {
    if (source.includes("isCorpusE2eRequest")) return source;
    let next = source;
    if (!next.includes("NextResponse")) {
      next = next.replace(
        /^(import \{ clerkMiddleware, createRouteMatcher \} from "@clerk\/nextjs\/server"\n)/,
        `$1import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server"\n`,
      );
    }
    next = next.replace(
      "export default clerkMiddleware((auth, req) => {",
      `function isCorpusE2eRequest(req: NextRequest): boolean {
  const pathname = req.nextUrl.pathname
  return (
    pathname === "/" ||
    req.nextUrl.searchParams.has("vendoThread") ||
    pathname.startsWith("/api/vendo") ||
    pathname.startsWith("/api/corpus")
  )
}

const skateshopClerkMiddleware = clerkMiddleware((auth, req) => {`,
    );
    return next.replace(
      "\n})\n\nexport const config = {",
      `\n})

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  if (isCorpusE2eRequest(req)) return NextResponse.next()
  return skateshopClerkMiddleware(req, event)
}

export const config = {`,
    );
  });
}

async function patchSkateshopLayout(appRoot: string): Promise<void> {
  const layoutPath = path.join(appRoot, "src/app/layout.tsx");
  await patchFile(layoutPath, (source) => {
    if (!source.includes("ClerkProvider")) return source;
    return source
      .replace('import { ClerkProvider } from "@clerk/nextjs"\n', "")
      .replace(/<ClerkProvider>\s*(<html\b)/, "$1")
      .replace(/(<\/html>)\s*<\/ClerkProvider>/, "$1");
  });
}

async function patchSkateshopUserQuery(appRoot: string): Promise<void> {
  const userQueryPath = path.join(appRoot, "src/lib/queries/user.ts");
  await patchFile(userQueryPath, (source) => {
    if (source.includes("cache(async () => null)")) return source;
    return source
      .replace('import { currentUser } from "@clerk/nextjs/server"\n', "")
      .replace("export const getCachedUser = cache(currentUser)", "export const getCachedUser = cache(async () => null)");
  });
}

async function firstExisting(filePaths: string[]): Promise<string | null> {
  for (const filePath of filePaths) {
    if (await access(filePath).then(() => true, () => false)) return filePath;
  }
  return null;
}

async function patchFile(filePath: string, patch: (source: string) => string): Promise<void> {
  const source = await readFile(filePath, "utf8");
  const next = patch(source);
  if (next !== source) {
    await writeFile(filePath, next);
  }
}
