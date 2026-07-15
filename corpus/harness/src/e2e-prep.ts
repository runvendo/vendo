import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  format: "vendo/tools@1",
  tools: [
    {
      name: "list_umami_websites",
      description: "List Umami websites visible to the logged-in user, including seeded Demo Blog and Demo SaaS IDs/domains.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/me/websites", argsIn: "query" },
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
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/websites/{websiteId}/metrics", argsIn: "query" },
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
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/websites/{websiteId}/pageviews", argsIn: "query" },
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
      risk: "read",
      binding: { kind: "openapi", operationId: "getUmamiRevenueReport", method: "POST", path: "/api/reports/revenue" },
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
      risk: "read",
      binding: { kind: "openapi", operationId: "getUmamiFunnelReport", method: "POST", path: "/api/reports/funnel" },
    },
  ],
};

const papermarkInstructions = [
  "This corpus run uses a deterministic Papermark fixture.",
  "Fixture user: e2e@corpus.test. Fixture team: Corpus E2E Team.",
  "Fixture documents: Corpus Q3 Board Packet.pdf, Pricing Memo.pdf, and Security Overview.pdf.",
  "Fixture dataroom: Investor Room. Fixture test recipient/viewer: analyst@example.test.",
  "Always call getTeams first and use the returned Corpus E2E Team id as teamId.",
  "For document lists, call listTeamDocuments and render a compact table with document names, status, views, links, and dataroom counts.",
  "For viewer activity, call listTeamDocuments to find the document id, then call getDocumentStats and getDocumentViews before answering.",
  "For link updates, call listDocumentLinks after finding the document id so you can identify the seeded link.",
  "For dataroom actions, call listDatarooms after getTeams so you can identify Investor Room.",
  "For every corpus prompt, fetch data before answering. Include the exact fixture names and analyst@example.test when relevant.",
  "Render a table for list asks, and render visible text that mentions viewer, visit, document, or activity for analytics asks.",
].join("\n");

