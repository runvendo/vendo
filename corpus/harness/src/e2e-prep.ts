import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ManifestEntry } from "./manifest.js";
import { prepareSkateshopE2eRepo } from "./e2e-prep/skateshop.js";

const umamiInstructions = [
  "This corpus run uses Umami seed data for Demo Blog (blog.example.com) and Demo SaaS (app.example.com).",
  "Always call list_umami_websites first to map a requested site name or domain to its websiteId.",
  "For top pages, blog article comparisons, signup events, and referrers, call get_umami_website_metrics.",
  "For revenue questions, call get_umami_revenue_report.",
  "Use UTC. Seeded date windows: last 7 days startAt=1782691200000 endAt=1783382399000; this month startDate=2026-07-01T00:00:00.000Z endDate=2026-07-06T23:59:59.000Z; last 30 days startAt=1780704000000 endAt=1783382399000.",
  "For every corpus prompt, answer only after gathering data. The visible answer must include labels and numeric values from the Umami tool result.",
  "If you render a view, keep it compact and still summarize the key values in visible text.",
].join("\n");

const umamiRootAuthShim = `
const UMAMI_AUTH_KEY = "umami.auth";

function readUmamiAuthToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(UMAMI_AUTH_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isUmamiApiRequest(input: Parameters<typeof fetch>[0]): boolean {
  if (typeof window === "undefined") return false;
  const rawUrl = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  try {
    const url = new URL(rawUrl, window.location.href);
    return url.origin === window.location.origin
      && url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/api/vendo");
  } catch {
    return false;
  }
}

function installUmamiAuthFetch(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const token = readUmamiAuthToken();
    if (!token || !isUmamiApiRequest(input)) {
      return originalFetch(input, init);
    }

    const requestHeaders = input instanceof Request ? input.headers : undefined;
    const headers = new Headers(init.headers ?? requestHeaders);
    if (!headers.has("authorization")) {
      headers.set("authorization", \`Bearer \${token}\`);
    }
    return originalFetch(input, { ...init, headers });
  };
  return () => {
    window.fetch = originalFetch;
  };
}
`;

const umamiTools = {
  version: 1,
  tools: [
    {
      name: "list_umami_websites",
      description: "List Umami websites visible to the logged-in user, including seeded Demo Blog and Demo SaaS IDs/domains.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { mutating: false, dangerous: false, idempotent: true },
      binding: { type: "http", method: "GET", path: "/api/me/websites" },
    },
    {
      name: "get_umami_website_metrics",
      description: "Get ranked Umami metrics for one website. Use type=path for top pages, type=event for custom events such as signup_started/signup_completed, and type=referrer for acquisition sources.",
      inputSchema: {
        type: "object",
        properties: {
          websiteId: { type: "string", description: "Umami website UUID from list_umami_websites." },
          type: {
            type: "string",
            enum: ["path", "event", "referrer", "title", "hostname"],
            description: "Metric dimension to rank.",
          },
          startAt: { type: "integer", description: "UTC start time in Unix milliseconds." },
          endAt: { type: "integer", description: "UTC end time in Unix milliseconds." },
          unit: { type: "string", enum: ["day", "hour", "month"], default: "day" },
          timezone: { type: "string", default: "UTC" },
          limit: { type: "integer", default: 10, minimum: 1, maximum: 50 },
        },
        required: ["websiteId", "type", "startAt", "endAt"],
        additionalProperties: false,
      },
      annotations: { mutating: false, dangerous: false, idempotent: true },
      binding: { type: "http", method: "GET", path: "/api/websites/{websiteId}/metrics" },
    },
    {
      name: "get_umami_pageviews",
      description: "Get Umami pageview and session time series for one website over a date range.",
      inputSchema: {
        type: "object",
        properties: {
          websiteId: { type: "string", description: "Umami website UUID from list_umami_websites." },
          startAt: { type: "integer", description: "UTC start time in Unix milliseconds." },
          endAt: { type: "integer", description: "UTC end time in Unix milliseconds." },
          unit: { type: "string", enum: ["day", "hour", "month"], default: "day" },
          timezone: { type: "string", default: "UTC" },
        },
        required: ["websiteId", "startAt", "endAt"],
        additionalProperties: false,
      },
      annotations: { mutating: false, dangerous: false, idempotent: true },
      binding: { type: "http", method: "GET", path: "/api/websites/{websiteId}/pageviews" },
    },
    {
      name: "get_umami_revenue_report",
      description: "Get seeded Umami revenue totals and breakdowns for one website. Use this for Demo SaaS purchase revenue questions.",
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              websiteId: { type: "string", description: "Umami website UUID from list_umami_websites." },
              filters: { type: "object", additionalProperties: true, default: {} },
              type: { type: "string", const: "revenue" },
              parameters: {
                type: "object",
                properties: {
                  startDate: { type: "string", description: "ISO start date." },
                  endDate: { type: "string", description: "ISO end date." },
                  unit: { type: "string", enum: ["day", "hour", "month"], default: "day" },
                  timezone: { type: "string", default: "UTC" },
                  currency: { type: "string", default: "USD" },
                  compare: { type: "string", enum: ["prev", "yoy"], default: "prev" },
                },
                required: ["startDate", "endDate", "currency"],
                additionalProperties: false,
              },
            },
            required: ["websiteId", "filters", "type", "parameters"],
            additionalProperties: false,
          },
        },
        required: ["body"],
        additionalProperties: false,
      },
      annotations: { mutating: false, dangerous: false, idempotent: true },
      binding: { type: "http", method: "POST", path: "/api/reports/revenue" },
      formats: { value: "cents", total: "cents" },
    },
    {
      name: "get_umami_funnel_report",
      description: "Get an Umami funnel report for path or event steps. Use for signup_started to signup_completed conversion questions.",
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              websiteId: { type: "string", description: "Umami website UUID from list_umami_websites." },
              filters: { type: "object", additionalProperties: true, default: {} },
              type: { type: "string", const: "funnel" },
              parameters: {
                type: "object",
                properties: {
                  startDate: { type: "string", description: "ISO start date." },
                  endDate: { type: "string", description: "ISO end date." },
                  window: { type: "integer", default: 30 },
                  steps: {
                    type: "array",
                    minItems: 2,
                    maxItems: 8,
                    items: {
                      type: "object",
                      properties: {
                        type: { type: "string", enum: ["path", "event"] },
                        value: { type: "string" },
                      },
                      required: ["type", "value"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["startDate", "endDate", "window", "steps"],
                additionalProperties: false,
              },
            },
            required: ["websiteId", "filters", "type", "parameters"],
            additionalProperties: false,
          },
        },
        required: ["body"],
        additionalProperties: false,
      },
      annotations: { mutating: false, dangerous: false, idempotent: true },
      binding: { type: "http", method: "POST", path: "/api/reports/funnel" },
    },
  ],
  events: [],
};

