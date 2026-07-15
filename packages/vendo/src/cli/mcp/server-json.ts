import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { consoleOutput, exists, type Output, writeText } from "../shared.js";
import {
  packageSlug,
  registryNamespace,
  SERVER_SCHEMA_URL,
  validateRegistryServer,
} from "./registry.js";

export interface ServerJsonOptions {
  targetDir: string;
  domain?: string;
  url?: string;
  force?: boolean;
  prompt?: (question: string) => Promise<string>;
  output?: Output;
}

interface HostIdentity {
  name: string;
  description: string;
  version: string;
  websiteUrl?: string;
}

async function promptOnce(question: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

async function hostIdentity(root: string): Promise<HostIdentity> {
  const raw = await readFile(join(root, "package.json"), "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  const name = typeof manifest.name === "string" ? manifest.name : "vendo";
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  const description = typeof manifest.description === "string" ? manifest.description : `${name} MCP server`;
  return {
    name,
    version,
    description,
    ...(typeof manifest.homepage === "string" ? { websiteUrl: manifest.homepage } : {}),
  };
}

/** 10-mcp §5 — generate the official-registry artifact from the same host
 * package.json identity the door advertises, plus explicit public discovery. */
export async function runServerJson(options: ServerJsonOptions): Promise<number> {
  const root = resolve(options.targetDir);
  const output = options.output ?? consoleOutput;
  const path = join(root, "server.json");

  if (!options.force && await exists(path)) {
    output.error("server.json already exists; pass --force to overwrite it");
    return 1;
  }

  try {
    const prompt = options.prompt ?? promptOnce;
    const domain = options.domain ?? await prompt("Registry domain (for example example.com): ");
    const publicUrl = options.url ?? await prompt("Public MCP URL: ");
    const identity = await hostIdentity(root);
    const server = {
      $schema: SERVER_SCHEMA_URL,
      name: `${registryNamespace(domain)}/${packageSlug(identity.name)}`,
      description: identity.description,
      version: identity.version,
      remotes: [{ type: "streamable-http", url: publicUrl.trim() }],
      ...(identity.websiteUrl === undefined ? {} : { websiteUrl: identity.websiteUrl }),
    };
    const errors = validateRegistryServer(server);
    if (errors.length > 0) {
      output.error(`server.json is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
      return 1;
    }
    await writeText(path, `${JSON.stringify(server, null, 2)}\n`);
    output.log(`Wrote server.json for ${server.name}`);
    return 0;
  } catch (error) {
    output.error(`Could not generate server.json: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}
