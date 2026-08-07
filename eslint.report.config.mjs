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
    plugins: { sonarjs },
    rules: sonarjs.configs.recommended.rules,
  },
);
