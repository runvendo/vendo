// Report-only lint for packages/*. NOT part of `pnpm lint` — see the
// `lint:report` script in the root package.json. Nothing here blocks: the
// point is to publish counts so a rule set can be chosen from real numbers
// rather than a guess. The three examples/* Next apps keep their own
// eslint.config.mjs and stay in the blocking gate.
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

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
    // packages/* already carries eslint-disable comments for rules no config
    // here defines (react-hooks, @next, @typescript-eslint) — left over from
    // editor setups, since eslint has never run over this tree. Without this
    // they surface as "Definition for rule was not found", which is directive
    // noise rather than a finding.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { sonarjs, '@typescript-eslint': tseslint.plugin },
    rules: {
      ...sonarjs.configs.recommended.rules,
      // Off for good: it does not see this repo's assertion helpers, so a test
      // that asserts through one reads as a test with no assertions. 108 of
      // those, all false.
      'sonarjs/assertions-in-tests': 'off',
      // Replaced by @typescript-eslint/no-unused-vars below. sonarjs's version
      // flags the binding in a rest-omit destructuring
      // (`const { secret: _secret, ...rest } = row`), where the binding is
      // what excludes the key — deleting it changes the object — and it takes
      // no options, so there is nothing to configure around it.
      'sonarjs/no-unused-vars': 'off',
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
);
