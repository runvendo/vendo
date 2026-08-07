import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  VENDO_KNOWLEDGE_HASH_FORMAT,
  canonicalJson,
  knowledgeHashManifestSchema,
  sha256Hex,
  type KnowledgeAdapter,
  type KnowledgeHashManifest,
} from "@vendoai/core";
import {
  VENDO_KNOWLEDGE_CONFIG_FORMAT,
  cloudKnowledge,
  ingestSources,
  knowledgeConfigSchema,
  knowledgeSourceConfigSchema,
  vendoKnowledge,
  type KnowledgeConfig,
} from "@vendoai/knowledge";
import { createStore } from "@vendoai/store";
import { resolveCloudBaseUrl } from "../../cloud-key-fetch.js";
import { environment } from "../../wire/shared.js";
import { formatTable } from "../cloud/output.js";
import { consoleOutput, withCommandRun, type Output, type TelemetryOptions } from "../shared.js";

/** `vendo knowledge` — the developer door (knowledge design v2, ENG-362).
 *
 * add/list/remove edit `.vendo/knowledge.json` (source entries only); `sync`
 * is the ONLY verb that moves content: ingest local files → diff against the
 * sha256 hash manifest (`.vendo/knowledge-manifest.json`, regenerable — safe
 * to gitignore) → document-level upsert/remove on the engine → rewrite the
 * manifest. The manifest is written LAST, after the engine confirms, so a
 * failed sync re-syncs instead of silently skipping (the frozen
 * upsert-resolves-when-searchable invariant, host-side half). */

const HELP = `vendo knowledge — sync local docs into the product knowledge base

Usage:
  vendo knowledge add <glob> [dir] [--kind docs|glossary|api] [--visibility public|internal] [--name <slug>]
  vendo knowledge add notion|gdocs
  vendo knowledge list [dir]
  vendo knowledge remove <name> [dir]
  vendo knowledge sync [dir] [--dry-run]

Commands:
  add      Register a local source (a glob of markdown/JSON files) in .vendo/knowledge.json
  list     Show configured sources and their synced document counts
  remove   Drop a source entry (its documents leave the engine on the next sync)
  sync     Ingest sources, diff against the hash manifest, and push changed documents

Options:
  --kind <kind>              Content shape: docs (prose), glossary, api (default: docs)
  --visibility <tier>        public (default) or internal (trusted-caller only)
  --name <slug>              Source name — namespaces its doc ids (default: derived from the glob)
  --dry-run                  Sync only: print the plan without moving content
`;

const KINDS = ["docs", "glossary", "api"] as const;
const VISIBILITIES = ["public", "internal"] as const;
const VALUE_OPTIONS = ["--kind", "--visibility", "--name"];
const CONSOLE_SOURCES_URL = "https://console.vendo.run/knowledge/sources";

export interface KnowledgeCliOptions {
  output?: Output;
  /** Injectable telemetry deps (matches init/doctor). */
  telemetry?: TelemetryOptions;
  /** The engine sync targets. Default: whichever engine the composed server
      would use for this project (see chooseSyncEngine); tests inject a
      double, and an injected adapter always wins. */
  adapter?: KnowledgeAdapter;
}

/** ENG-335 rule: unknown flags and value flags missing their value fail
    loudly before anything runs. */
function optionErrors(args: string[], flags: Set<string>, valueOptions: string[]): string[] {
  const errors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;
    if (flags.has(arg)) continue;
    if (valueOptions.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) errors.push(`${arg} requires a value`);
      else index += 1;
      continue;
    }
    if (valueOptions.some((name) => arg.startsWith(`${name}=`))) continue;
    errors.push(`unknown option: ${arg}`);
  }
  return errors;
}

function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(name);
  if (exact >= 0) {
    const value = args[exact + 1];
    return value !== undefined && !value.startsWith("--") ? value : undefined;
  }
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** Positionals with value-flag values stripped (the config.ts rule: a bare
    `--name X` must never leak into the glob/dir scan). */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (VALUE_OPTIONS.includes(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) out.push(arg);
  }
  return out;
}

