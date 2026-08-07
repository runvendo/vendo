/**
 * Compile-time proof that core's vendored filesystem interface still matches the
 * real one — nothing here runs, and nothing here is exported.
 *
 * `WorkspaceFs` extends an `IFileSystem` that core vendors verbatim (Apache-2.0)
 * so the SDK does not ship a bash interpreter for a type. Vendoring means the
 * copy can drift from upstream, and the failure mode is nasty: the workspace
 * would stop being accepted by `new Bash({ fs })` — the whole point of §3.2 —
 * and nothing else in the tree would notice. `pnpm typecheck` notices, here.
 *
 * just-bash is a devDependency (the bash tests), which is exactly right: this
 * assertion runs at build time in this repo and the import is type-only, so it
 * leaves no trace in the published surface.
 */
import type { WorkspaceFs } from "@vendoai/core";
import type { IFileSystem as UpstreamFileSystem } from "just-bash";

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** A workspace must remain usable as just-bash's filesystem.
 *
 *  Deliberately NOT exported: an exported alias would put a real
 *  `import type … from "just-bash"` into the published `.d.ts`, and every
 *  consumer of `@vendoai/store` would then need the interpreter's types
 *  installed — reintroducing the dependency this file exists to prevent.
 *  Unexported, TypeScript checks it here and elides the import from the
 *  emitted declaration. */
type WorkspaceFsIsUpstreamFileSystem = Assert<WorkspaceFs extends UpstreamFileSystem ? true : false>;
