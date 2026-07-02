export interface InitOptions {
  targetDir: string;
  skipLlm: boolean;
  force: boolean;
}

export async function runInit(_opts: InitOptions): Promise<number> {
  throw new Error("not implemented");
}
