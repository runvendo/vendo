import path from "node:path";
import { fileURLToPath } from "node:url";

const repoNamePattern = /^[a-z0-9][a-z0-9-]*$/;

export interface CorpusRunContext {
  corpusRoot: string;
  reposDir: string;
  repoDir(name: string): string;
}

export interface CreateRunContextOptions {
  corpusRoot?: string;
}

export const defaultCorpusRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

export function createRunContext(options: CreateRunContextOptions = {}): CorpusRunContext {
  const corpusRoot = path.resolve(options.corpusRoot ?? defaultCorpusRoot);
  const reposDir = path.join(corpusRoot, ".repos");

  return {
    corpusRoot,
    reposDir,
    repoDir(name: string): string {
      if (!repoNamePattern.test(name)) {
        throw new Error(`Invalid corpus repo name "${name}"`);
      }
      return path.join(reposDir, name);
    },
  };
}
