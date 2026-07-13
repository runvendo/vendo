import { readFile } from "node:fs/promises";
import { option, positionals } from "./args.js";
import { CloudError, type CloudFetchOptions } from "./client.js";
import {
  commandContext,
  type CloudCommandContext,
  type CloudCommandOptions,
} from "./command.js";
import { errorMessage, printJson } from "./output.js";

function machineOptions(args: string[], context: CloudCommandContext): CloudFetchOptions {
  return {
    auth: "key",
    apiKey: option(args, "--key"),
    apiUrl: option(args, "--api-url"),
    env: context.env,
  };
}

async function serviceCommand(
  options: CloudCommandOptions,
  operation: (context: CloudCommandContext) => Promise<unknown>,
): Promise<number> {
  const context = commandContext(options);
  try {
    printJson(context.output, await operation(context));
    return 0;
  } catch (error) {
    if (error instanceof CloudError && error.code === "cloud-required") {
      context.output.error("This key's org needs a Cloud plan (cloud-required).");
    } else {
      context.output.error(errorMessage(error));
    }
    return 1;
  }
}

async function appDocument(args: string[]): Promise<unknown> {
  const file = positionals(args, ["--key", "--api-url"])[0];
  if (!file) throw new Error("An appfile.json path is required");
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

export function runValidate(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return serviceCommand(options, (context) => context.fetcher("/api/v1/keys/validate", {
    ...machineOptions(args, context),
    method: "POST",
  }));
}

export function runShare(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return serviceCommand(options, async (context) => context.fetcher("/api/v1/apps/share", {
    ...machineOptions(args, context),
    method: "POST",
    body: await appDocument(args),
  }));
}

export function runPublish(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return serviceCommand(options, async (context) => context.fetcher("/api/v1/apps/publish", {
    ...machineOptions(args, context),
    method: "POST",
    body: await appDocument(args),
  }));
}

export function runPinShip(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return serviceCommand(options, async (context) => {
    const appId = option(args, "--app");
    const slot = option(args, "--slot");
    const baseHash = option(args, "--base");
    const diffFile = option(args, "--diff");
    if (!appId || !slot || !baseHash || !diffFile) {
      throw new Error("pin-ship requires --app <id> --slot <slot> --base <hash> --diff <file>");
    }
    return context.fetcher("/api/v1/pins/ship", {
      ...machineOptions(args, context),
      method: "POST",
      body: { appId, slot, baseHash, diff: await readFile(diffFile, "utf8") },
    });
  });
}
