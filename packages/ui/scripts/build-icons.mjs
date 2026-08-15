/**
 * Regenerates src/kit/icons.gen.ts — the Icon brick's path data, extracted from
 * lucide at build time so the runtime bundle carries ~200 short markup strings
 * and never the lucide package (a devDependency, pinned for determinism).
 *
 * lucide is licensed under the ISC License
 * (Copyright (c) 2020, Lucide Contributors, https://github.com/lucide-icons/lucide).
 *
 * Run: pnpm --filter @vendoai/ui build:icons
 * Check (writes nothing, exits 1 when the committed file is stale):
 *   pnpm --filter @vendoai/ui check:icons
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as lucide from "lucide";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const output = resolve(here, "../src/kit/icons.gen.ts");
// The NAMES are model-facing vocabulary — the catalog prompt lists them so the
// model stops inventing glyphs — and `@vendoai/apps` cannot import `@vendoai/ui`
// (it is the layer below). So the one curated list emits a second committed
// artifact there rather than being hand-copied into two packages.
const namesOutput = resolve(here, "../../apps/src/contract/kit/icon-names.gen.ts");

// The vocabulary. A name the model can guess is worth more than a name that is
// merely available, so this is the common set, not lucide's 1600 — and it is
// spelled in lucide's own kebab-case, which is what the world calls these.
const NAMES = [
  // arrows & chevrons
  "arrow-up", "arrow-down", "arrow-left", "arrow-right",
  "arrow-up-right", "arrow-up-left", "arrow-down-right", "arrow-down-left",
  "arrow-left-right", "arrow-up-down", "chevron-up", "chevron-down",
  "chevron-left", "chevron-right", "chevrons-up-down", "chevrons-left",
  "chevrons-right", "corner-down-right", "move-up", "move-down",
  "undo", "redo",
  // actions
  "plus", "minus", "x", "check", "edit", "pencil", "trash", "trash-2",
  "download", "upload", "copy", "clipboard", "clipboard-check", "search",
  "filter", "settings", "sliders-horizontal", "refresh-cw", "refresh-ccw",
  "rotate-cw", "external-link", "more-horizontal", "more-vertical", "save",
  "send", "share", "share-2", "log-in", "log-out", "menu", "grip-vertical",
  "maximize", "minimize", "play", "pause", "scissors", "archive", "inbox",
  "printer", "split",
  // status
  "info", "alert-circle", "alert-triangle", "alert-octagon", "check-circle",
  "x-circle", "help-circle", "circle", "circle-dot", "clock", "calendar",
  "calendar-days", "calendar-clock", "bell", "bell-off", "loader",
  "ban", "badge-check", "thumbs-up", "thumbs-down", "message-circle",
  "message-square", "activity", "history", "hourglass", "timer",
  // files & folders
  "file", "file-text", "file-plus", "file-check", "files", "folder",
  "folder-open", "folder-plus", "paperclip", "book", "book-open", "newspaper",
  // people & places
  "user", "user-plus", "user-check", "user-x", "users", "home", "building",
  "building-2", "landmark", "briefcase", "map", "map-pin", "navigation",
  "globe", "flag", "compass",
  // contact
  "mail", "mail-open", "phone", "phone-call", "message-square-text", "at-sign",
  // commerce
  "credit-card", "wallet", "shopping-cart", "shopping-bag", "package",
  "package-check", "truck", "tag", "tags", "receipt", "banknote", "coins",
  "dollar-sign", "euro", "percent", "calculator", "gift", "ticket", "store",
  // charts & data
  "line-chart", "bar-chart", "bar-chart-3", "pie-chart", "area-chart",
  "trending-up", "trending-down", "gauge", "target", "scale",
  // systems
  "database", "server", "hard-drive", "cloud", "cloud-upload", "cloud-download",
  "cpu", "terminal", "code", "git-branch", "git-commit-horizontal", "wifi",
  "wifi-off", "battery", "plug", "power", "monitor", "smartphone", "tablet",
  "laptop",
  // media & links
  "link", "link-2", "unlink", "image", "images", "camera", "video", "mic",
  "mic-off", "volume-2", "volume-x", "music", "qr-code", "scan",
  // layout
  "layers", "layout-grid", "layout-dashboard", "list", "list-checks", "table",
  "columns-3", "rows-3", "panel-left", "sidebar", "align-left", "align-center",
  "type", "hash",
  // toggles & marks
  "eye", "eye-off", "lock", "unlock", "star", "star-off", "heart", "bookmark",
  "pin", "pin-off", "zap", "zap-off", "shield", "shield-check", "shield-alert",
  "sun", "moon", "toggle-left", "toggle-right", "key", "fingerprint",
  "sparkles", "flame", "award", "crown", "rocket", "wand-2", "lightbulb",
];

const pascal = (name) => name.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join("");
const attrs = (record) => Object.entries(record).map(([key, value]) => ` ${key}="${value}"`).join("");

const entries = NAMES.map((name) => {
  const node = lucide[pascal(name)];
  if (node === undefined) throw new Error(`lucide has no icon "${name}" (${pascal(name)})`);
  const markup = node.map(([tag, record]) => `<${tag}${attrs(record)}/>`).join("");
  return `  ${JSON.stringify(name)}: ${JSON.stringify(markup)},`;
});

const source = `/**
 * Generated by packages/ui/scripts/build-icons.mjs. Do not edit.
 *
 * lucide path data (ISC — Copyright (c) 2020, Lucide Contributors), extracted
 * so the runtime carries the markup and not the package.
 *
 * Regenerate: pnpm --filter @vendoai/ui build:icons
 */
export const ICON_PATHS: Readonly<Record<string, string>> = {
${entries.join("\n")}
};

export const ICON_NAMES: readonly string[] = Object.keys(ICON_PATHS);
`;

const namesSource = `/**
 * Generated by packages/ui/scripts/build-icons.mjs. Do not edit.
 *
 * The names only — the vocabulary the catalog prompt teaches. The path data
 * lives in \`@vendoai/ui\`'s icons.gen.ts, which this package may not import.
 *
 * Regenerate: pnpm --filter @vendoai/ui build:icons
 */
export const KIT_ICON_NAMES: readonly string[] = ${JSON.stringify(NAMES)};
`;

const files = [[output, source], [namesOutput, namesSource]];

// Unlike the jail runtime, icons.gen.ts is COMMITTED, so the pre-scripts check
// it rather than rewrite it: a curated-name edit or a lucide bump that nobody
// regenerated must fail the build, not silently pass with missing glyphs.
for (const [path, contents] of files) {
  if (process.argv.includes("--check")) {
    if (await readFile(path, "utf8") !== contents) {
      console.error(`${path} is stale — run: pnpm --filter @vendoai/ui build:icons`);
      process.exit(1);
    }
    console.log(`${path} is current (${NAMES.length} icons)`);
  } else {
    await writeFile(path, contents);
    console.log(`wrote ${path} (${NAMES.length} icons)`);
  }
}
