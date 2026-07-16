import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerActionBinding } from "../formats.js";
import { runExtractors } from "./extractors.js";
import { detectServerActions, extractServerActions, serverActionKey, serverActionRegistrations } from "./server-actions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryHost(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-sa-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeFile(root: string, relative: string, source: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

/** A NextCRM-shaped fixture: module-level "use server" action files (typed
 * positional params, zod-inferred inputs, default exports, unclassifiable
 * wrapped exports) plus an inline action in a server component. */
async function writeServerActionsHost(root: string): Promise<void> {
  await writeFile(root, "package.json", JSON.stringify({
    name: "sa-host",
    dependencies: { next: "16.0.0", zod: "^3.23.0" },
  }));
  await writeFile(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { paths: { "@/*": ["./src/*"] } },
  }));
  // Separate action file: module-level directive, exported async functions.
  await writeFile(root, "src/actions/api-tokens.ts", `
"use server";

export async function createApiToken(data: { name: string; expiresAt?: Date }) {
  return { data };
}

export async function deleteApiToken(tokenId: string) {
  return { tokenId };
}

export const listApiTokens = async () => [];

export async function searchAccounts(query: string, limit?: number) {
  return { query, limit };
}
`);
  // Zod-validated actions, including a schema imported from a sibling module.
  await writeFile(root, "src/actions/invoices.ts", `
"use server";
import { z } from "zod";
import { updateInvoiceSchema } from "@/actions/schemas";

const createInvoiceSchema = z.object({ title: z.string().min(1), amount: z.number() });

export async function createInvoice(input: z.infer<typeof createInvoiceSchema>) {
  return input;
}

export async function updateInvoice(id: string, input: z.infer<typeof updateInvoiceSchema>) {
  return { id, input };
}
`);
  await writeFile(root, "src/actions/schemas.ts", `
import { z } from "zod";
export const updateInvoiceSchema = z.object({ status: z.enum(["draft", "sent"]) });
`);
  // Default export + FormData parameter.
  await writeFile(root, "src/actions/report.ts", `
"use server";

export default async function sendReport(formData: FormData) {
  return formData;
}
`);
  // A wrapped export the extractor cannot confirm is a function — fail closed.
  await writeFile(root, "src/actions/misc.ts", `
"use server";
import { withTelemetry } from "@/lib/telemetry";

export const wrapped = withTelemetry(async () => []);
`);
  // react cache() memoization — the export is the inner function, unwrapped.
  await writeFile(root, "src/actions/cached.ts", `
"use server";
import { cache } from "react";

export const getReports = cache(async (accountId: string) => []);
`);
  // createSafeAction(schema, handler) — one validated "data" param from the zod schema.
  await writeFile(root, "src/actions/safe.ts", `
"use server";
import { z } from "zod";
import { createSafeAction } from "@/lib/create-safe-action";

const createProductSchema = z.object({ name: z.string().min(1), sku: z.string().optional() });

const handler = async (data: z.infer<typeof createProductSchema>) => ({ data });

export const createProduct = createSafeAction(createProductSchema, handler);
`);
  // Inline action inside a component — real surface, but not importable.
  await writeFile(root, "src/app/settings/page.tsx", `
import { z } from "zod";

const SettingsCard = async () => {
  const setSmtpKey = async (formData: FormData) => {
    "use server";
    return formData;
  };
  return <form action={setSmtpKey} />;
};

export default SettingsCard;
`);
  // A cache()-wrapped server helper WITHOUT the directive is not an action.
  await writeFile(root, "src/lib/data.ts", `
import { cache } from "react";
export const getAccounts = cache(async () => []);
`);
}

describe("detectServerActions", () => {
  it("detects the next dependency", async () => {
    const root = await temporaryHost();
    await writeServerActionsHost(root);
    expect(await detectServerActions(root)).toBe(true);
  });

  it("stays quiet for hosts without next", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({ name: "plain", dependencies: { express: "^4.0.0" } }));
    expect(await detectServerActions(root)).toBe(false);
  });
});

