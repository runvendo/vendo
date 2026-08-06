#!/usr/bin/env node
/**
 * Console seeding CLI — the same seeding the app runs at boot on a local
 * store (src/demo-script/console-seed.ts), pointable at any store:
 *
 *   pnpm seed:console                          # local .vendo/data (stop the dev server first — PGlite is single-writer)
 *   pnpm seed:console -- --data-dir /tmp/x     # local, elsewhere
 *   pnpm seed:console -- --cloud               # Yousef's Cloud tenant (needs VENDO_API_KEY)
 *
 * Usage/metering is not seedable from here — the console meters model-gateway,
 * tool, and sandbox traffic server-side; real agent turns fill those charts.
 */
import { join } from "node:path";
import { createStore, type VendoStore } from "@vendoai/store";
import { seedConsoleData } from "../src/demo-script/console-seed";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const cloud = args.includes("--cloud");
  const dataDirFlag = args.indexOf("--data-dir");
  const dataDir = dataDirFlag === -1
    ? join(__dirname, "../.vendo/data")
    : args[dataDirFlag + 1];
  if (dataDir === undefined) throw new Error("--data-dir needs a path");

  let store: VendoStore;
  if (cloud) {
    const apiKey = process.env.VENDO_API_KEY;
    if (!apiKey) throw new Error("--cloud needs VENDO_API_KEY (Yousef's Vendo Cloud key)");
    const { hostedStore } = await import("@vendoai/vendo/server");
    const baseUrl = process.env.VENDO_CLOUD_URL;
    store = hostedStore({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) });
    console.log(`Seeding the Vendo Cloud HOSTED store${baseUrl === undefined ? "" : ` at ${baseUrl}`} — this writes into the live tenant.`);
  } else {
    store = createStore({ dataDir });
    console.log(`Seeding the local PGlite store at ${dataDir} (stop the dev server first — single writer).`);
  }

  try {
    const totals = await seedConsoleData(store);
    console.log(`automations: ${totals.automations} written`);
    console.log(`run history: ${totals.runs} written`);
    console.log(`audit trail: ${totals.audit} written`);
    console.log(`org policy:  ${totals.orgPolicy}`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
