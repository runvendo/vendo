import { randomBytes } from "node:crypto";
import { consoleOutput, type Output } from "./shared.js";

const HELP = `vendo service-key — keys for your OWN backend to act as one of your users over MCP\n\nUsage:\n  vendo service-key new [--name <label>] [--json]\n\nOptions:\n  --name <label>  A label for your own records; it is printed back and stored nowhere\n  --json          Print { key, name } instead of the human output\n`;

const FLAGS = new Set(["--json"]);
const VALUE_OPTIONS = ["--name"];

export interface ServiceKeyOptions {
  output?: Output;
}

export async function runServiceKey(args: string[], options: ServiceKeyOptions = {}): Promise<number> {
  const output = options.output ?? consoleOutput;
  const [command, ...commandArgs] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    output.log(HELP);
    return 0;
  }
  if (command !== "new") {
    output.error(`Unknown service-key command: ${command}\n\n${HELP}`);
    return 1;
  }
  const problems = optionErrors(commandArgs, FLAGS, VALUE_OPTIONS);
  if (problems.length > 0) {
    output.error(`vendo service-key ${command}: ${problems.join("; ")}\n\n${HELP}`);
    return 1;
  }

  // The door treats a key as an opaque string, so the only job here is enough
  // entropy and a recognizable prefix. Minted here and nowhere else: nothing is
  // written, nothing is sent, and this process is the only copy.
  const key = `vsk_${randomBytes(24).toString("hex")}`;
  const name = option(commandArgs, "--name");
  if (commandArgs.includes("--json")) {
    output.log(JSON.stringify({ key, ...(name === undefined ? {} : { name }) }));
    return 0;
  }
  output.log(`Service key${name === undefined ? "" : ` (${name})`} — copy it now. It is shown once and cannot be recovered.`);
  output.log(`\n  VENDO_SERVICE_KEY=${key}\n`);
  output.log("Vendo keeps no copy: list it on your door yourself, and rotate by listing both keys until the old one is out of use.");
  output.log("\n  createVendo({ mcp: { serviceAuth: { keys: [process.env.VENDO_SERVICE_KEY!] } } })\n");
  output.log("Your backend posts it to the door's token endpoint for one user's short-lived MCP token — https://docs.vendo.run/existing-agents/mcp");
  return 0;
}

/** ENG-335 rule: unknown flags and value flags missing their value fail
    loudly before anything runs — here, before a key nobody asked for is
    minted and the label is silently dropped. */
function optionErrors(args: string[], flags: Set<string>, valueOptions: string[]): string[] {
  const errors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    if (flags.has(arg)) continue;
    if (valueOptions.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) errors.push(`${arg} requires a value`);
      else index += 1;
      continue;
    }
    if (valueOptions.some((name) => arg.startsWith(`${name}=`))) continue;
    errors.push(`unknown option: ${arg}`);
  }
  return errors;
}

function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) {
    const value = args[exact + 1];
    return value !== undefined && !value.startsWith("--") ? value : undefined;
  }
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
