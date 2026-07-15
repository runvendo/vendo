import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ManifestEntry } from "./manifest.js";
import { mountCorpusOverlay } from "./e2e-prep/overlay-mount.js";
import { vendoRouteFilePath } from "./e2e-prep/route-path.js";
import { prepareSkateshopE2eRepo } from "./e2e-prep/skateshop.js";

// Umami authenticates its API with a Bearer token the app keeps in
// localStorage. Chat tool calls now execute SERVER-side (route bindings,
// 04 §4), and the registry forwards the WIRE request's cookie/authorization
// headers to same-origin bindings when VENDO_BASE_URL is operator-set — so
// the shim attaches the Bearer to every same-origin /api/ request INCLUDING
// /api/vendo, and prep pins VENDO_BASE_URL in the fixture .env.
const umamiAuthShim = `
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
    // Includes /api/vendo on purpose: the Vendo wire forwards
    // cookie/authorization to same-origin route bindings, which is how the
    // server-side Umami tool calls authenticate.
    return url.origin === window.location.origin
      && url.pathname.startsWith("/api/");
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

// A curated endpoint expressed through the overrides channel: matched to init's
// extraction by binding (method + path), then given the reviewed description +
// risk. The overrides file only carries description/risk/disabled (04 §1), so
// every schema hint the agent needs — required args, seeded windows, request
// body shape, cents units — lives in the description prose, the same way the
// Papermark curated surface encodes its write-tool bodies.
interface CuratedEndpoint {
  binding: { method: string; path: string };
  // "read" | "write"; validated against riskLabelSchema when overrides load.
  risk: string;
  description: string;
}

// Shared fixture framing prepended to every curated Umami description so the
// seeded sites/windows guidance survives without a handler-level knob.
const umamiFixtureNote =
  "Deterministic Umami corpus fixture: seeded sites Demo Blog (blog.example.com) and "
  + "Demo SaaS (app.example.com). Call list_umami_websites first to map a requested site "
  + "name or domain to its websiteId, fetch data before answering, and quote the exact "
  + "labels and numeric values from the tool results.";

const umamiCuratedTools: readonly CuratedEndpoint[] = [
  {
    binding: { method: "GET", path: "/api/me/websites" },
    risk: "read",
    description:
      "List Umami websites visible to the logged-in user, including the seeded Demo Blog "
      + "(blog.example.com) and Demo SaaS (app.example.com) ids and domains. Always call this "
      + "first to resolve a requested site name or domain to its websiteId.",
  },
  {
    binding: { method: "GET", path: "/api/websites/{websiteId}/metrics" },
    risk: "read",
    description:
      "Get ranked Umami metrics for one website. Pass query args websiteId, type, startAt, endAt. "
      + "Use type=path for top pages, type=event for custom events such as "
      + "signup_started/signup_completed, type=referrer for acquisition sources, and "
      + "type=title/hostname where relevant. Use UTC with the seeded windows: last 7 days "
      + "startAt=1782691200000 endAt=1783382399000; last 30 days startAt=1780704000000 "
      + "endAt=1783382399000. Optional unit (day/hour/month), timezone (default UTC), and limit "
      + "(default 10).",
  },
  {
    binding: { method: "GET", path: "/api/websites/{websiteId}/pageviews" },
    risk: "read",
    description:
      "Get the Umami pageview and session time series for one website over a date range. Pass "
      + "query args websiteId, startAt, endAt. Use UTC with the seeded windows: last 7 days "
      + "startAt=1782691200000 endAt=1783382399000; last 30 days startAt=1780704000000 "
      + "endAt=1783382399000. Optional unit (day/hour/month) and timezone (default UTC).",
  },
  {
    binding: { method: "POST", path: "/api/reports/revenue" },
    risk: "read",
    description:
      "Get seeded Umami revenue totals and breakdowns for one website; use it for Demo SaaS "
      + "purchase-revenue questions. Send the request body "
      + '{ websiteId, filters: {}, type: "revenue", parameters: { startDate, endDate, '
      + 'currency: "USD", timezone: "UTC" } } using the seeded this-month window (UTC) '
      + "startDate=2026-07-01T00:00:00.000Z endDate=2026-07-06T23:59:59.000Z. Revenue amounts are "
      + "returned in integer cents — divide by 100 for dollar figures.",
  },
  {
    binding: { method: "POST", path: "/api/reports/funnel" },
    risk: "read",
    description:
      "Get an Umami funnel report for path or event steps; use it for signup_started to "
      + "signup_completed conversion questions. Send the request body "
      + '{ websiteId, filters: {}, type: "funnel", parameters: { startDate, endDate, window: 30, '
      + 'steps: [{ type: "event", value: "signup_started" }, { type: "event", value: '
      + '"signup_completed" }] } } using the seeded this-month window (UTC) '
      + "startDate=2026-07-01T00:00:00.000Z endDate=2026-07-06T23:59:59.000Z.",
  },
];

// Shared fixture framing prepended to every curated Papermark description so
// the guidance survives without the old handler-level instructionsExtra knob
// (the descriptions are what the agent sees).
const papermarkFixtureNote =
  "Deterministic Papermark corpus fixture: user e2e@corpus.test, team Corpus E2E Team, "
  + "documents Corpus Q3 Board Packet.pdf / Pricing Memo.pdf / Security Overview.pdf, "
  + "dataroom Investor Room, test recipient analyst@example.test. "
  + "Fetch data before answering and quote the exact fixture names.";

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

  // Umami's init-installed dev/build hooks run `vendo sync` (`predev`,
  // `prebuild --strict`), which re-extracts and diffs against .vendo/tools.json.
  // A curated manifest written INTO tools.json is therefore clobbered on the
  // next boot back to the ~147 generic host_* route-scan tools. So the pin
  // stays exactly what init extracted, and the curation ships through
  // .vendo/overrides.json — the human channel both sync (symmetric merge, no
  // diff) and the runtime registry (description/risk/disabled) respect.
  await writeCuratedOverrides({
    appRoot,
    curatedTools: umamiCuratedTools,
    fixtureNote: umamiFixtureNote,
    repoLabel: "Umami",
  });
  actions.push("kept .vendo/tools.json pinned to init's extraction; wrote curated overrides.json (descriptions/risk for the 5 fixture endpoints, everything else disabled)");

  // Credential forwarding to route bindings requires a TRUSTED operator-set
  // base URL (04 §4); a learned origin never receives the caller's headers.
  await ensureEnvValue(path.join(appRoot, ".env"), "VENDO_BASE_URL", "http://127.0.0.1:3000");
  actions.push("pinned VENDO_BASE_URL so the wire forwards Umami Bearer auth to route bindings");

  await mountCorpusOverlay(appRoot, "src/app", {
    moduleSource: umamiAuthShim,
    effect: "installUmamiAuthFetch()",
  });
  actions.push("mounted the corpus Vendo overlay with the Umami auth fetch shim");

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

  // Teable's Nest backend embeds the Next app with the backend directory as
  // process.cwd(); next-i18next resolves its user config from cwd, so every
  // page render (including /auth/login readiness) 500s unless the config sits
  // beside the backend. The config resolves its own locale paths relative to
  // cwd and works unchanged from apps/nestjs-backend.
  const i18nConfig = path.join(appRoot, "next-i18next.config.js");
  const backendRoot = path.join(path.dirname(appRoot), "nestjs-backend");
  if (!await pathExists(i18nConfig)) {
    throw new Error("Teable e2e prep expected apps/nextjs-app/next-i18next.config.js to exist");
  }
  await mkdir(backendRoot, { recursive: true });
  await copyFile(i18nConfig, path.join(backendRoot, "next-i18next.config.js"));

  const actions = [
    "aligned Teable Vendo App Router with src/pages",
    "aligned Teable Vendo model module with the @/ alias",
    "copied next-i18next.config.js beside the Nest backend",
  ];
  await writeFile(logPath, `${actions.join("\n")}\n`);
  return [logPath];
}

async function preparePapermarkE2eRepo(appRoot: string, logPath: string): Promise<string[]> {
  const actions: string[] = [];

  // Papermark is the one npm-driven deep fixture, so `npm run build` / `npm
  // run dev` execute the init-installed `vendo sync` hooks (`--strict` on
  // build). sync re-extracts and diffs against the .vendo/tools.json pin,
  // which means the curated Layer 3 manifest can never live IN tools.json
  // here: replacing the pin read as 9 breaking tool renames (exit 2) once
  // ENG-242's widened extraction covered these endpoints. The pin therefore
  // stays exactly what init extracted, and the curation ships as
  // .vendo/overrides.json — the human-written channel that both sync
  // (symmetric merge, no diff) and the runtime registry (description/risk/
  // disabled) respect.
  await writePapermarkOverrides(appRoot);
  actions.push("kept .vendo/tools.json pinned to init's extraction; wrote curated overrides.json (descriptions/risk for the 9 fixture endpoints, everything else disabled)");

  const routePath = await vendoRouteFilePath(appRoot, "app");
  await mkdir(path.dirname(routePath), { recursive: true });
  await ensureFile(routePath, `import { model } from "@/lib/ai";
import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";

const vendo = createVendo({
  model,
  principal: async () => null,
});

export const { GET, POST, DELETE } = nextVendoHandler(vendo);
`);
  actions.push("ensured the Vendo App Router handler exists (current init scaffold)");

  // Credential forwarding to route bindings requires a TRUSTED operator-set
  // base URL (04 §4); the fixture session cookie set by /api/corpus-login
  // only reaches the real Papermark API through it.
  await ensureEnvValue(path.join(appRoot, ".env"), "VENDO_BASE_URL", "http://127.0.0.1:3000");
  actions.push("pinned VENDO_BASE_URL so the wire forwards the fixture session cookie to route bindings");

  await mountCorpusOverlay(appRoot, "app");
  actions.push("mounted the corpus Vendo overlay");

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

