#!/usr/bin/env node
/** Citation guard — every path/to/file.ext citation in a doc or a code
 *  comment must point at a file that actually exists in the tree, and every
 *  @vendoai/* package it names must be a package that still exists.
 *
 *  Scans the full text of tracked .md/.mdx files, and the COMMENT text only
 *  of tracked .ts/.tsx/.mjs source, including tests — comment-only scanning is
 *  what makes tests safe to include: a fixture literal like
 *  `source: "docs/<name>.md"` is mock knowledge-base data outside any
 *  comment, so it is never a candidate in the first place.
 *
 *  A citation is resolved against the repo root AND against every ancestor
 *  directory of the file that cites it, because many packages (cloud/console,
 *  packages/vendo, fixtures/mcp-e2e, ...) nest their OWN scripts/, docs/ and
 *  fixtures/ directories, and a comment inside one of them written as
 *  `scripts/<name>.ts` means package-relative, not repo-root-relative.
 *
 *  A citation covered by .gitignore (a path the prose documents as a RUNTIME
 *  OUTPUT, e.g. "the run writes corpus/.repos/.logs/ai-scoreboard.md") is not
 *  checked against the committed tree — that's what makes it gitignored.
 *
 *  CREDITS.md and CHANGELOG.md files cite paths in THIRD-PARTY upstream repos
 *  (attribution) or are changesets-generated history; corpus/expectations/**
 *  grades pinned THIRD-PARTY host repos cloned at eval time. None of those
 *  paths live in this tree, by design, so those files are not scanned.
 *
 *  Because this scans `git ls-files`, it cannot see itself until it is
 *  committed — a local run against the untracked working copy silently skips
 *  this very file, examples and all.
 *
 *  Run: node scripts/citation-guard.mjs  (wired into `pnpm lint`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const EXCLUDE_FILES = new Set(["CREDITS.md"]);
const isExcluded = (f) => EXCLUDE_FILES.has(f) || f.endsWith("CHANGELOG.md") || f.startsWith("corpus/expectations/");

const PREFIXES = [
  "packages", "examples", "fixtures", "corpus", "genbench",
  "scripts", "docs-site", "docs", "cloud", "oss", "assets",
];
const EXT = "tsx|mjs|cjs|json|mdx|ts|js|sql|md|yml|yaml";
// A maximal run of path characters ending in a known extension. Requiring the
// captured token itself to START with a known top-level dir (below) — rather
// than searching for the prefix anywhere inside a longer run — is what keeps
// this from matching a truncated tail of a longer path (e.g. picking
// "fixtures/<name>.json" out of the middle of "cloud/console/fixtures/<name>.json") or
// the tail of a github blob URL ("main/packages/foo.ts"). The extension
// alternation is ordered longest-first (tsx before ts, json before js, mdx
// before md) because JS regex alternation takes the first alternative that
// matches, not the longest.
const TOKEN_RE = new RegExp(`[A-Za-z0-9_./-]+\\.(?:${EXT})`, "g");

// Block comments as whole chunks, and each maximal run of contiguous `//`
// lines as one chunk — locality that matters below, because a "Ported from"
// disclaimer and the upstream path it excuses are rarely on the same line.
function commentChunks(source) {
  const chunks = [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
  let run = null;
  for (const line of source.split("\n")) {
    const i = line.indexOf("//");
    if (i === -1) {
      if (run !== null) chunks.push(run);
      run = null;
    } else {
      run = run === null ? line.slice(i) : `${run}\n${line.slice(i)}`;
    }
  }
  if (run !== null) chunks.push(run);
  return chunks;
}

function gitFiles(...patterns) {
  return execFileSync("git", ["ls-files", "-z", ...patterns], { cwd: root, maxBuffer: 1024 * 1024 * 32 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

// "Ported from pi-mono `packages/agent/...ts` (MIT, ...)" — CREDITS.md's own
// words are "every port carries an attribution comment at the site of use
// naming the source file and license"; that source file lives in the
// UPSTREAM repo, not this one, exactly like CREDITS.md itself (excluded
// above). The marker is the same word CREDITS.md uses for the roll-up.
const isAttribution = (chunk) => /\b(ported from|adapted from|MIT|Apache-2\.0|BSD-|ISC)\b/i.test(chunk);

function citationsIn(chunks) {
  const found = new Set();
  for (const chunk of chunks) {
    if (isAttribution(chunk)) continue;
    for (const tok of chunk.match(TOKEN_RE) ?? []) {
      const p = tok.replace(/^\.\//, "");
      if (PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))) found.add(p);
    }
  }
  return found;
}

// A package name is a citation too — "<some @vendoai package> exports the
// constant" sends a reader to a package exactly the way a path sends them to a
// file, and a name that no longer resolves is the same dead end. The
// live set is DERIVED: every `name` in every tracked package.json, so a fold,
// a rename or a new package moves this the day it lands. There is deliberately
// no list of retired names here — dependency-guard.mjs owns that list for the
// IMPORT rule, and a second copy is a second thing to forget.
const NAME_RE = /@vendoai\/[a-z0-9-]+/g;
const liveNames = new Set(
  gitFiles("*package.json").flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(root, f), "utf8")).name].filter(Boolean);
    } catch {
      return [];
    }
  }),
);

/** The only files allowed to name a package that no longer exists.
 *
 *  Everywhere else the name is a lead, and a lead to a deleted package is worse
 *  than none. Three kinds are not leads:
 *
 *   - the two guards THEMSELVES: dependency-guard.mjs is the retirement
 *     registry, and this file has to name a dead package to explain the rule.
 *     A `*.gen.ts` artifact (matched below, not listed) is generated
 *     rather than authored: its payload is a minified bundle whose `//` runs are not
 *     comments and whose embedded import list names whatever the generator saw.
 *   - the scanner pair, where a retired name is a string this repo still has to
 *     RECOGNISE in a stranger's code: route-scan keys on `@vendoai/agents`
 *     because a host that installed it before the fold still imports it.
 *   - the rest are sentences that NARRATE a retirement ("it arrived here when X
 *     folded in"), where the dead name is the subject of a past-tense fact and
 *     is correct as written.
 *
 *  The excuse is per FILE, so a new FALSE claim added to one of these is not
 *  caught. That is accepted, and it is why the list is enumerated rather than
 *  pattern-matched: every past-tense marker tried against the real corpus ("no
 *  longer", "moved", "until") also appeared in present-tense claims that were
 *  wrong — "`@vendoai/harnesses` no longer imports `@vendoai/vendo/apps`" is
 *  both — so a marker heuristic would have waved through the very sentences
 *  this gate exists to catch.
 *
 *  A stale entry is an error, below — but only when the file is actually in
 *  the tree being scanned: the public projection runs this same guard over a
 *  copy with cloud/ removed, and an entry for a file that is not there is
 *  absent, not stale. */
