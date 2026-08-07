import { option } from "./args.js";
import {
  resolveProjectId,
  runCommand,
  userOptions,
  type CloudCommandOptions,
} from "./command.js";

export function runOrgs(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return runCommand(options, (context) => context.fetcher("/api/v1/orgs", userOptions(args, context)));
}

export function runUsage(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  const days = option(args, "--days") ?? "30";
  return runCommand(options, async (context) => {
    const projectId = await resolveProjectId(args, context);
    return context.fetcher(
      `/api/v1/projects/${encodeURIComponent(projectId)}/usage?days=${encodeURIComponent(days)}`,
      userOptions(args, context),
    );
  });
}
