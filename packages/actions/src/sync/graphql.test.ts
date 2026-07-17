import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphqlBinding } from "../formats.js";
import { bindingIdentity } from "./common.js";
import { runExtractors } from "./extractors.js";
import { detectGraphql, extractGraphql } from "./graphql.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryHost(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-actions-graphql-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeFile(root: string, relative: string, source: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

function binding(tool: { binding: unknown }): GraphqlBinding {
  return tool.binding as GraphqlBinding;
}

/** An SDL-first Next host: yoga route mount, split schema files, enums,
 * input objects, custom scalars, list/non-null wrappers, a subscription. */
async function writeSdlHost(root: string): Promise<void> {
  await writeFile(root, "package.json", JSON.stringify({
    name: "sdl-host",
    dependencies: { graphql: "^16.9.0", "graphql-yoga": "^5.0.0", next: "16.0.0" },
  }));
  await writeFile(root, "app/api/graphql/route.ts", `
import { createYoga } from "graphql-yoga";
import { schema } from "@/server/schema";

const yoga = createYoga({ schema, graphqlEndpoint: "/api/graphql" });
export { yoga as GET, yoga as POST };
`);
  await writeFile(root, "schema/query.graphql", `
enum PollStatus {
  OPEN
  CLOSED
}

type Comment {
  id: ID!
  text: String!
  author: User!
}

type User {
  id: ID!
  name: String!
  email: String
}

type Poll {
  id: ID!
  title: String!
  votes: Int!
  score: Float
  open: Boolean!
  status: PollStatus!
  createdAt: DateTime!
  owner: User!
  comments(first: Int): [Comment!]!
}

scalar DateTime

type Query {
  pollsList(status: PollStatus, search: String, limit: Int! = 20): [Poll!]!
  pollGet(id: ID!): Poll
  serverVersion: String!
}
`);
  await writeFile(root, "schema/mutation.graphql", `
input CreatePollInput {
  title: String!
  options: [String!]!
  tags: [String]
  status: PollStatus
}

type Mutation {
  createPoll(input: CreatePollInput!): Poll!
  renamePoll(id: ID!, title: String!): Poll!
  deletePoll(id: ID!): Boolean!
}

type Subscription {
  pollUpdated(id: ID!): Poll!
}
`);
}

/** A single-endpoint NestJS code-first host: GraphQLModule.forRoot path
 * literal, resolvers with @Args variants, input/args classes, custom scalar. */
async function writeNestHost(root: string): Promise<void> {
  await writeFile(root, "package.json", JSON.stringify({
    name: "nest-host",
    dependencies: { "@nestjs/graphql": "^12.0.0", graphql: "^16.9.0" },
  }));
  await writeFile(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { paths: { "src/*": ["./src/*"] } },
  }));
  await writeFile(root, "src/app.module.ts", `
import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";

@Module({
  imports: [
    GraphQLModule.forRoot({ autoSchemaFile: true, path: "/api/gql" }),
  ],
})
export class AppModule {}
`);
  await writeFile(root, "src/scalars.ts", `
import { GraphQLScalarType } from "graphql";
export const UUIDScalarType = new GraphQLScalarType({ name: "UUID", description: "uuid" });
`);
  await writeFile(root, "src/invoice/invoice.dto.ts", `
import { Field, Float, ID, InputType, Int, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class CustomerDto {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;
}

@ObjectType("Invoice")
export class InvoiceDto {
  @Field(() => ID)
  id: string;

  @Field()
  reference: string;

  @Field(() => Float)
  total: number;

  @Field(() => Int, { nullable: true })
  lineCount?: number;

  @Field(() => CustomerDto)
  customer: CustomerDto;
}

@InputType()
export class CreateInvoiceInput {
  @Field()
  reference: string;

  @Field(() => Float)
  total: number;

  @Field({ nullable: true })
  note?: string;
}
`);
  await writeFile(root, "src/invoice/invoice.resolver.ts", `
import { Args, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";
import { CreateInvoiceInput, InvoiceDto } from "src/invoice/invoice.dto";
import { UUIDScalarType } from "src/scalars";

@Resolver(() => InvoiceDto)
export class InvoiceResolver {
  @Query(() => [InvoiceDto])
  async invoicesList(@Args("search", { nullable: true }) search: string): Promise<InvoiceDto[]> {
    return [];
  }

  @Query(() => InvoiceDto, { nullable: true, name: "invoice" })
  async findInvoice(@Args("id", { type: () => UUIDScalarType }) id: string): Promise<InvoiceDto | null> {
    return null;
  }

  @Mutation(() => InvoiceDto)
  async createInvoice(@Args("input") input: CreateInvoiceInput): Promise<InvoiceDto> {
    return {} as InvoiceDto;
  }

  @Mutation(() => Boolean)
  async removeInvoice(@Args("id", { type: () => UUIDScalarType }) id: string): Promise<boolean> {
    return true;
  }

  @Subscription(() => InvoiceDto)
  invoiceChanged() {
    return null;
  }
}
`);
}