const MAY_NAME_RETIRED = new Set([
  "scripts/citation-guard.mjs",
  "scripts/dependency-guard.mjs",
  ".changeset/cli-ships-with-vendo.md",
  "cloud/console/tests/config-preview.test.ts",
  "packages/ui/src/tree/screen-engine.ts",
  "packages/vendo/README.md",
  "packages/vendo/src/actions/sync/route-scan.ts",
  "packages/vendo/src/harnesses/index.ts",
  "packages/vendo/src/index.ts",
  "packages/vendo/src/server.ts",
  "packages/vendo/src/threads.ts",
  "packages/vendo/src/turn/index.ts",
  "packages/vendo/tests/actions/sync/route-exclusions.agents.test.ts",
  "packages/vendo/tests/apps/automations-double.test-util.ts",
  "packages/vendo/tests/apps/engine.bundler-safety.e2e.test.ts",
  "packages/vendo/tests/apps/test-doubles.test-util.ts",
  "packages/vendo/tests/harness-system-prompt.test.ts",
  "packages/vendo/tests/harnesses/provider-401.test.ts",
  "packages/vendo/tests/threads.test.ts",
  "packages/vendo/vitest.config.ts",
]);
const mayNameRetired = (f) => MAY_NAME_RETIRED.has(f) || /\.gen\.tsx?$/.test(f);

