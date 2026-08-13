import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { consoleOutput, exists, stripBom, type Output, writeText } from "../shared.js";
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
  /** TTY seam (tests pin both sides). */
  isTty?: boolean;
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
  const raw = stripBom(await readFile(join(root, "package.json"), "utf8"));
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

  // Self-serve audit B6: the two questions below used to fire on a piped stdin
  // too, so a CI job or an agent wedged on a prompt nobody could ever answer.
  // Ask only where an answer can arrive; everywhere else, name both flags.
  // A flag present but blank (`--domain=`, `--domain ""`) is an ANSWER NOBODY
  // GAVE, not an answer: the option parser hands back "" for both spellings,
  // so treating it as supplied skipped the prompt on a TTY and slipped past
  // this guard everywhere else, surfacing as `Invalid registry domain:` from
  // the generator instead of the two flag names.
  const supplied = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === "" ? undefined : value;
  const suppliedDomain = supplied(options.domain);
  const suppliedUrl = supplied(options.url);
  const tty = options.isTty ?? stdin.isTTY === true;
  if (!tty && (suppliedDomain === undefined || suppliedUrl === undefined)) {
    output.error("vendo mcp server-json: --domain and --url are required non-interactively (example: vendo mcp server-json --domain example.com --url https://example.com/api/vendo/mcp)");
    return 1;
  }

  try {
    const prompt = options.prompt ?? promptOnce;
    const domain = suppliedDomain ?? await prompt("Registry domain (for example example.com): ");
    const publicUrl = suppliedUrl ?? await prompt("Public MCP URL: ");
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
