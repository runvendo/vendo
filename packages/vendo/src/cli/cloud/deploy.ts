import type { AppDocument, PermissionGrant } from "@vendoai/core";
import {
  appStore,
  createStore,
  grantStore,
  type VendoStore,
} from "@vendoai/store";
import { join } from "node:path";
import { option, options as repeatedOptions } from "./args.js";
import { CloudError, resolveCloudBaseUrl, type CloudFetchOptions } from "./client.js";
import {
  commandContext,
  type CloudCommandContext,
  type CloudCommandOptions,
} from "./command.js";
import { errorMessage, formatTable, printJson } from "./output.js";

export interface LocalDeployApp {
  doc: AppDocument;
  enabled: boolean;
}

export interface LocalDeployProject {
  subject: string;
  apps: LocalDeployApp[];
  grants: PermissionGrant[];
}

export interface LocalProjectReadOptions {
  subject?: string;
  cwd?: string;
}

export interface ReadLocalProjectOptions extends LocalProjectReadOptions {
  storeFactory?: () => VendoStore;
}

export type LocalProjectReader = (options: LocalProjectReadOptions) => Promise<LocalDeployProject>;

export interface CloudDeployOptions extends CloudCommandOptions {
  cwd?: string;
  localProjectReader?: LocalProjectReader;
}

