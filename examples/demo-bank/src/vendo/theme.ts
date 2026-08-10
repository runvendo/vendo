import {
  vendoThemeSchema,
} from "@vendoai/apps/contract";
import theme from "../../.vendo/theme.json";

export const mapleTheme = vendoThemeSchema.parse(theme);
