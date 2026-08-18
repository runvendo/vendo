/**
 * The one block a deployment prints when `createVendo` finishes composing.
 *
 *     ◆  vendo ready
 *     │  ✓ sandbox   cloud    VENDO_API_KEY
 *     │  ✓ store     local    .vendo/data
 *     │  ✓ models    cloud    VENDO_API_KEY (gateway)
 *     │  ✓ auth      clerk    auth: clerk()
 *     │  ⚠ store     .vendo/data is under /tmp — data will not survive a redeploy.
 *     │              Mount a volume, or pass url: "postgres://…" to createVendo.
 *
 * Column 2 is the VENUE — which implementation the adapter rule chose. Column 3
 * is what chose it: the env variable, or the config line the host wrote. The
 * rows are the same facts `/status` reports (wire/misc.ts), said once, at boot,
 * to the operator instead of to a client.
 *
 * Two hard constraints:
 *
 *   1. COMPOSED FACTS ONLY. `createVendo` must stay I/O-free at module init for
 *      Workers portability (compose-store.ts's `selectFiles` note), so nothing
 *      here may stat a path, open a handle, or await anything. Every row is a
 *      property read off the finished composition or an env variable — including
 *      the ephemeral-disk judgment, which its OWNER makes (the store, at
 *      `createStore`) and hangs on the engine handle, so this block reads it
 *      like any other composed fact and renders it as a WARNING, which is data
 *      in `BootSummary`, not a special case in the renderer.
 *
 *   2. ONE BLOCK PER PROCESS. A dev server recomposes on nearly every request;
 *      this is a boot fact, not a per-request one (the same latch
 *      `reportHostedStoreOnce` uses).
 */
import { log, vendoStyle, type VendoStyle } from "@vendoai/core";
import { maybeDbFor, type VendoStore } from "@vendoai/store";
import type { VendoComposition } from "./compose-context.js";
import { ENV_KEY_VARS } from "./dev-creds/resolve.js";
import { environment } from "./wire/shared.js";

/** One seam that is serving, and what chose it. */
export interface BootRow {
  /** The seam, as `/status` names it: sandbox, store, models, connections… */
  readonly label: string;
  /** The implementation the adapter rule picked — cloud, local, e2b, byo… */
  readonly venue: string;
  /** The env variable or config line that chose that venue. */
  readonly detail: string;
}

/** Something the operator has to know about a seam that composed anyway. Data,
    not a special case: a producer that discovers one (the ephemeral-disk check)
    appends it, and the renderer already knows how to draw it. */
export interface BootWarning {
  readonly label: string;
  /** Shown in the venue column when the warning is ABOUT the venue (a stray key
      that no longer selects one). Absent → the text starts at that column. */
  readonly venue?: string;
  /** The text, already broken into rail lines. Continuations align under the
      first line; a degraded run joins them into one. */
  readonly lines: readonly string[];
}

export interface BootSummary {
  readonly rows: readonly BootRow[];
  readonly warnings: readonly BootWarning[];
}

/** "Did the operator set this?" — TRIMMED, because a whitespace-only value is
    not a key, and `present` in dev-creds/resolve.ts — the ladder that actually
    resolves the model credentials this asks about — makes the same call. It is
    STRICTER than `environment()` (wire/shared.ts), which any non-empty string
    satisfies, and `vendo doctor` matches that looser predicate deliberately
    (doctor-config-checks.ts's checkStorePersistence), so the three do NOT all
    agree for a whitespace-only value. */
const keySet = (name: string): boolean => (environment(name)?.trim() ?? "") !== "";

const MARKER = "◆";
const BAR = "│";
const OK = "✓";
const WARN = "⚠";
const TITLE = "vendo ready";

/** A preset name is "spelled the way a host writes it in config" — `clerk`,
    `auth0`, `authJs` (auth-presets/shared.ts) — so an identifier, never free
    text. The one HOST-supplied string in the whole block is checked against
    this before it is rendered; see the auth row in `bootSummaryFor`. */
const PRESET_NAME = /^[\w.-]{1,32}$/;

/** The founder's column widths. `padEnd` never truncates, so a longer label or
    venue widens its column for the whole block instead of breaking alignment. */
const LABEL_COLUMN = 10;
const VENUE_COLUMN = 9;
const columnWidth = (base: number, values: readonly string[]): number =>
  Math.max(base, ...values.map((value) => value.length + 1));

