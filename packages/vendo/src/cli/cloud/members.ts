import { option } from "./args.js";
import {
  resolveOrgId,
  runCommand,
  userOptions,
  type CloudCommandOptions,
} from "./command.js";

export function runMembers(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return runCommand(options, async (context) => {
    const orgId = await resolveOrgId(args, context);
    return context.fetcher(
      `/api/v1/orgs/${encodeURIComponent(orgId)}/members`,
      userOptions(args, context),
    );
  });
}

export function runInvite(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return runCommand(options, async (context) => {
    const email = option(args, "--email");
    const role = option(args, "--role");
    if (!email) throw new Error("Inviting a member requires --email <email>");
    if (role !== "admin" && role !== "member") {
      throw new Error("Inviting a member requires --role <admin|member>");
    }
    const orgId = await resolveOrgId(args, context);
    return context.fetcher(`/api/v1/orgs/${encodeURIComponent(orgId)}/invites`, {
      ...userOptions(args, context),
      method: "POST",
      body: { email, role },
    });
  });
}