export async function prepareE2eRepo(
  repo: Pick<ManifestEntry, "name">,
  appRoot: string,
  logsDir: string,
): Promise<string[]> {
  if (repo.name === "skateshop") return prepareSkateshopE2eRepo(appRoot, logsDir);
  if (repo.name !== "umami") return [];

  await mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "e2e.prepare.log");
  const actions: string[] = [];

  await writeFile(
    path.join(appRoot, ".vendo/tools.json"),
    `${JSON.stringify(umamiTools, null, 2)}\n`,
  );
  actions.push("wrote Umami Layer 3 read-only tools manifest");

  const routePath = path.join(appRoot, "src/app/api/vendo/[...path]/route.ts");
  await patchFile(routePath, (source) => {
    if (source.includes("storage: false") && source.includes("instructionsExtra")) return source;
    return source.replace(
      "export const { GET, POST } = createVendoHandler();",
      `export const { GET, POST } = createVendoHandler({
  storage: false,
  maxSteps: 8,
  instructionsExtra: ${JSON.stringify(umamiInstructions)},
});`,
    );
  });
  actions.push("patched Vendo handler for e2e-only in-memory storage and Umami tool guidance");

  const rootPath = path.join(appRoot, "src/app/vendo-root.tsx");
  await patchFile(rootPath, (source) => {
    let next = source;
    if (!next.includes('installUmamiAuthFetch')) {
      next = next
        .replace(
          'import type { ReactNode } from "react";',
          'import { useEffect, type ReactNode } from "react";',
        )
        .replace(
          'import tools from "../../.vendo/tools.json";',
          `import tools from "../../.vendo/tools.json";\n${umamiRootAuthShim}`,
        );
    }
    if (!next.includes("threadId={threadId}")) {
      next = next
      .replace(
        "export function AppVendoRoot({ children }: { children: ReactNode }) {\n  return (",
        `export function AppVendoRoot({ children }: { children: ReactNode }) {
  const threadId = typeof window === "undefined"
    ? "vendo"
    : new URLSearchParams(window.location.search).get("vendoThread") ?? "vendo";

  return (`,
      )
      .replace(
        '<VendoRoot theme={theme} tools={tools} productName="Umami">',
        '<VendoRoot theme={theme} tools={tools} productName="Umami" threadId={threadId}>',
      );
    }
    if (!next.includes("installUmamiAuthFetch();")) {
      next = next.replace(
        "export function AppVendoRoot({ children }: { children: ReactNode }) {",
        `export function AppVendoRoot({ children }: { children: ReactNode }) {
  useEffect(() => installUmamiAuthFetch(), []);`,
      );
    }
    return next;
  });
  actions.push("patched Vendo root to accept per-attempt thread ids and Umami auth headers");

  await writeFile(logPath, `${actions.join("\n")}\n`);
  return [logPath];
}

async function patchFile(filePath: string, patch: (source: string) => string): Promise<void> {
  const source = await readFile(filePath, "utf8");
  const next = patch(source);
  if (next !== source) {
    await writeFile(filePath, next);
  }
}
