export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  return new Date(iso).toLocaleDateString("en-US", opts)
}
export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}
export function relativeDay(iso: string, now = new Date()) {
  const d = new Date(iso); const days = Math.floor((+startOfDay(now) - +startOfDay(d)) / 86400000)
  if (days === 0) return "Today"; if (days === 1) return "Yesterday"
  return formatDate(iso, { weekday: "short", month: "short", day: "numeric" })
}
function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