describe("detectGraphql", () => {
  it("detects graphql server dependencies", async () => {
    const sdl = await temporaryHost();
    await writeSdlHost(sdl);
    expect(await detectGraphql(sdl)).toBe(true);

    const nest = await temporaryHost();
    await writeNestHost(nest);
    expect(await detectGraphql(nest)).toBe(true);
  });

  it("stays quiet for hosts without graphql", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({ name: "plain", dependencies: { next: "16.0.0" } }));
    expect(await detectGraphql(root)).toBe(false);
  });
});

describe("extractGraphql — SDL sources", () => {
  it("extracts one tool per query and mutation with the route-derived endpoint", async () => {
    const root = await temporaryHost();
    await writeSdlHost(root);
    const result = await extractGraphql(root);
    const byOperation = new Map(result.tools.map((tool) => [binding(tool).operation, tool]));
    expect([...byOperation.keys()].sort()).toEqual([
      "createPoll",
      "deletePoll",
      "pollGet",
      "pollUpdated",
      "pollsList",
      "renamePoll",
      "serverVersion",
    ]);
    for (const tool of result.tools) {
      expect(binding(tool).endpoint).toBe("/api/graphql");
      expect(binding(tool).kind).toBe("graphql");
    }
    expect(binding(byOperation.get("pollsList")!).type).toBe("query");
    expect(binding(byOperation.get("createPoll")!).type).toBe("mutation");
  });

  it("labels risk fail-closed: read-shaped queries read, mutations write, destructive words destructive", async () => {
    const root = await temporaryHost();
    await writeSdlHost(root);
    const { tools } = await extractGraphql(root);
    const risk = (operation: string) => tools.find((tool) => binding(tool).operation === operation)?.risk;
    expect(risk("pollsList")).toBe("read");
    expect(risk("pollGet")).toBe("read");
    // A query without a read-shaped name never auto-earns read.
    expect(risk("serverVersion")).toBe("write");
    expect(risk("createPoll")).toBe("write");
    expect(risk("renamePoll")).toBe("write");
    expect(risk("deletePoll")).toBe("destructive");
  });

  it("derives inputSchema deterministically from argument types", async () => {
    const root = await temporaryHost();
    await writeSdlHost(root);
    const { tools } = await extractGraphql(root);
    const list = tools.find((tool) => binding(tool).operation === "pollsList")!;
    expect(list.inputSchema).toEqual({
      type: "object",
      properties: {
        status: { type: "string", enum: ["OPEN", "CLOSED"] },
        search: { type: "string" },
        limit: { type: "integer", default: 20 },
      },
      additionalProperties: false,
    });

    const create = tools.find((tool) => binding(tool).operation === "createPoll")!;
    expect(create.inputSchema).toEqual({
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            title: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["OPEN", "CLOSED"] },
          },
          required: ["title", "options"],
          additionalProperties: false,
        },
      },
      required: ["input"],
      additionalProperties: false,
    });

    const get = tools.find((tool) => binding(tool).operation === "pollGet")!;
    expect(get.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    });
  });

  it("builds executable documents with depth-limited default selection sets", async () => {
    const root = await temporaryHost();
    await writeSdlHost(root);
    const { tools } = await extractGraphql(root);
    const get = tools.find((tool) => binding(tool).operation === "pollGet")!;
    // Depth 1: Poll scalars + enum + custom scalar; depth 2: nested owner
    // scalars; arg-bearing fields (comments) are skipped.
    expect(binding(get).document).toBe(
      "query pollGet($id: ID!) { pollGet(id: $id) { id title votes score open status createdAt owner { id name email } } }",
    );

    const version = tools.find((tool) => binding(tool).operation === "serverVersion")!;
    expect(binding(version).document).toBe("query serverVersion { serverVersion }");

    const remove = tools.find((tool) => binding(tool).operation === "deletePoll")!;
    expect(binding(remove).document).toBe(
      "mutation deletePoll($id: ID!) { deletePoll(id: $id) }",
    );
  });

  it("emits subscriptions disabled with a note, never silently enabled", async () => {
    const root = await temporaryHost();
    await writeSdlHost(root);
    const result = await extractGraphql(root);
    const updated = result.tools.find((tool) => binding(tool).operation === "pollUpdated")!;
    expect(updated.disabled).toBe(true);
    expect(updated.risk).toBe("destructive");
    expect(updated.note).toContain("subscriptions");
    expect(binding(updated).type).toBe("mutation");
    expect(result.warnings.some((warning) => warning.includes("pollUpdated"))).toBe(true);
  });

  it("falls back to the default /graphql endpoint without a discoverable mount", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "sdl-bare",
      dependencies: { graphql: "^16.9.0" },
    }));
    await writeFile(root, "schema.graphql", `
type Query {
  healthGet: String!
}
`);
    const { tools } = await extractGraphql(root);
    expect(tools).toHaveLength(1);
    expect(binding(tools[0]!).endpoint).toBe("/graphql");
    expect(tools[0]!.risk).toBe("read");
  });

  it("warns and extracts nothing when no schema source exists", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "graphql-dep-only",
      dependencies: { graphql: "^16.9.0" },
    }));
    const result = await extractGraphql(root);
    expect(result.tools).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("no SDL schema or code-first resolvers"))).toBe(true);
  });

  it("skips unparsable SDL files with a warning instead of failing extraction", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "sdl-broken",
      dependencies: { graphql: "^16.9.0" },
    }));
    await writeFile(root, "schema.graphql", `type Query { ok: String! }`);
    await writeFile(root, "broken.graphql", `type { nope`);
    const result = await extractGraphql(root);
    expect(result.tools.map((tool) => binding(tool).operation)).toEqual(["ok"]);
    expect(result.warnings.some((warning) => warning.includes("broken.graphql"))).toBe(true);
  });

  it("resolves schema roots renamed through a schema definition and extend clauses", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "sdl-renamed",
      dependencies: { graphql: "^16.9.0" },
    }));
    await writeFile(root, "schema.graphql", `
schema {
  query: RootQuery
  mutation: RootMutation
}

type RootQuery {
  itemsList: [String!]!
}

type RootMutation {
  addItem(name: String!): String!
}

extend type RootQuery {
  itemGet(id: ID!): String
}
`);
    const { tools } = await extractGraphql(root);
    expect(tools.map((tool) => binding(tool).operation).sort()).toEqual(["addItem", "itemGet", "itemsList"]);
  });

  it("fails closed to a permissive per-argument schema on unknown custom scalars", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "sdl-scalar",
      dependencies: { graphql: "^16.9.0" },
    }));
    await writeFile(root, "schema.graphql", `
scalar Opaque

type Query {
  thingGet(ref: Opaque!): String
}
`);
    const { tools } = await extractGraphql(root);
    const get = tools.find((tool) => binding(tool).operation === "thingGet")!;
    expect(get.inputSchema).toEqual({
      type: "object",
      properties: { ref: {} },
      required: ["ref"],
      additionalProperties: false,
    });
    expect(get.note).toContain("Opaque");
    expect(binding(get).document).toBe("query thingGet($ref: Opaque!) { thingGet(ref: $ref) }");
  });
});