const papermarkTools = {
  format: "vendo/tools@1",
  tools: [
    {
      name: "getTeams",
      description: "List Papermark teams for the logged-in user. Use this first to discover the Corpus E2E Team id.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/teams", argsIn: "query" },
    },
    {
      name: "listTeamDocuments",
      description: "List documents in a Papermark team, including seeded document names and counts for links, views, versions, and dataroom membership.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Papermark team id from getTeams." },
          query: { type: "string", description: "Optional document search query." },
          sort: { type: "string", enum: ["createdAt", "views", "name", "links", "lastViewed"] },
        },
        required: ["teamId"],
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/teams/{teamId}/documents", argsIn: "query" },
    },
    {
      name: "getDocumentStats",
      description: "Get a lightweight real Papermark view count for one document. Use after listTeamDocuments to summarize visits.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Papermark team id from getTeams." },
          documentId: { type: "string", description: "Document id from listTeamDocuments." },
        },
        required: ["teamId", "documentId"],
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/teams/{teamId}/documents/{documentId}/views-count", argsIn: "query" },
    },
    {
      name: "getDocumentViews",
      description: "List real Papermark team viewer activity. Use query=analyst@example.test for the seeded recipient when summarizing document activity.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Papermark team id from getTeams." },
          query: { type: "string", description: "Optional viewer email prefix, for example analyst@example.test." },
          pageSize: { type: "integer", minimum: 1, maximum: 100, default: 10 },
          sortBy: { type: "string", enum: ["lastViewed", "totalVisits"], default: "lastViewed" },
          sortOrder: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
        required: ["teamId"],
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/teams/{teamId}/viewers", argsIn: "query" },
    },
    {
      name: "listDocumentLinks",
      description: "List share links for one Papermark document. Use this before updating the seeded Security Overview.pdf link.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Papermark team id from getTeams." },
          documentId: { type: "string", description: "Document id from listTeamDocuments." },
        },
        required: ["teamId", "documentId"],
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/teams/{teamId}/documents/{documentId}/links", argsIn: "query" },
    },
    {
      name: "listDatarooms",
      description: "List Papermark datarooms for a team. Use this to find the seeded Investor Room dataroom id.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Papermark team id from getTeams." },
          simple: { type: "string", enum: ["true"], default: "true" },
        },
        required: ["teamId"],
        additionalProperties: false,
      },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/teams/{teamId}/datarooms", argsIn: "query" },
    },
    {
      name: "createShareLink",
      description: "Create a Papermark share link for a document. This is a write and must show approval before execution. Body example: { teamId, targetId: documentId, linkType: \"DOCUMENT_LINK\", name, allowList: [\"analyst@example.test\"], denyList: [], emailProtected: true, emailAuthenticated: false, allowDownload: false, audienceType: \"GENERAL\" }.",
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "object",
            properties: {
              teamId: { type: "string" },
              targetId: { type: "string", description: "Document id from listTeamDocuments." },
              linkType: { type: "string", enum: ["DOCUMENT_LINK"] },
              name: { type: "string" },
              allowList: { type: "array", items: { type: "string" }, default: ["analyst@example.test"] },
              denyList: { type: "array", items: { type: "string" }, default: [] },
              emailProtected: { type: "boolean", default: true },
              emailAuthenticated: { type: "boolean", default: false },
              allowDownload: { type: "boolean", default: false },
              audienceType: { type: "string", enum: ["GENERAL"], default: "GENERAL" },
            },
            required: ["teamId", "targetId", "linkType"],
            additionalProperties: true,
          },
        },
        required: ["body"],
        additionalProperties: false,
      },
      risk: "write",
      binding: { kind: "route", method: "POST", path: "/api/links", argsIn: "body" },
    },
    {
      name: "addDocumentToDataroom",
      description: "Add a Papermark document to a dataroom. This is a write and must show approval before execution.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Papermark team id from getTeams." },
          documentId: { type: "string", description: "Document id from listTeamDocuments." },
          body: {
            type: "object",
            properties: {
              dataroomId: { type: "string", description: "Investor Room id from listDatarooms." },
            },
            required: ["dataroomId"],
            additionalProperties: false,
          },
        },
        required: ["teamId", "documentId", "body"],
        additionalProperties: false,
      },
      risk: "write",
      binding: { kind: "route", method: "POST", path: "/api/teams/{teamId}/documents/{documentId}/add-to-dataroom", argsIn: "body" },
    },
    {
      name: "updateLinkSettings",
      description: "Update Papermark share link settings such as download permissions. This is a write and must show approval before execution.",
      inputSchema: {
        type: "object",
        properties: {
          linkId: { type: "string", description: "Link id from listDocumentLinks." },
          body: {
            type: "object",
            properties: {
              allowDownload: { type: "boolean", description: "Set true for download-only/download-enabled link behavior." },
              emailProtected: { type: "boolean" },
              name: { type: "string" },
            },
            additionalProperties: true,
          },
        },
        required: ["linkId", "body"],
        additionalProperties: false,
      },
      risk: "write",
      binding: { kind: "route", method: "PUT", path: "/api/links/{linkId}", argsIn: "body" },
    },
  ],
};

