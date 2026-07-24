import { vendoThemeSchema } from "@vendoai/core";
import theme from "../../.vendo/theme.json";

// CREATOR SEAM — .vendo/theme.json is a neutral default. The creator
// overwrites it with the prospect's extracted brand (colors, type, radius)
// so the Vendo panel renders brand-native; this file just validates it.
export const demoTheme = vendoThemeSchema.parse(theme);
