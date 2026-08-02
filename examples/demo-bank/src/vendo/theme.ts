import { vendoThemeSchema } from "@vendoai/core";
import theme from "../../.vendo/theme.json";

export const mapleTheme = vendoThemeSchema.parse(theme);
