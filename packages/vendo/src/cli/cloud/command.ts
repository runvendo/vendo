import { option } from "./args.js";
import { cloudFetch, type CloudFetchOptions } from "./client.js";
import { errorMessage, printJson } from "./output.js";
import { consoleOutput, type Output } from "../shared.js";

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
    output: options.output ?? consoleOutput,
    fetcher: options.fetcher ?? cloudFetch,
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

interface ProjectRecord {
  id?: unknown;
  [key: string]: unknown;
}

function projectRecords(value: unknown): ProjectRecord[] {
  if (Array.isArray(value)) return value as ProjectRecord[];
  if (typeof value === "object" && value !== null && Array.isArray((value as { projects?: unknown }).projects)) {
    return (value as { projects: ProjectRecord[] }).projects;
  }
  return [];
}

// Keys and usage live under the project since the spine v2 realignment; a
// bare command walks org -> only project the same way resolveOrgId walks
// account -> only org.
export async function resolveProjectId(args: string[], context: CloudCommandContext): Promise<string> {
  const explicit = option(args, "--project");
  if (explicit) return explicit;
  const orgId = await resolveOrgId(args, context);
  const value = await context.fetcher(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/projects`,
    userOptions(args, context),
  );
  const projects = projectRecords(value);
  if (projects.length === 1 && typeof projects[0]?.id === "string") return projects[0].id;
  throw new Error("Pass --project <id> (it can only be omitted when the organization has exactly one project)");
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
