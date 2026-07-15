import { readFile } from "node:fs/promises";
import { option, positionals } from "./args.js";
import { CloudError, cloudFetch, resolveCloudBaseUrl, type CloudFetchOptions } from "./client.js";
import {
  commandContext,
  type CloudCommandContext,
  type CloudCommandOptions,
} from "./command.js";
import { errorMessage, printJson, renderContract } from "./output.js";
import {
  entitlementsCacheKey,
  resolveEntitlements,
  type EntitlementResolution,
} from "./entitlements-cache.js";
import { isVendoKey, parseContractV2, type ContractV2 } from "./entitlements.js";

export function pushSyncReport(
  payload: unknown,
  options: Pick<CloudFetchOptions, "apiKey" | "apiUrl" | "env" | "fetchImpl"> = {},
): Promise<unknown> {
  return cloudFetch("/api/v1/sync/report", {
    ...options,
    auth: "key",
    method: "POST",
    body: payload,
  });
}

function machineOptions(args: string[], context: CloudCommandContext): CloudFetchOptions {
  const apiKey = option(args, "--key") ?? context.env.VENDO_API_KEY;
  if (!apiKey) throw new CloudError("missing-api-key", "Pass --key or set VENDO_API_KEY", 0);
  if (!isVendoKey(apiKey)) {
    throw new Error("Invalid API key format (expected vnd_ followed by 40 hex characters)");
  }
  return {
    auth: "key",
    apiKey,
    apiUrl: option(args, "--api-url"),
    env: context.env,
  };
}

function printServiceError(context: CloudCommandContext, error: unknown): void {
  if (error instanceof CloudError && error.code === "cloud-required") {
    context.output.error("This key's org needs a Cloud plan (cloud-required).");
  } else if (error instanceof CloudError && error.code === "http-401") {
    context.output.error("Invalid or revoked API key (401)");
  } else {
    context.output.error(errorMessage(error));
  }
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
    printServiceError(context, error);
    return 1;
  }
}

async function appDocument(args: string[]): Promise<unknown> {
  const file = positionals(args, ["--key", "--api-url", "--app"])[0];
  if (!file) throw new Error("An appfile.json path is required");
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function appRequestBody(args: string[]): Promise<{ appId: string; doc: unknown }> {
  const doc = await appDocument(args);
  const documentId = typeof doc === "object" && doc !== null
    ? (doc as { id?: unknown }).id
    : undefined;
  const appId = option(args, "--app") ?? (typeof documentId === "string" ? documentId : undefined);
  if (!appId) throw new Error("App document must have a string id or pass --app <id>");
  return { appId, doc };
}

function validateResolution(
  fetchContract: () => Promise<ContractV2>,
  cacheKey: string,
  context: CloudCommandContext,
): Promise<EntitlementResolution> {
  return resolveEntitlements(fetchContract, {
    cacheKey,
    home: context.home,
    now: context.now,
    forceRefresh: true,
  });
}

export async function runValidate(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  const context = commandContext(options);
  try {
    const fetchOptions = { ...machineOptions(args, context), method: "POST" };
    const cacheKey = entitlementsCacheKey(resolveCloudBaseUrl(fetchOptions), fetchOptions.apiKey!);
    let raw: unknown;
    try {
      raw = await context.fetcher("/api/v1/keys/validate", fetchOptions);
    } catch (error) {
      const resolution = await validateResolution(async () => { throw error; }, cacheKey, context);
      if (args.includes("--json")) {
        printJson(context.output, resolution.contract);
      } else {
        context.output.log(renderContract(resolution.contract, resolution));
      }
      return resolution.state === "degraded" ? 1 : 0;
    }

    const contract = parseContractV2(raw);
    if (!contract) {
      printJson(context.output, raw);
      return 0;
    }
    const resolution = await validateResolution(async () => contract, cacheKey, context);
    if (args.includes("--json")) {
      printJson(context.output, raw);
    } else {
      context.output.log(renderContract(resolution.contract, resolution));
    }
    return 0;
  } catch (error) {
    printServiceError(context, error);
    return 1;
  }
}

export function runShare(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return serviceCommand(options, async (context) => context.fetcher("/api/v1/apps/share", {
    ...machineOptions(args, context),
    method: "POST",
    body: await appRequestBody(args),
  }));
}

export function runPublish(args: string[], options: CloudCommandOptions = {}): Promise<number> {
  return serviceCommand(options, async (context) => context.fetcher("/api/v1/apps/publish", {
    ...machineOptions(args, context),
    method: "POST",
    body: await appRequestBody(args),
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
