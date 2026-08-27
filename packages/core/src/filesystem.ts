/**
 * The filesystem interface the workspace speaks (build contract §3.2).
 *
 * Vendored verbatim from just-bash's `IFileSystem` (`vercel-labs/just-bash`,
 * `dist/fs/interface.d.ts`, v3.2.0) so that `@vendoai/core` — the package every
 * consumer installs — carries the SHAPE without the ~50 MB bash interpreter
 * behind it. The runtime dependency belongs to whoever actually runs bash
 * (`@vendoai/harnesses`), never to core.
 *
 * Keep this structurally identical to upstream: a `WorkspaceFs` must stay
 * assignable to `new Bash({ fs })`. The one deliberate omission is upstream's
 * optional `readFileBytes?(path): Promise<ByteString>` — it is optional
 * precisely so external implementations may skip it, and just-bash falls back
 * to `readFileBuffer` when it is absent (documented upstream). Omitting an
 * optional member does not affect assignability.
 *
 * ---------------------------------------------------------------------------
 * just-bash — Copyright (c) Vercel, Inc. and just-bash contributors.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 * ---------------------------------------------------------------------------
 */

/** Supported buffer encodings. */
export type BufferEncoding = "utf8" | "utf-8" | "ascii" | "binary" | "base64" | "hex" | "latin1";

/** File content can be string or bytes. */
export type FileContent = string | Uint8Array;

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

/** Directory entry with type information (Node's Dirent, narrowed). */
export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Stat result from the filesystem. */
export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
  /** Stable filesystem identity when the backend can expose it safely. */
  dev?: number | bigint;
  ino?: number | bigint;
  identity?: string;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

/**
 * Abstract filesystem interface, implementable by different backends —
 * in-memory, a real disk, or (ours) the store.
 */
export interface IFileSystem {
  /** Read a file as decoded text. Default encoding is utf8. */
  readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string>;
  /** Read a file as raw bytes. */
  readFileBuffer(path: string): Promise<Uint8Array>;
  /** Write content to a file, creating it if it does not exist. */
  writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
  /** Append content to a file, creating it if it does not exist. */
  appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** @throws if the path does not exist. */
  stat(path: string): Promise<FsStat>;
  /** @throws if the parent does not exist (unless recursive) or the path exists. */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  /** Entry names, not full paths. */
  readdir(path: string): Promise<string[]>;
  /** Optional: entry names with type information, cheaper than readdir + stat. */
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;
  /** @throws if the path does not exist (unless force) or a directory is not empty (unless recursive). */
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  /** Resolve a relative path against a base path. Synchronous by contract. */
  resolvePath(base: string, path: string): string;
  /** Every path in the filesystem (glob matching). Synchronous by contract. */
  getAllPaths(): string[];
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  /** Stat without following symlinks. */
  lstat(path: string): Promise<FsStat>;
  /** POSIX realpath: resolve every symlink to the canonical physical path. */
  realpath(path: string): Promise<string>;
  /** Set access and modification times. `atime` is accepted for API compatibility. */
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}