const papermarkSeedScript = String.raw`import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const fixtureUserEmail = "e2e@corpus.test";
const fixtureViewerEmail = "analyst@example.test";
const fixtureTeamSlug = "corpus-e2e";
const fixtureDataroomPid = "dr_corpus_investor";
const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8");

const documents = [
  { name: "Corpus Q3 Board Packet.pdf", key: "/corpus-fixtures/corpus-q3-board-packet.pdf", pages: 12, linkUrl: "corpus-q3-board-packet" },
  { name: "Pricing Memo.pdf", key: "/corpus-fixtures/pricing-memo.pdf", pages: 4, linkUrl: "corpus-pricing-memo" },
  { name: "Security Overview.pdf", key: "/corpus-fixtures/security-overview.pdf", pages: 6, linkUrl: "corpus-security-overview" },
];

async function writeFixturePdfs() {
  const dir = path.join(process.cwd(), "public", "corpus-fixtures");
  await mkdir(dir, { recursive: true });
  for (const document of documents) {
    await writeFile(path.join(process.cwd(), "public", document.key), pdfBytes);
  }
}

async function ensureDocument(teamId, ownerId, definition) {
  const existing = await prisma.document.findFirst({
    where: { teamId, name: definition.name },
  });
  const data = {
    name: definition.name,
    file: definition.key,
    originalFile: definition.key,
    type: "pdf",
    contentType: "application/pdf",
    storageType: "VERCEL_BLOB",
    numPages: definition.pages,
    ownerId,
    hiddenInAllDocuments: false,
    downloadOnly: false,
  };
  const document = existing
    ? await prisma.document.update({ where: { id: existing.id }, data })
    : await prisma.document.create({ data: { ...data, teamId } });

  const version = await prisma.documentVersion.upsert({
    where: { versionNumber_documentId: { versionNumber: 1, documentId: document.id } },
    update: {
      file: definition.key,
      originalFile: definition.key,
      type: "pdf",
      contentType: "application/pdf",
      storageType: "VERCEL_BLOB",
      fileSize: BigInt(pdfBytes.length),
      numPages: definition.pages,
      isPrimary: true,
      hasPages: true,
    },
    create: {
      documentId: document.id,
      versionNumber: 1,
      file: definition.key,
      originalFile: definition.key,
      type: "pdf",
      contentType: "application/pdf",
      storageType: "VERCEL_BLOB",
      fileSize: BigInt(pdfBytes.length),
      numPages: definition.pages,
      isPrimary: true,
      hasPages: true,
    },
  });

  await prisma.documentPage.upsert({
    where: { pageNumber_versionId: { pageNumber: 1, versionId: version.id } },
    update: { file: definition.key, storageType: "VERCEL_BLOB" },
    create: {
      versionId: version.id,
      pageNumber: 1,
      embeddedLinks: [],
      file: definition.key,
      storageType: "VERCEL_BLOB",
    },
  });

  return document;
}

async function ensureLink(teamId, ownerId, documentId, definition) {
  return prisma.link.upsert({
    where: { url: definition.linkUrl },
    update: {
      documentId,
      teamId,
      ownerId,
      linkType: "DOCUMENT_LINK",
      name: definition.name.replace(".pdf", " Share Link"),
      allowList: [fixtureViewerEmail],
      denyList: [],
      emailProtected: true,
      emailAuthenticated: false,
      allowDownload: false,
      isArchived: false,
      deletedAt: null,
      slug: definition.linkUrl,
    },
    create: {
      url: definition.linkUrl,
      documentId,
      teamId,
      ownerId,
      linkType: "DOCUMENT_LINK",
      name: definition.name.replace(".pdf", " Share Link"),
      allowList: [fixtureViewerEmail],
      denyList: [],
      emailProtected: true,
      emailAuthenticated: false,
      allowDownload: false,
      slug: definition.linkUrl,
    },
  });
}

async function main() {
  await writeFixturePdfs();

  const user = await prisma.user.upsert({
    where: { email: fixtureUserEmail },
    update: { name: "Corpus E2E", emailVerified: new Date("2026-07-01T00:00:00.000Z") },
    create: {
      email: fixtureUserEmail,
      name: "Corpus E2E",
      emailVerified: new Date("2026-07-01T00:00:00.000Z"),
    },
  });

  const team = await prisma.team.upsert({
    where: { slug: fixtureTeamSlug },
    update: { name: "Corpus E2E Team", plan: "datarooms-unlimited" },
    create: {
      slug: fixtureTeamSlug,
      name: "Corpus E2E Team",
      plan: "datarooms-unlimited",
      users: { create: { userId: user.id, role: "ADMIN" } },
    },
  });

  await prisma.userTeam.upsert({
    where: { userId_teamId: { userId: user.id, teamId: team.id } },
    update: { role: "ADMIN", status: "ACTIVE" },
    create: { userId: user.id, teamId: team.id, role: "ADMIN", status: "ACTIVE" },
  });

  const dataroom = await prisma.dataroom.upsert({
    where: { pId: fixtureDataroomPid },
    update: { name: "Investor Room", teamId: team.id, isFrozen: false },
    create: {
      pId: fixtureDataroomPid,
      name: "Investor Room",
      teamId: team.id,
      isFrozen: false,
    },
  });

  const viewer = await prisma.viewer.upsert({
    where: { teamId_email: { teamId: team.id, email: fixtureViewerEmail } },
    update: { verified: true, dataroomId: dataroom.id },
    create: {
      email: fixtureViewerEmail,
      verified: true,
      teamId: team.id,
      dataroomId: dataroom.id,
    },
  });

  const seededDocuments = [];
  const seededLinks = [];
  for (const definition of documents) {
    const document = await ensureDocument(team.id, user.id, definition);
    const link = await ensureLink(team.id, user.id, document.id, definition);
    seededDocuments.push({ definition, document });
    seededLinks.push({ definition, link, document });
  }

  const boardPacket = seededDocuments.find((entry) => entry.definition.name === "Corpus Q3 Board Packet.pdf");
  const securityOverview = seededDocuments.find((entry) => entry.definition.name === "Security Overview.pdf");
  for (const entry of [boardPacket, securityOverview]) {
    if (!entry) continue;
    await prisma.dataroomDocument.upsert({
      where: { dataroomId_documentId: { dataroomId: dataroom.id, documentId: entry.document.id } },
      update: {},
      create: { dataroomId: dataroom.id, documentId: entry.document.id },
    });
  }

  await prisma.view.deleteMany({
    where: { teamId: team.id, viewerEmail: fixtureViewerEmail },
  });

  const viewedAt = [
    new Date("2026-07-01T12:00:00.000Z"),
    new Date("2026-07-02T13:00:00.000Z"),
    new Date("2026-07-03T14:00:00.000Z"),
    new Date("2026-07-04T15:00:00.000Z"),
  ];
  const q3 = seededLinks.find((entry) => entry.definition.name === "Corpus Q3 Board Packet.pdf");
  const pricing = seededLinks.find((entry) => entry.definition.name === "Pricing Memo.pdf");
  const security = seededLinks.find((entry) => entry.definition.name === "Security Overview.pdf");
  const viewRows = [
    q3 ? { entry: q3, date: viewedAt[0], dataroomId: dataroom.id } : null,
    q3 ? { entry: q3, date: viewedAt[1], dataroomId: null } : null,
    pricing ? { entry: pricing, date: viewedAt[2], dataroomId: null } : null,
    security ? { entry: security, date: viewedAt[3], dataroomId: dataroom.id } : null,
  ].filter(Boolean);

  for (const row of viewRows) {
    await prisma.view.create({
      data: {
        linkId: row.entry.link.id,
        documentId: row.entry.document.id,
        dataroomId: row.dataroomId,
        teamId: team.id,
        viewerId: viewer.id,
        viewerEmail: fixtureViewerEmail,
        viewerName: "Corpus Analyst",
        verified: true,
        viewedAt: row.date,
      },
    });
  }

  console.log(JSON.stringify({
    user: user.email,
    team: team.id,
    dataroom: dataroom.id,
    documents: seededDocuments.map((entry) => entry.document.name),
    viewer: viewer.email,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
`;