describe("extractGraphql — code-first NestJS sources", () => {
  it("extracts decorated queries and mutations with the module path endpoint", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    const result = await extractGraphql(root);
    const byOperation = new Map(result.tools.map((tool) => [binding(tool).operation, tool]));
    expect([...byOperation.keys()].sort()).toEqual([
      "createInvoice",
      "invoice",
      "invoiceChanged",
      "invoicesList",
      "removeInvoice",
    ]);
    for (const tool of result.tools) {
      expect(binding(tool).endpoint).toBe("/api/gql");
    }
    // The name option overrides the method name.
    expect(byOperation.get("invoice")).toBeDefined();
    expect(byOperation.get("findInvoice")).toBeUndefined();
  });

  it("labels code-first risk with the same fail-closed rules", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    const { tools } = await extractGraphql(root);
    const risk = (operation: string) => tools.find((tool) => binding(tool).operation === operation)?.risk;
    expect(risk("invoicesList")).toBe("read");
    expect(risk("invoice")).toBe("write");
    expect(risk("createInvoice")).toBe("write");
    expect(risk("removeInvoice")).toBe("destructive");
  });

  it("derives inputSchema from @Args decorators, input classes, and custom scalars", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    const { tools } = await extractGraphql(root);
    const list = tools.find((tool) => binding(tool).operation === "invoicesList")!;
    expect(list.inputSchema).toEqual({
      type: "object",
      properties: { search: { type: "string" } },
      additionalProperties: false,
    });

    const create = tools.find((tool) => binding(tool).operation === "createInvoice")!;
    expect(create.inputSchema).toEqual({
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            reference: { type: "string" },
            total: { type: "number" },
            note: { type: "string" },
          },
          required: ["reference", "total"],
          additionalProperties: false,
        },
      },
      required: ["input"],
      additionalProperties: false,
    });

    const get = tools.find((tool) => binding(tool).operation === "invoice")!;
    expect(get.inputSchema).toEqual({
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
      required: ["id"],
      additionalProperties: false,
    });
    expect(binding(get).document).toBe(
      "query invoice($id: UUID!) { invoice(id: $id) { id reference total lineCount customer { id name } } }",
    );
  });

  it("builds documents with class-declared GraphQL type names in variable declarations", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    const { tools } = await extractGraphql(root);
    const create = tools.find((tool) => binding(tool).operation === "createInvoice")!;
    expect(binding(create).document).toBe(
      "mutation createInvoice($input: CreateInvoiceInput!) { createInvoice(input: $input) { id reference total lineCount customer { id name } } }",
    );
    const remove = tools.find((tool) => binding(tool).operation === "removeInvoice")!;
    expect(binding(remove).document).toBe(
      "mutation removeInvoice($id: UUID!) { removeInvoice(id: $id) }",
    );
  });

  it("gives list-returning operations the same selection depth as single-object ones", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    const { tools } = await extractGraphql(root);
    // [InvoiceDto] must keep the nested customer selection exactly like the
    // bare InvoiceDto return — the list wrapper is not a nesting level.
    const list = tools.find((tool) => binding(tool).operation === "invoicesList")!;
    expect(binding(list).document).toBe(
      "query invoicesList($search: String) { invoicesList(search: $search) { id reference total lineCount customer { id name } } }",
    );
  });

  it("keeps the list wrapper for Array<T> generic argument annotations", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "nest-array-generic",
      dependencies: { "@nestjs/graphql": "^12.0.0", graphql: "^16.9.0" },
    }));
    await writeFile(root, "src/tags.resolver.ts", `
import { Args, Mutation, Resolver } from "@nestjs/graphql";

@Resolver()
export class TagsResolver {
  @Mutation(() => Boolean)
  applyTags(@Args("tags") tags: Array<string>, @Args("names") names: string[]): boolean {
    return true;
  }
}
`);
    const { tools } = await extractGraphql(root);
    const apply = tools.find((tool) => binding(tool).operation === "applyTags")!;
    expect(apply.inputSchema).toEqual({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        names: { type: "array", items: { type: "string" } },
      },
      required: ["tags", "names"],
      additionalProperties: false,
    });
    expect(binding(apply).document).toBe(
      "mutation applyTags($tags: [String!]!, $names: [String!]!) { applyTags(tags: $tags, names: $names) }",
    );
  });

  it("emits code-first subscriptions disabled with a note", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    const { tools } = await extractGraphql(root);
    const changed = tools.find((tool) => binding(tool).operation === "invoiceChanged")!;
    expect(changed.disabled).toBe(true);
    expect(changed.risk).toBe("destructive");
    expect(changed.note).toContain("subscriptions");
  });

  it("disables every operation when multiple GraphQL endpoints defeat static attribution", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    // A second GraphQL module whose factory declares another endpoint — the
    // Twenty shape (core /graphql + metadata /metadata + admin schemas).
    await writeFile(root, "src/metadata.module-factory.ts", `
export const metadataModuleFactory = () => {
  return {
    autoSchemaFile: true,
    path: "/metadata",
  };
};
`);
    await writeFile(root, "src/metadata.module.ts", `
import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { metadataModuleFactory } from "src/metadata.module-factory";

@Module({
  imports: [
    GraphQLModule.forRootAsync({ useFactory: metadataModuleFactory }),
  ],
})
export class MetadataModule {}
`);
    const result = await extractGraphql(root);
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.disabled).toBe(true);
      expect(tool.note).toContain("endpoint");
    }
    // Risk labels still apply to disabled tools.
    expect(result.tools.find((tool) => binding(tool).operation === "removeInvoice")!.risk).toBe("destructive");
    expect(result.warnings.some((warning) => warning.includes("/metadata"))).toBe(true);
  });

  it("fails closed with a permissive schema and note when an argument cannot be interpreted", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "nest-opaque",
      dependencies: { "@nestjs/graphql": "^12.0.0", graphql: "^16.9.0" },
    }));
    await writeFile(root, "src/thing.resolver.ts", `
import { Args, Query, Resolver } from "@nestjs/graphql";
import { mysteryValidator } from "@somewhere/else";

@Resolver()
export class ThingResolver {
  @Query(() => String)
  thingFind(@Args("filter", { type: () => mysteryValidator }) filter: unknown): string {
    return "";
  }
}
`);
    const result = await extractGraphql(root);
    const find = result.tools.find((tool) => binding(tool).operation === "thingFind")!;
    // The argument's GraphQL type name cannot be declared, so the document is
    // not executable: fail closed to disabled, never guess a wire type.
    expect(find.disabled).toBe(true);
    expect(find.note).toContain("filter");
  });

  it("treats graphql-type-json imports as the JSON scalar", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "nest-json",
      dependencies: { "@nestjs/graphql": "^12.0.0", graphql: "^16.9.0", "graphql-type-json": "^0.3.2" },
    }));
    await writeFile(root, "src/config.resolver.ts", `
import { Args, Query, Resolver } from "@nestjs/graphql";
import graphqlTypeJson from "graphql-type-json";

@Resolver()
export class ConfigResolver {
  @Query(() => graphqlTypeJson)
  configGet(@Args("section", { type: () => graphqlTypeJson, nullable: true }) section: unknown): unknown {
    return {};
  }
}
`);
    const { tools } = await extractGraphql(root);
    const get = tools.find((tool) => binding(tool).operation === "configGet")!;
    expect(get.disabled).toBeUndefined();
    expect(get.inputSchema).toEqual({
      type: "object",
      properties: { section: {} },
      additionalProperties: false,
    });
    expect(binding(get).document).toBe("query configGet($section: JSON) { configGet(section: $section) }");
  });

  it("expands @Args() args-classes into per-field arguments", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "nest-argsclass",
      dependencies: { "@nestjs/graphql": "^12.0.0", graphql: "^16.9.0" },
    }));
    await writeFile(root, "src/search.args.ts", `
import { ArgsType, Field, Int } from "@nestjs/graphql";

@ArgsType()
export class SearchArgs {
  @Field()
  term: string;

  @Field(() => Int, { nullable: true })
  limit?: number;
}
`);
    await writeFile(root, "src/search.resolver.ts", `
import { Args, Query, Resolver } from "@nestjs/graphql";
import { SearchArgs } from "./search.args";

@Resolver()
export class SearchResolver {
  @Query(() => [String])
  searchList(@Args() args: SearchArgs): string[] {
    return [];
  }
}
`);
    const result = await extractGraphql(root);
    const search = result.tools.find((tool) => binding(tool).operation === "searchList")!;
    expect(search.inputSchema).toEqual({
      type: "object",
      properties: {
        term: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["term"],
      additionalProperties: false,
    });
    expect(binding(search).document).toBe(
      "query searchList($term: String!, $limit: Int) { searchList(term: $term, limit: $limit) }",
    );
  });
});

