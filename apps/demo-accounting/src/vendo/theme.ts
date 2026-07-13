import { vendoThemeSchema } from "@vendoai/core";
import theme from "../../.vendo/theme.json";

export const cadenceTheme = vendoThemeSchema.parse(theme);