const papermarkLoginRoute = String.raw`import type { NextApiRequest, NextApiResponse } from "next";
import { encode } from "next-auth/jwt";

import prisma from "@/lib/prisma";

const fixtureUserEmail = "e2e@corpus.test";
const maxAge = 60 * 60;

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return res.status(500).json({ error: "NEXTAUTH_SECRET is required for corpus login." });

  const user = await prisma.user.findUnique({ where: { email: fixtureUserEmail } });
  if (!user?.email) return res.status(404).json({ error: "Corpus fixture user is missing. Run the corpus seed first." });

  const token = await encode({
    secret,
    maxAge,
    token: {
      sub: user.id,
      email: user.email,
      name: user.name,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
    },
  });

  res.setHeader(
    "Set-Cookie",
    "next-auth.session-token=" + encodeURIComponent(token) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge,
  );
  return res.status(200).json({ ok: true, userId: user.id });
}
`;

const papermarkPremiumTeamLimitShim = `export const PREMIUM_TEAM_LIMIT = 3;

export async function getPremiumTeamEligibility(_userId: string): Promise<{
  isPremiumAdmin: boolean;
  canCreate: boolean;
  teamCount: number;
}> {
  return { isPremiumAdmin: false, canCreate: false, teamCount: 0 };
}
`;

const papermarkUnlimitedTeamLimitShim = `export async function canCreateUnlimitedTeam(_userId: string): Promise<boolean> {
  return false;
}
`;

const papermarkApiErrorShim = `export class PapermarkApiError extends Error {
  statusCode = 400;

  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "PapermarkApiError";
  }
}
`;

