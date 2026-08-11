/** Google favicon-based logo URL for a domain. Full-color, reliable, no token. */
export function logoUrl(domain: string, size = 128): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`
}

// Only well-known brands whose favicon is a clean, recognizable logo. Local spots
// (Tartine, Sightglass, Philz, etc.) have muddy favicons, so they intentionally fall
// back to the colored-initials avatar instead.
const DOMAINS: Record<string, string> = {
  "DoorDash": "doordash.com",
  "Whole Foods Market": "wholefoodsmarket.com",
  "Trader Joe's": "traderjoes.com",
  "Blue Bottle Coffee": "bluebottlecoffee.com",
  "Uber": "uber.com",
  "Lyft": "lyft.com",
  "Amazon": "amazon.com",
  "Apple Store": "apple.com",
  "Chipotle": "chipotle.com",
  "Shell": "shell.com",
  "Spotify": "spotify.com",
  "Netflix": "netflix.com",
  "iCloud+": "apple.com",
  "ChatGPT": "openai.com",
  "Equinox": "equinox.com",
  "United Airlines": "united.com",
  "PG&E": "pge.com",
  // payees / linked accounts
  "Chase": "chase.com",
  "Venmo": "venmo.com",
  "Apple Pay": "apple.com",
}
export function domainForName(name: string): string | undefined {
  return DOMAINS[name]
}