/** The pretty block — only for a run `vendoStyle().pretty` said yes to. */
function prettyLines(summary: BootSummary, style: VendoStyle): string[] {
  const labels = [...summary.rows, ...summary.warnings].map((entry) => entry.label);
  const venues = [
    ...summary.rows.map((row) => row.venue),
    ...summary.warnings.flatMap((warning) => (warning.venue === undefined ? [] : [warning.venue])),
  ];
  const labelWidth = columnWidth(LABEL_COLUMN, labels);
  const venueWidth = columnWidth(VENUE_COLUMN, venues);
  const bar = style.dim(BAR);
  const lines = [`${style.accent(MARKER)}  ${style.bold(TITLE)}`];
  for (const row of summary.rows) {
    lines.push(
      `${bar}  ${style.ok(OK)} ${row.label.padEnd(labelWidth)}`
      + `${style.bold(row.venue.padEnd(venueWidth))}${style.dim(row.detail)}`,
    );
  }
  for (const warning of summary.warnings) {
    const head = warning.label.padEnd(labelWidth)
      + (warning.venue === undefined ? "" : warning.venue.padEnd(venueWidth));
    const [first = "", ...rest] = warning.lines;
    lines.push(`${bar}  ${style.warn(WARN)} ${head}${style.warn(first)}`);
    // `⚠ ` is two cells; the continuation starts under the text, not the marker.
    const indent = " ".repeat(head.length + 2);
    for (const line of rest) lines.push(`${bar}  ${indent}${style.warn(line)}`);
  }
  return lines;
}

/** The degraded form — a piped, NO_COLOR, CI or TERM=dumb run. One line for the
    summary, one per warning, and the `[vendo] ` prefix every plain Vendo line
    carries (core's log.ts keeps it inside the message on purpose). */
function plainLines(summary: BootSummary): string[] {
  const venues = summary.rows.map((row) => `${row.label}: ${row.venue}`).join(" · ");
  return [
    venues === "" ? "[vendo] ready" : `[vendo] ready — ${venues}`,
    ...summary.warnings.map(
      (warning) => `[vendo] warning: ${warning.label} — ${warning.lines.join(" ")}`,
    ),
  ];
}

/** The block as text, for the style handed in. Pure — the printer below is the
    only thing with state, which is what makes every rendering testable. */
export function renderBootSummary(summary: BootSummary, style: VendoStyle): string {
  return (style.pretty ? prettyLines(summary, style) : plainLines(summary)).join("\n");
}

/** ONE block per process (see the header). Module-scoped on purpose: the latch
    belongs to the process, not to an instance — a host holding two `createVendo`
    handles is one deployment and says "ready" once. */
let announced = false;

/**
 * Say it, once. Everything Vendo says out loud goes through core's sink
 * (log.ts), so a host can route or quieten this like any other line — and it is
 * ONE event, so the block can never be split across stdout and stderr and
 * arrive interleaved with something else.
 */
export function announceBootSummary(summary: BootSummary, style: VendoStyle = vendoStyle()): void {
  if (announced) return;
  announced = true;
  log({
    code: "vendo.ready",
    level: summary.warnings.length > 0 ? "warn" : "info",
    message: renderBootSummary(summary, style),
  });
}

/** The frozen hint: E2B_API_KEY sitting in the environment of a deployment with
    no sandbox. Wording is the founder's, byte for byte. */
const STRAY_E2B: BootWarning = {
  label: "sandbox",
  venue: "none",
  lines: [
    "found E2B_API_KEY, which no longer selects a sandbox"
    + " — pass sandbox: e2bSandbox() to use it",
  ],
};

/** The store's own ephemeral-disk judgment, said in the block instead of on its
    own console line: made at `createStore` and carried on the engine handle
    (`EphemeralDataDir`), so reading it here is a property read, not a stat. The
    dir is named the way the store ROW above names it — `.vendo/data`, as
    configured — and the second line is the operator's two ways out.

    Silent for every store this cannot be true of: a Postgres url, `memory://`,
    a real disk, the Cloud hosted store, and a host's own adapter. */
function ephemeralStoreWarning(store: VendoStore): BootWarning | undefined {
  const ephemeral = maybeDbFor(store)?.ephemeral;
  if (ephemeral === undefined) return undefined;
  const where = ephemeral.platform === undefined
    ? "is under /tmp"
    : `is on ${ephemeral.platform}'s container filesystem`;
  return {
    label: "store",
    lines: [
      `${ephemeral.dataDir} ${where} — data will not survive a redeploy.`,
      'Mount a volume, or pass url: "postgres://…" to createVendo.',
    ],
  };
}

/** Which ladder rung the composed model slot rode — named from the environment,
    because the ladder itself resolves LAZILY and asking it would force a
    resolution at boot (the same reason /status reports only "ladder"). The rung
    order is `resolveDevCredential`'s, over its own ENV_KEY_VARS list, so the two
    cannot drift on which variables count. */
function modelRow(): BootRow | undefined {
  // The E2E rung pin overrides everything the probe below can see; naming a rung
  // it may have replaced would be a guess, so say what is really in charge.
  if (keySet("VENDO_DEV_CREDENTIAL")) {
    return { label: "models", venue: "ladder", detail: "VENDO_DEV_CREDENTIAL" };
  }
  const key = ENV_KEY_VARS.find((entry) => keySet(entry.envVar));
  if (key !== undefined) return { label: "models", venue: key.provider, detail: key.envVar };
  if (keySet("VENDO_API_KEY")) {
    return { label: "models", venue: "cloud", detail: "VENDO_API_KEY (gateway)" };
  }
  return undefined;
}

