/**
 * The RECEIVING end of provision data — the box side of the contract that
 * nothing company-specific is ever baked (founder ruling 2026-08-04). The
 * template is generic and versioned with Vendo releases; the host's brand and
 * the host's own components arrive as FILES in the app's workspace when the box
 * is provisioned.
 *
 * The landing zone is `<app>/.vendo/host/`, and its layout is BYTE-IDENTICAL to
 * a host project's own `.vendo/` directory as `vendo sync` writes it:
 *
 *   .vendo/host/theme.json                     — VendoTheme (core's vendoThemeSchema)
 *   .vendo/host/components/<Name>.json         — CapturedHostComponent record
 *   .vendo/host/components/modules/<hex>.json  — CapturedModule { source, imports? }
 *
 * So the producer's whole job is a directory copy of what it already has: there
 * is no new format, no new transport, and no second shape to keep in sync.
 *
 * It is a SUBTREE of `.vendo/`, not `.vendo/` itself, because `.vendo/` is the
 * supervisor's control directory (`run`, `agent-<id>.log`). A host component
 * named `run` must not be able to collide with the entry that starts the app.
 *
 * Absent is normal, and never fatal: a box provisioned without host data serves
 * the app on Vendo's own neutral defaults.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Where a provisioner drops the host's captured data, relative to the app root. */
export const HOST_DIR = path.join(".vendo", "host");

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The host's brand tokens, or undefined. Shape-tolerant on purpose: a partial or
 * malformed theme must degrade to Vendo's defaults, never blank the app — the
 * same rule the `?vendoTheme=` query param has always followed.
 * @returns {Record<string, unknown> | undefined}
 */
export function readTheme(appRoot) {
  const theme = readJson(path.join(appRoot, HOST_DIR, "theme.json"));
  return isObject(theme) ? theme : undefined;
}

/**
 * Every host component the box was provisioned with, in name order.
 *
 * Mirrors the host-side reader's rules exactly (`readLocal` in
 * packages/vendo/src/cli/cloud/host-components.ts): the file stem IS the
 * component name, and a record referencing a module whose body is missing is
 * dropped WHOLE rather than surfaced half-built — a component that cannot be
 * rendered is worse than one that was never offered.
 *
 * @returns {Array<{ name: string, record: Record<string, unknown>, sources: Record<string, string> }>}
 */
export function readHostComponents(appRoot) {
  const dir = path.join(appRoot, HOST_DIR, "components");
  let entries;
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const name = entry.slice(0, -".json".length);
    const record = readJson(path.join(dir, entry));
    if (!isObject(record) || record.name !== name) continue;
    const refs = [
      ...(typeof record.entry === "string" ? [record.entry] : []),
      ...Object.values(isObject(record.modules) ? record.modules : {}),
      ...(Array.isArray(record.styles) ? record.styles.map((style) => style?.ref) : []),
    ].filter((ref) => typeof ref === "string");
    const sources = {};
    let complete = true;
    for (const ref of refs) {
      const body = readJson(path.join(dir, "modules", `${ref}.json`));
      if (!isObject(body) || typeof body.source !== "string") {
        complete = false;
        break;
      }
      sources[ref] = body.source;
    }
    if (complete) found.push({ name, record, sources });
  }
  return found;
}

/**
 * What the served page needs before its first paint: which app this is, and the
 * host's brand. Read at RUNTIME (never `import.meta.env`, which would freeze
 * per-app values into the template's build) and handed to the page as injected
 * data by whichever server is in front — `server.js` in production, the dev
 * server's own plugin for the live preview.
 *
 * @returns {{ appId?: string, theme?: Record<string, unknown> }}
 */
export function readRuntimeConfig(appRoot) {
  const appId = process.env.VENDO_APP_ID;
  const theme = readTheme(appRoot);
  return {
    ...(appId === undefined || appId === "" ? {} : { appId }),
    ...(theme === undefined ? {} : { theme }),
  };
}

/** The placeholder `index.html` carries, replaced with the real config by
 *  whichever server serves the page. */
export const RUNTIME_TOKEN = "__VENDO_RUNTIME__";

/** Splice the runtime config into a served page. `</script` is escaped because
 *  the payload sits inside a `<script type="application/json">` block. */
export function injectRuntimeConfig(html, config) {
  return html.replace(RUNTIME_TOKEN, JSON.stringify(config).replaceAll("<", "\\u003c"));
}
