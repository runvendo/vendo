import type { Category } from "@/server/types"

/** One shared, restrained category color scale. Muted and harmonious — warm greys, sage, clay — never neon. */
export const CATEGORY_COLORS: Record<Category, string> = {
  dining: "#B0473A", // clay (the DoorDash category — slightly warmer so it reads)
  groceries: "#5F7355", // sage
  coffee: "#8A6D3B", // mocha
  transport: "#4E6472", // slate blue
  subscriptions: "#6B5B7B", // muted plum
  shopping: "#9A6A4F", // terracotta
  income: "#1E7F53", // green (positive)
  transfer: "#908C85", // muted (neutral)
  housing: "#3F4A5A", // deep slate
  other: "#A8A29A", // grey
}

export const categoryColor = (c: Category) => CATEGORY_COLORS[c] ?? "#A8A29A"

export const categoryLabel = (c: Category) => c.charAt(0).toUpperCase() + c.slice(1)
