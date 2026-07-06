import { loadManifest } from "./manifest.js";

const usage = `Usage:
  pnpm corpus --help
  pnpm corpus validate
  pnpm corpus list

Commands:
  validate  Load and validate corpus/manifest.json.
  list      Print manifest repo names with tier and pinned SHA.
`;

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }

  if (command === "validate") {
    const manifest = await loadManifest();
    console.log(`Loaded ${manifest.length} corpus repos from corpus/manifest.json.`);
    return;
  }

  if (command === "list") {
    const manifest = await loadManifest();
    for (const repo of manifest) {
      console.log(`${repo.name}\t${repo.tier}\t${repo.pinnedSha}`);
    }
    return;
  }

  console.error(`Unknown corpus command: ${command}`);
  console.error(usage);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
