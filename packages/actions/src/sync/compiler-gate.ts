/**
 * The shared resolver and capability gate for every TypeScript compiler
 * extraction loads. Extraction's law is "extraction never fails your build":
 * a compiler that loads but predates the API surface extraction calls must
 * degrade exactly like a compiler that failed to load — analysis resolves to
 * nothing — never crash mid-scan (FINDINGS F1: a host pinning typescript 4.7
 * died on `ts.getModifiers is not a function` during `vendo init`).
 */
import { createRequire } from "node:module";
import path from "node:path";
import type TS from "typescript";

/**
 * EVERY module-level compiler function the scanners call (regenerate with
 * `grep -rhoE "\bts\??\.[A-Za-z_]+\(" packages/actions/src --include="*.ts"
 * --exclude="*.test.ts"`). Gating on the full set — each entry
 * feature-detected, never a version string — is what keeps the floor honest:
 * 4.8 added canHaveModifiers/getModifiers, but a 4.8 host still crashed on
 * isSatisfiesExpression, which arrives in 4.9 (checker round 2; verified
 * against real typescript 4.7.4 / 4.8.4 / 4.9.5 installs — 4.9.5 is the
 * first carrying the whole set, so 4.9 is the floor the warning names).
 * Forks or patched compilers that carry every API pass regardless of what
 * their version string claims.
 */
export const REQUIRED_COMPILER_API = [
  "canHaveModifiers", "createCompilerHost", "createModuleResolutionCache",
  "createProgram", "createSourceFile", "findConfigFile",
  "flattenDiagnosticMessageText", "forEachChild", "getModifiers",
  "isArrayLiteralExpression", "isArrayTypeNode", "isArrowFunction",
  "isAsExpression", "isAwaitExpression", "isBinaryExpression", "isBlock",
  "isCallExpression", "isCaseBlock", "isCaseClause", "isClassDeclaration",
  "isDefaultClause", "isEnumDeclaration", "isExportAssignment",
  "isExportDeclaration", "isExpressionStatement", "isFunctionDeclaration",
  "isFunctionExpression", "isGetAccessorDeclaration", "isIdentifier",
  "isIfStatement", "isImportDeclaration", "isIndexSignatureDeclaration",
  "isJsxAttribute", "isJsxElement", "isJsxExpression", "isJsxFragment",
  "isJsxOpeningElement", "isJsxSelfClosingElement", "isLiteralTypeNode",
  "isMethodDeclaration", "isNamedExports", "isNamedImports",
  "isNamespaceExport", "isNamespaceImport", "isNewExpression",
  "isNoSubstitutionTemplateLiteral", "isNonNullExpression",
  "isNumericLiteral", "isObjectBindingPattern", "isObjectLiteralExpression",
  "isOmittedExpression", "isParenthesizedExpression",
  "isParenthesizedTypeNode", "isPrefixUnaryExpression",
  "isPropertyAccessExpression", "isPropertyAssignment",
  "isPropertyDeclaration", "isPropertySignature", "isReturnStatement",
  "isSatisfiesExpression", "isShorthandPropertyAssignment",
  "isSpreadAssignment", "isSpreadElement", "isStringLiteral",
  "isStringLiteralLike", "isTypeAssertionExpression", "isTypeLiteralNode",
  "isTypeQueryNode", "isTypeReferenceNode", "isUnionTypeNode",
  "isVariableDeclaration", "isVariableStatement",
  "parseConfigFileTextToJson", "parseJsonConfigFileContent",
  "readConfigFile", "resolveModuleName",
] as const;

/** The minimum released TypeScript carrying every required API. */
export const COMPILER_FLOOR = "4.9";

export interface RejectedCompiler {
  version: string;
  /** The first required API the candidate lacks, named in the floor warning. */
  missingApi: string;
}

/** Null when the candidate exposes every API extraction needs; otherwise its
 * version and the first missing API, feeding the floor warning. */
export function unsupportedCompiler(candidate: unknown): RejectedCompiler | null {
  const ts = candidate as (Record<string, unknown> & { version?: unknown }) | null | undefined;
  const missingApi = REQUIRED_COMPILER_API.find((api) => typeof ts?.[api] !== "function");
  if (missingApi === undefined) return null;
  return { version: typeof ts?.version === "string" ? ts.version : "unknown", missingApi };
}

/** Sticky for the process — a host's toolchain does not change mid-run, and
 * `loadCompiler` memoizes its (rejected) resolution anyway, so later syncs in
 * the same process could not re-detect the rejection themselves. */
let rejectedCompiler: RejectedCompiler | null = null;
let unresolvableCompiler = false;
let compilerRoot: string | undefined;

/** Called by a loader whose every resolution candidate loaded but failed the
 * capability probe; sync surfaces the result once per report. */
export function noteRejectedCompiler(rejected: RejectedCompiler): void {
  rejectedCompiler = rejected;
}

/** Called when no resolution base could load a compiler at all. */
export function noteUnresolvableCompiler(): void {
  unresolvableCompiler = true;
}

/** The project being synced. Its node_modules is the FIRST place every
 * compiler load looks: under `npx` the running install cannot see the
 * project's typescript, and a compiler resolved from nowhere leaves every
 * extractor reporting empty results as if the project had nothing to find. */
export function setCompilerRoot(root: string): void {
  compilerRoot = root;
}

/** The host's compiler, project first and this install second, gated on the
 * capability probe. Null — with the reason noted for the report — when no base
 * yields a usable one. */
export function resolveCompiler(root = compilerRoot): typeof TS | null {
  const bases = root === undefined ? [import.meta.url] : [path.join(root, "package.json"), import.meta.url];
  let rejected: RejectedCompiler | null = null;
  for (const base of bases) {
    let candidate: typeof TS;
    try {
      candidate = createRequire(base)("typescript") as typeof TS;
    } catch {
      continue; // Try the next resolution base.
    }
    const tooOld = unsupportedCompiler(candidate);
    if (tooOld === null) return candidate;
    rejected = tooOld;
  }
  if (rejected === null) noteUnresolvableCompiler();
  else noteRejectedCompiler(rejected);
  return null;
}

/** The single host-facing warning when compiler-based extraction is off,
 * naming the cause. A rejected compiler is a NAMED cause and outranks the
 * bare "nothing resolved". Null while extraction has a usable compiler. */
export function compilerFloorWarning(): string | null {
  const disabled = "compiler-based extraction (routes, trpc, server actions, component catalog) is disabled and resolves to nothing — ";
  if (rejectedCompiler !== null) {
    return `host typescript ${rejectedCompiler.version} is older than the >=${COMPILER_FLOOR} floor extraction requires (missing ts.${rejectedCompiler.missingApi}); `
      + disabled
      + `upgrade the host's typescript to >=${COMPILER_FLOOR} to restore it`;
  }
  if (!unresolvableCompiler) return null;
  return "no typescript compiler resolved from this project or from vendo's own install; "
    + disabled
    + `install typescript >=${COMPILER_FLOOR} in this project to restore it`;
}

/** Test seam: the notes and the root are process-sticky by design. */
export function resetCompilerGateForTests(): void {
  rejectedCompiler = null;
  unresolvableCompiler = false;
  compilerRoot = undefined;
}