/**
 * The composed facts, as rows.
 *
 * A seam earns a row only when it is actually SERVING. An unset sandbox, an
 * unconfigured guard and an unbrokered connections seam say nothing here —
 * silence is the honest report for a seam a host chose not to fill, and the
 * block stays four lines for the deployment that filled four seams.
 */
export function bootSummaryFor(composition: VendoComposition): BootSummary {
  const { config, composed, sandbox, inference, connections, guard, hostedStoreComposed, store }
    = composition;
  const { membershipsSeam } = composition;
  const rows: BootRow[] = [];
  const warnings: BootWarning[] = [];

  switch (sandbox.venue) {
    case "custom":
      rows.push({ label: "sandbox", venue: "custom", detail: "createVendo({ sandbox })" });
      break;
    case "e2b":
      rows.push({ label: "sandbox", venue: "e2b", detail: "E2B_API_KEY" });
      break;
    case "cloud":
      rows.push({ label: "sandbox", venue: "cloud", detail: "VENDO_API_KEY" });
      break;
    default:
      if (keySet("E2B_API_KEY")) warnings.push(STRAY_E2B);
  }

  const explicitStore = config.store ?? composed?.store;
  if (explicitStore !== undefined) {
    // A host may pass `hostedStore({…})` itself; the venue is still Cloud, but
    // the config line is what chose it, not the key.
    rows.push({
      label: "store",
      venue: hostedStoreComposed ? "cloud" : "custom",
      detail: "createVendo({ store })",
    });
  } else if (hostedStoreComposed) {
    rows.push({ label: "store", venue: "cloud", detail: "VENDO_API_KEY" });
  } else {
    rows.push({ label: "store", venue: "local", detail: ".vendo/data" });
  }
  // Whatever store composed, on disk or not: only the store knows, and only the
  // deployment can tell the operator.
  const ephemeral = ephemeralStoreWarning(store);
  if (ephemeral !== undefined) warnings.push(ephemeral);

  // What bounds the users' file drawer. Only when the host actually filled the
  // seam: unset, the store's own blobs back it and the store row above already
  // names where those live, so a second row would say the same thing twice.
  if (config.files !== undefined) {
    rows.push({ label: "files", venue: "byo", detail: "createVendo({ files })" });
  }

  if (inference.agent.venue === "custom") {
    rows.push({ label: "models", venue: "custom", detail: "createVendo({ models })" });
  } else {
    const model = modelRow();
    if (model !== undefined) rows.push(model);
  }

  if (connections.posture === "byo") {
    rows.push({
      label: "connections",
      venue: "byo",
      detail: config.connections === undefined
        ? "createVendo({ connectors })"
        : "createVendo({ connections })",
    });
  } else if (connections.posture === "cloud") {
    rows.push({ label: "connections", venue: "cloud", detail: "VENDO_API_KEY" });
  }

  // The VENDOR, when a shipped preset composed this deployment's identity — one
  // line telling the operator which auth is live is most of this row's value.
  // A host-composed preset has no vendor to name and a raw `principal` has no
  // preset at all; both say so rather than borrowing a name.
  //
  // This name is the one HOST-supplied string the block renders, and the block
  // is a SINGLE log event (announceBootSummary) whose whole point is that it
  // cannot be split or interleaved. A newline or an ANSI escape in the name
  // would forge a row inside that event and drive the operator's terminal, and
  // a non-printing character also breaks `columnWidth`, which counts characters
  // as cells. A name that is not an identifier is not a vendor name, and the
  // unnamed-preset row below already says exactly that.
  const preset = config.auth?.name;
  if (preset !== undefined && PRESET_NAME.test(preset)) {
    rows.push({ label: "auth", venue: preset, detail: `auth: ${preset}()` });
  } else if (config.auth !== undefined) {
    rows.push({ label: "auth", venue: "preset", detail: "createVendo({ auth })" });
  } else {
    rows.push({ label: "auth", venue: "custom", detail: "createVendo({ principal })" });
  }

  // Tenant connectors are per-ORG, and an org only ever reaches a request
  // through the memberships seam (build contract §9.1). Without one, no run can
  // ever assert an org and no overlay can ever be selected — the seam is not
  // serving, so it says nothing, like every other unfilled seam above.
  if (membershipsSeam !== undefined) {
    rows.push({ label: "tenants", venue: "store", detail: "vendo.tenantConnectors" });
  }

  const posture = guard.status().posture;
  if (posture !== "unconfigured") {
    rows.push({
      label: "guard",
      venue: posture,
      detail: config.guard === undefined ? "createVendo({ profile })" : "createVendo({ guard })",
    });
  }

  return { rows, warnings };
}