// deadName -> namingFile -> true
const retired = new Map();
const usedExcuse = new Set();
// Which excused files this run actually SAW. The public projection is a real
// subset of this tree — the OSS suite copies everything but cloud/ into a fresh
// index and runs this guard there — so an entry naming a file that is not in
// the tree at hand is absent, not stale, and only a file that IS scanned and
// names nothing has gone stale.
const scannedFiles = new Set();

function retiredIn(file, chunks) {
  scannedFiles.add(file);
  for (const chunk of chunks) {
    for (const name of chunk.match(NAME_RE) ?? []) {
      if (liveNames.has(name)) continue;
      if (mayNameRetired(file)) {
        usedExcuse.add(file);
        continue;
      }
      if (!retired.has(name)) retired.set(name, new Set());
      retired.get(name).add(file);
    }
  }
}

// citedPath -> citingFile -> true
const citations = new Map();
const record = (path, file) => {
  if (!citations.has(path)) citations.set(path, new Set());
  citations.get(path).add(file);
};

for (const f of gitFiles("*.md", "*.mdx")) {
  if (isExcluded(f)) continue;
  const text = readFileSync(join(root, f), "utf8");
  // Paragraphs, not the whole file, so one license mention anywhere in a long
  // doc (e.g. crediting an on-prem vendor's own license) can't blanket-excuse
  // every citation in the rest of the file.
  const chunks = text.split(/\n{2,}/);
  for (const p of citationsIn(chunks)) record(p, f);
  retiredIn(f, chunks);
}

for (const f of gitFiles("*.ts", "*.tsx", "*.mjs")) {
  if (isExcluded(f)) continue;
  const text = readFileSync(join(root, f), "utf8");
  const chunks = commentChunks(text);
  for (const p of citationsIn(chunks)) record(p, f);
  retiredIn(f, chunks);
}

const isIgnored = (p) => {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { cwd: root });
    return true;
  } catch {
    return false;
  }
};

/** True if `p` resolves at the repo root or relative to any ancestor
 *  directory of any file that cites it. */
function resolves(p, citingFiles) {
  if (existsSync(join(root, p))) return true;
  for (const file of citingFiles) {
    let dir = dirname(join(root, file));
    while (dir !== root && dir !== dirname(dir)) {
      if (existsSync(join(dir, p))) return true;
      dir = dirname(dir);
    }
  }
  return false;
}

let dead = 0;
let total = 0;
for (const [p, files] of [...citations].sort(([a], [b]) => a.localeCompare(b))) {
  total += 1;
  if (resolves(p, files) || isIgnored(p)) continue;
  dead += 1;
  const list = [...files].sort();
  const shown = list.slice(0, 3).join(", ") + (list.length > 3 ? `, +${list.length - 3} more` : "");
  console.error(`citation-guard: DEAD ${p} (cited by ${shown})`);
}

let deadNames = 0;
for (const [name, files] of [...retired].sort(([a], [b]) => a.localeCompare(b))) {
  deadNames += 1;
  const list = [...files].sort();
  const shown = list.slice(0, 3).join(", ") + (list.length > 3 ? `, +${list.length - 3} more` : "");
  console.error(`citation-guard: RETIRED ${name} — no such package (named by ${shown})`);
}

for (const f of [...MAY_NAME_RETIRED].sort()) {
  if (usedExcuse.has(f) || !scannedFiles.has(f)) continue;
  deadNames += 1;
  console.error(`citation-guard: STALE EXCUSE ${f} names no retired package — drop it from MAY_NAME_RETIRED`);
}

if (dead > 0 || deadNames > 0) {
  console.error(
    `citation-guard: ${dead} dead citation(s) out of ${total} checked, ${deadNames} retired package name(s)`,
  );
  process.exit(1);
}
console.log(`citation-guard: ${total} citations checked, all resolve; ${liveNames.size} live package names`);
