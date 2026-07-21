import { option } from "./args.js";
import {
  resolveProjectId,
  runCommand,
  userOptions,
  type CloudCommandOptions,
} from "./command.js";

export function runKeys(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return runCommand(options, async (context) => {
    const [action] = args;
    if (!action || !["list", "create", "revoke"].includes(action)) {
      throw new Error("Usage: vendo cloud keys <list|create|revoke> --project <id>");
    }
    const projectId = await resolveProjectId(args, context);
    const root = `/api/v1/projects/${encodeURIComponent(projectId)}/keys`;
    if (action === "list") return context.fetcher(root, userOptions(args, context));
    if (action === "create") {
      const name = option(args, "--name");
      if (!name) throw new Error("Key creation requires --name <name>");
      return context.fetcher(root, {
        ...userOptions(args, context),
        method: "POST",
        body: { name },
      });
    }
    const keyId = option(args, "--id");
    if (!keyId) throw new Error("Key revocation requires --id <keyId>");
    return context.fetcher(`${root}/${encodeURIComponent(keyId)}/revoke`, {
      ...userOptions(args, context),
      method: "POST",
    });
  });
}