describe("graphql + route-scan interplay", () => {
  it("shadows the yoga route handler when graphql tools exist for that endpoint", async () => {
    const root = await temporaryHost();
    await writeSdlHost(root);
    const result = await runExtractors(root);
    expect(result.tools.some((tool) => tool.binding.kind === "route" && tool.binding.path.startsWith("/api/graphql"))).toBe(false);
    expect(result.tools.some((tool) => tool.binding.kind === "graphql")).toBe(true);
  });

  it("keeps a query and a mutation that share one field name as two tools", async () => {
    const root = await temporaryHost();
    await writeFile(root, "package.json", JSON.stringify({
      name: "sdl-shared-name",
      dependencies: { graphql: "^16.9.0" },
    }));
    await writeFile(root, "schema.graphql", `
type Query {
  sync: String!
}

type Mutation {
  sync(force: Boolean): String!
}
`);
    const { tools } = await extractGraphql(root);
    const shared = tools.filter((tool) => binding(tool).operation === "sync");
    expect(shared).toHaveLength(2);
    expect(shared.map((tool) => binding(tool).type).sort()).toEqual(["mutation", "query"]);
    // Distinct dedup identities and distinct provider-safe names survive the
    // sync union unchanged.
    expect(new Set(shared.map((tool) => bindingIdentity(tool.binding))).size).toBe(2);
    expect(new Set(shared.map((tool) => tool.name)).size).toBe(2);
  });

  it("keeps SDL and code-first from double-describing one operation", async () => {
    const root = await temporaryHost();
    await writeNestHost(root);
    await writeFile(root, "schema.gql", `
type Query {
  invoicesList(search: String): [String!]!
}
`);
    const { tools } = await extractGraphql(root);
    expect(tools.filter((tool) => binding(tool).operation === "invoicesList")).toHaveLength(1);
  });
});