async function writePapermarkOverrides(appRoot: string): Promise<void> {
  await writeCuratedOverrides({
    appRoot,
    curatedTools: papermarkTools.tools,
    fixtureNote: papermarkFixtureNote,
    repoLabel: "Papermark",
  });
}

/**
 * A curated deep-tier surface expressed through the overrides channel:
 * `.vendo/tools.json` stays pinned to init's extraction (so the fixture's
 * `vendo sync`/`--strict` hooks are a no-op diff), and each curated endpoint's
 * description + risk are keyed to the EXTRACTION name for that binding. Every
 * other extracted tool is disabled so the agent works only the curated surface
 * the fixture was written against. Fails loudly when extraction stops covering
 * a curated endpoint — that is a real re-pin moment, not a skip.
 */
async function writeCuratedOverrides(options: {
  appRoot: string;
  curatedTools: readonly CuratedEndpoint[];
  fixtureNote: string;
  repoLabel: string;
}): Promise<void> {
  const toolsPath = path.join(options.appRoot, ".vendo/tools.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(toolsPath, "utf8"));
  } catch {
    throw new Error(`${options.repoLabel} e2e prep expected vendo init to write .vendo/tools.json before prep runs`);
  }
  const extracted = isRecord(parsed) && Array.isArray(parsed.tools) ? parsed.tools : [];
  // Param NAMES differ between the curated bindings ({documentId}) and
  // route-scan output ({id}); match endpoints the way sync itself does
  // (dedupKey): method + path with every {param} normalized to {}.
  const endpointKey = (method: string, bindingPath: string): string =>
    `${method} ${bindingPath.replace(/\{[^}]+\}/g, "{}")}`;
  const nameByBinding = new Map<string, string>();
  const extractedNames: string[] = [];
  for (const tool of extracted) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !isRecord(tool.binding)) continue;
    extractedNames.push(tool.name);
    if (typeof tool.binding.method === "string" && typeof tool.binding.path === "string") {
      nameByBinding.set(endpointKey(tool.binding.method, tool.binding.path), tool.name);
    }
  }

  const overrides: Record<string, { risk?: string; description?: string; disabled?: boolean }> = {};
  const curatedNames = new Set<string>();
  for (const curated of options.curatedTools) {
    const endpoint = `${curated.binding.method} ${curated.binding.path}`;
    const extractedName = nameByBinding.get(endpointKey(curated.binding.method, curated.binding.path));
    if (extractedName === undefined) {
      throw new Error(`${options.repoLabel} e2e prep: extraction has no tool for curated endpoint ${endpoint}; re-pin the curated manifest against current extraction output`);
    }
    curatedNames.add(extractedName);
    overrides[extractedName] = {
      risk: curated.risk,
      description: `${options.fixtureNote} ${curated.description}`,
    };
  }
  for (const name of extractedNames) {
    if (!curatedNames.has(name)) overrides[name] = { disabled: true };
  }

  await writeFile(
    path.join(options.appRoot, ".vendo/overrides.json"),
    `${JSON.stringify({ format: "vendo/overrides@1", tools: overrides }, null, 2)}\n`,
  );
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
