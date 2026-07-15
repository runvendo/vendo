import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrpcBinding } from "../formats.js";
import { runExtractors } from "./extractors.js";
import { detectTrpc, extractTrpc } from "./trpc.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryHost(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-trpc-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeFile(root: string, relative: string, source: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

/** A Rallly-shaped fixture: app-router mount, src/ tsconfig alias, superjson
 * transformer, mergeRouters root, nested + imported routers, zod inputs. */
async function writeTrpcHost(root: string): Promise<void> {
  await writeFile(root, "package.json", JSON.stringify({
    name: "trpc-host",
    dependencies: { "@trpc/server": "^11.0.0", next: "16.0.0", zod: "^4.0.0" },
  }));
  await writeFile(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { paths: { "@/*": ["./src/*"] } },
  }));
  await writeFile(root, "src/app/api/trpc/[trpc]/route.ts", `
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/trpc/routers";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => ({}),
  });

export { handler as GET, handler as POST };
`);
  await writeFile(root, "src/trpc/init.ts", `
import { initTRPC } from "@trpc/server";
import superjson from "superjson";

const t = initTRPC.create({ transformer: superjson });
export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;
`);
  await writeFile(root, "src/trpc/routers/index.ts", `
import { mergeRouters, router } from "../init";
import { polls } from "./polls";
import { user } from "./user";

export const appRouter = mergeRouters(router({ polls, user }));
export type AppRouter = typeof appRouter;
`);
  await writeFile(root, "src/trpc/routers/polls.ts", `
import * as z from "zod";
import { publicProcedure, router } from "../init";
import { comments } from "./polls/comments";
import { pollIdSchema } from "./polls/schema";

export const polls = router({
  comments,
  list: publicProcedure
    .input(z.object({
      status: z.enum(["open", "closed"]).optional(),
      search: z.string().trim().optional(),
      cursor: z.number().optional().default(1),
      limit: z.number().default(20),
    }))
    .query(() => []),
  create: publicProcedure
    .input(z.object({ title: z.string().min(1), options: z.array(z.string()) }))
    .mutation(() => ({})),
  delete: publicProcedure
    .input(pollIdSchema)
    .mutation(() => ({})),
  reindex: publicProcedure.mutation(() => ({})),
  watch: publicProcedure.subscription(() => ({})),
});
`);
  await writeFile(root, "src/trpc/routers/polls/comments.ts", `
import * as z from "zod";
import { publicProcedure, router } from "../../init";

export const comments = router({
  add: publicProcedure
    .input(z.object({ pollId: z.string(), text: z.string().max(280) }))
    .mutation(() => ({})),
});
`);
  await writeFile(root, "src/trpc/routers/polls/schema.ts", `
import * as z from "zod";
export const pollIdSchema = z.object({ pollId: z.string() });
`);
  await writeFile(root, "src/trpc/routers/user.ts", `
import { customValidator } from "@some/validator-lib";
import { publicProcedure, router } from "../init";

export const user = router({
  get: publicProcedure.query(() => ({})),
  update: publicProcedure.input(customValidator).mutation(() => ({})),
});
`);
}

describe("detectTrpc", () => {
  it("detects the @trpc/server dependency", async () => {
    const root = await temporaryHost();
    await writeTrpcHost(root);
    expect(await detectTrpc(root)).toBe(true);
  });

  it("stays quiet for hosts without trpc", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({ name: "plain", dependencies: { next: "16.0.0" } }));
    expect(await detectTrpc(root)).toBe(false);
  });
});

