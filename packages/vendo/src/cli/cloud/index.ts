import { runLogin, runLogout, runWhoami, type CloudAuthOptions } from "./auth.js";
import type { CloudCommandOptions } from "./command.js";
import { runDeviceLogin, type DeviceLoginOptions } from "./device-login.js";
import { runKeys } from "./keys.js";
import { runInvite, runMembers } from "./members.js";
import { consoleOutput } from "../shared.js";
import { runBilling, runDeployments, runOrgs, runUsage } from "./read.js";
import { runPinShip, runPublish, runShare } from "./services.js";
import { runDeploy, type CloudDeployOptions } from "./deploy.js";

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
  keys list --org <id>                  List API keys
  keys create --org <id> --name <name> Create an API key
  keys revoke --org <id> --id <keyId>  Revoke an API key
  deployments --org <id>               List deployments
  usage --org <id> [--days <days>]     Show usage (default 30 days)
  members --org <id>                   List organization members
  invite --org <id> --email <email> --role <admin|member>
  billing --org <id>                   Show billing status

Machine commands:
  deploy [--app <id>] [--secret NAME=VALUE]
                                        Deploy local enabled automations to the hosted instance
  share <appfile.json>                  Create a ShareSnapshot
  publish <appfile.json>                Create a PublishRecord
  pin-ship --app <id> --slot <slot> --base <hash> --diff <file>

Global options:
  --api-url <url>  Override VENDO_CLOUD_URL / https://console.vendo.run
  --key <vnd_...>  Override VENDO_API_KEY for machine commands
  --app <id>       Deploy only this automation (repeatable; includes disabled selections)
  --subject <id>   Local subject (required when .vendo/data contains more than one)
  --secret NAME=VALUE
                   Deploy a referenced secret value (repeatable)
  --json           JSON output (deploy defaults to a concise summary table)
`;

export type RunCloudOptions = CloudCommandOptions & CloudAuthOptions & CloudDeployOptions & DeviceLoginOptions;

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
  if (command === "deployments") return runDeployments(commandArgs, options);
  if (command === "usage") return runUsage(commandArgs, options);
  if (command === "members") return runMembers(commandArgs, options);
  if (command === "invite") return runInvite(commandArgs, options);
  if (command === "billing") return runBilling(commandArgs, options);
  if (command === "deploy") return runDeploy(commandArgs, options);
  if (command === "share") return runShare(commandArgs, options);
  if (command === "publish") return runPublish(commandArgs, options);
  if (command === "pin-ship") return runPinShip(commandArgs, options);
  output.error(`Unknown cloud command: ${command}\n\n${CLOUD_HELP}`);
  return 1;
}
