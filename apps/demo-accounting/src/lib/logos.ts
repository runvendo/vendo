/** Google favicon-based logo URL for a domain. Full-color, reliable, no token. */
export function logoUrl(domain: string, size = 128): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`
}

/**
 * Real institutions the seeded documents come from (payroll providers, banks),
 * detected from the deterministic seed filenames. Only well-known brands with
 * clean favicons; everything else keeps the neutral document chip.
 */
const PROVIDERS: { match: RegExp; name: string; domain: string }[] = [
  { match: /gusto/i, name: "Gusto", domain: "gusto.com" },
  { match: /\badp\b|adp-|-adp/i, name: "ADP", domain: "adp.com" },
  { match: /\bboa\b|boa-/i, name: "Bank of America", domain: "bankofamerica.com" },
  { match: /chase/i, name: "Chase", domain: "chase.com" },
  { match: /wells-?fargo/i, name: "Wells Fargo", domain: "wellsfargo.com" },
  { match: /usbank/i, name: "U.S. Bank", domain: "usbank.com" },
  { match: /mercury/i, name: "Mercury", domain: "mercury.com" },
]

export function providerForFilename(
  filename: string,
): { name: string; domain: string } | undefined {
  return PROVIDERS.find(p => p.match.test(filename))
}