describe("extractTrpc", () => {
  it("extracts procedures across nested, merged, and imported routers", async () => {
    const root = await temporaryHost();
    await writeTrpcHost(root);
    const result = await extractTrpc(root);
    const byProcedure = new Map(result.tools.map((tool) => [(tool.binding as TrpcBinding).procedure, tool]));
    expect([...byProcedure.keys()].sort()).toEqual([
      "polls.comments.add",
      "polls.create",
      "polls.delete",
      "polls.list",
      "polls.reindex",
      "polls.watch",
      "user.get",
      "user.update",
    ]);
    for (const tool of result.tools) {
      expect(tool.binding).toMatchObject({ kind: "trpc", mount: "/api/trpc", transformer: "superjson" });
    }
  });

  it("labels risk fail-closed: read-shaped queries read, mutations write, destructive words destructive", async () => {
    const root = await temporaryHost();
    await writeTrpcHost(root);
    const { tools } = await extractTrpc(root);
    const risk = (procedure: string) =>
      tools.find((tool) => (tool.binding as TrpcBinding).procedure === procedure)?.risk;
    expect(risk("polls.list")).toBe("read");
    expect(risk("user.get")).toBe("read");
    expect(risk("polls.create")).toBe("write");
    expect(risk("polls.reindex")).toBe("write");
    expect(risk("polls.delete")).toBe("destructive");
  });

  it("interprets common zod patterns statically", async () => {
    const root = await temporaryHost();
    await writeTrpcHost(root);
    const { tools } = await extractTrpc(root);
    const list = tools.find((tool) => (tool.binding as TrpcBinding).procedure === "polls.list")!;
    expect(list.inputSchema).toMatchObject({
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "closed"] },
        search: { type: "string" },
        cursor: { type: "number", default: 1 },
        limit: { type: "number", default: 20 },
      },
    });
    expect((list.inputSchema as { required?: string[] }).required).toBeUndefined();

    const create = tools.find((tool) => (tool.binding as TrpcBinding).procedure === "polls.create")!;
    expect(create.inputSchema).toMatchObject({
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        options: { type: "array", items: { type: "string" } },
      },
      required: ["title", "options"],
    });

    // Schema imported from another module resolves through the import.
    const remove = tools.find((tool) => (tool.binding as TrpcBinding).procedure === "polls.delete")!;
    expect(remove.inputSchema).toMatchObject({
      type: "object",
      properties: { pollId: { type: "string" } },
      required: ["pollId"],
    });
  });

  it("fails closed on unrecognized validators with a permissive schema and note", async () => {
    const root = await temporaryHost();
    await writeTrpcHost(root);
    const { tools } = await extractTrpc(root);
    const update = tools.find((tool) => (tool.binding as TrpcBinding).procedure === "user.update")!;
    expect(update.inputSchema).toEqual({ type: "object", additionalProperties: true });
    expect(update.note).toContain("not statically interpreted");
    expect(update.disabled).toBeUndefined();
    expect(update.risk).toBe("write");
  });

  it("emits subscriptions disabled with a note, never silently enabled", async () => {
    const root = await temporaryHost();
    await writeTrpcHost(root);
    const result = await extractTrpc(root);
    const watch = result.tools.find((tool) => (tool.binding as TrpcBinding).procedure === "polls.watch")!;
    expect(watch.disabled).toBe(true);
    expect(watch.risk).toBe("destructive");
    expect(watch.note).toContain("subscriptions");
    expect(result.warnings.some((warning) => warning.includes("polls.watch"))).toBe(true);
  });

  it("warns and extracts nothing when no adapter mount exists", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "trpc-no-mount",
      dependencies: { "@trpc/server": "^11.0.0" },
    }));
    const result = await extractTrpc(root);
    expect(result.tools).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("no HTTP adapter mount"))).toBe(true);
  });

  it("derives the mount from a pages-router catch-all without an endpoint option", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "trpc-pages",
      dependencies: { "@trpc/server": "^10.0.0" },
    }));
    await writeFile(root, "pages/api/rpc/[trpc].ts", `
import { createNextApiHandler } from "@trpc/server/adapters/next";
import { appRouter } from "@/server/router";

export default createNextApiHandler({ router: appRouter });
`);
    await writeFile(root, "server/router.ts", `
import { initTRPC } from "@trpc/server";
import * as z from "zod";

const t = initTRPC.create();
export const appRouter = t.router({
  health: t.procedure.query(() => "ok"),
  echo: t.procedure.input(z.object({ message: z.string() })).mutation(() => "ok"),
});
`);
    const { tools } = await extractTrpc(root);
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      const binding = tool.binding as TrpcBinding;
      expect(binding.mount).toBe("/api/rpc");
      expect(binding.transformer).toBeUndefined();
    }
  });
});