describe("extractServerActions", () => {
  async function extractFixture(): Promise<{
    byKey: Map<string, Awaited<ReturnType<typeof extractServerActions>>["tools"][number]>;
    result: Awaited<ReturnType<typeof extractServerActions>>;
  }> {
    const root = await temporaryHost();
    await writeServerActionsHost(root);
    const result = await extractServerActions(root);
    const byKey = new Map(result.tools.map((tool) => [
      serverActionKey(tool.binding as ServerActionBinding),
      tool,
    ]));
    return { byKey, result };
  }

  it("extracts exported actions from module-level \"use server\" files", async () => {
    const { byKey } = await extractFixture();
    expect([...byKey.keys()].sort()).toEqual([
      "src/actions/api-tokens.ts#createApiToken",
      "src/actions/api-tokens.ts#deleteApiToken",
      "src/actions/api-tokens.ts#listApiTokens",
      "src/actions/api-tokens.ts#searchAccounts",
      "src/actions/cached.ts#getReports",
      "src/actions/invoices.ts#createInvoice",
      "src/actions/invoices.ts#updateInvoice",
      "src/actions/misc.ts#wrapped",
      "src/actions/report.ts#default",
      "src/actions/safe.ts#createProduct",
      "src/app/settings/page.tsx#setSmtpKey",
    ]);
  });

  it("unwraps react cache() to the inner function's parameters", async () => {
    const { byKey } = await extractFixture();
    const cached = byKey.get("src/actions/cached.ts#getReports")!;
    expect(cached.disabled).toBeUndefined();
    expect(cached.binding).toMatchObject({ exportName: "getReports", params: ["accountId"] });
    expect(cached.inputSchema).toEqual({
      type: "object",
      properties: { accountId: { type: "string" } },
      required: ["accountId"],
      additionalProperties: false,
    });
  });

  it("recognizes createSafeAction(schema, handler) as one zod-validated data parameter", async () => {
    const { byKey } = await extractFixture();
    const safe = byKey.get("src/actions/safe.ts#createProduct")!;
    expect(safe.disabled).toBeUndefined();
    expect(safe.binding).toMatchObject({ exportName: "createProduct", params: ["data"] });
    expect(safe.inputSchema).toEqual({
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: { name: { type: "string", minLength: 1 }, sku: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["data"],
      additionalProperties: false,
    });
  });

  it("binds actions by module path, export name, and ordered parameters", async () => {
    const { byKey } = await extractFixture();
    const update = byKey.get("src/actions/invoices.ts#updateInvoice")!;
    expect(update.binding).toEqual({
      kind: "server-action",
      module: "src/actions/invoices.ts",
      exportName: "updateInvoice",
      params: ["id", "input"],
    });
    expect(update.name).toBe("host_update_invoice");
  });

  it("interprets zod-inferred parameter types, including imported schemas", async () => {
    const { byKey } = await extractFixture();
    const create = byKey.get("src/actions/invoices.ts#createInvoice")!;
    expect(create.inputSchema).toEqual({
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: { title: { type: "string", minLength: 1 }, amount: { type: "number" } },
          required: ["title", "amount"],
          additionalProperties: false,
        },
      },
      required: ["input"],
      additionalProperties: false,
    });
    const update = byKey.get("src/actions/invoices.ts#updateInvoice")!;
    expect(update.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        input: {
          type: "object",
          properties: { status: { type: "string", enum: ["draft", "sent"] } },
          required: ["status"],
          additionalProperties: false,
        },
      },
      required: ["id", "input"],
      additionalProperties: false,
    });
  });

  it("interprets primitive annotations and object type literals", async () => {
    const { byKey } = await extractFixture();
    const create = byKey.get("src/actions/api-tokens.ts#createApiToken")!;
    expect(create.inputSchema).toEqual({
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: { name: { type: "string" }, expiresAt: { type: "string", format: "date-time" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["data"],
      additionalProperties: false,
    });
    const search = byKey.get("src/actions/api-tokens.ts#searchAccounts")!;
    expect(search.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    });
  });

  it("fails closed to a permissive parameter with a note for FormData", async () => {
    const { byKey } = await extractFixture();
    const report = byKey.get("src/actions/report.ts#default")!;
    expect(report.inputSchema).toEqual({
      type: "object",
      properties: { formData: {} },
      required: ["formData"],
      additionalProperties: false,
    });
    expect(report.note).toMatch(/formData/);
    expect(report.disabled).toBeUndefined();
  });

  it("labels risk fail-closed: default write, destructive words apply, no read grants", async () => {
    const { byKey } = await extractFixture();
    expect(byKey.get("src/actions/api-tokens.ts#deleteApiToken")!.risk).toBe("destructive");
    // "send" is on the destructive word list; the default-export tool is named
    // from its declared function name.
    const report = byKey.get("src/actions/report.ts#default")!;
    expect(report.risk).toBe("destructive");
    expect(report.name).toBe("host_send_report");
    // A read-shaped name never earns read: server actions default to write.
    expect(byKey.get("src/actions/api-tokens.ts#searchAccounts")!.risk).toBe("write");
    expect(byKey.get("src/actions/api-tokens.ts#listApiTokens")!.risk).toBe("write");
    expect(byKey.get("src/actions/invoices.ts#createInvoice")!.risk).toBe("write");
  });

  it("emits unclassifiable exports disabled with a note", async () => {
    const { byKey } = await extractFixture();
    const wrapped = byKey.get("src/actions/misc.ts#wrapped")!;
    expect(wrapped.disabled).toBe(true);
    expect(wrapped.risk).toBe("destructive");
    expect(wrapped.note).toMatch(/overrides\.json/);
  });

  it("emits inline actions disabled — they are not importable by the wiring", async () => {
    const { byKey } = await extractFixture();
    const inline = byKey.get("src/app/settings/page.tsx#setSmtpKey")!;
    expect(inline.disabled).toBe(true);
    expect(inline.note).toMatch(/inline/i);
  });

  it("ignores server helpers without the directive", async () => {
    const { byKey } = await extractFixture();
    expect([...byKey.keys()].some((key) => key.startsWith("src/lib/data.ts"))).toBe(false);
  });

  it("skips test and mock sources", async () => {
    const root = await temporaryHost();
    await writeServerActionsHost(root);
    await writeFile(root, "src/actions/__tests__/api-tokens.test.ts", `
"use server";
export async function phantomAction() {}
`);
    const result = await extractServerActions(root);
    expect(result.tools.some((tool) => tool.name.includes("phantom"))).toBe(false);
  });

  it("fails closed to zero tools when the TypeScript compiler is unavailable", async () => {
    // The compiler resolves from the host, falling back to our own
    // devDependency — so this only asserts extraction never throws.
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({ name: "empty", dependencies: { next: "16.0.0" } }));
    const result = await extractServerActions(root);
    expect(result.tools).toEqual([]);
  });
});

describe("serverActionRegistrations", () => {
  it("lists enabled actions only, with module and export name", async () => {
    const root = await temporaryHost();
    await writeServerActionsHost(root);
    const { tools } = await extractServerActions(root);
    const registrations = serverActionRegistrations(tools);
    expect(registrations.map((entry) => `${entry.module}#${entry.exportName}`).sort()).toEqual([
      "src/actions/api-tokens.ts#createApiToken",
      "src/actions/api-tokens.ts#deleteApiToken",
      "src/actions/api-tokens.ts#listApiTokens",
      "src/actions/api-tokens.ts#searchAccounts",
      "src/actions/cached.ts#getReports",
      "src/actions/invoices.ts#createInvoice",
      "src/actions/invoices.ts#updateInvoice",
      "src/actions/report.ts#default",
      "src/actions/safe.ts#createProduct",
    ]);
  });
});

describe("runExtractors integration", () => {
  it("registers the server-actions extractor behind the seam", async () => {
    const root = await temporaryHost();
    await writeServerActionsHost(root);
    const result = await runExtractors(root);
    const kinds = new Set(result.tools.map((tool) => tool.binding.kind));
    expect(kinds.has("server-action")).toBe(true);
  });
});