interface QueryDriver {
  query<Row extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

interface SubjectRow extends Record<string, unknown> {
  subject: string;
}

export async function readLocalProject(options: ReadLocalProjectOptions = {}): Promise<LocalDeployProject> {
  const store = options.storeFactory?.() ?? createStore({
    dataDir: join(options.cwd ?? process.cwd(), ".vendo/data"),
  });
  try {
    await store.ensureSchema();
    const driver = store.raw() as QueryDriver;
    const subjectRows = await driver.query<SubjectRow>(
      "SELECT DISTINCT subject FROM vendo_apps ORDER BY subject ASC",
    );
    const subjects = subjectRows.rows.map((row) => row.subject);
    if (subjects.length === 0) throw new Error("No local Vendo apps found in .vendo/data");

    let subject = options.subject;
    if (subject === undefined) {
      if (subjects.length > 1) {
        throw new Error(`Multiple local Vendo subjects found: ${subjects.join(", ")}. Pass --subject <subject>.`);
      }
      subject = subjects[0]!;
    } else if (!subjects.includes(subject)) {
      throw new Error(`Subject ${subject} was not found in the local Vendo store`);
    }

    const appIds = await driver.query<IdRow>(
      "SELECT id FROM vendo_apps WHERE subject = $1 ORDER BY created_at ASC, id ASC",
      [subject],
    );
    const apps = (await Promise.all(appIds.rows.map(async ({ id }) => {
      const row = await appStore(store).get(id);
      if (row === null || row.subject !== subject) return null;
      return { doc: row.doc, enabled: row.enabled };
    }))).filter((row): row is LocalDeployApp => row !== null);

    const grantIds = await driver.query<IdRow>(
      `SELECT id FROM vendo_grants
       WHERE subject = $1 AND source = 'automation'
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       ORDER BY granted_at ASC, id ASC`,
      [subject],
    );
    const grants = (await Promise.all(grantIds.rows.map(({ id }) => grantStore(store).get(id))))
      .filter((grant): grant is PermissionGrant => grant !== null);

    return { subject, apps, grants };
  } finally {
    await store.close();
  }
}

interface HostedDeployResponse {
  org: { id: string; slug: string };
  instance: { status: string };
  applied: { apps: number; grants: number; secrets: number };
  webhooks: Array<{ app_id: string; source: string; url: string }>;
}

function machineOptions(args: string[], context: CloudCommandContext): CloudFetchOptions {
  return {
    auth: "key",
    apiKey: option(args, "--key"),
    apiUrl: option(args, "--api-url"),
    env: context.env,
  };
}

function secretValues(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const pair of repeatedOptions(args, "--secret")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error("--secret must use NAME=VALUE");
    values.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return values;
}

function selectedApps(project: LocalDeployProject, args: string[]): LocalDeployApp[] {
  const requested = [...new Set(repeatedOptions(args, "--app"))];
  if (requested.length === 0) {
    const selected = project.apps.filter((app) => app.enabled && app.doc.trigger !== undefined);
    if (selected.length === 0) throw new Error("No enabled local automations found");
    return selected;
  }

  const requestedIds = new Set(requested);
  for (const appId of requested) {
    const app = project.apps.find((candidate) => candidate.doc.id === appId);
    if (app === undefined) throw new Error(`App ${appId} was not found for subject ${project.subject}`);
    if (app.doc.trigger === undefined) throw new Error(`App ${appId} is not an automation`);
  }
  return project.apps.filter((app) => requestedIds.has(app.doc.id));
}

function warnUnsupportedFnSteps(context: CloudCommandContext, apps: LocalDeployApp[]): void {
  for (const app of apps) {
    const run = app.doc.trigger?.run;
    if (run?.kind === "steps" && run.steps.some((step) => step.tool.startsWith("fn:"))) {
      context.output.error(
        `WARNING: Automation ${app.doc.id} has fn: steps that target the app's machine, which is unreachable from hosted sandboxes in v1; those steps will fail/park when fired hosted.`,
      );
    }
  }
}

function deployResponse(value: unknown): HostedDeployResponse {
  if (typeof value !== "object" || value === null) throw new Error("Vendo Cloud returned an invalid deploy response");
  const result = value as Partial<HostedDeployResponse>;
  if (
    typeof result.org?.id !== "string"
    || typeof result.org.slug !== "string"
    || typeof result.instance?.status !== "string"
    || typeof result.applied?.apps !== "number"
    || typeof result.applied.grants !== "number"
    || typeof result.applied.secrets !== "number"
    || !Array.isArray(result.webhooks)
    || result.webhooks.some((webhook) => typeof webhook.app_id !== "string"
      || typeof webhook.source !== "string"
      || typeof webhook.url !== "string")
  ) {
    throw new Error("Vendo Cloud returned an invalid deploy response");
  }
  return result as HostedDeployResponse;
}

function printDeploySummary(context: CloudCommandContext, response: HostedDeployResponse): void {
  const lines = [
    `Vendo Cloud deploy: ${response.org.slug} (${response.instance.status})`,
    "",
    formatTable(["APPLIED", "COUNT"], [
      ["apps", String(response.applied.apps)],
      ["grants", String(response.applied.grants)],
      ["secrets", String(response.applied.secrets)],
    ]),
    "",
  ];
  if (response.webhooks.length === 0) {
    lines.push("Webhooks: none");
  } else {
    lines.push(formatTable(["AUTOMATION", "SOURCE", "WEBHOOK URL"], response.webhooks.map((webhook) => [
      webhook.app_id,
      webhook.source,
      webhook.url,
    ])));
  }
  context.output.log(lines.join("\n"));
}

export async function runDeploy(args: string[], options: CloudDeployOptions = {}): Promise<number> {
  const context = commandContext(options);
  try {
    const project = await (options.localProjectReader ?? readLocalProject)({
      subject: option(args, "--subject"),
      cwd: options.cwd ?? process.cwd(),
    });
    const apps = selectedApps(project, args);
    warnUnsupportedFnSteps(context, apps);
    const appIds = new Set(apps.map((app) => app.doc.id));
    const grants = project.grants.filter((grant) => grant.subject === project.subject
      && grant.source === "automation"
      && grant.appId !== undefined
      && appIds.has(grant.appId));

    const provided = secretValues(args);
    const referenced = new Set<string>();
    for (const app of apps) {
      for (const name of app.doc.secrets ?? []) {
        referenced.add(name);
        if (!provided.has(name)) {
          context.output.error(`Automation ${app.doc.id} references missing secret ${name}; pass --secret ${name}=VALUE`);
        }
      }
    }
    const secrets = [...referenced]
      .filter((name) => provided.has(name))
      .map((name) => ({ name, value: provided.get(name)! }));

    const requestOptions = machineOptions(args, context);
    if (secrets.length > 0 && new URL(resolveCloudBaseUrl(requestOptions)).protocol !== "https:") {
      throw new Error("Deploying secret values requires an HTTPS Vendo Cloud URL");
    }
    const response = deployResponse(await context.fetcher("/api/v1/hosted/deploy", {
      ...requestOptions,
      method: "POST",
      body: {
        apps: apps.map((app) => ({ doc: app.doc, enabled: app.enabled })),
        grants,
        secrets,
      },
    }));
    if (args.includes("--json")) printJson(context.output, response);
    else printDeploySummary(context, response);
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
