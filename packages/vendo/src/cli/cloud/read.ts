import { option } from "./args.js";
import {
  resolveOrgId,
  runCommand,
  userOptions,
  type CloudCommandOptions,
} from "./command.js";

export function runOrgs(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return runCommand(options, (context) => context.fetcher("/api/v1/orgs", userOptions(args, context)));
}

function orgRead(
  args: string[],
  options: CloudCommandOptions,
  resource: string,
  query = "",
): Promise<number> {
  return runCommand(options, async (context) => {
    const orgId = await resolveOrgId(args, context);
    return context.fetcher(
      `/api/v1/orgs/${encodeURIComponent(orgId)}/${resource}${query}`,
      userOptions(args, context),
    );
  });
}

export function runUsage(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  const days = option(args, "--days") ?? "30";
  return orgRead(args, options, "usage", `?days=${encodeURIComponent(days)}`);
}

export function runBilling(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return orgRead(args, options, "billing");
}
