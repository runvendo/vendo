import { consoleOutput, type Output } from "../shared.js";
import { runServerJson } from "./server-json.js";
import { runVerifyDomain } from "./verify-domain.js";

const HELP = `vendo mcp — MCP registry discovery tooling\n\nUsage:\n  vendo mcp server-json [dir] --domain <domain> --url <public-mcp-url> [--force]\n  vendo mcp verify-domain [dir] --domain <domain> --key-out <path> [--write-well-known <dir>]\n\nCommands:\n  vendo mcp server-json    Generate and validate the official registry server.json\n  vendo mcp verify-domain Generate Ed25519 DNS and HTTP domain-verification material\n`;

export interface McpOptions {
  output?: Output;
}

const VALUE_OPTIONS = new Set(["--domain", "--url", "--key-out", "--write-well-known"]);

function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) {
    const value = args[exact + 1];
    return value !== undefined && !value.startsWith("--") ? value : undefined;
  }
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function target(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (VALUE_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("--")) return value;
  }
  return process.cwd();
}

export async function runMcp(args: string[], options: McpOptions = {}): Promise<number> {
  const output = options.output ?? consoleOutput;
  const [command, ...commandArgs] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    output.log(HELP);
    return 0;
  }
  if (command === "server-json") {
    return runServerJson({
      targetDir: target(commandArgs),
      domain: option(commandArgs, "--domain"),
      url: option(commandArgs, "--url"),
      force: commandArgs.includes("--force"),
      output,
    });
  }
  if (command === "verify-domain") {
    return runVerifyDomain({
      targetDir: target(commandArgs),
      domain: option(commandArgs, "--domain"),
      keyOut: option(commandArgs, "--key-out"),
      writeWellKnown: option(commandArgs, "--write-well-known"),
      output,
    });
  }
  output.error(`Unknown mcp command: ${command}\n\n${HELP}`);
  return 1;
}
