import { option } from "./args.js";
import { cloudFetch, type CloudFetchOptions } from "./client.js";
import { cloudConsoleOutput, errorMessage, printJson } from "./output.js";
import type { Output } from "../shared.js";

export type CloudFetcher = (path: string, options?: CloudFetchOptions) => Promise<unknown>;

export interface CloudCommandOptions {
  output?: Output;
  fetcher?: CloudFetcher;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: number | (() => number);
}

export interface CloudCommandContext {
  output: Output;
  fetcher: CloudFetcher;
  home?: string;
  env: Record<string, string | undefined>;
  now?: number | (() => number);
}

export function commandContext(options: CloudCommandOptions): CloudCommandContext {
  return {
    output: options.output ?? cloudConsoleOutput,
    fetcher: options.fetcher ?? ((path, fetchOptions) => cloudFetch(path, fetchOptions)),
    home: options.home,
    env: options.env ?? process.env,
    now: options.now,
  };
}

export function userOptions(args: string[], context: CloudCommandContext): CloudFetchOptions {
  return {
    auth: "user",
    apiUrl: option(args, "--api-url"),
    accessToken: option(args, "--token"),
    home: context.home,
    env: context.env,
  };
}

interface OrgRecord {
  id?: unknown;
  [key: string]: unknown;
}

function orgRecords(value: unknown): OrgRecord[] {
  if (Array.isArray(value)) return value as OrgRecord[];
  if (typeof value === "object" && value !== null && Array.isArray((value as { orgs?: unknown }).orgs)) {
    return (value as { orgs: OrgRecord[] }).orgs;
  }
  return [];
}

export async function resolveOrgId(args: string[], context: CloudCommandContext): Promise<string> {
  const explicit = option(args, "--org");
  if (explicit) return explicit;
  const value = await context.fetcher("/api/v1/orgs", userOptions(args, context));
  const orgs = orgRecords(value);
  if (orgs.length === 1 && typeof orgs[0]?.id === "string") return orgs[0].id;
  throw new Error("Pass --org <id> (it can only be omitted when your account has exactly one organization)");
}

export async function runCommand(
  options: CloudCommandOptions,
  operation: (context: CloudCommandContext) => Promise<unknown>,
): Promise<number> {
  const context = commandContext(options);
  try {
    printJson(context.output, await operation(context));
    return 0;
  } catch (error) {
    context.output.error(errorMessage(error));
    return 1;
  }
}
