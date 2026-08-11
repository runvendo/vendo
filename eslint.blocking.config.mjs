// The blocking lint over packages/*, run from the root `lint` script. Four
// rules, chosen from the census `pnpm lint:report` prints; everything else
// stays in eslint.report.config.mjs and blocks nothing.
//
// No rule here is disabled per-file, per-line or per-package. A rule is
// enforced everywhere in packages/* or it does not belong in this file.
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import reactHooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      // Generated into the source tree by packages/ui's prebuild.
      '**/*.gen.ts',
    ],
  },
  {
    files: ['packages/*/**/*.{ts,tsx,mts,cts}'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    // react-hooks and @next/next are registered, not enabled: nine
    // `eslint-disable` comments in packages/ui name their rules, and ESLint
    // reports an unknown rule in a directive as an error of its own. Without
    // the plugins present that is nine errors no rule set can clear — and
    // deleting the comments would silently re-enable those rules in every
    // editor and in the examples' Next lint, where they do resolve.
    plugins: {
      sonarjs,
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      '@next/next': next,
    },
    rules: {
      'sonarjs/unused-import': 'error',
      'sonarjs/no-dead-store': 'error',
      // Not sonarjs/no-unused-vars: that rule flags the binding in a rest-omit
      // destructuring (`const { secret: _secret, ...rest } = row`), where the
      // binding is what excludes the key — deleting it changes the object —
      // and it takes no options, so there is nothing to configure around it.
      // Same intent, correct semantics. The `^_` patterns cover the other
      // deliberate idiom: signature-preserving no-op parameters in the edge
      // shims (store/src/crypto-edge.ts, vendo-telemetry/src/edge.ts) and the
      // React error boundaries, where the parameter has to exist for the
      // function to match the type it implements.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // src/ only, threshold 50. The test estate carries fixtures far above this
    // (ui/test/wire-server.ts scores 266) and re-cutting it is not dispatched;
    // blocking on them would gate the repo on work nobody owns. Note this
    // scoping is by directory, not by filename — a test helper that lives in
    // src/ is still covered.
    files: ['packages/*/src/**/*.{ts,tsx,mts,cts}'],
    plugins: { sonarjs },
    rules: { 'sonarjs/cognitive-complexity': ['error', 50] },
  },
);
