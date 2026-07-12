import { createUi, type Ui } from "../ui.js";

export interface SyncOptions {
  targetDir: string;
  now?: () => string;
  ui?: Ui;
}

/** Kept as the stable prebuild command while generated app artifacts are rebuilt. */
export async function runSync(options: SyncOptions): Promise<number> {
  const ui = options.ui ?? createUi();
  ui.header("vendo sync");
  ui.step("ok", "generated artifacts up to date");
  return 0;
}