const configPath = (dir: string): string => join(dir, ".vendo", "knowledge.json");
const manifestPath = (dir: string): string => join(dir, ".vendo", "knowledge-manifest.json");

/** Missing file → null; anything else unreadable/invalid fails loudly (a
    silently-ignored config would sync an empty corpus). */
async function readConfig(dir: string): Promise<KnowledgeConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(dir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = knowledgeConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`.vendo/knowledge.json is invalid: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

async function writeConfig(dir: string, config: KnowledgeConfig): Promise<void> {
  await mkdir(join(dir, ".vendo"), { recursive: true });
  await writeFile(configPath(dir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readManifest(dir: string): Promise<KnowledgeHashManifest | null> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(dir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = knowledgeHashManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      ".vendo/knowledge-manifest.json is corrupt — delete it to re-sync every document from scratch",
    );
  }
  return parsed.data;
}

/** `<source>#…` doc-id prefix → this source's synced docs in the manifest. */
const docCount = (manifest: KnowledgeHashManifest | null, name: string): number =>
  manifest === null ? 0 : Object.keys(manifest.docs).filter((id) => id.startsWith(`${name}#`)).length;

/** Default source name: the glob's first literal path segment (`docs/**` →
    `docs`), else a slug of the whole glob. Deterministic; collisions ask for
    an explicit --name rather than guessing. */
function deriveName(glob: string): string {
  const literal = glob.split("/").find((segment) => segment.length > 0 && !/[*?]/.test(segment));
  const slug = (literal ?? glob).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "source";
}

async function runAdd(args: string[], output: Output, failure: { failedStep?: string }): Promise<number> {
  const positional = positionals(args);
  const glob = positional[0];
  if (glob === undefined) {
    failure.failedStep = "missing-glob";
    output.error(`vendo knowledge add: a source glob is required\n\n${HELP}`);
    return 1;
  }
  if (glob === "notion" || glob === "gdocs") {
    output.log(`Notion and Google Drive sources are connected in the Vendo console (cloud-managed sync):`);
    output.log(`  ${CONSOLE_SOURCES_URL}?connect=${glob}`);
    return 0;
  }
  const dir = positional[1] ?? process.cwd();
  const kind = (option(args, "--kind") ?? "docs") as KnowledgeConfig["sources"][number]["kind"];
  const visibility = (option(args, "--visibility") ?? "public") as KnowledgeConfig["sources"][number]["visibility"];
  const name = option(args, "--name") ?? deriveName(glob);
  const config = (await readConfig(dir)) ?? { format: VENDO_KNOWLEDGE_CONFIG_FORMAT, sources: [] };
  if (config.sources.some((source) => source.name === name)) {
    failure.failedStep = "duplicate-name";
    output.error(`vendo knowledge add: a source named ${JSON.stringify(name)} already exists — pass --name <slug> or remove it first`);
    return 1;
  }
  const entry = knowledgeSourceConfigSchema.safeParse({ name, glob, kind, visibility });
  if (!entry.success) {
    failure.failedStep = "invalid-source";
    output.error(`vendo knowledge add: ${entry.error.issues.map((issue) => issue.message).join("; ")}`);
    return 1;
  }
  await writeConfig(dir, { ...config, sources: [...config.sources, entry.data] });
  output.log(`Added source ${name} (${glob}, ${kind}/${visibility}). Run \`vendo knowledge sync\` to push it.`);
  return 0;
}

async function runList(args: string[], output: Output): Promise<number> {
  const dir = positionals(args)[0] ?? process.cwd();
  const config = await readConfig(dir);
  if (config === null || config.sources.length === 0) {
    output.log("No knowledge sources configured. Add one with `vendo knowledge add <glob>`.");
    return 0;
  }
  const manifest = await readManifest(dir);
  output.log(formatTable(
    ["NAME", "GLOB", "KIND", "VISIBILITY", "SYNCED DOCS"],
    config.sources.map((source) => [
      source.name,
      source.glob,
      source.kind,
      source.visibility,
      manifest === null ? "-" : String(docCount(manifest, source.name)),
    ]),
  ));
  return 0;
}

async function runRemove(args: string[], output: Output, failure: { failedStep?: string }): Promise<number> {
  const positional = positionals(args);
  const name = positional[0];
  if (name === undefined) {
    failure.failedStep = "missing-name";
    output.error(`vendo knowledge remove: a source name is required\n\n${HELP}`);
    return 1;
  }
  const dir = positional[1] ?? process.cwd();
  const config = await readConfig(dir);
  if (config === null || !config.sources.some((source) => source.name === name)) {
    failure.failedStep = "unknown-source";
    const known = config?.sources.map((source) => source.name).join(", ") || "none";
    output.error(`vendo knowledge remove: no source named ${JSON.stringify(name)} (known: ${known})`);
    return 1;
  }
  await writeConfig(dir, { ...config, sources: config.sources.filter((source) => source.name !== name) });
  output.log(`Removed source ${name}. Its documents leave the engine on the next \`vendo knowledge sync\`.`);
  return 0;
}

/** `sha256:<hex>` content hash of the canonical doc JSON — any change to
    text, title, kind, or visibility re-upserts the document. */
const docHash = (doc: unknown): string => `sha256:${sha256Hex(canonicalJson(doc))}`;

async function runSyncVerb(
  args: string[],
  options: KnowledgeCliOptions,
  output: Output,
  failure: { failedStep?: string },
): Promise<number> {
  const dir = positionals(args)[0] ?? process.cwd();
  const dryRun = args.includes("--dry-run");
  const config = await readConfig(dir);
  if (config === null) {
    failure.failedStep = "no-config";
    output.error("vendo knowledge sync: no .vendo/knowledge.json — add a source first (`vendo knowledge add <glob>`)");
    return 1;
  }
  const docs = await ingestSources(config, { root: dir });
  const manifest = await readManifest(dir);
  const hashes = new Map(docs.map((doc) => [doc.id, docHash(doc)]));
  const upserts = docs.filter((doc) => manifest?.docs[doc.id] !== hashes.get(doc.id));
  const removes = Object.keys(manifest?.docs ?? {}).filter((id) => !hashes.has(id));
  const unchanged = docs.length - upserts.length;

  // Named before the plan prints: a developer must be able to see WHERE the
  // docs are going without running the sync to find out.
  const engine = chooseSyncEngine(dir, options.adapter);
  output.log(`Plan: ${upserts.length} to upsert, ${removes.length} to remove, ${unchanged} unchanged (${docs.length} docs total) → ${engine.target}.`);
  if (dryRun) {
    for (const doc of upserts) output.log(`  upsert ${doc.id}`);
    for (const id of removes) output.log(`  remove ${id}`);
    output.log("Dry run — nothing moved.");
    return 0;
  }

  const resolved = await engine.open();
  const adapter = resolved.adapter;
  try {
    if (!adapter.posture.write || adapter.upsert === undefined || adapter.remove === undefined) {
      failure.failedStep = "read-only-engine";
      output.error("vendo knowledge sync: the configured engine is read-only (posture.write: false) — sync cannot push documents to it. Point sync at a writable engine or manage this corpus at its source.");
      return 1;
    }
    if (upserts.length > 0) await adapter.upsert(upserts);
    if (removes.length > 0) await adapter.remove(removes);
    // Manifest write comes LAST: the engine has confirmed searchability, so a
    // crash before this line re-syncs the same docs instead of dropping them.
    await mkdir(join(dir, ".vendo"), { recursive: true });
    const next: KnowledgeHashManifest = {
      format: VENDO_KNOWLEDGE_HASH_FORMAT,
      docs: Object.fromEntries(hashes),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(manifestPath(dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    output.log(`Synced: ${upserts.length} upserted, ${removes.length} removed, ${unchanged} unchanged → ${engine.target}.`);
    return 0;
  } finally {
    await resolved.close?.();
  }
}

/** What sync is about to push to, chosen and NAMED before anything moves.
    `open()` is deferred so `--dry-run` can print the target without building
    an engine (opening the local store would take its single-writer lock). */
interface SyncEngine {
  /** Human phrase for the output line — the whole point is that a developer
      can see WHERE their docs went without reading this file. */
  target: string;
  open: () => Promise<{ adapter: KnowledgeAdapter; close?: () => Promise<void> }>;
}

/** Which engine sync targets, mirroring the composed server's
    `selectKnowledge` seam (server.ts) restricted to what a CLI can know:

      1. an injected adapter always wins (the adapter rule — tests and hosts
         driving the CLI directly);
      2. a Cloud key means Vendo Cloud, so `sync` pushes over the same
         `vendo/knowledge-wire@1` /upsert + /remove the server would read
         from — the key is read exactly the way the server reads it
         (cloudKeyOptions: VENDO_API_KEY, repointed by VENDO_CLOUD_URL);
      3. no key: the local lexical engine over the project store
         (`.vendo/data`, the same createStore default the server falls back
         to — ENG-351 single-writer discipline applies, so a running dev
         server on the same data dir makes this fail loudly, never corrupt).

    Syncing into a store the server never reads is the failure this closes:
    before, a Cloud-keyed project pushed its docs into a local store while its
    agent searched Cloud, and nothing said so. */
function chooseSyncEngine(dir: string, injected: KnowledgeAdapter | undefined): SyncEngine {
  if (injected !== undefined) {
    return { target: "the configured engine", open: async () => ({ adapter: injected }) };
  }
  const apiKey = environment("VENDO_API_KEY");
  if (apiKey !== undefined) {
    const baseUrl = resolveCloudBaseUrl();
    return {
      target: `Vendo Cloud (${hostLabel(baseUrl)})`,
      open: async () => ({ adapter: cloudKnowledge({ apiKey, baseUrl }) }),
    };
  }
  return {
    target: "local store (.vendo/data)",
    open: async () => {
      const store = createStore({ dataDir: join(dir, ".vendo", "data") });
      await store.ensureSchema();
      return { adapter: vendoKnowledge({ store }), close: () => store.close() };
    },
  };
}

/** The console's host, so the line reads "Vendo Cloud (console.vendo.run)"
    rather than repeating a full URL nobody needs to read. */
function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export async function runKnowledge(args: string[], options: KnowledgeCliOptions = {}): Promise<number> {
  const output = options.output ?? consoleOutput;
  const [command, ...commandArgs] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    output.log(HELP);
    return 0;
  }
  const problems = command === "sync"
    ? optionErrors(commandArgs, new Set(["--dry-run"]), [])
    : optionErrors(commandArgs, new Set(), command === "add" ? VALUE_OPTIONS : []);
  const kind = option(commandArgs, "--kind");
  if (command === "add" && kind !== undefined && !KINDS.includes(kind as never)) {
    problems.push(`--kind must be one of ${KINDS.join(", ")}`);
  }
  const visibility = option(commandArgs, "--visibility");
  if (command === "add" && visibility !== undefined && !VISIBILITIES.includes(visibility as never)) {
    problems.push(`--visibility must be public or internal`);
  }
  const name = option(commandArgs, "--name");
  if (command === "add" && name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    problems.push("--name must be a lowercase slug (a-z, 0-9, -)");
  }
  if (problems.length > 0) {
    output.error(`vendo knowledge ${command}: ${problems.join("; ")}\n\n${HELP}`);
    return 1;
  }
  return withCommandRun(
    {
      command: "knowledge",
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    },
    async (failure) => {
      try {
        if (command === "add") return await runAdd(commandArgs, output, failure);
        if (command === "list") return await runList(commandArgs, output);
        if (command === "remove") return await runRemove(commandArgs, output, failure);
        if (command === "sync") return await runSyncVerb(commandArgs, options, output, failure);
        failure.failedStep = "unknown-command";
        output.error(`Unknown knowledge command: ${command}\n\n${HELP}`);
        return 1;
      } catch (error) {
        failure.failedStep ??= "error";
        output.error(`vendo knowledge ${command}: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    },
  );
}