describe("extractTrpc — zod breadth and router edge cases", () => {
  async function writeKitchenSinkHost(root: string): Promise<void> {
    await writeFile(root, "package.json", JSON.stringify({
      name: "trpc-sink",
      devDependencies: { "@trpc/server": "^11.0.0" },
    }));
    await writeFile(root, "pages/api/trpc/[trpc].ts", `
import { createNextApiHandler } from "@trpc/server/adapters/next";
import { appRouter } from "@/server/index";

export default createNextApiHandler({ router: appRouter });
`);
    await writeFile(root, "server/index.ts", `
export * from "./root";
`);
    await writeFile(root, "server/root.ts", `
import { initTRPC } from "@trpc/server";
import * as z from "zod";
import { sub } from "./sub";

const t = initTRPC.create();
const router = t.router;
const p = t.procedure;

const inner = router({
  ping: p.query(() => "pong"),
});

export const appRouter = t.mergeRouters(
  (router({
    sub,
    inner,
    ...inner,
    kitchen: p
      .input(z.object({
        lit: z.literal("fixed"),
        negative: z.literal(-2),
        flag: z.literal(true),
        pick: z.union([z.literal("a"), z.literal("b")]),
        disc: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("x"), value: z.number().int().min(0).max(10) }),
          z.object({ kind: z.literal("y") }),
        ]),
        bag: z.record(z.string(), z.number()),
        tags: z.array(z.string()).min(1).max(5),
        maybe: z.string().nullable(),
        soft: z.number().nullish(),
        email: z.string().email(),
        link: z.string().url(),
        id: z.string().uuid(),
        when: z.string().datetime(),
        stamp: z.date(),
        big: z.bigint(),
        empty: z.null(),
        anything: z.any(),
        mystery: z.unknown(),
        coerced: z.coerce.number(),
        fallback: z.string().default("dft"),
        opaque: z.tuple([z.string(), z.number()]),
        strange: z.string().somethingNew(),
      }))
      .mutation(() => ({})),
    bare: p.input(z.object({ list: z.array() })).query(() => []),
  }) satisfies unknown),
  notARouter,
);
`);
    await writeFile(root, "server/sub.ts", `
import { initTRPC } from "@trpc/server";

const t = initTRPC.create();
export const sub = t.router({
  echo: t.procedure.query(() => "ok"),
});
`);
  }

  it("detects trpc through devDependencies and survives a missing package.json", async () => {
    const root = await temporaryHost();
    await writeKitchenSinkHost(root);
    expect(await detectTrpc(root)).toBe(true);
    expect(await detectTrpc(path.join(root, "does-not-exist"))).toBe(false);
  });

  it("interprets the zod kitchen sink, failing closed per-property where unknown", async () => {
    const root = await temporaryHost();
    await writeKitchenSinkHost(root);
    const result = await extractTrpc(root);
    const kitchen = result.tools.find((tool) => (tool.binding as TrpcBinding).procedure === "kitchen")!;
    const schema = kitchen.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] };
    expect(schema.properties.lit).toEqual({ const: "fixed" });
    expect(schema.properties.negative).toEqual({ const: -2 });
    expect(schema.properties.flag).toEqual({ const: true });
    expect(schema.properties.pick).toEqual({ anyOf: [{ const: "a" }, { const: "b" }] });
    expect(schema.properties.disc).toMatchObject({ anyOf: [
      { type: "object", properties: { kind: { const: "x" }, value: { type: "integer", minimum: 0, maximum: 10 } } },
      { type: "object" },
    ] });
    expect(schema.properties.bag).toEqual({ type: "object", additionalProperties: { type: "number" } });
    expect(schema.properties.tags).toEqual({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 });
    expect(schema.properties.maybe).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(schema.properties.email).toEqual({ type: "string", format: "email" });
    expect(schema.properties.link).toEqual({ type: "string", format: "uri" });
    expect(schema.properties.id).toEqual({ type: "string", format: "uuid" });
    expect(schema.properties.when).toEqual({ type: "string", format: "date-time" });
    expect(schema.properties.stamp).toEqual({ type: "string", format: "date-time" });
    expect(schema.properties.big).toEqual({ type: "integer" });
    expect(schema.properties.empty).toEqual({ type: "null" });
    expect(schema.properties.anything).toEqual({});
    expect(schema.properties.mystery).toEqual({});
    expect(schema.properties.coerced).toEqual({ type: "number" });
    expect(schema.properties.fallback).toEqual({ type: "string", default: "dft" });
    // Unknown constructs fail closed to permissive per-property with a note.
    expect(schema.properties.opaque).toEqual({});
    expect(schema.properties.strange).toEqual({});
    expect(kitchen.note).toContain("opaque");
    expect(kitchen.note).toContain("strange");
    const required = schema.required ?? [];
    expect(required).not.toContain("soft");
    expect(required).not.toContain("fallback");
    expect(required).toContain("lit");

    const bare = result.tools.find((tool) => (tool.binding as TrpcBinding).procedure === "bare")!;
    expect((bare.inputSchema as { properties: Record<string, unknown> }).properties.list).toEqual({ type: "array" });
  });

  it("follows export-star re-exports, satisfies wrappers, spreads, and warns on unresolvable merges", async () => {
    const root = await temporaryHost();
    await writeKitchenSinkHost(root);
    const result = await extractTrpc(root);
    const procedures = result.tools.map((tool) => (tool.binding as TrpcBinding).procedure).sort();
    expect(procedures).toEqual(["bare", "inner.ping", "kitchen", "ping", "sub.echo"]);
    // No superjson anywhere in this host.
    for (const tool of result.tools) {
      expect((tool.binding as TrpcBinding).transformer).toBeUndefined();
    }
    expect(result.warnings.some((warning) => warning.includes("mergeRouters"))).toBe(true);
  });

  it("resolves routers imported through a default export", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "trpc-default",
      dependencies: { "@trpc/server": "^11.0.0" },
    }));
    await writeFile(root, "pages/api/trpc/[trpc].ts", `
import { createNextApiHandler } from "@trpc/server/adapters/next";
import appRouter from "@/server/router";

export default createNextApiHandler({ router: appRouter });
`);
    await writeFile(root, "server/router.ts", `
import { initTRPC } from "@trpc/server";

const t = initTRPC.create();
const appRouter = t.router({
  health: t.procedure.query(() => "ok"),
});
export default appRouter;
`);
    const { tools } = await extractTrpc(root);
    expect(tools.map((tool) => (tool.binding as TrpcBinding).procedure)).toEqual(["health"]);
  });

  it("warns when the mount router identifier cannot be resolved", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "trpc-broken",
      dependencies: { "@trpc/server": "^11.0.0" },
    }));
    await writeFile(root, "pages/api/trpc/[trpc].ts", `
import { createNextApiHandler } from "@trpc/server/adapters/next";
import { appRouter } from "missing-package-router";

export default createNextApiHandler({ router: appRouter });
`);
    const result = await extractTrpc(root);
    expect(result.tools).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("could not be statically resolved"))).toBe(true);
  });
});

describe("trpc + route-scan interplay", () => {
  it("shadows the catch-all mount route when trpc tools exist", async () => {
    const root = await temporaryHost();
    await writeTrpcHost(root);
    const result = await runExtractors(root);
    const routeTools = result.tools.filter((tool) => tool.binding.kind === "route");
    expect(routeTools.map((tool) => tool.binding.kind === "route" && tool.binding.path)).not.toContain("/api/trpc/{trpc}");
    expect(result.tools.some((tool) => tool.binding.kind === "trpc")).toBe(true);
  });
});
