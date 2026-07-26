/**
 * Chip pre-generation (demo-hygiene): each curated "try this" prompt runs
 * through the REAL app-creation pipeline once and the resulting app id is
 * recorded in the per-subject chip manifest, so a chip tap attaches instantly.
 *
 * Callers fire-and-forget AFTER boot/reset seeding (an awaited call inside
 * instrumentation would hang a second app instance on the store's
 * cross-process writer lock). Idempotent: a manifest entry whose app still
 * exists is skipped, so re-runs only repair gaps. Per-chip failures are
 * logged and skipped — a flaky generation must never wedge boot or reset.
 *
 * Spend posture: generation runs for the PRIMARY demo user only (~5 apps per
 * seed, the accepted budget); other subjects fall through to live generation.
 */
import type { AppDocument, PermissionGrant, RecordStore, RunContext } from "@vendoai/core";
import { mapleDemoUsers } from "@/server/users";
import { mapleAuth, vendo } from "@/vendo/server";
import {
  CHIP_MANIFEST_COLLECTION,
  chipManifestRowId,
  mapleChips,
  type ChipManifestEntry,
  type TryThisChip,
} from "./chips";

interface ChipAppsRuntime {
  create(input: { prompt: string }, ctx: RunContext): Promise<AppDocument>;
  get(appId: string, ctx: RunContext): Promise<AppDocument | null>;
}

/** DI core — exercised directly by tests; pregenerateChips binds the live
 *  vendo runtime and store below. */
export async function pregenerate(
  apps: ChipAppsRuntime,
  manifests: RecordStore,
  subject: string,
  chips: TryThisChip[],
  requestHeaders?: Record<string, string>,
): Promise<ChipManifestEntry[]> {
  const ctx: RunContext = {
    principal: { kind: "user", subject },
    venue: "chat",
    presence: "present",
    sessionId: "demo-chips-seed",
    ...(requestHeaders === undefined ? {} : { requestHeaders }),
  };
  const rowId = chipManifestRowId(subject);
  const record = await manifests.get(rowId);
  const data = record?.data as { subject?: string; entries?: ChipManifestEntry[] } | undefined;
  const existing = new Map(
    (data?.subject === subject ? data.entries ?? [] : []).map((entry) => [entry.key, entry]),
  );

  const entries: ChipManifestEntry[] = [];
  for (const chip of chips) {
    const cached = existing.get(chip.key);
    if (cached !== undefined && (await apps.get(cached.appId, ctx)) !== null) {
      entries.push({ ...chip, appId: cached.appId });
      continue;
    }
    try {
      const app = await apps.create({ prompt: chip.prompt }, ctx);
      entries.push({ ...chip, appId: app.id });
    } catch (error) {
      console.warn(`demo chips: generating "${chip.prompt}" for ${subject} failed`, error);
    }
  }
  await manifests.put({ id: rowId, data: { subject, entries } });
  return entries;
}

/** Fire-and-forget entry point (boot instrumentation + demo reset). */
export async function pregenerateChips(): Promise<void> {
  const primary = mapleDemoUsers()[0];
  if (primary === undefined) return;
  // Idempotent migration guard — the boot path usually ran seedDemoScript
  // first, but reset/manual callers shouldn't depend on that ordering.
  await vendo.store.ensureSchema();
  await pregenerate(
    vendo.apps,
    vendo.store.records(CHIP_MANIFEST_COLLECTION),
    primary.subject,
    mapleChips,
    await seedSessionHeaders(primary.subject),
  );
}

/** A background seed has no request, but the generated apps' data captures
 * need Maple's session-walled host API — mint the SAME away session the
 * automations path mints (authJs actAs; see auth.test.ts "mints an away
 * session Maple's own session reads accept"). Failure degrades to headerless
 * generation rather than blocking the seed. */
async function seedSessionHeaders(subject: string): Promise<Record<string, string> | undefined> {
  const grant: PermissionGrant = {
    id: "grt_demo_chips_seed",
    subject,
    tool: "host_*",
    descriptorHash: "sha256:demo-chips-seed",
    scope: { kind: "tool" },
    duration: "standing",
    source: "automation",
    grantedAt: new Date().toISOString(),
  };
  try {
    const material = await mapleAuth.actAs?.({ kind: "user", subject }, grant);
    return material?.headers;
  } catch (error) {
    console.warn("demo chips: minting the seed session failed; generating without host auth", error);
    return undefined;
  }
}
