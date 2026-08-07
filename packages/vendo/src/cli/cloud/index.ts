import { runLogin, runLogout, runWhoami, type CloudAuthOptions } from "./auth.js";
import type { CloudCommandOptions } from "./command.js";
import { runDeviceLogin, type DeviceLoginOptions } from "./device-login.js";
import { runKeys } from "./keys.js";
import { runInvite, runMembers } from "./members.js";
import { consoleOutput } from "../shared.js";
import { runOrgs, runUsage } from "./read.js";

const CLOUD_HELP = `vendo cloud — Vendo Cloud API client

Usage: vendo cloud <command> [options]

User commands:
  device-login [EMAIL]                  alias of \`vendo login\` — the auth.md user-claimed
                                        flow: your human approves a code in the browser;
                                        the minted VENDO_API_KEY is written to .env.local
                                        (never printed)
  login EMAIL                           Fallback: send an email OTP (6-10 digits) and prompt for it
  login --token <jwt>                   Fallback: store an access token directly
  logout                               Delete the stored cloud session
  whoami [--token <jwt>]                List organizations for the current user
  orgs                                  List organizations
  keys list --project <id>              List API keys
  keys create --project <id> --name <name>  Create an API key
  keys revoke --project <id> --id <keyId>   Revoke an API key
  usage --project <id> [--days <days>]  Show usage (default 30 days)
  members --org <id>                   List organization members
  invite --org <id> --email <email> --role <admin|member>

Global options:
  --api-url <url>  Override VENDO_CLOUD_URL / https://console.vendo.run
  --json           JSON output
`;

export type RunCloudOptions = CloudCommandOptions & CloudAuthOptions & DeviceLoginOptions;

export async function runCloud(args: string[], options: RunCloudOptions = {}): Promise<number> {
  const [command, ...commandArgs] = args;
  const output = options.output ?? consoleOutput;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    output.log(CLOUD_HELP);
    return 0;
  }
  if (command === "login") return runLogin(commandArgs, options);
  if (command === "device-login") return runDeviceLogin(commandArgs, options);
  if (command === "logout") return runLogout(commandArgs, options);
  if (command === "whoami") return runWhoami(commandArgs, options);
  if (command === "orgs") return runOrgs(commandArgs, options);
  if (command === "keys") return runKeys(commandArgs, options);
  if (command === "usage") return runUsage(commandArgs, options);
  if (command === "members") return runMembers(commandArgs, options);
  if (command === "invite") return runInvite(commandArgs, options);
  output.error(`Unknown cloud command: ${command}\n\n${CLOUD_HELP}`);
  return 1;
}
