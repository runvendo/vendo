// Fixture: a clean local module — a type-only @vendoai/core import is erased.
import type { VendoTheme } from "@vendoai/core";

export const helper = (theme: VendoTheme): number => Object.keys(theme).length;
