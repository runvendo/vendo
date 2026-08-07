// Fixture: a clean client entry — only react + a local module in its closure.
import { useState } from "react";
import { helper } from "./helper.js";

export const value = useState;
export { helper };
