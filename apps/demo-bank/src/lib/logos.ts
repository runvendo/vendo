/** Google favicon-based logo URL for a domain. Full-color, reliable, no token. */
export function logoUrl(domain: string, size = 128): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`
}

/** Display name -> brand domain. Names not present here fall back to an initials avatar. */
const DOMAINS: Record<string, string> = {
  "DoorDash": "doordash.com",
  "Whole Foods Market": "wholefoodsmarket.com",
  "Trader Joe's": "traderjoes.com",
  "Blue Bottle Coffee": "bluebottlecoffee.com",
  "Sightglass Coffee": "sightglasscoffee.com",
  "Philz Coffee": "philzcoffee.com",
  "Uber": "uber.com",
  "Lyft": "lyft.com",
  "Amazon": "amazon.com",
  "Apple Store": "apple.com",
  "Tartine Bakery": "tartinebakery.com",
  "Chipotle": "chipotle.com",
  "Shell": "shell.com",
  "Spotify": "spotify.com",
  "Netflix": "netflix.com",
  "iCloud+": "apple.com",
  "ChatGPT": "openai.com",
  "Equinox": "equinox.com",
  "United Airlines": "united.com",
  "PG&E": "pge.com",
  // payees / linked accounts / networks
  "Chase": "chase.com",
  "Venmo": "venmo.com",
  "Apple Pay": "apple.com",
  "Visa": "visa.com",
  "Mastercard": "mastercard.com",
}
export function domainForName(name: string): string | undefined {
  return DOMAINS[name]
}
export function networkDomain(network: string): string {
  return network === "mastercard" ? "mastercard.com" : "visa.com"
}