export async function prepareE2eRepo(
  repo: Pick<ManifestEntry, "name">,
  appRoot: string,
  logsDir: string,
): Promise<string[]> {
  if (repo.name === "express-host") return [];
  if (repo.name === "skateshop") return prepareSkateshopE2eRepo(appRoot, logsDir);
  await mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "e2e.prepare.log");
  if (repo.name === "teable") {
    return prepareTeableE2eRepo(appRoot, logPath);
  }
  if (repo.name === "papermark") {
    return preparePapermarkE2eRepo(appRoot, logPath);
  }
  if (repo.name !== "umami") return [];

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

async function prepareTeableE2eRepo(appRoot: string, logPath: string): Promise<string[]> {
  const rootApp = path.join(appRoot, "app");
  const srcApp = path.join(appRoot, "src/app");
  if (await pathExists(rootApp)) {
    if (await pathExists(srcApp)) {
      throw new Error("Teable e2e prep cannot align Vendo App Router because both app and src/app exist");
    }
    await mkdir(path.dirname(srcApp), { recursive: true });
    await rename(rootApp, srcApp);
  }
  if (!await pathExists(srcApp)) {
    throw new Error("Teable e2e prep expected Vendo init to create app or src/app");
  }

  await patchFile(path.join(srcApp, "layout.tsx"), (source) =>
    source.replace('from "../.vendo/theme.json"', 'from "../../.vendo/theme.json"'));

  const rootModel = path.join(appRoot, "lib/ai.ts");
  const srcModel = path.join(appRoot, "src/lib/ai.ts");
  if (await pathExists(rootModel)) {
    if (await pathExists(srcModel)) {
      throw new Error("Teable e2e prep cannot align Vendo model because both lib/ai.ts and src/lib/ai.ts exist");
    }
    await mkdir(path.dirname(srcModel), { recursive: true });
    await rename(rootModel, srcModel);
  }
  if (!await pathExists(srcModel)) {
    throw new Error("Teable e2e prep expected Vendo init to create lib/ai.ts or src/lib/ai.ts");
  }

  const actions = [
    "aligned Teable Vendo App Router with src/pages",
    "aligned Teable Vendo model module with the @/ alias",
  ];
  await writeFile(logPath, `${actions.join("\n")}\n`);
  return [logPath];
}

async function preparePapermarkE2eRepo(appRoot: string, logPath: string): Promise<string[]> {
  const actions: string[] = [];

  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await writeFile(
    path.join(appRoot, ".vendo/tools.json"),
    `${JSON.stringify(papermarkTools, null, 2)}\n`,
  );
  actions.push("wrote Papermark Layer 3 curated tools manifest");

  const routePath = path.join(appRoot, "app/api/vendo/[...path]/route.ts");
  await mkdir(path.dirname(routePath), { recursive: true });
  await ensureFile(routePath, `import { createVendoHandler } from "vendoai/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = createVendoHandler();
`);
  await patchFile(routePath, (source) => {
    if (source.includes("storage: false") && source.includes("instructionsExtra")) return source;
    return source.replace(
      "export const { GET, POST } = createVendoHandler();",
      `export const { GET, POST } = createVendoHandler({
  storage: false,
  maxSteps: 8,
  instructionsExtra: ${JSON.stringify(papermarkInstructions)},
});`,
    );
  });
  actions.push("patched Vendo handler for e2e-only in-memory storage and Papermark fixture guidance");

  const rootPath = path.join(appRoot, "app/vendo-root.tsx");
  await ensureFile(rootPath, `"use client";
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
`);
  await patchVendoRoot(rootPath, "Papermark");
  actions.push("patched Vendo root to accept per-attempt thread ids");

  const corpusPagePath = path.join(appRoot, "app/corpus-e2e/page.tsx");
  await mkdir(path.dirname(corpusPagePath), { recursive: true });
  await writeFile(corpusPagePath, `export default function CorpusE2ePage() {
  return (
    <main>
      <h1>Corpus Papermark E2E</h1>
      <p>Stable authenticated host page for the Papermark Layer 3 corpus run.</p>
    </main>
  );
}
`);
  actions.push("wrote Papermark App Router e2e host page");

  const layoutPath = path.join(appRoot, "app/layout.tsx");
  await patchFile(layoutPath, (source) => {
    if (source.includes("<AppVendoRoot")) return source;
    const withImport = source.includes('import { AppVendoRoot } from "./vendo-root";')
      ? source
      : `import { AppVendoRoot } from "./vendo-root";\n${source}`;
    return withImport.replace("{children}", "<AppVendoRoot>{children}</AppVendoRoot>");
  });
  actions.push("patched root layout to wrap children with AppVendoRoot");

  const loginRoutePath = path.join(appRoot, "pages/api/corpus-login.ts");
  await mkdir(path.dirname(loginRoutePath), { recursive: true });
  await writeFile(loginRoutePath, papermarkLoginRoute);
  actions.push("wrote Papermark e2e login route");

  await ensureEnvValue(path.join(appRoot, ".env"), "STRIPE_SECRET_KEY", "sk_test_corpus_e2e");
  await ensureEnvValue(path.join(appRoot, ".env"), "STRIPE_SECRET_KEY_OLD", "sk_test_corpus_e2e_old");
  actions.push("ensured Papermark dummy Stripe key for server-side module initialization");

  await writePapermarkEeLimitShims(appRoot);
  actions.push("wrote Papermark EE limit shims needed by the real team API");

  await writePapermarkApiSupportShims(appRoot);
  actions.push("wrote Papermark API support shims needed by the real document API");

  const seedPath = path.join(appRoot, "scripts/corpus-seed.mjs");
  await mkdir(path.dirname(seedPath), { recursive: true });
  await writeFile(seedPath, papermarkSeedScript);
  actions.push("wrote Papermark fixture seed");

  await patchPapermarkSeedCommand(path.join(appRoot, "package.json"));
  actions.push("patched Papermark dev:prisma to run fixture seed during deep boot");

  await writeFile(logPath, `${actions.join("\n")}\n`);
  return [logPath];
}

