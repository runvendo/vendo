/**
 * The shared capability gate for every host-resolved TypeScript compiler
 * (`loadCompiler` in common.ts, `loadTypescript` in static-ts.ts, the catalog
 * scan's dynamic import). Extraction's law is "extraction never fails your
 * build": a compiler that loads but predates the API surface extraction calls
 * must degrade exactly like a compiler that failed to load — analysis
 * resolves to nothing — never crash mid-scan (FINDINGS F1: a host pinning
 * typescript 4.7 died on `ts.getModifiers is not a function` during
 * `vendo init`).
 */

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

/** Called by a loader whose every resolution candidate loaded but failed the
 * capability probe; sync surfaces the result once per report. */
export function noteRejectedCompiler(rejected: RejectedCompiler): void {
  rejectedCompiler = rejected;
}

/** The single host-facing warning for a loaded-but-too-old compiler, naming
 * the host's version, the missing API, and the floor. Null when no loader
 * rejected one. */
export function compilerFloorWarning(): string | null {
  if (rejectedCompiler === null) return null;
  return `host typescript ${rejectedCompiler.version} is older than the >=${COMPILER_FLOOR} floor extraction requires (missing ts.${rejectedCompiler.missingApi}); `
    + "compiler-based extraction (routes, trpc, graphql, server actions, component catalog) is disabled and resolves to nothing — "
    + `upgrade the host's typescript to >=${COMPILER_FLOOR} to restore it`;
}

/** Test seam: the rejection note is process-sticky by design. */
export function resetCompilerGateForTests(): void {
  rejectedCompiler = null;
}
