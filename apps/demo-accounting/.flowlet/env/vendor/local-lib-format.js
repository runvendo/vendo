// src/lib/format.ts
var MINUTE = 6e4;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
function relativeTime(iso, now = /* @__PURE__ */ new Date()) {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (elapsed < 0) return elapsed > -MINUTE ? "just now" : formatDate(iso, now);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return formatDate(iso, now);
}
function daysUntil(iso, now = /* @__PURE__ */ new Date()) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / DAY);
}
function formatDate(iso, now = /* @__PURE__ */ new Date()) {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}
  });
}
var ENTITY_LABELS = {
  s_corp: "S-Corp",
  c_corp: "C-Corp",
  sole_prop: "Sole Prop",
  partnership: "Partnership",
  individual: "Individual"
};
function entityLabel(type) {
  return ENTITY_LABELS[type];
}
export {
  ENTITY_LABELS,
  daysUntil,
  entityLabel,
  formatDate,
  relativeTime
};