async function writePapermarkEeLimitShims(appRoot: string): Promise<void> {
  const limitsDir = path.join(appRoot, "ee/limits");
  await mkdir(limitsDir, { recursive: true });
  await ensureFile(
    path.join(limitsDir, "can-create-premium-team.ts"),
    papermarkPremiumTeamLimitShim,
  );
  await ensureFile(
    path.join(limitsDir, "can-create-unlimited-team.ts"),
    papermarkUnlimitedTeamLimitShim,
  );
}

async function writePapermarkApiSupportShims(appRoot: string): Promise<void> {
  await ensureFile(path.join(appRoot, "lib/api/errors.ts"), papermarkApiErrorShim);
}

async function patchVendoRoot(rootPath: string, productName: string): Promise<void> {
  await patchFile(rootPath, (source) => {
    let next = source;
    if (!next.includes("threadId={threadId}")) {
      next = next.replace(
        "export function AppVendoRoot({ children }: { children: ReactNode }) {\n  return (",
        `export function AppVendoRoot({ children }: { children: ReactNode }) {
  const threadId = typeof window === "undefined"
    ? "vendo"
    : new URLSearchParams(window.location.search).get("vendoThread") ?? "vendo";

  return (`,
      );
      next = next.replace(
        `<VendoRoot theme={theme} tools={tools} productName="${productName}">`,
        `<VendoRoot theme={theme} tools={tools} productName="${productName}" threadId={threadId}>`,
      );
    }
    return next;
  });
}

async function patchPapermarkSeedCommand(packageJsonPath: string): Promise<void> {
  const raw = await readFile(packageJsonPath, "utf8");
  const value = JSON.parse(raw) as Record<string, unknown>;
  const scripts = isRecord(value.scripts) ? { ...value.scripts } : {};
  const existing = typeof scripts["dev:prisma"] === "string"
    ? scripts["dev:prisma"]
    : "npx prisma generate && npx prisma migrate deploy";
  scripts["dev:prisma"] = existing.includes("scripts/corpus-seed.mjs")
    ? existing
    : `${existing} && node scripts/corpus-seed.mjs`;
  value.scripts = scripts;
  await writeFile(packageJsonPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function ensureEnvValue(envPath: string, key: string, value: string): Promise<void> {
  let source = "";
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (new RegExp(`^${escapeRegExp(key)}=`, "m").test(source)) return;
  const separator = source === "" || source.endsWith("\n") ? "" : "\n";
  await writeFile(envPath, `${source}${separator}${key}=${value}\n`);
}

async function patchFile(filePath: string, patch: (source: string) => string): Promise<void> {
  const source = await readFile(filePath, "utf8");
  const next = patch(source);
  if (next !== source) {
    await writeFile(filePath, next);
  }
}

async function ensureFile(filePath: string, source: string): Promise<void> {
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}
