import { VendoError } from "./errors.js";
import { TOOL_NAME_PATTERN } from "./tools.js";

/** Names we will not let a host's tools hide behind.
 *
 *  `host` is banned because it is OUR word for the product, not the product's own
 *  (design §4: "never the word host — the model should read them as native
 *  product actions"). `vendo` and its variants are banned because that namespace
 *  is ours: `vendo_apps_*` and `vendo_*` already mean specific things to the
 *  runtime, and a host slug colliding with them would make a host tool
 *  indistinguishable from a platform one. */
const RESERVED_SLUG_STEMS = new Set(["host", "vendo", "vendoai"]);

const words = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);

/**
 * Design §4 — the host's product slug, derived at init from its product name and
 * overridable in config. It prefixes every extracted host tool
 * (`maple_invoices_list`) so the model reads them as the product's own actions.
 *
 * Throws rather than falling back, deliberately: a silent fallback would either
 * reintroduce `host_` or invent a slug the host never chose, and because the slug
 * is part of every tool name it is part of every `descriptorHash` — so getting it
 * wrong silently revokes the deployment's grants later instead of failing now.
 */
export function deriveProductSlug(productName: string): string {
  const parts = words(productName);
  const slug = parts.join("_");
  if (slug === "") {
    throw new VendoError(
      "validation",
      `Cannot derive a tool-name prefix from the product name ${JSON.stringify(productName)}. `
      + "Set one explicitly (it becomes the prefix on every host tool, e.g. maple_invoices_list).",
    );
  }
  if (/^[0-9]/.test(slug)) {
    throw new VendoError(
      "validation",
      `A tool-name prefix cannot start with a digit (got ${JSON.stringify(slug)}). Set one explicitly.`,
    );
  }
  if (parts.some((part) => RESERVED_SLUG_STEMS.has(part))) {
    throw new VendoError(
      "validation",
      `${JSON.stringify(slug)} is reserved and cannot prefix host tools. `
      + "Host tools carry the product's own name so the model reads them as native actions; "
      + "\"host\" is our word for your product, and \"vendo\" is the platform's own namespace.",
    );
  }
  return slug;
}

/**
 * The tool name the model sees. Idempotent in both directions that matter:
 * extraction runs repeatedly, so a stem that already carries the slug is not
 * double-prefixed, and a legacy `host_` stem has that prefix REPLACED rather
 * than stacked on (`maple_host_invoices_list` would be nonsense).
 */
export function prefixedToolName(slug: string, stem: string): string {
  // Validate the slug HERE too, not only in deriveProductSlug. The design makes
  // the slug configurable, so a caller can hand one straight to this function —
  // which left the reserved host/vendo ban bypassable through exactly the path
  // the design offers. Re-deriving is the check: it throws on the same inputs.
  if (deriveProductSlug(slug) !== slug) {
    throw new VendoError(
      "validation",
      `${JSON.stringify(slug)} is not a normalised tool-name prefix; derive it with deriveProductSlug.`,
    );
  }
  const bare = stem.startsWith("host_")
    ? stem.slice("host_".length)
    : stem.startsWith(`${slug}_`)
      ? stem.slice(slug.length + 1)
      : stem;
  const name = `${slug}_${bare}`;
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new VendoError(
      "validation",
      `${JSON.stringify(name)} is not a valid tool name (${TOOL_NAME_PATTERN}).`,
    );
  }
  return name;
}
